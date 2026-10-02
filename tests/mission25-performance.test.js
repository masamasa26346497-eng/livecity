// tests/mission25-performance.test.js
// [Mission25 大阪市全域描画のパフォーマンス最適化]
//   静的 mesh 最適化 / FPS 計測 / __PERFORMANCE_DEBUG__ 配線 / render loop hot path /
//   duplicate render 抑止・LOD 維持（回帰）/ Mission24 完成度回帰 / protected・production 無変更 / runtime。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { auditRenderLoopHotPath, auditStaticMeshUsage, validatePerfBaselineSchema } from '../tools/lib/performance-budget.js';

const require = createRequire(import.meta.url);
const HTML_PATH = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];

function run() {
  return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
}
async function flush(n = 24) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

// ── HTML 構文 ──
test('[Mission25] インライン <script> の JS 構文が壊れていない', () => {
  const f = path.join(os.tmpdir(), `m25-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

// ── 静的 mesh 最適化（§5/§13）──
test('[Mission25] markStaticMesh: 定義 + 静的レイヤーへ適用（matrixAutoUpdate=false）', () => {
  assert.ok(/function markStaticMesh\(obj\) \{/.test(html), 'markStaticMesh が未定義');
  assert.ok(/obj\.updateMatrix\(\); obj\.matrixAutoUpdate = false;/.test(html), 'updateMatrix + matrixAutoUpdate=false の順序が違う');
  const u = auditStaticMeshUsage(html);
  assert.ok(u.callCount >= 8, `markStaticMesh 適用が少ない (${u.callCount})`);
  for (const L of ['RiverLayerV2', 'CityBuildingLOD', 'CityTileLayer', 'LandSurfaceLayer', 'ParkLayer', 'WaterSurfaceLayer', 'BuildingTileLayer']) {
    assert.ok(u.layers.includes(L), `${L} に markStaticMesh 未適用`);
  }
});

// ── FPS / frameMs 計測（§1/§20）──
test('[Mission25] __PERF_FRAME__ / __perfFrameTick__ が render loop に配線', () => {
  assert.ok(/const __PERF_FRAME__ = \{ fps: 0, frameMs: 0/.test(html));
  assert.ok(/function __perfFrameTick__\(\) \{/.test(html));
  assert.ok(/\(function loop\(\)\{[\s\S]*?__perfFrameTick__\(\);/.test(html), 'loop 先頭で __perfFrameTick__ を呼んでいない');
  // 外れ値ガード（タブ復帰）
  assert.ok(/dt > 2000\) return;/.test(html), 'フレーム間隔の外れ値ガードが無い');
});

// ── performance debug API（§2/§14）──
test('[Mission25] window.__PERFORMANCE_DEBUG__ / __PERFORMANCE_BASELINE__ が公開されている', () => {
  assert.ok(/window\.__PERFORMANCE_DEBUG__ = function \(\)/.test(html));
  assert.ok(/window\.__PERFORMANCE_BASELINE__ = function \(\)/.test(html));
  const s = js.indexOf('function __perfSceneTraversal__');
  const e = js.indexOf('window.__LANDMARK_FOCUS__', s);
  const fn = js.slice(s, e > s ? e : undefined);
  for (const k of ['mode', 'fps', 'frameMs', 'drawCalls', 'triangles', 'geometries', 'textures', 'programs',
    'scene', 'layers', 'memory', 'staticMatrixMeshes', 'visibleMeshes', 'approxVisibleTriangles', 'byType']) {
    assert.ok(fn.includes(k), `__PERFORMANCE_DEBUG__ ブロックに ${k} が無い`);
  }
});

// ── render loop hot path（§16）──
test('[Mission25] render loop hot path に console/JSON.parse/geometry生成/querySelector が無い', () => {
  const a = auditRenderLoopHotPath(html);
  assert.equal(a.ok, true, 'hot path: ' + a.hits.join(', '));
});

// ── LOD / duplicate build 抑止（§3/§4/§6/§17 回帰）──
test('[Mission25] CityTileLayer LOD dirty-flag / CityBuildingLOD handoff 距離が不変', () => {
  assert.ok(/let lastCityLodKey = null;/.test(html), 'lastCityLodKey が消えた');
  assert.ok(/if \(!force && key === lastCityLodKey\) return;/.test(html), 'applyCityLOD の dirty-flag ガードが消えた');
  assert.ok(/const HIDE_NEAR_M = 4000;/.test(html), 'HIDE_NEAR_M=4000 が変わった（duplicate building draw 抑止）');
  // 道路 LOD band（Mission02）維持
  assert.ok(/const ROAD_LOD_FAR_M = 9000, ROAD_LOD_MID_M = 3500;/.test(html), 'Road LOD 閾値が変わった');
  // rail railClass 優先（Mission24）維持
  assert.ok(/buckets\[f\.railClass \|\| classifyRail\(f\.railway, railLineLength\(f\.p\)\)\]\.push\(f\);/.test(html), 'rail railClass 優先が消えた');
});

test('[Mission25] BuildingTileLayer / WardMode の throttle 呼び出しが維持されている', () => {
  assert.ok(/BuildingTileLayer\.updateByCamera\(camera\); \/\/ \[building-tile-engine-v1\]/.test(html));
  assert.ok(/WardModeManager\.update\(\); \/\/ \[WARD-MODE\] 内部200ms throttle済み/.test(html));
});

// ── 既存レイヤー / debug API 回帰 ──
test('[Mission25] 既存レイヤー・debug API が消えていない', () => {
  for (const kw of ['const LandSurfaceLayer = (function', 'const RiverLayerV2 = (function', 'const CityBuildingLOD',
    'const CityTileLayer = (function', 'const BuildingTileLayer = (function',
    '__RAIL_LOD_DEBUG__', '__ROAD_NETWORK_DEBUG__', '__PARK_LOD_DEBUG__', '__MAP_COMPLETENESS_DEBUG__',
    '__BUILDING_COVERAGE_DEBUG__', '__VISIBLE_BUILDING_GAP_DEBUG__', '__CITY_MODE_DEBUG__']) {
    assert.ok(html.includes(kw), `${kw} が消えた`);
  }
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html), 'projection 式が変わった');
});

// ── protected / production 無変更（§0）──
test('[Mission25] protected HTML に Mission25 の変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/markStaticMesh|__PERF_FRAME__|__PERFORMANCE_DEBUG__|__perfFrameTick__/.test(h), `${rel} に Mission25 混入`);
  }
});

// ── Mission24 完成度の回帰（§23）──
test('[Mission25] map-completeness-audit.json が overallScore 100 / CRITICAL 0 / HIGH 0 を維持', () => {
  const p = path.join(PROJECT_ROOT, 'data', 'reports', 'map-completeness-audit.json');
  if (!fs.existsSync(p)) { assert.ok(true, 'audit report 未生成（skip）'); return; }
  const a = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.equal(a.overallScore, 100);
  assert.equal(a.criticalCount, 0);
  assert.equal(a.highCount, 0);
  assert.equal(a.verdict, '大阪市基礎地図 β1 完成候補');
});

// ── runtime ──
test('[Mission25] runtime: __PERFORMANCE_DEBUG__ / __PERFORMANCE_BASELINE__ が形を返す', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  await flush();
  const d = r.window.__PERFORMANCE_DEBUG__();
  assert.ok(d && typeof d === 'object', '__PERFORMANCE_DEBUG__ が null');
  assert.ok(d.mode === 'city' || d.mode === 'ward');
  assert.ok(d.scene && typeof d.scene === 'object', 'scene traversal オブジェクトが無い');
  assert.ok('staticMatrixMeshes' in d.scene && 'visibleMeshes' in d.scene);
  assert.ok(d.layers && 'buildings' in d.layers && 'roads' in d.layers && 'rivers' in d.layers);
  const b = r.window.__PERFORMANCE_BASELINE__();
  const schema = validatePerfBaselineSchema(b);
  assert.equal(schema.ok, true, 'baseline schema: missing=' + schema.missing.join(',') + ' bad=' + schema.badType.join(','));
});

test('[Mission25] runtime: 例外なく評価され既存 debug API も生きている', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  await flush();
  assert.ok(typeof r.window.__RAIL_LOD_DEBUG__ === 'function');
  assert.ok(typeof r.window.__MAP_COMPLETENESS_DEBUG__ === 'function');
  const rail = r.window.__RAIL_LOD_DEBUG__();
  assert.ok(rail && 'band' in rail, 'rail LOD debug が壊れた');
});
