'use strict';
// Mission 169: 俯瞰/ナビ/データ状態の静的検証(実ブラウザ描画ではない)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

test('overlay.js は構文として有効で、ナビ(俯瞰/LOD2地点/データ状態)を持つ', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/lod2/lod2-overlay.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(src));
  for (const k of ['lc152-ov', 'lc152-data', 'LOD2 地点', 'lod2ov', '駅名・町名ではなく']) assert.ok(src.includes(k), k);
});

test('dataStatus: 路線データ未接続の原因を日本語で返し、24区LOD1未接続も明示する', () => {
  const { dataStatus, extCandidates } = require('../tools/lod2/lod2-preview-serve.cjs');
  const d = dataStatus();
  for (const k of ['lod1Wards', 'stations', 'railOperators', 'towns', 'roads', 'rivers']) assert.ok(k in d && typeof d[k].ok === 'boolean' && d[k].msg, k);
  assert.strictEqual(d.lod1Wards.ok, false);
  assert.match(d.lod1Wards.msg, /未接続/);
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission145-data/stations-24.json'), 'utf8'));
  assert.strictEqual(d.railOperators.ok, !!(st.operatorData && st.operatorData.connected));
  if (!d.railOperators.ok) assert.match(d.railOperators.msg, /路線データ未接続/);
  const c = extCandidates();
  assert.ok(Array.isArray(c));
  for (const x of c) assert.ok(!path.isAbsolute(x.dir), '絶対パスを返さない');
});

test('launcher: --all は俯瞰(lod2ov)、通常は従来どおり lod2fly', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/lod2/lod2-launch.mjs'), 'utf8');
  assert.match(s, /ALL \? 'lod2ov=1' : 'lod2fly=1'/);
});
