// tests/building-exact-near-alignment.test.js
// [Mission 31G-FIX24] Building Ground-Anchor Final Fix。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInlineScript } from './_ward-ux-v1-smoke-harness.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

test('[FIX24 §30] building-exact-near-alignment validator が PASS', { skip: !rpt('building-exact-near-alignment-validation.json') && 'no report' }, () => {
  const v = rpt('building-exact-near-alignment-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['nearUsesExactCanonicalFootprint', 'roadNearToleranceUnchanged', 'fixApplied',
    'exactRuntimeZeroDeviation', 'publicNearMatchesProcessed', 'nearFeatureCountMatchesCanonical']) {
    assert.equal(v.checks[k], true, k + ' が true でない');
  }
  assert.equal(v.checks.nearSimplificationTolerance, 0);
  assert.equal(v.checks.baseTopXZMismatch, 0);
  assert.equal(v.checks.buildingGeometryMutation, 0);
  assert.equal(v.checks.roadGeometryMutation, 0);
  assert.equal(v.checks.projectionMutation, 0);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[FIX24 §1] derived/near/buildings の simplificationToleranceM が 0（canonical exact footprint）', () => {
  const m = rj(R('data', 'processed', 'osaka-city', 'derived', 'near', 'buildings', 'manifest.json'));
  assert.ok(m, 'near buildings manifest が無い');
  assert.equal(m.simplificationToleranceM, 0);
  assert.equal(m.featureCount, 615617);
  const pubM = rj(R('public', 'map-data', 'osaka-city', 'derived', 'near', 'buildings', 'manifest.json'));
  assert.ok(pubM, 'publicへ未反映');
  assert.equal(pubM.simplificationToleranceM, 0);
});

test('[FIX24 §20] road/water/park/rail の near tier tolerance は変更していない（tolM=2のまま）', () => {
  for (const layer of ['roads', 'water', 'parks', 'rail']) {
    const m = rj(R('data', 'processed', 'osaka-city', 'derived', 'near', layer, 'manifest.json'));
    assert.ok(m, layer + ' near manifest が無い');
    assert.equal(m.simplificationToleranceM, 2, layer + ' のnear tier toleranceが変更されている');
  }
});

test('[FIX24 §6/§7/§29] building-exact-near-alignment.json に実測結果(修正前/修正後)が記録されている', { skip: !rpt('building-exact-near-alignment.json') && 'no report' }, () => {
  const j = rpt('building-exact-near-alignment.json');
  assert.equal(j.sampleCount, 615617);
  assert.equal(j.fixApplied, true);
  // 修正前(tolM=2)の実測（このミッション内で実際に測定した値）
  assert.ok(j.beforeFix);
  assert.equal(j.beforeFix.sampleCount, 615617);
  assert.ok(j.beforeFix.countsOverPerBuilding['1m'] > 0, '修正前実測で1m超の棟が0件は不自然（実際に発見された偏差と矛盾）');
  // 修正後(tolM=0)は理論上0
  assert.ok(j.exactRuntime);
  assert.equal(j.exactRuntime.medianEdgeDeviation, 0);
  assert.equal(j.exactRuntime.p95EdgeDeviation, 0);
  assert.equal(j.exactRuntime.maxEdgeDeviation, 0);
});

test('[FIX24 §9/§10] pushExtrude(): 壁のbase(y=0)とtop(y=h)でx/zが完全一致する（Canonical Runtime抽出ロジック）', { skip: !html && 'no html' }, () => {
  // [Mission 35H] 引数に colors（頂点カラー）が増えたが、**positions の積み方は不変**。
  const start = html.indexOf('function pushExtrude(positions, geometryType, coordinates, h');
  const end = html.indexOf('\n  function meshFromPositions', start);
  const body = html.slice(start, end);
  assert.match(body, /positions\.push\(a\[0\], 0, a\[1\], b\[0\], 0, b\[1\], b\[0\], h, b\[1\]\);/);
  assert.match(body, /positions\.push\(a\[0\], 0, a\[1\], b\[0\], h, b\[1\], a\[0\], h, a\[1\]\);/);
  // 屋根も同じcontour(x/z)をy=hで積むだけ（新しい座標を作らない）
  assert.match(body, /positions\.push\(v\.x, h, v\.y\);/);
});

test('[FIX24] 動的: buildGroup(layer=buildings)が例外なく呼べ、fetchAndParseのURL構築(band別)が既存どおり動作する', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0, 'FIX24変更後もLegacy residualが0のまま（既存FIX23/23B/23Cの修正が壊れていない）');
});

test('[FIX24] tools/build-derived-geometry.js は自身が所有する出力だけを削除する（他script成果物の巻き添え削除を防止）', () => {
  const src = fs.readFileSync(R('tools', 'build-derived-geometry.js'), 'utf-8');
  assert.doesNotMatch(src, /fs\.rmSync\(DERIVED, \{ recursive: true, force: true \}\);/,
    'derived/ ディレクトリ全体を削除する退行を検出（refined-road-surface.json等の巻き添え削除realバグの再発）');
  assert.match(src, /function cleanOwnedOutputs\(\)/);
});

test('[FIX24 §0] protected HTML に building-exact-near-alignment 関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /LOD_TOLERANCE_OVERRIDE|cleanOwnedOutputs/, f + ' に混入');
  }
});
