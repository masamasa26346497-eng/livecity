// tests/mission29-building-density.test.js
// [Mission29 建物網羅性の最終強化]
//   fallback tile schema（source/heightSource/confidence/usage）/ roof等除外 / footprint quality /
//   per-class 高さ / LOD 統合（CityBuildingLOD + isMajorBuilding + BuildingTileLayer）/
//   building-density validator / map completeness 100 / production・protected 無変更 / runtime。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const require = createRequire(import.meta.url);
const HTML_PATH = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');

const FB_DIR = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'buildings', 'osaka-osm-fallback');
const FB_REPORT = path.join(PROJECT_ROOT, 'data', 'reports', 'osm-building-fallback.json');
const DENS_VAL = path.join(PROJECT_ROOT, 'data', 'reports', 'building-density-validation.json');
const COV_AUDIT = path.join(PROJECT_ROOT, 'data', 'reports', 'building-coverage-audit.json');
const MAP_AUDIT = path.join(PROJECT_ROOT, 'data', 'reports', 'map-completeness-audit.json');
const rd = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null);
const hasFb = fs.existsSync(FB_DIR);

function run() {
  return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
}
async function flush(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

function loadFbBuildings() {
  const out = [];
  for (const f of fs.readdirSync(FB_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(FB_DIR, f), 'utf-8'));
    for (const b of (t.buildings || [])) out.push(b);
  }
  return out;
}
const VALID_HS = new Set(['osm-height', 'osm-levels', 'class-default', 'generic-default']);
const EXCLUDED = new Set(['roof', 'construction', 'ruins', 'proposed', 'demolished']);

test('[Mission29] fallback tile schema: source / heightSource / confidence / usage', { skip: !hasFb && 'no fallback' }, () => {
  const bs = loadFbBuildings();
  assert.ok(bs.length > 30000, 'fallback が少なすぎる: ' + bs.length);
  for (const b of bs) {
    assert.ok(/^osm_\d+/.test(b.id), 'id 形式: ' + b.id);
    assert.ok(/^way\/\d+/.test(String(b.osmId)), 'osmId が way/N でない: ' + b.osmId);
    assert.equal(b.source, 'osm-fallback');
    assert.ok(VALID_HS.has(b.heightSource), 'heightSource: ' + b.heightSource);
    assert.equal(typeof b.confidence, 'number');
    assert.ok(b.confidence >= 0 && b.confidence <= 1, 'confidence: ' + b.confidence);
    assert.ok(Array.isArray(b.fp) && b.fp.length >= 3);
    assert.ok(b.dz > 0 && b.dz <= 60, 'dz clamp: ' + b.dz);
    // heightUnknown な建物は actualHeight null
    if (b.heightUnknown) assert.equal(b.actualHeight, null);
  }
});

test('[Mission29] §2 roof/construction/ruins が fallback に混入していない', { skip: !hasFb && 'no fallback' }, () => {
  for (const b of loadFbBuildings()) {
    if (b.usage) assert.ok(!EXCLUDED.has(String(b.usage).toLowerCase()), b.id + ' usage=' + b.usage);
  }
});

test('[Mission29] §10 per-class 高さ: class-default 建物が現実的な高さ', { skip: !hasFb && 'no fallback' }, () => {
  const bs = loadFbBuildings().filter((b) => b.heightSource === 'class-default');
  assert.ok(bs.length > 500, 'class-default が少ない: ' + bs.length);
  for (const b of bs) {
    assert.ok(b.dz >= 3 && b.dz <= 20, b.usage + ' の class-default height ' + b.dz + ' が非現実的');
    assert.equal(b.heightUnknown, true);
  }
  // flat 6m だけではない（class ごとに差がある）
  const heights = new Set(bs.map((b) => b.dz));
  assert.ok(heights.size >= 3, 'class-default の高さが単一値（per-class になっていない）');
});

test('[Mission29] §11 fallback report: byUsage / confidence / footprintQuality', { skip: !fs.existsSync(FB_REPORT) && 'no report' }, () => {
  const r = rd(FB_REPORT);
  assert.ok(r.byUsage && Object.keys(r.byUsage).length > 5);
  assert.ok(r.confidence && typeof r.confidence.mean === 'number' && r.confidence.mean > 0 && r.confidence.mean <= 1);
  assert.ok(r.footprintQuality && typeof r.footprintQuality.selfIntersect === 'number');
  assert.equal(r.stats.badFootprint, 0, 'badFootprint が残っている');
  assert.ok(r.heightSourceCounts['class-default'] > 0, 'class-default が 0（§10 未適用）');
});

