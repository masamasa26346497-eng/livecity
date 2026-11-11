'use strict';
// [Mission 75] 真上/復元 QA 切替の静的テスト＋合成 fixture。実ブラウザは使わない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');

const gate = html.indexOf("get('qa') === '1'");
const a = html.indexOf('// 75: 真上(pitch -90)');
const end = html.indexOf('const handler = new Cesium.ScreenSpaceEventHandler');
const body = html.slice(a, end);

test('75 block exists and is inside the QA gate (localhost + ?qa=1)', () => {
  assert.ok(gate > 0 && a > gate && end > a);
  assert.ok(html.includes("/^(localhost|127\\.0\\.0\\.1)$/.test(location.hostname)"));
  // ゲートの if ブロックは 75 ブロックの後で閉じる（パネル生成が QA 外に漏れない）
  const between = html.slice(gate, end);
  assert.ok(between.includes('qa75-panel'));
  assert.ok(!html.slice(0, gate).includes('qa75-panel'));
});
test('top-down uses pitch -90 and keeps camera height; saves/restores position+heading+pitch+roll', () => {
  assert.ok(body.includes('toRadians(-90)'));
  assert.ok(body.includes('Cesium.Cartographic.fromCartesian(cam.positionWC).height'));
  for (const k of ['pos:', 'heading:', 'pitch:', 'roll:']) assert.ok(body.includes(k), k);
  assert.ok(body.includes('if (!saved75) saved75 ='));   // 真上のまま再実行しても元視点を上書きしない
  assert.ok(body.includes('saved75 = null'));
});
test('non-destructive: camera only; no data, LOD, selection, layer or fetch changes', () => {
  for (const bad of ['fetch(', 'dispatchEvent', 'selectPoi(', 'setBuildingWard', 'setVisible', '.show =', 'maximumScreenSpaceError', 'canonicalId', 'getProperty(', 'style =', 'flyTo', 'LAYER_H.', 'PROJ']) assert.ok(!body.includes(bad), bad);
});
test('panel does not interfere with map drag (pointerdown stopped) and copies anonymous stats only', () => {
  assert.ok(body.includes("addEventListener('pointerdown', (e) => e.stopPropagation())"));
  assert.ok(body.includes('parallaxPair75'));
  assert.ok(body.includes('predShiftP50') && body.includes('roundTripMax'));
  assert.ok(body.includes('実際の座標誤差ではない'));
  assert.ok(!/lon|lat\b|positionWC\.[xyz]/.test(body.slice(body.indexOf('const pick ='), body.indexOf('const pick =') + 500)));
});
test('projection constants unchanged', () => {
  assert.ok(html.includes('const PROJ = { clat: 34.604208, clon: 135.525020, mpd: 111320 };'));
});
