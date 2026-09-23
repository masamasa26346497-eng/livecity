// tests/road-visual-surface.test.js
// [Mission 31G-FIX12] Canonical Road（source truth）と Road Visual Surface（描画面）の分離。
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

test('[FIX12 §20] road-visual-surface validator が PASS', { skip: !rpt('road-visual-surface-validation.json') && 'no report' }, () => {
  const v = rpt('road-visual-surface-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.invalidVisualPolygon, 0);
  assert.equal(v.checks.unknownRenderedAsFullRoad, 0);
  assert.equal(v.checks.roadVisualProvenancePct, 100);
  assert.equal(v.checks.sourceGeometryMutation, 0);
  assert.equal(v.checks.buildingGeometryMutation, 0);
  assert.equal(v.checks.projectionUnchanged, true);
  assert.equal(v.checks.productionUnchanged, true);
  assert.equal(v.checks.protectedUnchanged, true);
});

test('[FIX12 §2/§13] road-render-class.json: classMap は primary 以外の renderClass のみ収録', { skip: !fs.existsSync(R('data', 'processed', 'osaka-city', 'derived', 'road-render-class.json')) && 'no index' }, () => {
  const rc = rj(R('data', 'processed', 'osaka-city', 'derived', 'road-render-class.json'));
  assert.equal(rc.version, 1);
  const rsSet = new Set();
  for (const v of Object.values(rc.classMap)) {
    assert.ok(['bridge', 'secondary', 'pedestrian', 'faint'].includes(v.rs), 'primary が index に載っている: ' + JSON.stringify(v));
    assert.ok(typeof v.conf === 'number' && v.conf >= 0 && v.conf <= 1);
    rsSet.add(v.rs);
  }
  assert.equal(Object.keys(rc.classMap).length, rc.indexedCount);
});

test('[FIX12 §4/§5] UNKNOWN / ROAD_RESERVE は濃い不透明道路面（primary/bridge）に分類されない', { skip: !fs.existsSync(R('data', 'processed', 'osaka-city', 'derived', 'road-render-class.json')) && 'no index' }, () => {
  const rc = rj(R('data', 'processed', 'osaka-city', 'derived', 'road-render-class.json'));
  for (const v of Object.values(rc.classMap)) {
    if (v.c === 'UNKNOWN' || v.c === 'ROAD_RESERVE' || v.c === 'MEDIAN' || v.c === 'SIDEWALK') {
      assert.equal(v.rs, 'faint', v.c + ' が faint でない: ' + v.rs);
    }
  }
});

test('[FIX12 §6/§7] audit: canonical road 面積 > visual road 面積（描画面が縮小）', { skip: !rpt('road-visual-surface-audit.json') && 'no audit' }, () => {
  const a = rpt('road-visual-surface-audit.json');
  assert.ok(a.visualRoadAreaM2 < a.canonicalRoadAreaM2, 'visual ' + a.visualRoadAreaM2 + ' >= canonical ' + a.canonicalRoadAreaM2);
  assert.ok(a.reductionRatio > 0, 'reduction ' + a.reductionRatio);
  assert.equal(a.sourceGeometryMutated, false);
  assert.equal(a.buildingGeometryMutated, false);
});

test('[FIX12 §8] Building ∩ VisualRoad < Building ∩ CanonicalRoad', { skip: !rpt('building-road-visual-overlap.json') && 'no overlap audit' }, () => {
  const o = rpt('building-road-visual-overlap.json');
  assert.ok(o.buildingOnVisualRoadAreaM2 < o.buildingOnCanonicalRoadAreaM2,
    'visual ' + o.buildingOnVisualRoadAreaM2 + ' >= canonical ' + o.buildingOnCanonicalRoadAreaM2);
  assert.ok(o.buildingsFreedFromVisualRoad > 0);
  assert.equal(o.buildingGeometryMutated, false);
  assert.equal(o.sourceGeometryMutated, false);
});

test('[FIX12 §13/§14] runtime: road-render-class.json を fetch し renderClass 別 style で描く', { skip: !html && 'no html' }, () => {
  assert.match(html, /fetch\(BASE \+ '\/road-render-class\.json'\)/);
  assert.match(html, /const roadRenderClass = new Map\(\);/);
  // [Mission 35H] 配色を profile で切り替えるため関数化した（style の作り方自体は同じ）。
  assert.match(html, /function buildRoadStyles\(\) \{/);
  assert.match(html, /CR_ROAD_RS = \{/);
  assert.match(html, /const buckets = \{ primary: \[\], bridge: \[\], secondary: \[\], pedestrian: \[\], sidewalk: \[\], median: \[\], faint: \[\] \};/);
  // 未収録 = primary 既定（fetch 失敗時も従来動作）
  assert.match(html, /let rs = roadRenderClass\.get\(f\.canonicalId\) \|\| 'primary';/);
});

test('[FIX12 §4/§11] primary は不透明・非primary は透明。全面 road 単一 mesh を廃止', { skip: !html && 'no html' }, () => {
  const s = html.indexOf("} else if (layer === 'roads') {");
  assert.ok(s >= 0);
  // [Mission 31G-FIX19B で発覚] 固定長 slice(s, s+N) は roads branch 冒頭にコードが追加されるたびに
  // 壊れる（html-test-endidx-literal-string-trap と同種の罠）。bucket 描画ループ自体を終端アンカーに
  // することで、冒頭にどれだけコードが増えても壊れないようにする。
  const loopIdx = html.indexOf("for (const rs of ['faint', 'median', 'sidewalk', 'pedestrian', 'secondary', 'primary', 'bridge'])", s);
  assert.ok(loopIdx > s, 'roads branch 内に bucket 描画ループが見つからない（構造が変わっていないか要確認）');
  const b = html.slice(s, loopIdx + 400);
  assert.match(b, /for \(const rs of \['faint', 'median', 'sidewalk', 'pedestrian', 'secondary', 'primary', 'bridge'\]\)/);
  assert.match(b, /transparent: st\.transparent, opacity: st\.opacity, depthWrite: !st\.transparent/);
  // 旧: 単一 meshFromPositions(pos, COL.road, REN.road, { side: THREE.DoubleSide }) が残っていない
  assert.doesNotMatch(b, /const m = meshFromPositions\(pos, COL\.road, REN\.road, \{ side: THREE\.DoubleSide \}\);/);
  assert.match(html, /primary:\s*\{ col: COL\.road, y: Y\.road,\s+opacity: 1\.0,\s+transparent: false/);
});

test('[FIX12 §10] road Y: primary は Y.road(0.30) 不変・bridge は Y.roadBridge・faint のみ地表へ寄せる', { skip: !html && 'no html' }, () => {
  assert.match(html, /const Y = \{ water: 0\.14, park: 0\.22, road: 0\.30, roadBridge: 3\.0/);
  assert.match(html, /primary:\s*\{ col: COL\.road, y: Y\.road,/);
  assert.match(html, /bridge:\s*\{ col: COL\.road, y: Y\.roadBridge,/);
  assert.match(html, /faint:\s*\{ col: [\s\S]{0,160}y: Y\.road - 0\.08/);
});

test('[FIX12 §0/§18] roads branch で source geometry（coordinates/geometryType）を書き換えない', { skip: !html && 'no html' }, () => {
  const s = html.indexOf("} else if (layer === 'roads') {");
  // roads branch の終端 = 次の layer branch 開始（parks）をアンカーにする。固定長 slice は使わない
  // （html-test-endidx-literal-string-trap と同種の罠を避ける・§FIX19B）。
  const e = html.indexOf("} else if (layer === 'parks') {", s);
  assert.ok(s >= 0 && e > s, 'roads branch の開始/終了アンカーが見つからない（構造が変わっていないか要確認）');
  const b = html.slice(s, e);
  assert.doesNotMatch(b, /\.coordinates\s*=|\.geometryType\s*=|f\.coordinates\.(push|splice|pop|shift)/);
});

test('[FIX12 §16] debug API に roadVisualSurface（classMapLoaded / nonPrimaryEntries）', { skip: !html && 'no html' }, () => {
  assert.match(html, /roadVisualSurface: \{[\s\S]{0,260}classMapLoaded: roadRenderClassLoaded/);
  assert.match(html, /nonPrimaryEntries: roadRenderClass\.size/);
});

test('[FIX12 §0] protected HTML に road visual surface コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /road-render-class|roadRenderClass|CR_ROAD_RS/, f + ' に混入');
  }
});

test('[FIX12] build-derived-public.js が road-render-class.json を配信対象に含む', () => {
  const t = fs.readFileSync(R('tools', 'build-derived-public.js'), 'utf-8');
  assert.match(t, /road-render-class\.json/);
});
