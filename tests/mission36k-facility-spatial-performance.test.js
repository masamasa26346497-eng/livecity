import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const COORDINATOR = path.join(ROOT, 'public', 'livecity-dev-ui-coordinator.js');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROTECTED = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const PREVIEW = path.join(ROOT, 'tools', 'preview.js');

const html = fs.readFileSync(DEV, 'utf8');
const coordinator = fs.readFileSync(COORDINATOR, 'utf8');
const preview = fs.readFileSync(PREVIEW, 'utf8');

function extract(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, `start anchor missing: ${start}`);
  const b = source.indexOf(end, a);
  assert.ok(b > a, `end anchor missing: ${end}`);
  return source.slice(a, b);
}

test('[36K PERF] preview coordinator installs 500m facility spatial index', () => {
  assert.match(coordinator, /\[Mission 36K PERF\] facility spatial coordinator/);
  assert.match(coordinator, /const CELL_METERS = 500;/);
  assert.match(coordinator, /const grid = new Map\(\);/);
  assert.match(coordinator, /const indexedIds = new Set\(\);/);
  assert.match(coordinator, /const recordsById = new Map\(\);/);
  assert.match(coordinator, /function indexRecords\(records\)/);
  assert.match(coordinator, /function queryNearby\(store, x, z, radiusM, options = \{\}\)/);
});

test('[36K PERF] finite-radius queries touch grid candidates rather than rebuilding a full ID map', () => {
  const q = extract(coordinator, '  function queryNearby(store, x, z, radiusM, options = {}) {', '\n  function patchStore(store) {');
  assert.match(q, /const minCx = cellCoord\(qx - radius\)/);
  assert.match(q, /const maxCx = cellCoord\(qx \+ radius\)/);
  assert.match(q, /const ids = grid\.get\(cellKey\(cx, cz\)\)/);
  assert.match(q, /const record = recordsById\.get\(id\)/);
  assert.match(q, /d2 > radiusSq/);
  assert.doesNotMatch(q, /store\.getAllRecords\(\)/);
  assert.doesNotMatch(q, /new Map\(\(store\.getAllRecords/);
});

test('[36K PERF] index refresh occurs on ward loading, not on every nearby query', () => {
  const patch = extract(coordinator, '  function patchStore(store) {', '\n  function getFacilityLayerBinding() {');
  assert.match(patch, /const originalLoadWard = store\.loadWard\.bind\(store\)/);
  assert.match(patch, /await originalLoadWard\(\.\.\.args\)/);
  assert.match(patch, /indexRecords\(store\.getAllRecords\(\)\)/);

  const countBlock = extract(patch, 'store.countNearbyBySubcategory =', '\n\n    store.queryNearbySpatial =');
  assert.doesNotMatch(countBlock, /indexRecords\(/);
  const queryBlock = extract(patch, 'store.queryNearbySpatial =', '\n\n    store.getSpatialPerformanceDebug =');
  assert.doesNotMatch(queryBlock, /indexRecords\(/);
});

test('[36K PERF] facility layer rebuild is bounded to nearby candidates', () => {
  const layerPatch = extract(coordinator, '  function patchFacilityLayer(store) {', '\n  function install() {');
  assert.match(layerPatch, /layer\.rebuildIfReady = \(force = false\) =>/);
  assert.match(layerPatch, /queryNearby\(store, center\.x, center\.z, radius/);
  assert.match(layerPatch, /limit: cap/);
  assert.match(layerPatch, /prioritizeMajor: true/);
  assert.match(layerPatch, /store\.getAllRecords = \(\) => nearby\.map/);
  assert.match(layerPatch, /store\.getAllRecords = originalGetAllRecords/);
  assert.doesNotMatch(layerPatch, /indexRecords\(store\.getAllRecords\(\)\)/);
});

test('[36K PERF] existing 24-ward source and exact building picking remain intact', () => {
  assert.match(html, /\[Mission 36J LAZY\] 24-ward facility lazy loading/);
  assert.match(html, /areaId: 'osaka-city'/);
  assert.match(html, /ward-manifest\.json/);
  assert.match(html, /function pickBuilding\(rayObj\) \{/);
  assert.match(html, /function buildingFromHit\(hit\) \{/);
  assert.match(html, /ud\.crTriBuilding\[hit\.faceIndex\]/);
  assert.match(html, /CanonicalRuntime\.pickBuilding\(ray\)/);
});

test('[36K PERF] optimization stays dev-preview-only', () => {
  assert.match(preview, /DEV_UI_SCRIPT = '\/livecity-dev-ui-coordinator\.js'/);
  assert.match(preview, /path\.basename\(abs\) !== DEV_UI_HTML/);
  for (const p of [PROD, PROTECTED]) {
    const source = fs.readFileSync(p, 'utf8');
    assert.doesNotMatch(source, /Mission 36K PERF/);
    assert.doesNotMatch(source, /livecity-dev-ui-coordinator\.js/);
  }
});
