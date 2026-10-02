// tests/canonical-spatial-alignment.test.js
// [Mission 31G-FIX10] 建物 ↔ 都市基盤の座標整合。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rpt = (n) => { try { return JSON.parse(fs.readFileSync(R('data', 'reports', n), 'utf-8')); } catch { return null; } };
const htmlPath = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf-8') : '';
const crBlock = (html.match(/const CanonicalRuntime = \(function[\s\S]*?console\.log\('\[CanonicalRuntime\] READY'\);/) || [''])[0];

test('[FIX10] CanonicalRuntime は座標を変換しない（識別変換のみ）', { skip: !html && 'no html' }, () => {
  // pushExtrude 壁: 頂点をそのまま push（tile 原点や z 反転を足さない）
  assert.match(html, /positions\.push\(a\[0\], 0, a\[1\], b\[0\], 0, b\[1\], b\[0\], h, b\[1\]\)/);
  // pushPolygon: triangulate 結果を [v.x, yLevel, v.y] でそのまま push
  assert.match(html, /positions\.push\(v\.x, yLevel, v\.y\)/);
  // z 反転 / tile 原点加算が CanonicalRuntime ブロックに無い
  assert.doesNotMatch(crBlock, /z\s*=\s*-\s*\w+\[1\]/);
  assert.doesNotMatch(crBlock, /\.position\.set\([^)]*\bt[xz]\b/);
  assert.doesNotMatch(crBlock, /group\.position\.[xz]\s*=[^=]/);
  assert.doesNotMatch(crBlock, /positions\.push\([^)]*\bt[xz]\s*\*/);
});

test('[FIX10] group / mesh は原点固定（matrix 不変・位置 offset なし）', { skip: !html && 'no html' }, () => {
  // FIX7 で group.updateMatrix + matrixAutoUpdate=false。position は触らない（= 単位行列のまま）
  assert.match(html, /gb\.group\.updateMatrix\(\); gb\.group\.matrixAutoUpdate = false;/);
  assert.doesNotMatch(crBlock, /gb\.group\.position\./);
});

test('[FIX10 §26] canonical-spatial-alignment validator が PASS', { skip: !rpt('canonical-spatial-alignment-validation.json') && 'no report' }, () => {
  const v = rpt('canonical-spatial-alignment-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.projectionOriginMismatch, 0);
  assert.equal(v.checks.coordinateConventionMismatch, 0);
  assert.equal(v.checks.unexpectedRuntimeTranslation, 0);
  assert.equal(v.checks.tileOffsetMismatch, 0);
  assert.equal(v.checks.canonicalToRuntimeDisplacement, 0);
  assert.equal(v.checks.lodCentroidJump, 0);
  assert.equal(v.checks.buildingRoadSystematicOffset, 0);
});

test('[FIX10 §9/§10] canonical→derived→runtime の centroid regression がほぼ 0m', { skip: !rpt('canonical-spatial-alignment.json') && 'no report' }, () => {
  const a = rpt('canonical-spatial-alignment.json');
  const cd = a.canonicalToRuntimeRegression.canonicalToDerived;
  assert.ok(cd.median <= 0.5, 'canonical→derived median ' + cd.median + 'm');
  assert.ok(cd.p95 <= 1.0, 'canonical→derived p95 ' + cd.p95 + 'm');
  // resolved→derived は simplification 微小差のみ
  assert.ok(a.canonicalToRuntimeRegression.resolvedToDerived.median <= 0.5);
});

test('[FIX10 §11/§23] LOD centroid 一致（near/mid ほぼ 0m・LOD 切替で建物がジャンプしない）', { skip: !rpt('canonical-spatial-alignment.json') && 'no report' }, () => {
  const a = rpt('canonical-spatial-alignment.json');
  assert.ok(a.lodCentroidConsistency.nearVsMid.p95 <= 2.0, 'near/mid p95 ' + a.lodCentroidConsistency.nearVsMid.p95);
  assert.ok(a.lodCentroidConsistency.nearVsFar.p95 <= 4.0, 'near/far p95 ' + a.lodCentroidConsistency.nearVsFar.p95);
});

test('[FIX10 §5/§8/§27] building ↔ canonical road: 系統的な回転/スケール/平行移動なし', { skip: !rpt('canonical-spatial-alignment.json') && 'no report' }, () => {
  const a = rpt('canonical-spatial-alignment.json');
  const br = a.buildingToNearestRoadVector;
  assert.ok(Math.abs(br.medianDx) <= 4 && Math.abs(br.medianDz) <= 4, 'median dx/dz ' + br.medianDx + '/' + br.medianDz);
  // z-band を跨いだ系統トレンドが小さい（回転/スケールなら大きく傾く）
  assert.ok(Math.abs(br.dxTrendOverCity) <= 8 && Math.abs(br.dzTrendOverCity) <= 8, 'trend dx/dz ' + br.dxTrendOverCity + '/' + br.dzTrendOverCity);
  assert.match(a.alignmentType, /F_SOURCE_DIFFERENCE|小残差/);
});

test('[FIX10 §1/§3] 座標 pipeline: roads/water/N03/geoToThree が同一原点の local-equirectangular', { skip: !rpt('canonical-spatial-alignment.json') && 'no report' }, () => {
  const a = rpt('canonical-spatial-alignment.json');
  const p = a.coordinatePipeline;
  assert.equal(p.originConsistency.centerLat, 34.604208);
  assert.equal(p.originConsistency.centerLon, 135.52502);
  assert.match(p.byLayer['PLATEAU tran roads'].pipeline, /z=-\(\(lat-34\.604208\)/);
  assert.match(p.byLayer['OSM water'].pipeline, /z=-\(\(lat-34\.604208\)/);
  assert.match(p.byLayer['CanonicalRuntime'].transform, /座標変換ゼロ|なし/);
});

test('[FIX10 §18/§19] source geometry 不変・placement policy 再計算不要（geometry 未変更）', () => {
  // この mission は canonical geometry を書き換えていない → placement/conflict を再生成する必要がない
  assert.ok(fs.existsSync(R('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json')));
  const m = JSON.parse(fs.readFileSync(R('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'), 'utf-8'));
  assert.equal(m.featureCount, 615617, 'canonical building 数 不変');
});
