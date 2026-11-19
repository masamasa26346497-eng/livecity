'use strict';
// Mission 177: カメラ近傍クリップの選定ロジック(合成データ。実データ・Chrome 描画ではない)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const CN = require('../tools/lod2/lod2-clip-near.cjs');

const fps = [];
for (let i = 0; i < 10698; i++) fps.push({ hull: [[135.30 + (i % 100) * 0.003, 34.55 + Math.floor(i / 100) * 0.0025]] });

test('遠景(高度超過)ではクリップ対象 0 件', () => {
  assert.deepStrictEqual(CN.selectNearby(fps, { lon: 135.45, lat: 34.68, h: 20000 }), []);
});
test('近景では半径内・最大件数に絞られ、10,698 件一括にならない', () => {
  const sel = CN.selectNearby(fps, { lon: 135.45, lat: 34.68, h: 600 });
  assert.ok(sel.length > 0 && sel.length <= CN.DEFAULTS.maxPolys);
  for (const i of sel) assert.ok(CN.distM(135.45, 34.68, fps[i].hull[0][0], fps[i].hull[0][1]) <= CN.DEFAULTS.radiusM);
});
test('選定は 10,698 件でも高速(1回 50ms 未満)', () => {
  const t = process.hrtime.bigint();
  CN.selectNearby(fps, { lon: 135.45, lat: 34.68, h: 600 });
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 50);
});
test('needsUpdate: 同一選定では再構築しない / 大きく動けば再構築', () => {
  const a = CN.selectNearby(fps, { lon: 135.45, lat: 34.68, h: 600 });
  assert.strictEqual(CN.needsUpdate(a, a.slice()), false);
  const b = CN.selectNearby(fps, { lon: 135.55, lat: 34.75, h: 600 });
  assert.strictEqual(CN.needsUpdate(a, b), true);
  assert.strictEqual(CN.needsUpdate(a, []), true);
});
test('overlay.js は構文が通り、near モードを持つ', () => {
  const src = fs.readFileSync(path.join(__dirname, '../tools/lod2/lod2-overlay.js'), 'utf8');
  new Function(src);
  assert.ok(src.includes("'near'") && src.includes('clipnear.js'));
});
