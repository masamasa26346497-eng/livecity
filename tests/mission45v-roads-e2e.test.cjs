'use strict';
// Mission 45V: fixture E2E for 45E server -> 45I layers -> viewer -> pixels. Synthetic data only.
// HTTP assertions always run. Browser assertions run only when Chrome + the CesiumJS CDN are reachable; otherwise they are reported as skipped (never as passed).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

test('45V E2E: layers are indexed, served (whitelist/404), mounted at the right level and visible in browser pixels', { timeout: 300000 }, (t) => {
  const stdout = execFileSync(process.execPath, [path.join(ROOT, 'tools/experiments/mission45v_roads_e2e.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 280000, maxBuffer: 1 << 24 });
  const R = JSON.parse(stdout);
  assert.deepStrictEqual(R.http.indexLayersWards, [{ ward: 'kita' }]);
  for (const f of ['roads', 'waterways', 'parks', 'railways', 'labels', 'layers-report']) assert.strictEqual(R.http[f], 200, f);
  assert.strictEqual(R.http.notWhitelisted, 404);
  assert.strictEqual(R.http.wardWithoutLayers, 404);
  assert.ok(R.http.roadFeatures > 0);
  assert.deepStrictEqual(R.errors, []);
  if (R.browser.skipped) { t.diagnostic('browser part skipped: ' + R.browser.skipped); return; }
  assert.strictEqual(R.browser.vecStats.lastError, null);
  const after = R.browser.vecMountedAfter8s['27127'];
  assert.strictEqual(after.level, 'near');
  assert.ok(after.layers.some((l) => /^roads:local:[1-9]/.test(l)), 'local roads built at near level');
  assert.ok(R.browser.roadsVisibleOnScreen, 'roads layer ON/OFF changes canvas pixels');
  assert.ok(!R.browser.badResponses, 'no 4xx/5xx besides favicon');
});

test('45V: the 45E server never lists layers for a ward without a layers dir', () => {
  const E = require('../tools/mission45e-preview.cjs');
  assert.deepStrictEqual(JSON.parse(E.indexJson([], false, null, { wards: [] })).layersWards, []);
  assert.deepStrictEqual(JSON.parse(E.indexJson([], false, null, { wards: ['kita'] })).layersWards, [{ ward: 'kita' }]);
});
