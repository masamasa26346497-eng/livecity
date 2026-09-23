// tests/semantic-map-display.test.js
// [Mission 32K] SEMANTICALLY CORRECT MAP DISPLAY。
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

test('[32K §16] validator が PASS（建物・projection 不変／通常表示構成が正しい）', { skip: !rpt('semantic-map-display-validation.json') && 'no report' }, () => {
  const v = rpt('semantic-map-display-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.buildingMutation, 0);
  assert.equal(v.checks.projectionMutation, 0);
  assert.equal(v.checks.canonicalBuildings, 615617);
  assert.equal(v.checks.normalViewRawGsiEdge, false);
  assert.equal(v.checks.normalViewRoadMode, 'ROAD_V3');
  assert.equal(v.checks.gsiEdgeStillAvailableForQa, true);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[32K §1/§13] 通常表示の既定: raw GSI Road Edge OFF / ROAD V3', () => {
  assert.match(html, /let gsiEdgeEnabled = false;/);
  assert.match(html, /let roadVisualMode = 'ROAD_V3';/);
});

test('[32K §2] QA/解析モードは緑線を使え、抜けたら既定へ戻す', () => {
  assert.match(html, /function requestGsiEdgeForQa\(on\)/);
  assert.match(html, /savedGsiEdgeEnabledBeforeQa/);
  // Reference Alignment が ON にし、終了時に戻す
  assert.match(html, /requestGsiEdgeForQa\(true\);\s*\n\s*await Promise\.all\(\[refreshReferenceOverlays/);
  assert.match(html, /requestGsiEdgeForQa\(false\); \/\/ \[Mission 32K §2\]/);
});

test('[32K §8] [GSI EDGE QA] トグルがあり "GSI Road Area Edge — QA Reference" を明示する', () => {
  assert.match(html, /id = 'gsi-edge-qa-toggle';/);
  assert.match(html, /title = 'GSI Road Area Edge — QA Reference';/);
  assert.match(html, /GSI Road Area Edge \(QA Reference\)/);
});

test('[32K §15] OLD / SEMANTIC 比較モードがある', () => {
  assert.match(html, /async function setDisplayPreset\(preset\)/);
  assert.match(html, /\['OLD', 'OLD DISPLAY'\], \['SEMANTIC', 'SEMANTIC DISPLAY'\]/);
  assert.match(html, /window\.__SET_DISPLAY_PRESET__/);
  assert.match(html, /window\.__SEMANTIC_DISPLAY_DEBUG__/);
});

test('[32K §0/§9] 建物を動かす処理を入れていない（source 座標をそのまま押し出す）', () => {
  // [Mission 35H] 頂点カラー用の bucket へ渡す形に変わったが、座標は f.coordinates のまま。
  assert.match(html, /pushExtrude\(bucket\.pos, f\.geometryType, f\.coordinates, h, bucket\.col\)/);
  // 32K で building 側に offset/scale/clip を足していないこと
  const bStart = html.indexOf("} else if (layer === 'buildings') {");
  const bEnd = html.indexOf("} else if (layer === 'rail') {");
  assert.ok(bStart > 0 && bEnd > bStart, 'buildings 分岐が特定できない');
  const section = html.slice(bStart, bEnd);
  assert.doesNotMatch(section, /offset|\.multiplyScalar\(|shrink|warp/i);
});

test('[32K §4] ROAD_V3 既定で V2 タイルを無駄に fetch しない', () => {
  assert.match(html, /roadVisualMode === 'ROAD_V2' \|\| roadVisualMode === 'LAND_BLOCK' \|\| roadVisualMode === 'DIFF' \|\| roadVisualMode === 'DIFF_V2_V3'/);
});

test('[32K §14/§18] 受け入れレポートの5サイトすべてで FIX13 比が改善している', { skip: !rpt('semantic-map-display.json') && 'no report' }, () => {
  const r = rpt('semantic-map-display.json');
  for (const id of ['umeda', 'honmachi', 'namba', 'tennoji', 'sumiyoshi']) {
    const s = r.sites[id];
    assert.ok(s, 'site ' + id + ' が無い');
    assert.ok(s.buildingDarkOverlapV3M2 < s.buildingDarkOverlapFix13M2,
      id + ' が FIX13 より改善していない');
    assert.equal(s.buildingGeometryChanged, false);
    assert.equal(s.rawGsiEdgeMeshesInNormalView, 0, id + ' の通常表示に緑線が出ている');
  }
  assert.equal(r.stopToken, 'SEMANTIC_MAP_DISPLAY_READY_FOR_VISUAL_QA');
  // FPS/メモリは測れないことを明示している（捏造していない）
  assert.equal(r.performance.notMeasured.fps, null);
  assert.ok(r.performance.notMeasured.reason.length > 0);
});

test('[32K 動的] 起動直後の通常表示が SEMANTIC 構成で、緑線が 1 本も読み込まれていない', () => {
  if (!fs.existsSync(HTML)) return;
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const d = r.window.__SEMANTIC_DISPLAY_DEBUG__();
  assert.equal(d.normalViewRoadMode, 'ROAD_V3');
  assert.equal(d.normalViewRawGsiEdge, false);
  assert.equal(d.preset, 'SEMANTIC');
  assert.equal(d.rawGsiEdgeMeshCount, 0, '通常表示で raw GSI Road Edge が読み込まれている');
  // §6 Normal City View の構成
  assert.equal(d.layers.buildings, true);
  assert.equal(d.layers.rail, true);
  assert.equal(d.layers.water, true);
  assert.equal(d.layers.parks, true);
  assert.equal(r.window.__CANONICAL_SELF_CHECK__().total, 0);
});

test('[32K 動的] OLD ⇄ SEMANTIC を往復しても residual が 0 を維持する', async () => {
  if (!fs.existsSync(HTML)) return;
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const old = await w.__SET_DISPLAY_PRESET__('OLD');
  assert.equal(old.preset, 'OLD');
  assert.equal(old.roadMode, 'FIX13');
  assert.equal(old.gsiEdgeEnabled, true);
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0, 'OLD で residual が 0 でない');
  const sem = await w.__SET_DISPLAY_PRESET__('SEMANTIC');
  assert.equal(sem.preset, 'SEMANTIC');
  assert.equal(sem.roadMode, 'ROAD_V3');
  assert.equal(sem.gsiEdgeEnabled, false);
  assert.equal(w.__SEMANTIC_DISPLAY_DEBUG__().preset, 'SEMANTIC');
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0, 'SEMANTIC 復帰後に residual が 0 でない');
});

test('[32K 動的] QA トグルで緑線を出して戻せる（§8: QA では残す）', async () => {
  if (!fs.existsSync(HTML)) return;
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  assert.equal(w.__SEMANTIC_DISPLAY_DEBUG__().normalViewRawGsiEdge, false);
  w.__SET_GSI_ROAD_EDGE_ENABLED__(true);
  await new Promise((res) => setTimeout(res, 1500));
  const on = w.__SEMANTIC_DISPLAY_DEBUG__();
  assert.equal(on.normalViewRawGsiEdge, true);
  assert.ok(on.rawGsiEdgeMeshCount > 0, 'QA ON にしても緑線が読み込まれない');
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
  w.__SET_GSI_ROAD_EDGE_ENABLED__(false);
  assert.equal(w.__SEMANTIC_DISPLAY_DEBUG__().normalViewRawGsiEdge, false);
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
});

test('[32K §17] protected HTML が変更されていない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /roadVisualMode = 'ROAD_V3'|gsi-edge-qa-toggle|setDisplayPreset|requestGsiEdgeForQa/, f + ' に混入');
  }
});
