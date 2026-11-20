'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');
const T = (() => { const ctx = { self: {} }; require('vm').runInNewContext(fs.readFileSync('public/mission145-towns.js', 'utf8'), ctx); return ctx.self.LiveCityTowns145; })();

test('151: 24区の町名ラベルは住吉区(37D lblStyle)と同じ濃紺文字+明るい縁取り、背景ボックスなし', () => {
  const m = html.match(/function townLabelOpts[\s\S]*?\n  \}\n/)[0];
  assert.match(m, /#16305a/);
  assert.match(m, /#f4f7fb/);
  assert.match(m, /outlineWidth: 3/);
  assert.doesNotMatch(m, /showBackground/);
  assert.match(m, /toCart\(x, z, 8\)/);
});
test('151: 町名は駅と別レイヤー(towns24)で、駅ラベルは blockers としてのみ参照', () => {
  assert.match(html, /id: 'towns24'/);
  assert.match(html, /blockers/);
  assert.doesNotMatch(html.match(/function townEnsureWard[\s\S]*?\n  \}\n/)[0], /stationLayer/);
});
test('151: 初回・トグル時に townTick を即時実行し、複数区を判定する', () => {
  assert.match(html, /\[0\.25, 0\.5\], \[0\.75, 0\.5\]/);
  assert.ok((html.match(/setTimeout\(\(\) => \{ try \{ townTick\(\)/g) || []).length >= 2);
});
test('151: declutter は blockers の矩形に重なる町名を落とす', () => {
  const items = [{ x: 100, y: 100, text: '長居東', pri: 5, fs: 15 }, { x: 400, y: 300, text: '北浜', pri: 1, fs: 15 }];
  const keep = T.declutter(items, 10, { w: 800, h: 600, blockers: [[40, 60, 160, 110]] });
  assert.equal(keep.has(0), false);
  assert.equal(keep.has(1), true);
  assert.equal(T.declutter(items, 10, { w: 800, h: 600 }).size, 2);
});