test('[Mission29] §19 building-density validator: RESULT PASS', { skip: !fs.existsSync(DENS_VAL) && 'no validation' }, () => {
  const v = rd(DENS_VAL);
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.counts.dupId, 0);
  assert.equal(v.counts.tileDup, 0);
  assert.equal(v.counts.invalidGeom, 0);
  assert.equal(v.counts.giant, 0);
  assert.equal(v.counts.outside, 0);
  assert.equal(v.counts.noSource, 0);
  assert.equal(v.counts.noConfidence, 0);
  assert.equal(v.counts.excludedUsage, 0);
  assert.equal(v.unexplainedGapClusters, 0);
  assert.ok(Object.keys(v.byWard).length >= 20, '24区中 ' + Object.keys(v.byWard).length);
});

test('[Mission29] §15/§16 building-coverage-audit: 24区別 / unexplained gap 0 / coverage', { skip: !fs.existsSync(COV_AUDIT) && 'no audit' }, () => {
  const a = rd(COV_AUDIT);
  assert.equal(a.RESULT, 'PASS');
  assert.equal(a.gapClusters.unexplained, 0);
  assert.equal(Object.keys(a.byWard).length, 24);
  assert.ok(a.gridAudit.afterFallback.buildingCellCoverage >= 0.85);
  assert.ok(a.gridAudit.afterFallback.suspectedGapCells < a.gridAudit.beforeFallback.suspectedGapCells, 'suspected gap が減っていない');
  assert.equal(a.corpus.classified, 574112, 'PLATEAU 建物数が変わった（§0 破壊禁止）');
});

test('[Mission29] map completeness 100 維持', { skip: !fs.existsSync(MAP_AUDIT) && 'no map audit' }, () => {
  const m = rd(MAP_AUDIT);
  assert.equal(m.overallScore, 100);
  assert.equal(m.criticalCount, 0);
  assert.equal(m.highCount, 0);
});

test('[Mission29] §12/§13/§20 HTML: LOD 統合（CityBuildingLOD fallback / isMajorBuilding / BuildingTileLayer / markStaticMesh）', () => {
  assert.ok(/await loadWard\('osm-fallback', 'osaka-osm-fallback'\);/.test(html), 'CityBuildingLOD が fallback をロードしない');
  assert.ok(/function isMajorBuilding\(b\) \{/.test(html), 'isMajorBuilding（Mission27・fallback にも適用）が無い');
  assert.ok(/const isFb = b\.source === 'osm-fallback' \|\| \(typeof b\.id === 'string' && b\.id\.startsWith\('osm_'\)\)/.test(html), 'BuildingTileLayer の fallback 判定が無い');
  assert.ok(/function markStaticMesh\(obj\) \{/.test(html), 'markStaticMesh（Mission25）が無い');
  // fallback 専用の per-building mesh を作っていない（tile merged）
  assert.ok(!/osaka-osm-fallback[\s\S]{0,300}for \([^)]*\)\s*\{\s*[^}]*new THREE\.Mesh/.test(html), 'fallback で per-building mesh 生成の疑い');
  // znorth-neg-v1 不変
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html));
});

test('[Mission29] protected HTML に建物補完/LOD の変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/osaka-osm-fallback|__BUILDING_COVERAGE_DEBUG__|isMajorBuilding/.test(h), rel + ' に混入');
  }
});

test('[Mission29] runtime: __BUILDING_COVERAGE_DEBUG__ が fallback / confidence を返す', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  await flush();
  const d = r.window.__BUILDING_COVERAGE_DEBUG__();
  assert.ok(d && typeof d === 'object');
  assert.ok((d.osmFallbackBuildings || 0) > 30000, 'osmFallbackBuildings=' + d.osmFallbackBuildings);
  // major building LOD debug が fallback 込みの件数を返す
  const mb = r.window.__MAJOR_BUILDING_LOD_DEBUG__ ? r.window.__MAJOR_BUILDING_LOD_DEBUG__() : null;
  if (mb) assert.equal(mb.thresholdHeight, 30);
});
