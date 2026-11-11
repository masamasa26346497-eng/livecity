'use strict';
// [Mission 74] 変換経路の独立 fixture と parallax74 フックの静的テスト。実データ・実ブラウザは使わない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const M = require('../tools/mission74-parallax-model.cjs');
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');

test('projection constants match the viewer (unchanged)', () => {
  assert.ok(html.includes('const PROJ = { clat: 34.604208, clon: 135.525020, mpd: 111320 };'));
  assert.deepStrictEqual(M.PROJ, { clat: 34.604208, clon: 135.525020, mpd: 111320 });
});
test('local -> WGS84 -> local round trip is exact', () => {
  for (const [x, z] of [[0, 0], [-2250, -750], [3000, 4000], [-9000, 9000]]) {
    const b = M.toLocal(M.toLon(x), M.toLat(z));
    assert.ok(Math.hypot(b.x - x, b.z - z) < 1e-6);
  }
});
test('source -> tile ENU -> ECEF equals direct ECEF within 1 mm over a 500 m tile and 150 m height', () => {
  for (const [x, z, h] of [[-2250, -750, 0], [-2000, -500, 120], [-2499, -774, 8]]) {
    assert.ok(M.chainError(x, z, h, { x: -2250, z: -750 }) < 1e-3);
  }
});
test('parallax: shift scales with height and off-nadir angle; zero looking straight down', () => {
  assert.strictEqual(M.parallaxShift(30, 0), 0);
  assert.ok(Math.abs(M.parallaxShift(30, 45) - 30) < 1e-9);
  assert.ok(M.parallaxShift(30, 60) > M.parallaxShift(30, 30));
});
test('parallax74 hook is inside the qa gate, read-only, prints no ids/coordinates', () => {
  const gate = html.indexOf("get('qa') === '1'");
  const a = html.indexOf('parallax74(cols, rows) {'), e = html.indexOf('// 64: 再現用スナップショット');
  assert.ok(gate > 0 && a > gate && e > a);
  const body = html.slice(a, e);
  for (const bad of ['fetch(', 'dispatchEvent', 'selectPoi(', 'flyTo', 'lookAt', '.show =', 'setVisible', 'canonicalId', 'getProperty(']) assert.ok(!body.includes(bad), bad);
  for (const k of ['roundTripM', 'predictedApparentShiftM', 'offNadirDeg', 'roofAboveGroundM']) assert.ok(body.includes(k), k);
});
test('model tool is offline and read-only', () => {
  const src = fs.readFileSync('tools/mission74-parallax-model.cjs', 'utf8');
  for (const bad of ['http', 'fetch(', 'writeFile', 'unlink', 'child_process']) assert.ok(!src.includes(bad), bad);
});
