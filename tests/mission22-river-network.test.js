// tests/mission22-river-network.test.js
// [Mission22 全水系カバレッジ] HTML 配線 / 配信データ / 3階級 / 連続性 / 地下水路除外 / 回帰保護。
//   成功条件: 「主要河川だけ」から「市内の河川・運河・水路網が自然に見える」へ。
//   ただし RiverLayerV2 の安全性（主要7河川 geometry 固定・旧 water polygon 非復活）は不変。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { validateRiverRibbon } from '../tools/lib/river-ribbon-validator.js';
import { MAJOR_RIVERS, normalizeRiverName } from '../tools/lib/river-network.js';

const require = createRequire(import.meta.url);
const HTML_PATH = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
const riverIife = js.slice(js.indexOf('const RiverLayerV2 = (function'), js.indexOf('RiverLayerV2.init();'));

const DATA = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json');
const COVERAGE = path.join(PROJECT_ROOT, 'data', 'reports', 'river-network-coverage.json');
const hasData = fs.existsSync(DATA);
const doc = hasData ? JSON.parse(fs.readFileSync(DATA, 'utf-8')) : null;

function run() {
  return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
}
async function flush(n = 14) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

// 主要7河川の回帰スナップショット（Mission04 の生成結果。3階級化で変わってはならない）。
//
// [Mission 35F] 神崎川だけ更新した（5 seg / 258 tri / 6,692m → 20 / 814 / 18,324m）。
//   神崎川は市域北端の境界河川で、旧 osaka-latest.osm.pbf が緯度 34.73 で切れていたため
//   下流の 6.7km 分しか入っていなかった。広域 PBF へ入れ替えて本来の長さになった。
//   他の 6 河川は 1 つも動いていない（= 切断と無関係な河川は不変）＝ ribbon 生成の
//   ロジックが変わったのではなく、入力が増えただけであることの裏付け。
const MAJOR_SNAPSHOT = {
  '淀川': { seg: 4, tri: 604, clen: 16042 },
  '大和川': { seg: 6, tri: 528, clen: 13218 },
  '神崎川': { seg: 20, tri: 814, clen: 18324 },
  '安治川': { seg: 2, tri: 244, clen: 6702 },
  '木津川': { seg: 3, tri: 336, clen: 6963 },
  '寝屋川': { seg: 8, tri: 386, clen: 6915 },
  '道頓堀川': { seg: 3, tri: 120, clen: 2805 },
};

