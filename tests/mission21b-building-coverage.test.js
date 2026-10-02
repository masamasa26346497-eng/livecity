// tests/mission21b-building-coverage.test.js
// [Mission21B 全建物カバレッジ] raw/classified/tile 整合・24区・tile completeness・OSM 補完 dataset・
//   fallback dedup・HTML 配線・回帰保護・runtime debug。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { flattenWardPolygons, pointInRing } from '../tools/lib/water-surface.js';

const require = createRequire(import.meta.url);
const HTML_PATH = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];

const BUILD_DIR = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'buildings');
const ROOT = path.join(BUILD_DIR, 'manifest.json');
const FB_DIR = path.join(BUILD_DIR, 'osaka-osm-fallback');
const AUDIT = path.join(PROJECT_ROOT, 'data', 'reports', 'building-coverage-audit.json');
const hasData = fs.existsSync(ROOT);
const root = hasData ? JSON.parse(fs.readFileSync(ROOT, 'utf-8')) : null;
const audit = fs.existsSync(AUDIT) ? JSON.parse(fs.readFileSync(AUDIT, 'utf-8')) : null;

function run() {
  return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
}
async function flush(n = 20) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

test('[Mission21B] インライン <script> の JS 構文が壊れていない', () => {
  const f = path.join(os.tmpdir(), `m21b-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission21B] root manifest: 24 ward dataset + OSM 補完 dataset / totals 整合', { skip: !hasData && 'no data' }, () => {
  const wardDs = root.datasets.filter((d) => d.wardId && d.kind !== 'osm-fallback');
  assert.equal(wardDs.length, 24, 'ward dataset が 24 でない');
  assert.equal(wardDs.reduce((s, d) => s + d.buildings, 0), root.totals.classified, 'ward 建物合計 ≠ classified');
  const fb = root.datasets.find((d) => d.id === 'osaka-osm-fallback');
  assert.ok(fb, 'osaka-osm-fallback dataset が root manifest に無い');
  assert.ok(fb.buildings > 3000, 'fallback 建物が少なすぎる: ' + fb.buildings);
  assert.equal(fb.wardId, null);
  assert.equal(fb.kind, 'osm-fallback');
});

test('[Mission21B] tile completeness: missing tile 0 / empty tile 0', { skip: !hasData && 'no data' }, () => {
  let missing = 0, empty = 0, datasets = 0;
  for (const d of root.datasets) {
    const dir = path.join(BUILD_DIR, d.id);
    const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    datasets++;
    for (const t of (man.tiles || [])) {
      const fp = path.join(dir, `tile_${t.tx}_${t.tz}.json`);
      if (!fs.existsSync(fp)) { missing++; continue; }
      const td = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (!(td.buildings || []).length) empty++;
    }
  }
  assert.equal(missing, 0, 'missing tile がある');
  assert.equal(empty, 0, 'empty tile がある');
  assert.equal(datasets, 25, 'dataset 数（24区 + fallback）');
});

test('[Mission21B] fallback dataset: id prefix osm_ / heightUnknown 保持 / footprint 有効 / id 重複なし', { skip: !fs.existsSync(FB_DIR) && 'no fallback' }, () => {
  const seen = new Set();
  let count = 0, heightUnknown = 0, badFp = 0, badHeight = 0;
  for (const f of fs.readdirSync(FB_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(FB_DIR, f), 'utf-8'));
    for (const b of (t.buildings || [])) {
      count++;
      assert.ok(String(b.id).startsWith('osm_'), 'id prefix が osm_ でない: ' + b.id);
      assert.ok(!seen.has(b.id), 'id 重複: ' + b.id); seen.add(b.id);
      assert.equal(b.source, 'osm-fallback');
      if (b.heightUnknown) heightUnknown++;
      if (!Array.isArray(b.fp) || b.fp.length < 3) badFp++;
      if (!Number.isFinite(b.dz) || b.dz <= 0 || b.dz > 60) badHeight++;
    }
  }
  assert.equal(badFp, 0, 'invalid footprint');
  assert.equal(badHeight, 0, 'invalid height');
  assert.ok(heightUnknown > 0 && heightUnknown < count, 'heightUnknown の分布が異常（' + heightUnknown + '/' + count + '）');
});

test('[Mission21B] fallback は N03 区内 かつ PLATEAU 未収録領域（区外・既存重複を入れない）', { skip: !fs.existsSync(FB_DIR) && 'no fallback' }, () => {
  const wj = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'), 'utf-8'));
  const wards = flattenWardPolygons(wj.wards);
  const wardAt = (x, z) => {
    for (const w of wards) { if (!pointInRing(x, z, w.outer)) continue; let h = false; for (const hh of (w.holes || [])) if (pointInRing(x, z, hh)) h = true; if (!h) return w.wardId; }
    return null;
  };
  let outCity = 0, n = 0;
  for (const f of fs.readdirSync(FB_DIR).slice(0, 60)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(FB_DIR, f), 'utf-8'));
    for (const b of (t.buildings || [])) { n++; if (!wardAt(b.repX, b.repZ)) outCity++; }
  }
  assert.ok(outCity / Math.max(1, n) < 0.02, '区外の fallback 建物が多い: ' + outCity + '/' + n);
});

test('[Mission21B] audit: unexplained gap cluster = 0 / 全クラスタに cause / coverage 改善', { skip: !audit && 'no audit' }, () => {
  assert.equal(audit.gapClusters.unexplained, 0, 'unexplained building gap cluster がある');
  for (const c of audit.gapClusters.list) assert.ok(c.likelyCause, 'cause 未設定の cluster: ' + c.id);
  assert.ok(audit.gridAudit.afterFallback.buildingCellCoverage > audit.gridAudit.beforeFallback.buildingCellCoverage, 'fallback で coverage が改善していない');
  assert.ok(audit.gridAudit.afterFallback.gapClusters < audit.gridAudit.beforeFallback.gapClusters, 'gap cluster が減っていない');
  assert.equal(audit.tileCompleteness.missingTiles, 0);
});

test('[Mission21B] audit: 未分類建物は N03 区外（区内すきま 0）', { skip: !audit && 'no audit' }, () => {
  assert.equal(audit.unclassifiedAnalysis.insideWardPolygon, 0, '区ポリゴン内なのに未分類の建物がある（分類バグ）');
});

test('[Mission21B] audit: 重点10区の building cell coverage', { skip: !audit && 'no audit' }, () => {
  for (const w of ['kita', 'chuo', 'nishi', 'naniwa', 'tennoji', 'abeno', 'konohana', 'minato', 'taisho', 'suminoe']) {
    assert.ok(audit.byWard[w], w + ' の byWard が無い');
    assert.ok(audit.byWard[w].buildings > 5000, w + ' の建物が少なすぎる');
  }
});

// ── HTML 配線 ──
test('[Mission21B] __BUILDING_COVERAGE_DEBUG__ が公開されている / 必須キー', () => {
  assert.ok(/window\.__BUILDING_COVERAGE_DEBUG__ = \(\) => \{/.test(html));
  const fn = js.slice(js.indexOf('window.__BUILDING_COVERAGE_DEBUG__'), js.indexOf('window.__BUILDING_COVERAGE_DEBUG__') + 2200);
  for (const k of ['rawBuildings', 'classifiedBuildings', 'unclassified', 'osmFallbackBuildings', 'expectedTiles', 'generatedTiles', 'loadedTiles', 'missingTiles', 'cityBuildingLOD', 'byWard', 'visibleBuildings']) {
    assert.ok(fn.includes(k), `__BUILDING_COVERAGE_DEBUG__ に ${k} が無い`);
  }
});

test('[Mission21B] CityBuildingLOD が OSM 補完を別枠でロード / getStats に osmFallbackStatus', () => {
  assert.ok(/await loadWard\('osm-fallback', 'osaka-osm-fallback'\);/.test(html), 'CityBuildingLOD が fallback を読み込んでいない');
  assert.ok(/osmFallbackStatus: fallbackStatus/.test(html), 'getStats に osmFallbackStatus が無い');
});

test('[Mission21B] BuildingTileLayer / CityBuildingLOD / Mission10 / Mission11B の既存構造は不変', () => {
  assert.ok(/const BuildingTileLayer = \(function/.test(html), 'BuildingTileLayer が消えた');
  assert.ok(/const CityBuildingLOD = \(function/.test(html), 'CityBuildingLOD が消えた');
  assert.ok(/const BUILDING_TILE_CONFIG = \{/.test(html) && /tileSize: 500/.test(html), 'BUILDING_TILE_CONFIG が変わった');
  assert.ok(/LandmarkLayer\.isSuppressedBuilding\(b\.id\)/.test(html), 'Mission11B suppress hook が消えた');
  assert.ok(/BUILDING_HEIGHT_STYLE\.getHeightStyle/.test(html), 'Mission10 高さ styling が消えた');
  // Mission21/22/23
  assert.ok(/const LandSurfaceLayer = \(function/.test(html) && /const RiverLayerV2 = /.test(html), 'Mission21/22 が消えた');
  assert.ok(/__ROAD_NETWORK_DEBUG__/.test(html), 'Mission23 が消えた');
});

test('[Mission21B] projection / znorth-neg-v1 は不変', () => {
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html));
});

test('[Mission21B] protected HTML に Mission21B の変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/__BUILDING_COVERAGE_DEBUG__|osaka-osm-fallback|getRootManifest/.test(h), `${rel} に Mission21B 混入`);
  }
});

// ── runtime ──
test('[Mission21B] runtime: 例外なく評価 / __BUILDING_COVERAGE_DEBUG__ が集計を返す / fallback dataset 登録', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  await flush();
  const d = r.window.__BUILDING_COVERAGE_DEBUG__();
  assert.ok(d, '__BUILDING_COVERAGE_DEBUG__ が null');
  assert.equal(d.rawBuildings, 584490);
  assert.equal(d.classifiedBuildings, 574112);
  assert.ok(d.osmFallbackBuildings > 3000, 'fallback 建物数が出ていない');
  assert.equal(d.missingTiles, 0);
  assert.ok(d.expectedTiles > 1096, 'fallback tiles が expectedTiles に含まれていない');
  assert.ok((d.datasets || []).some((x) => x.id === 'osaka-osm-fallback' && x.manifestState === 'ready'), 'fallback dataset が ready でない');
});
