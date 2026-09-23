// tests/refined-road-visual-surface.test.js
// [Mission 31G-FIX13] Road Visual Surface のさらなる精密化（CARRIAGEWAY/SIDEWALK/MEDIAN 分離）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';
const REFINED = R('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');

test('[FIX13 §22] refined-road-visual-surface validator が PASS', { skip: !rpt('refined-road-visual-surface-validation.json') && 'no report' }, () => {
  const v = rpt('refined-road-visual-surface-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.invalidCarriagewayPolygon, 0);
  assert.equal(v.checks.untrackedWidthSource, 0);
  assert.equal(v.checks.sourceProvenancePct, 100);
  assert.equal(v.checks.canonicalRoadMutation, 0);
  assert.equal(v.checks.buildingGeometryMutation, 0);
  assert.equal(v.checks.negativeBufferHackInBuild, 0);
  assert.equal(v.checks.lanesUsedForGeometry, 0);
  assert.equal(v.checks.intersectionTopologyBreak, 0);
  assert.equal(v.checks.projectionUnchanged, true);
  assert.equal(v.checks.productionUnchanged, true);
  assert.equal(v.checks.protectedUnchanged, true);
});

test('[FIX13 §17] refined-road-surface.json: §17 renderClass taxonomy を持つ', { skip: !fs.existsSync(REFINED) && 'no index' }, () => {
  const rc = rj(REFINED);
  assert.equal(rc.version, 1);
  const classes = new Set(rc.classes);
  for (const c of ['CARRIAGEWAY', 'INTERSECTION', 'RAMP', 'BRIDGE', 'PEDESTRIAN', 'SIDEWALK', 'MEDIAN', 'ROAD_RESERVE', 'FAINT']) assert.ok(classes.has(c), c + ' が classes に無い');
  // classMap の値は既知 rsCode（primary は index 省略）
  const known = new Set(Object.keys(rc.rsCodes || {}));
  for (const code of Object.values(rc.classMap)) assert.ok(known.has(code), '未知の rs code: ' + code);
});

test('[FIX13 §9/§10] SIDEWALK / MEDIAN が CARRIAGEWAY から分離されている（byClass に存在・面積 > 0）', { skip: !fs.existsSync(REFINED) && 'no index' }, () => {
  const rc = rj(REFINED);
  assert.ok(rc.byClass.SIDEWALK > 0, 'SIDEWALK が 0 件');
  assert.ok(rc.byClass.MEDIAN > 0, 'MEDIAN が 0 件');
  assert.ok(rc.areaByClassM2.SIDEWALK > 0);
  assert.ok(rc.areaByClassM2.MEDIAN > 0);
});

test('[FIX13 §4] lanes は幾何 clamp に使われていない（build script に uniform buffer/shrink コードが無い）', () => {
  const src = fs.readFileSync(R('tools', 'build-refined-road-surface.js'), 'utf-8');
  assert.doesNotMatch(src, /\.buffer\(-\d/);
  assert.doesNotMatch(src, /shrinkToLanes|clampWidth/);
  // 幹線（arterial）は advisory のみで幾何を変えないことを明記
  assert.match(src, /幾何 clamp には使わない/);
});

test('[FIX13 §7] audit: canonical > FIX12 visual > FIX13 carriageway 面積（降順で単調縮小）', { skip: !rpt('refined-road-visual-surface.json') && 'no report' }, () => {
  const r = rpt('refined-road-visual-surface.json');
  assert.ok(r.newVisualAreaKm2 < r.canonicalAreaKm2);
  assert.ok(r.newVisualAreaKm2 <= r.oldVisualAreaKm2, 'FIX13 visual ' + r.newVisualAreaKm2 + ' > FIX12 visual ' + r.oldVisualAreaKm2);
  assert.ok(r.newCarriagewayAreaKm2 < r.canonicalAreaKm2);
  assert.equal(r.sourceGeometryMutated, false);
  assert.equal(r.buildingGeometryMutated, false);
  assert.equal(r.negativeBufferHack, false);
  assert.equal(r.officialRoadEdgeAcquired, false);
});

test('[FIX13 §14] Building ∩ RefinedCarriageway ≤ Building ∩ FIX12VisualRoad ≤ Building ∩ CanonicalRoad', { skip: !rpt('refined-carriageway-overlap.json') && 'no overlap audit' }, () => {
  const o = rpt('refined-carriageway-overlap.json');
  assert.ok(o.buildingOnRefinedCarriagewayAreaM2 <= o.buildingOnFix12VisualRoadAreaM2);
  assert.ok(o.buildingOnFix12VisualRoadAreaM2 <= o.buildingOnCanonicalRoadAreaM2);
  assert.ok(o.buildingsFreedFix12ToFix13 >= 0);
  assert.equal(o.buildingGeometryMutated, false);
  assert.equal(o.sourceGeometryMutated, false);
});

test('[FIX13 §18] runtime: refined-road-surface.json を優先 fetch し、road-render-class.json へ fallback', { skip: !html && 'no html' }, () => {
  assert.match(html, /fetch\(BASE \+ '\/refined-road-surface\.json'\)/);
  assert.match(html, /fetch\(BASE \+ '\/road-render-class\.json'\)/);
  assert.match(html, /roadRenderClass\.set\(pfx \+ k, rs\)/);
  assert.match(html, /roadRenderClassSource = 'refined'/);
  assert.match(html, /roadRenderClassSource = 'fix12'/);
});

test('[FIX13 §9/§18] runtime: sidewalk / median は車道と別 style（不透明車道を維持）', { skip: !html && 'no html' }, () => {
  // [Mission 35H] msBlend のガードを mix() へまとめた（混ぜる色と比率は不変）。
  assert.match(html, /const mix = \(a, b, t\) => \(\(typeof msBlend === 'function'\) \? msBlend\(a, b, t\) : a\);/);
  assert.match(html, /sidewalk:\s*\{ col: mix\(0xb8b0a4, 0xf3f4f1, 0\.45\)/);
  assert.match(html, /median:\s*\{ col: mix\(0x9ac888, 0xf3f4f1, 0\.4\)/);
  // 車道 primary は FIX12 から不透明のまま（§0: 見た目だけで縮めない）
  assert.match(html, /primary:\s*\{ col: COL\.road, y: Y\.road,\s+opacity: 1\.0,\s+transparent: false/);
});

test('[FIX13 §19] performance: buckets/style は precompute 済みデータの参照のみ（毎フレーム道路幅計算なし）', { skip: !html && 'no html' }, () => {
  const s = html.indexOf("} else if (layer === 'roads') {");
  const b = html.slice(s, s + 1800);
  assert.doesNotMatch(b, /Math\.hypot|perimeterOf|effW|laneWidth/);
});

test('[FIX13 §0/§15] 建物 branch は変更されていない（buildings 分岐は roads と独立）', () => {
  const s = html.indexOf("} else if (layer === 'buildings') {");
  assert.ok(s >= 0);
  const b = html.slice(s, s + 400);
  assert.doesNotMatch(b, /roadRenderClass|CR_ROAD_RS|carriageway/i);
});

test('[FIX13 §0] protected HTML に refined road surface コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /refined-road-surface|CARRIAGEWAY|carriagewayRibbons/, f + ' に混入');
  }
});

test('[FIX13] build-derived-public.js が refined-road-surface.json を配信対象に含む', () => {
  const t = fs.readFileSync(R('tools', 'build-derived-public.js'), 'utf-8');
  assert.match(t, /refined-road-surface\.json/);
});
