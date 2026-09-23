// tests/gsi-road-hybrid-runtime-cutover.test.js
// [Mission 31G-FIX19B] Hybrid Runtime Visual Cutover。
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
const hasRealHybridData = fs.existsSync(R('public', 'map-data', 'osaka-city', 'gsi-road-hybrid-v1', 'hybrid-surfaces-sample.json'));

test('[FIX19B §23] gsi-road-hybrid-runtime-cutover validator が PASS', { skip: !rpt('gsi-road-hybrid-runtime-cutover-validation.json') && 'no report' }, () => {
  const v = rpt('gsi-road-hybrid-runtime-cutover-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['roadRenderModeExists', 'hybridReplacesFix13InsideSample', 'fix13OutsideSample',
    'diffDebugUsesDistinctColors', 'hybridZeroSurfaceErrorVisible', 'sampleOutsideStatusVisible']) {
    assert.equal(v.checks[k], true, k + ' が true でない');
  }
  assert.equal(v.checks.unexpectedFix13ResidualInsideHybrid, 0);
  assert.equal(v.checks.geometryMutation, 0);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[FIX19B §2] ROAD_RENDER_MODE は FIX13/HYBRID_V1/DIFF_DEBUG の3値のみ（曖昧な複数booleanでない）', { skip: !html && 'no html' }, () => {
  assert.match(html, /let roadRenderMode = 'FIX13';/);
  assert.match(html, /mode !== 'FIX13' && mode !== 'HYBRID_V1' && mode !== 'DIFF_DEBUG'/);
});

test('[FIX19B §3] sample 内で HYBRID_V1/DIFF_DEBUG は FIX13 を二重描画しない（GSI被覆時は continue で suppress）', { skip: !html && 'no html' }, () => {
  const roadsStart = html.indexOf("} else if (layer === 'roads') {");
  const parksStart = html.indexOf("} else if (layer === 'parks') {", roadsStart);
  assert.ok(roadsStart >= 0 && parksStart > roadsStart, 'roads branch が見つからない');
  const b = html.slice(roadsStart, parksStart);
  assert.match(b, /if \(covered\) \{ hybridSuppressedCount\+\+; continue; \}/);
});

test('[FIX19B §7] HYBRID_V1 は sample 内の GSI 非被覆部分を通常の FIX13 style のまま描画する（Hybrid dataset内のFIX13_FALLBACK）', { skip: !html && 'no html' }, () => {
  const roadsStart = html.indexOf("} else if (layer === 'roads') {");
  const parksStart = html.indexOf("} else if (layer === 'parks') {", roadsStart);
  const b = html.slice(roadsStart, parksStart);
  assert.match(b, /HYBRID_V1: Hybrid dataset内のFIX13_FALLBACK＝通常のFIX13 styleのまま描画する/);
});

test('[FIX19B §8/§9] Hybrid mesh は Y.road 基準・renderOrder は REN.road より高い（下へ潜らない）', { skip: !html && 'no html' }, () => {
  assert.match(html, /m\.renderOrder = REN\.road \+ 5;/);
  assert.match(html, /const dy = Y\.road \+ 0\.02;/);   // DIFF_DEBUG のみの極小 offset（geometry 補正ではない）
});

test('[FIX19B §10/§11] mode 切替時、sample bbox に重なる roads tile のみキャッシュ破棄→即 refresh', { skip: !html && 'no html' }, () => {
  const s = html.indexOf('function invalidateHybridAffectedRoadTiles()');
  assert.ok(s >= 0);
  const b = html.slice(s, s + 800);
  assert.match(b, /disposeEntry\(e\); tileCache\.delete\(k\);/);
  const setModeIdx = html.indexOf('async function setRoadRenderMode(mode)');
  const setModeBody = html.slice(setModeIdx, setModeIdx + 900);
  assert.match(setModeBody, /invalidateHybridAffectedRoadTiles\(\);/);
  assert.match(setModeBody, /refresh\(\);/);
});

