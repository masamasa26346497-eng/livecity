#!/usr/bin/env node
// tools/validate/performance-budget.js
// [Mission25 §26] パフォーマンス最適化の静的 validator。
//
// PASS 条件:
//   - markStaticMesh 定義あり + 主要レイヤー（RiverLayerV2 / CityBuildingLOD / CityTileLayer /
//     LandSurfaceLayer / ParkLayer / WaterSurfaceLayer）へ適用済み
//   - __PERF_FRAME__ / __perfFrameTick__() が render loop に配線
//   - window.__PERFORMANCE_DEBUG__ / window.__PERFORMANCE_BASELINE__ 公開
//   - render loop hot path に console / JSON.parse / geometry生成 / querySelector なし
//   - CityTileLayer の LOD dirty-flag（lastCityLodKey）維持
//   - duplicate build draw 抑止: CityBuildingLOD.HIDE_NEAR_M = 4000 維持
//   - 既存 debug API（__RAIL_LOD_DEBUG__ / __ROAD_NETWORK_DEBUG__ / __MAP_COMPLETENESS_DEBUG__ 等）維持
//   - Mission24 完成度が PASS（overallScore 100 / CRITICAL 0 / HIGH 0）
//   - production / protected HTML に Mission25 変更が混入していない
//
// 実行: node tools/validate/performance-budget.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { auditRenderLoopHotPath, auditStaticMeshUsage } from '../lib/performance-budget.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const MAP_AUDIT = P('data', 'reports', 'map-completeness-audit.json');
const REPORT = P('data', 'reports', 'performance-budget-validation.json');
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; } };

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(DEV_HTML)) { console.error('[stop] dev HTML なし'); process.exitCode = 1; return; }
  const html = fs.readFileSync(DEV_HTML, 'utf-8');

  // ── 静的 mesh 最適化 ──
  const sm = auditStaticMeshUsage(html);
  if (!sm.defined) errors.push('markStaticMesh() が定義されていない');
  if (sm.callCount < 8) errors.push('markStaticMesh() の適用箇所が少なすぎる (' + sm.callCount + ')');
  for (const L of ['RiverLayerV2', 'CityBuildingLOD', 'CityTileLayer', 'LandSurfaceLayer', 'ParkLayer', 'WaterSurfaceLayer', 'BuildingTileLayer']) {
    if (!sm.layers.includes(L)) errors.push('markStaticMesh が ' + L + ' に適用されていない');
  }

  // ── FPS / frameMs 計測 ──
  if (!/const __PERF_FRAME__ = \{/.test(html)) errors.push('__PERF_FRAME__ が無い');
  if (!/function __perfFrameTick__\(\)/.test(html)) errors.push('__perfFrameTick__() が無い');
  if (!/__perfFrameTick__\(\); \/\/ \[Mission25\]/.test(html)) errors.push('__perfFrameTick__() が render loop に配線されていない');

  // ── performance debug API ──
  if (!/window\.__PERFORMANCE_DEBUG__ = function \(\)/.test(html)) errors.push('window.__PERFORMANCE_DEBUG__ が無い');
  if (!/window\.__PERFORMANCE_BASELINE__ = function \(\)/.test(html)) errors.push('window.__PERFORMANCE_BASELINE__ が無い');
  for (const k of ['staticMatrixMeshes', 'visibleMeshes', 'approxVisibleTriangles', '__perfSceneTraversal__', '__perfLayerStats__']) {
    if (!html.includes(k)) errors.push('__PERFORMANCE_DEBUG__ に ' + k + ' が無い');
  }

  // ── render loop hot path ──
  const hp = auditRenderLoopHotPath(html);
  if (!hp.ok) errors.push('render loop hot path に重い処理: ' + hp.hits.join(', '));

  // ── LOD / dirty-flag / duplicate build 抑止（回帰）──
  if (!/let lastCityLodKey = null;/.test(html)) errors.push('CityTileLayer の LOD dirty-flag (lastCityLodKey) が消えた');
  if (!/if \(!force && key === lastCityLodKey\) return;/.test(html)) errors.push('applyCityLOD の dirty-flag ガードが消えた');
  if (!/const HIDE_NEAR_M = 4000;/.test(html)) errors.push('CityBuildingLOD.HIDE_NEAR_M = 4000 が変わった（duplicate build draw 抑止）');
  if (!/BuildingTileLayer\.updateByCamera\(camera\); \/\/ \[building-tile-engine-v1\]/.test(html)) errors.push('BuildingTileLayer.updateByCamera の throttle 呼び出しが消えた');

  // ── 既存 debug API / レイヤー（回帰）──
  for (const kw of ['__RAIL_LOD_DEBUG__', '__ROAD_NETWORK_DEBUG__', '__MAP_COMPLETENESS_DEBUG__', '__BUILDING_COVERAGE_DEBUG__',
    '__VISIBLE_BUILDING_GAP_DEBUG__', 'const RiverLayerV2 = (function', 'const CityBuildingLOD', 'const CityTileLayer = (function',
    'f.railClass || classifyRail']) {
    if (!html.includes(kw)) errors.push('既存 ' + kw + ' が消えた');
  }
  // projection 不変
  if (!/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html)) errors.push('projection 式が変わった');

  // ── Mission24 完成度の回帰 ──
  const mc = rd(MAP_AUDIT);
  if (!mc) warns.push('map-completeness-audit.json が無い（先に node tools/audit/map-completeness.js）');
  else {
    if (mc.overallScore !== 100) errors.push('map completeness overallScore ' + mc.overallScore + ' (期待 100)');
    if (mc.criticalCount !== 0) errors.push('map completeness CRITICAL ' + mc.criticalCount);
    if (mc.highCount !== 0) errors.push('map completeness HIGH ' + mc.highCount);
    if (mc.verdict !== '大阪市基礎地図 β1 完成候補') errors.push('map completeness verdict: ' + mc.verdict);
  }

  // ── production / protected 無混入 ──
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(label + ' HTML なし'); continue; }
    const h = fs.readFileSync(p, 'utf-8');
    if (/markStaticMesh|__PERF_FRAME__|__PERFORMANCE_DEBUG__|__perfFrameTick__/.test(h)) errors.push(label + ' HTML に Mission25 の変更が混入している');
  }

  console.log('[performance-budget-validate]');
  console.log('  markStaticMesh: defined=' + sm.defined + ' calls=' + sm.callCount + ' layers=' + sm.layers.join('/'));
  console.log('  render loop hot path: ' + (hp.ok ? 'clean' : hp.hits.join(', ')));
  console.log('  map completeness: ' + (mc ? (mc.overallScore + ' / ' + mc.verdict) : 'n/a'));
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    staticMesh: sm,
    renderLoopHotPath: hp,
    mapCompleteness: mc ? { overallScore: mc.overallScore, criticalCount: mc.criticalCount, highCount: mc.highCount, verdict: mc.verdict } : null,
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[performance-budget-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
