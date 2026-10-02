// tests/mission21c-building-visual-gap.test.js
// [Mission21C 視覚 building gap 突合] sparse-mismatch fallback / reconciliation / debug API /
//   City-Ward parity / Mission21B・RoadLayer・LandSurface 回帰 / protected・production 無変更。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const require = createRequire(import.meta.url);
const HTML_PATH = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];

const BUILD_DIR = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'buildings');
const FB_DIR = path.join(BUILD_DIR, 'osaka-osm-fallback');
const RECON = path.join(PROJECT_ROOT, 'data', 'reports', 'building-visual-gap-reconciliation.json');
const FB_REPORT = path.join(PROJECT_ROOT, 'data', 'reports', 'osm-building-fallback.json');
const recon = fs.existsSync(RECON) ? JSON.parse(fs.readFileSync(RECON, 'utf-8')) : null;
const fbRep = fs.existsSync(FB_REPORT) ? JSON.parse(fs.readFileSync(FB_REPORT, 'utf-8')) : null;

function run() {
  return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
}
async function flush(n = 20) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

test('[Mission21C] インライン <script> の JS 構文が壊れていない', () => {
  const f = path.join(os.tmpdir(), `m21c-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission21C] fallback: hole + sparse-mismatch の 2 種で採用 / fallbackReason 保持', { skip: !fs.existsSync(FB_DIR) && 'no fallback' }, () => {
  const reason = { hole: 0, 'sparse-mismatch': 0, other: 0 };
  let count = 0;
  for (const f of fs.readdirSync(FB_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(FB_DIR, f), 'utf-8'));
    for (const b of (t.buildings || [])) {
      count++;
      assert.ok(['hole', 'sparse-mismatch'].includes(b.fallbackReason), 'fallbackReason=' + b.fallbackReason);
      reason[b.fallbackReason]++;
      // renderHeight / heightUnknown 分離（§6）
      assert.ok(Number.isFinite(b.dz) && b.dz > 0);
      if (b.heightUnknown) assert.equal(b.actualHeight, null, '実高不明なのに actualHeight');
      else assert.ok(Number.isFinite(b.actualHeight), '実高ありなのに actualHeight が無い');
    }
  }
  assert.ok(reason.hole > 3000, 'hole 由来が少ない: ' + reason.hole);
  assert.ok(reason['sparse-mismatch'] > 5000, 'sparse-mismatch 由来が少ない: ' + reason['sparse-mismatch']);
});

test('[Mission21C] reconciliation report（§11）: 必須項目 + residual/missed = 0', { skip: !recon && 'no recon' }, () => {
  for (const k of ['visualGapClusters', 'sparseMismatchClusters', 'causeBreakdown', 'fallbackAdded', 'duplicatesRejected', 'runtimeMissing', 'remainingExplained', 'footprintAreaCoverage']) {
    assert.ok(k in recon, 'reconciliation report に ' + k + ' が無い');
  }
  assert.equal(recon.sparseMismatch.residualCells, 0, 'sparse mismatch residual が残っている');
  assert.equal(recon.sparseMismatch.missedCells, 0, 'sparse mismatch 見落としがある');
  assert.equal(recon.runtimeMissing, 0, 'runtime missing tile がある');
  assert.equal(recon.remainingExplained.unexplained, 0, 'unexplained visual gap がある');
  assert.ok(recon.remainingExplained.allHaveCause, '全 gap cluster に cause が付いていない');
});

test('[Mission21C] footprint 面積 coverage が fallback で改善（PLATEAU-only < +fallback）', { skip: !recon && 'no recon' }, () => {
  const fac = recon.footprintAreaCoverage;
  assert.ok(fac.plateauPlusFallback > fac.plateauOnly, `${fac.plateauOnly} → ${fac.plateauPlusFallback}`);
});

test('[Mission21C] duplicate fallback = 0（polygon レベル。sparse-mismatch 含む）', { skip: !fbRep && 'no fb report' }, () => {
  // build 側 dedup で拒否された件数 > 0（機能している）かつ、残った fallback に polygon 重複が無いことは
  //   tools/validate/building-coverage.js が担保。ここでは build 側統計を確認。
  assert.ok((fbRep.duplicatesRejected ?? fbRep.stats.dupRejected) > 100, 'polygon dedup が機能していない');
});

// ── HTML 配線 ──
test('[Mission21C] __VISIBLE_BUILDING_GAP_DEBUG__ が公開されている / 必須キー', () => {
  assert.ok(/window\.__VISIBLE_BUILDING_GAP_DEBUG__ = \(\) => \{/.test(html));
  const fn = js.slice(js.indexOf('window.__VISIBLE_BUILDING_GAP_DEBUG__'), js.indexOf('window.__VISIBLE_BUILDING_GAP_DEBUG__') + 2600);
  for (const k of ['cameraTarget', 'cameraRadius', 'visibleBuildingTiles', 'visibleRoadTiles', 'visibleLandTiles', 'visibleBuildingCount', 'visibleRoadCount', 'visibleFallbackBuildings', 'visiblePlateauBuildings', 'visibleEmptyCells', 'suspectedVisualGaps']) {
    assert.ok(fn.includes(k), '__VISIBLE_BUILDING_GAP_DEBUG__ に ' + k + ' が無い');
  }
});

test('[Mission21C] __BUILDING_GAP_FOCUS__ / BuildingTileLayer.getBuildingCellCounts / CityTileLayer.getRoadCellCoverage', () => {
  assert.ok(/window\.__BUILDING_GAP_FOCUS__ = \(x, z, radius\) => \{/.test(html), '__BUILDING_GAP_FOCUS__ が無い');
  assert.ok(/getBuildingCellCounts\(bbox, cellM\)/.test(html), 'BuildingTileLayer.getBuildingCellCounts が無い');
  assert.ok(/getRoadCellCoverage\(bbox, cellM\)/.test(html), 'CityTileLayer.getRoadCellCoverage が無い');
});

test('[Mission21C §6] 実高不明の OSM 補完建物は高さ階級カウントへ入れない（detail / cityLOD 両方）', () => {
  const detailGuard = /BUILDING_HEIGHT_STYLE\.isEnabled\(\) && !b\.heightUnknown\) \{\s*const hs = BUILDING_HEIGHT_STYLE\.getHeightStyle\(b\.dz, 'detail'\)/;
  const cityGuard = /BUILDING_HEIGHT_STYLE\.isEnabled\(\) && !b\.heightUnknown\) \{\s*const hs = BUILDING_HEIGHT_STYLE\.getHeightStyle\(b\.dz, 'cityLOD'\)/;
  assert.ok(detailGuard.test(html), 'detail 側の heightUnknown ガードが無い');
  assert.ok(cityGuard.test(html), 'cityLOD 側の heightUnknown ガードが無い');
});

// ── 回帰 ──
test('[Mission21C] Mission21B: CityBuildingLOD の OSM 補完ロード / __BUILDING_COVERAGE_DEBUG__ 維持', () => {
  assert.ok(/await loadWard\('osm-fallback', 'osaka-osm-fallback'\);/.test(html), 'CityBuildingLOD の fallback ロードが消えた');
  assert.ok(/window\.__BUILDING_COVERAGE_DEBUG__/.test(html), '__BUILDING_COVERAGE_DEBUG__ が消えた');
});

test('[Mission21C] City / Ward parity: fallback dataset は BuildingTileLayer（Ward）と CityBuildingLOD（City）両方が対象', () => {
  // BuildingTileLayer は root manifest datasets を initDatasets で enable（fallback も含む）
  assert.ok(/for \(const entry of \(root\.datasets \|\| \[\]\)\)/.test(html), 'BuildingTileLayer が root datasets を全件登録していない');
  // CityBuildingLOD は WARD_DEFS ループ後に fallback を別枠ロード
  assert.ok(/for \(const w of WardModeManager\.WARD_DEFS\) \{[\s\S]{0,120}await loadWard\(w\.id, w\.datasetId\);[\s\S]{0,400}await loadWard\('osm-fallback'/.test(html), 'City / Ward parity 配線が壊れた');
});

test('[Mission21C] RoadLayer / LandSurfaceLayer / RiverLayerV2 / Mission19-20-23 は不変', () => {
  assert.ok(/__ROAD_NETWORK_DEBUG__/.test(html) && /const RoadLayer\b|buildRoadMeshes/.test(html), 'RoadLayer/Mission23 が消えた');
  assert.ok(/const LandSurfaceLayer = \(function/.test(html) && /land-surface\/land-surface\.json/.test(html), 'LandSurfaceLayer が消えた');
  assert.ok(/const RiverLayerV2 = /.test(html) && /mediumMesh/.test(html), 'RiverLayerV2/Mission22 が消えた');
  assert.ok(/--lc-bg:/.test(html) && /LiveCityModeManager/.test(html), 'Mission19/20 UI が消えた');
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html), 'projection が変わった');
});

test('[Mission21C] protected HTML に Mission21C の変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/__VISIBLE_BUILDING_GAP_DEBUG__|__BUILDING_GAP_FOCUS__|getBuildingCellCounts|getRoadCellCoverage/.test(h), rel + ' に Mission21C 混入');
  }
});

// ── runtime ──
test('[Mission21C] runtime: __VISIBLE_BUILDING_GAP_DEBUG__ / __BUILDING_GAP_FOCUS__ が形を返す', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  await flush();
  const d = r.window.__VISIBLE_BUILDING_GAP_DEBUG__();
  assert.ok(d && d.cameraTarget && Number.isFinite(d.cameraRadius));
  assert.ok('visibleFallbackBuildings' in d && 'visiblePlateauBuildings' in d);
  assert.ok(Array.isArray(d.suspectedVisualGaps));
  const f = r.window.__BUILDING_GAP_FOCUS__(-9600, -10250);
  assert.ok(f && Array.isArray(f.focus) && f.radius > 0);
  const c = r.window.__BUILDING_COVERAGE_DEBUG__();
  assert.ok(c.osmFallbackBuildings > 20000, 'fallback 拡張が反映されていない: ' + c.osmFallbackBuildings);
  assert.ok(c.osmFallbackReasons && c.osmFallbackReasons['sparse-mismatch'] > 0, 'reasonCounts が出ていない');
});
