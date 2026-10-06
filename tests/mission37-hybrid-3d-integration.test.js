import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const preview = fs.readFileSync('tools/preview.js', 'utf8');
const toggle = fs.readFileSync('public/livecity-hybrid-3d-toggle.js', 'utf8');
const compare = fs.readFileSync('public/mission37-livecity-hybrid-3d-compare.html', 'utf8');

test('[Mission37] dev preview injects the hybrid launcher', () => {
  assert.ok(preview.includes('/livecity-hybrid-3d-toggle.js'));
  assert.ok(toggle.includes('Cesium POC'));
  assert.ok(toggle.includes('mission37-livecity-hybrid-3d-poc.html'));
});

test('[Mission37] side-by-side comparison page exists', () => {
  assert.ok(compare.includes('osaka_3d_buildings.ward-ux-v1.html'));
  assert.ok(compare.includes('mission37-livecity-hybrid-3d-poc.html'));
});

test('[Mission37] production pages are not patched by launcher source', () => {
  assert.ok(!toggle.includes('osaka_3d_buildings.html'));
  assert.ok(!toggle.includes('osaka_3d_buildings.fullward-v3.html'));
});


test('[Mission37] Cesium click is bridged to existing Live City photo index', () => {
  const html = fs.readFileSync('public/mission37-livecity-hybrid-3d-poc.html', 'utf8');
  assert.ok(html.includes('/map-data/osaka-city/derived/building-photo-index.json'));
  assert.ok(html.includes('ScreenSpaceEventType.LEFT_CLICK'));
  assert.ok(html.includes('pickPosition'));
  assert.ok(html.includes('nearestPhotoBuilding'));
  assert.ok(html.includes('canonicalId'));
});

test('[Mission37] photo index stays lazy until building interaction', () => {
  const html = fs.readFileSync('public/mission37-livecity-hybrid-3d-poc.html', 'utf8');
  assert.ok(html.includes('let photoIndexPromise = null'));
  assert.ok(html.includes('async function loadPhotoSpatialIndex'));
  assert.ok(!html.includes('<script src="/map-data/osaka-city/derived/building-photo-index.json'));
});


test('[Mission37] exact canonical footprint lookup is preferred', () => {
  const html = fs.readFileSync('public/mission37-livecity-hybrid-3d-poc.html','utf8');
  const lookup = fs.readFileSync('public/livecity-cesium-building-lookup.js','utf8');
  assert.ok(html.includes('livecity-cesium-building-lookup.js'));
  assert.ok(html.includes('exactCanonicalBuilding'));
  assert.ok(html.includes('photoRecordForCanonicalId'));
  assert.ok(lookup.includes('pointInFeature'));
  assert.ok(lookup.includes('buildingsAtLatLon'));
  assert.ok(lookup.includes('derived-v4-final/near/buildings'));
  assert.ok(lookup.includes('for (let dx=-1; dx<=1; dx++)'));
});