// ── HTML: 構文・配線 ──
test('[Mission22] インライン <script> の JS 構文が壊れていない', () => {
  const f = path.join(os.tmpdir(), `m22-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission22/28] RiverLayerV2 は 4 階級 mesh（major/medium/minor/micro）＋ shore', () => {
  assert.ok(/let majorMesh = null, mediumMesh = null, minorMesh = null, microMesh = null, shoreMesh = null;/.test(riverIife), 'microMesh 宣言が無い');
  assert.ok(/const majorPos = \[\], mediumPos = \[\], minorPos = \[\], microPos = \[\], shorePos = \[\];/.test(riverIife), 'microPos バケットが無い');
  assert.ok(/tier === 'major' \? majorPos : tier === 'medium' \? mediumPos : tier === 'micro' \? microPos : minorPos/.test(riverIife), 'tier で 4 分岐していない');
  assert.ok(/mediumMesh = new THREE\.Mesh\(geom, makeMaterial\(STYLE\.mediumOpacity\)\)/.test(riverIife), 'medium mesh 生成が無い');
  assert.ok(/microMesh = new THREE\.Mesh\(geom, makeMaterial\(STYLE\.microOpacity\)\)/.test(riverIife), 'micro mesh 生成が無い');
});

test('[Mission22/28] LOD: ULTRA_NEAR=+micro / NEAR=+minor / MID=major+medium / FAR=major のみ', () => {
  assert.ok(/const MEDIUM_HIDE_DISTANCE_M = 9000/.test(riverIife), 'medium LOD 距離が変わった');
  assert.ok(/const MINOR_HIDE_DISTANCE_M = 4500;/.test(riverIife), 'minor LOD 距離が変わった');
  assert.ok(/const MICRO_HIDE_DISTANCE_M = 1500;/.test(riverIife), 'micro LOD 距離（1500）が無い');
  assert.ok(/if \(mediumMesh\) mediumMesh\.visible = visible && distance <= MEDIUM_HIDE_DISTANCE_M/.test(riverIife), 'medium の距離非表示が無い');
  assert.ok(/if \(minorMesh\) minorMesh\.visible = visible && distance <= MINOR_HIDE_DISTANCE_M/.test(riverIife), 'minor の距離非表示が消えた');
  assert.ok(/if \(microMesh\) microMesh\.visible = visible && distance <= MICRO_HIDE_DISTANCE_M/.test(riverIife), 'micro の距離非表示が無い');
});

test('[Mission22/28] shore は major/medium のみ（minor/micro に岸線を足さない・§11）', () => {
  assert.ok(/if \(tier === 'major' \|\| tier === 'medium'\) \{ appendShorelineSegments\(shorePos, r\.left\); appendShorelineSegments\(shorePos, r\.right\); \}/.test(riverIife),
    'minor/micro を除外した岸線生成になっていない');
});

test('[Mission22] __RIVER_NETWORK_DEBUG__ が形を返す / 個別河川名も受ける', () => {
  assert.ok(/window\.__RIVER_NETWORK_DEBUG__ = \(name\) => RiverLayerV2\.getNetworkDebug\(name\);/.test(html), '__RIVER_NETWORK_DEBUG__ の公開が無い');
  const fn = riverIife.slice(riverIife.indexOf('function getNetworkDebug'));
  for (const k of ['total', 'major', 'medium', 'minor', 'visible', 'segments', 'triangles', 'drawCalls', 'loadedTiles', 'namedRivers', 'unnamedRivers', 'gapCount', 'buildingConflicts', 'undergroundSkipped']) {
    assert.ok(fn.includes(k), `getNetworkDebug に ${k} が無い`);
  }
});

test('[Mission22] 旧 water polygon / coastline を復活させていない', () => {
  assert.ok(/let WATER_LAYER_ENABLED = false;/.test(html), 'WATER_LAYER_ENABLED が false でない');
  assert.ok(!/buildWaterMeshes|ShapeUtils\.triangulateShape|assembleMultipolygon/.test(riverIife), 'RiverLayerV2 に旧 water ロジックが混入');
  assert.ok(!/coastline/i.test(riverIife), 'coastline を河川代わりに使っている');
});

test('[Mission22] 主要7河川は MAJOR_RIVER_NAMES として維持（名称ハードコードは registry 由来）', () => {
  assert.ok(/const MAJOR_RIVER_NAMES = new Set\(\['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川'\]\);/.test(html));
});

// ── 配信データ ──
test('[Mission22] rivers.json: znorth-neg-v1 / 3階級 / 全 ribbon ok / ERROR 0', { skip: !hasData && 'no data' }, () => {
  assert.equal(doc.coordinateConvention, 'znorth-neg-v1');
  assert.ok(doc.version >= 2, 'version が上がっていない');
  for (const r of doc.rivers) assert.ok(['major', 'medium', 'minor', 'micro'].includes(r.riverClass), `${r.name || r.id}: riverClass=${r.riverClass}`);
  assert.deepEqual(doc.rivers.filter((r) => r.ok === false).map((r) => r.id), [], 'ribbon 生成失敗がある');
  assert.deepEqual(doc.rivers.filter((r) => (r.validationErrors || []).length).map((r) => r.id), [], 'validator ERROR が残っている');
  assert.ok(doc.mediumCount >= 20, `medium が少なすぎる: ${doc.mediumCount}`);
  assert.ok(doc.microCount >= 10, `[Mission28] micro が少なすぎる: ${doc.microCount}`);
});

test('[Mission22] 地下水路（暗渠）は rivers.json に混入しない（§14）', { skip: !hasData && 'no data' }, () => {
  for (const r of doc.rivers) assert.notEqual(r.surface, false, `${r.name || r.id}: surface:false が混入`);
  assert.ok(doc.undergroundSkipped > 0, '地下水路の除外件数が記録されていない');
});

test('[Mission22] 主要7河川 geometry 回帰（seg数 / 三角形数 / centerline長）', { skip: !hasData && 'no data' }, () => {
  for (const [nm, snap] of Object.entries(MAJOR_SNAPSHOT)) {
    const segs = doc.rivers.filter((r) => r.name === nm);
    assert.equal(segs.length, snap.seg, `${nm}: seg数 ${segs.length} != ${snap.seg}`);
    for (const s of segs) { assert.equal(s.riverClass, 'major'); assert.equal(s.ok, true); assert.equal(!!s.suppressed, false); }
    const tri = segs.reduce((s, r) => s + (r.triangleCount || 0), 0);
    const clen = Math.round(segs.reduce((s, r) => s + (r.centerlineLength || 0), 0));
    assert.equal(tri, snap.tri, `${nm}: 三角形数 ${tri} != ${snap.tri}（geometry 回帰）`);
    assert.ok(Math.abs(clen - snap.clen) <= 2, `${nm}: centerline長 ${clen} != ${snap.clen}`);
  }
});

test('[Mission22] ユーザー指摘の河川が表示される（大川/堂島川/土佐堀川/城北川/平野川/第二寝屋川/正蓮寺川/東横堀川）', { skip: !hasData && 'no data' }, () => {
  const wanted = ['大川', '堂島川', '土佐堀川', '城北川', '平野川', '第二寝屋川', '正蓮寺川', '東横堀川', '平野川分水路', '六軒家川', '尻無川'];
  for (const nm of wanted) {
    const segs = doc.rivers.filter((r) => r.normName === nm && r.ok && !r.suppressed);
    assert.ok(segs.length > 0, `${nm} が 1 本も表示されない`);
    const cont = doc.continuity[nm];
    assert.ok(cont, `${nm} の連続性データが無い`);
  }
});

test('[Mission22] named river の未説明 gap（B: OSM 欠落）= 0（勝手に補間しない・全 gap に原因）', { skip: !hasData && 'no data' }, () => {
  const bad = [];
  for (const [nm, c] of Object.entries(doc.continuity || {})) {
    for (const g of (c.gaps || [])) if (/^B:|^E:/.test(g.cause)) bad.push(`${nm}: ${g.cause}`);
  }
  assert.deepEqual(bad, [], '未分類 gap が残っている');
});

test('[Mission22] giant triangle 0 / width 有限（非 major）', { skip: !hasData && 'no data' }, () => {
  for (const r of doc.rivers) {
    if (!r.ok || r.riverClass === 'major') continue;
    assert.ok((r.maxTriangleEdge || 0) <= 700, `${r.name || r.id}: maxTriangleEdge=${r.maxTriangleEdge}`);
    for (const w of [r.widthMin, r.widthMedian, r.widthMax]) {
      if (w != null) assert.ok(Number.isFinite(w) && w > 0 && w < 200, `${r.name || r.id}: width=${w}`);
    }
  }
});

test('[Mission22] coverage report（§18）が主要項目を持つ', { skip: !fs.existsSync(COVERAGE) && 'no coverage' }, () => {
  const c = JSON.parse(fs.readFileSync(COVERAGE, 'utf-8'));
  for (const k of ['totalWaterwayLineFeatures', 'surfaceLineFeatures', 'undergroundLineFeatures', 'byWaterwayTag', 'tiers', 'displayed', 'skipped', 'skipReasons', 'qaRivers', 'namedRivers', 'unexplainedGapRivers']) {
    assert.ok(k in c, `coverage report に ${k} が無い`);
  }
  assert.deepEqual(c.unexplainedGapRivers, [], 'unexplained gap river がある');
  assert.ok(c.qaRivers.filter((q) => q.resolved).length >= 14, 'QA 河川の解決数が少なすぎる');
});

// ── 回帰保護 ──
test('[Mission22/28] minor/micro のみ suppress される（major/medium は suppress しない）', { skip: !hasData && 'no data' }, () => {
  const suppressed = doc.rivers.filter((r) => r.suppressed);
  for (const r of suppressed) assert.ok(r.riverClass === 'minor' || r.riverClass === 'micro', `${r.name || r.id}(${r.riverClass}) が suppress されている`);
});

test('[Mission22] Mission06 WaterSurfaceLayer / Mission21 LandSurfaceLayer は不変', () => {
  assert.ok(/const WaterSurfaceLayer = \(function/.test(html) && /water-surface\.json/.test(html), 'WaterSurfaceLayer が消えた');
  assert.ok(/const LandSurfaceLayer = \(function/.test(html) && /land-surface\.json/.test(html), 'LandSurfaceLayer が消えた');
  assert.ok(/RiverLayerV2 とは完全に独立/.test(html), 'WaterSurfaceLayer と RiverLayerV2 の分離コメントが消えた');
});

test('[Mission22] projection / MAP_LAYER_Y.WATER / 旧河川無効化は不変', () => {
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html), 'projection 式が変わった');
  assert.ok(/const Y = MAP_LAYER_Y\.WATER;/.test(riverIife), 'RiverLayerV2 の Y が変わった（geometry 変更の疑い）');
});

test('[Mission22] protected HTML に Mission22 の変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/__RIVER_NETWORK_DEBUG__|mediumMesh|MEDIUM_HIDE_DISTANCE_M|microMesh|MICRO_HIDE_DISTANCE_M/.test(h), `${rel} に Mission22/28 混入`);
  }
});

// ── runtime ──
test('[Mission22] runtime: 例外なく評価 / __RIVER_NETWORK_DEBUG__ が集計を返す', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  await flush();
  const d = r.window.__RIVER_NETWORK_DEBUG__();
  assert.ok(d.major === 31 || d.major >= 25, `major=${d.major}`);
  assert.ok(d.medium >= 20, `medium=${d.medium}`);
  assert.ok(d.visible >= 120, `visible=${d.visible}`);
  assert.equal(d.unexplainedGapRivers.length, 0, 'runtime で未説明 gap');
  assert.ok(d.drawCalls >= 1 && d.drawCalls <= 5, `drawCalls=${d.drawCalls}`); // [Mission28] micro mesh 追加で最大5（major/medium/minor/micro/shore）
  assert.ok(d.undergroundSkipped > 0, 'underground 除外数が出ていない');
  const oo = r.window.__RIVER_NETWORK_DEBUG__('大川');
  assert.equal(oo.resolved, true);
  assert.equal(oo.class, 'medium');
});
