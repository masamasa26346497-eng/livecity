'use strict';
// [Mission 66] probe/probePair は localhost + ?qa=1 ブロック内に限られ、読み取り専用で、誤称をしないこと。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');
const guide = fs.readFileSync('MISSION65_PC_QA_GUIDE.md', 'utf8');
const gate = html.indexOf("get('qa') === '1'");
const a = html.indexOf('probe(px, py) {'), b = html.indexOf('probePair(a, b) {'), end = html.indexOf('// 64: 建物を単色');
test('probe hooks live inside the qa gate', () => { assert.ok(gate > 0 && a > gate && b > a && end > b); });
test('probe body is read-only and has no network/selection calls', () => {
  const body = html.slice(a, end);
  for (const bad of ['fetch(', 'dispatchEvent', 'selectPoi(', 'flyTo', 'lookAt', '.show =', 'setVisible', '.style =']) assert.ok(!body.includes(bad), bad);
  for (const k of ['depthLocal', 'groundLocal', 'reprojectPx', 'visibleLayers', 'tilesReady', 'globeLevels']) assert.ok(body.includes(k), k);
});
test('probePair does not call the delta a horizontal error', () => {
  assert.ok(!/horizontalError|水平誤差:/.test(html.slice(b, end)));
  assert.match(html.slice(b, end), /sameCamera/);
});
test('guide documents probe, limits and undetermined cause', () => {
  assert.match(guide, /probePair/); assert.match(guide, /Not measurable/); assert.match(guide, /undetermined/);
});