test('[FIX19C §15-18] FIX13/HYBRID/DIFFボタン・sample selector・[Bounds]トグルが Canonical status panel 内に統合されている', { skip: !html && 'no html' }, () => {
  // [Mission 31G-FIX19C] FIX19B の独立固定位置ボタンは WARD-DIAG 等の高z-index overlayに隠れたため、
  // 必ず最前面の canonical-runtime-status panel 内へ統合した。
  const panelStart = html.indexOf("function ensureStatusUI_()");
  const panelEnd = html.indexOf('function renderStatus()', panelStart);
  assert.ok(panelStart >= 0 && panelEnd > panelStart, 'ensureStatusUI_ が見つからない');
  const panel = html.slice(panelStart, panelEnd);
  assert.match(panel, /roadModeBtns\[mode\] = b;/);
  assert.match(panel, /setRoadRenderMode\(mode\)/);
  assert.match(panel, /hybrid-sample-select/);
  assert.match(panel, /flyTo\(a\.x, a\.z, \{ r: 700 \}\)/);   // 新しい camera system は作らず既存 flyTo() を使う
  assert.match(panel, /id = 'hybrid-sample-bounds-toggle';/);
  assert.match(panel, /statusEl\.appendChild\(roadBox\);/);
  assert.match(html, /window\.toggleHybridSampleBounds = function/);
  // §16: 選択中ボタンの強調ロジックが renderStatus_ 側にある
  assert.match(html, /if \(roadModeBtns\) \{/);
});

test('[FIX19B §25] protected HTML は無変更（開発 HTML のみ変更）（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /roadRenderMode|setRoadRenderMode|HYBRID_SAMPLE_AREAS|hybridCoveredAt/, f + ' に混入');
  }
});

// ── 動的テスト: smoke harness の実 fetch（fetchRoot=public）で本物の Hybrid データを読み込ませ、
//   「UIトグル→state→manifest load→geometry fetch→parse」までが実際につながっているかを確認する。
//   （§21: スクリーンショットは無いが、実データでのロード成功は「捏造ではない」実証）
test('[FIX19B §1/§15] 動的: 実データで Hybrid dataset が load され surfaceCount > 0 になる', { skip: !hasRealHybridData && 'hybrid-surfaces-sample.json が無い（先に data:gsi-road-edge:hybrid-v1 → public へコピー）' }, async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  assert.equal(typeof w.__SET_ROAD_RENDER_MODE__, 'function', '__SET_ROAD_RENDER_MODE__ が無い');
  const mode = await w.__SET_ROAD_RENDER_MODE__('HYBRID_V1');
  assert.equal(mode, 'HYBRID_V1');
  const d = w.__ROAD_RENDER_MODE_DEBUG__();
  assert.equal(d.mode, 'HYBRID_V1');
  assert.equal(d.hybridStatus, 'ready', 'hybridStatus が ready でない: ' + d.hybridStatus + '（0 surfaces 相当のバグを検知）');
  assert.ok(d.surfaceCount > 5000, 'surfaceCount が異常に少ない: ' + d.surfaceCount);
  assert.ok(d.bySource.GSI_CORRIDOR_HIGH > 4000, 'GSI_CORRIDOR_HIGH が異常に少ない: ' + d.bySource.GSI_CORRIDOR_HIGH);
  assert.ok(d.bySource.GSI_CORRIDOR_MEDIUM > 500, 'GSI_CORRIDOR_MEDIUM が異常に少ない: ' + d.bySource.GSI_CORRIDOR_MEDIUM);
  assert.ok(Array.isArray(d.sampleAreas) && d.sampleAreas.length === 10, 'sample エリアが10件でない: ' + (d.sampleAreas && d.sampleAreas.length));
  for (const name of ['梅田', '中之島', '本町', '難波', '天王寺', '阿倍野', '十三', '住吉', '京橋', '平野']) {
    assert.ok(d.sampleAreas.includes(name), name + ' が sample エリアに無い');
  }
  // DIFF_DEBUG / FIX13 へ切替えても例外を投げない（invalidateHybridAffectedRoadTiles が tileCache 空でも安全）
  await w.__SET_ROAD_RENDER_MODE__('DIFF_DEBUG');
  assert.equal(w.__ROAD_RENDER_MODE_DEBUG__().mode, 'DIFF_DEBUG');
  await w.__SET_ROAD_RENDER_MODE__('FIX13');
  assert.equal(w.__ROAD_RENDER_MODE_DEBUG__().mode, 'FIX13');
});

test('[FIX19B §12] 動的: getHybridSampleAt がサンプル中心座標を正しく判定する（geoToThree と同一投影・znorth-neg-v1）', () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  assert.equal(typeof w.__HYBRID_SAMPLE_AREAS__, 'function');
  assert.equal(typeof w.__HYBRID_SAMPLE_AT__, 'function');
  const areas = w.__HYBRID_SAMPLE_AREAS__();
  assert.equal(areas.length, 10);
  const umeda = areas.find((a) => a.name === '梅田');
  assert.ok(umeda, '梅田 sample area が見つからない');
  // sample 中心座標そのものは必ずその sample と判定される
  assert.equal(w.__HYBRID_SAMPLE_AT__(umeda.x, umeda.z), '梅田');
  // 遠く離れた座標（大阪湾はるか沖合相当）はどの sample にも属さない
  assert.equal(w.__HYBRID_SAMPLE_AT__(50000, 50000), null);
});
