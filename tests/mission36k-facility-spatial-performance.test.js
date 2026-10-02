import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROTECTED = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const html = fs.readFileSync(DEV, 'utf8');

function extractBetween(start, end) {
  const a = html.indexOf(start);
  assert.ok(a >= 0, `start anchor missing: ${start}`);
  const b = html.indexOf(end, a);
  assert.ok(b > a, `end anchor missing: ${end}`);
  return html.slice(a, b);
}

test('[36K PERF] facility store keeps 24-ward lazy loading and adds spatial grid', () => {
  assert.match(html, /\[Mission 36J LAZY\] 24-ward facility lazy loading/);
  assert.match(html, /\[Mission 36K PERF\] facility spatial index/);
  assert.match(html, /const FACILITY_GRID_CELL_METERS = 500;/);
  assert.match(html, /let spatialGrid = new Map\(\);/);
  assert.match(html, /function indexSpatialRecord\(record\)/);
  assert.match(html, /function queryNearbySpatial\(x, z, radiusM, subcategories = \[\], options = \{\}\)/);
  assert.match(html, /indexSpatialRecord\(record\);/);
});

test('[36K PERF] finite-radius facility queries use nearby grid cells', () => {
  const q = extractBetween('  function queryNearbySpatial(', '\n  function mergeRecords(');
  assert.match(q, /const minCx = spatialCellCoord\(qx - radius\)/);
  assert.match(q, /const maxCx = spatialCellCoord\(qx \+ radius\)/);
  assert.match(q, /const ids = spatialGrid\.get\(spatialCellKey\(cx, cz\)\)/);
  assert.match(q, /const r = recordsById\.get\(id\)/);
  assert.match(q, /d2 > radiusSq/);
});

test('[36K PERF] renderer no longer maps/sorts every loaded facility', () => {
  const layer = extractBetween('const FacilityLayer = (function () {', '\n})();');
  assert.match(layer, /FacilityDataStore\.queryNearby\(centerX, centerZ, FACILITY_RENDER_RADIUS_METERS/);
  assert.match(layer, /limit: MAX_RENDERED_FACILITIES/);
  assert.match(layer, /prioritizeMajor: true/);
  assert.doesNotMatch(layer, /const selectedFacilityRecords = allFacilityRecords/);
  assert.doesNotMatch(layer, /allFacilityRecords\s*\.map\(/);
});

test('[36K PERF] facility cap and Osaka-wide source remain intact', () => {
  assert.match(html, /MAX_RENDERED_FACILITIES/);
  assert.match(html, /areaId: 'osaka-city'/);
  assert.match(html, /google-places-osaka-city-mapping\.json/);
  assert.match(html, /ward-manifest\.json/);
});

test('[36K PERF] exact building picking path remains intact', () => {
  // 施設側を軽量化しても、35YのfaceIndexベースの建物選択を変更しない。
  assert.match(html, /function pickBuilding\(rayObj\) \{/);
  assert.match(html, /function buildingFromHit\(hit\) \{/);
  assert.match(html, /ud\.crTriBuilding\[hit\.faceIndex\]/);
  assert.match(html, /CanonicalRuntime\.pickBuilding\(ray\)/);
});

test('[36K PERF] production/protected HTML are not patched with dev-only spatial index', () => {
  for (const p of [PROD, PROTECTED]) {
    const s = fs.readFileSync(p, 'utf8');
    assert.doesNotMatch(s, /\[Mission 36K PERF\] facility spatial index/);
    assert.doesNotMatch(s, /FACILITY_GRID_CELL_METERS/);
  }
});
