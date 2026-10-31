'use strict';
// Mission 37K-2: 画面空間の間引きロジックの単体テスト（純粋関数。ブラウザ実行ではない）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// package.json が "type": "module" のため、.js は vm で評価する（ブラウザと同じ self 経路）
const sandbox = {};
sandbox.self = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public/mission37k-poi-select.js'), 'utf8'), sandbox);
const PS = sandbox.LiveCityPoiSelect;

const opts = (o) => Object.assign({ viewW: 1280, viewH: 720, height: 200 }, o);
const grid = (n, cat, name) => Array.from({ length: n }, (_, i) => ({ x: 20 + (i % 40) * 30, y: 20 + Math.floor(i / 40) * 30, d: i, cat, name: name ? name + i : '' }));

test('点はデスクトップ80/スマホ30を超えない', () => {
  const items = grid(1200, 'shopping', 'S');
  assert.ok(PS.select(items, opts()).points.size <= 80);
  assert.ok(PS.select(items, opts({ viewW: 400, viewH: 700 })).points.size <= 30);
});

test('同じグリッドセルには1点だけ（重なりマーカーを代表点にする）', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ x: 300 + (i % 3), y: 300, d: i, cat: 'shopping', name: 'a' + i }));
  assert.equal(PS.select(items, opts()).points.size, 1);
});

test('ラベルは重ならない・予算内', () => {
  const items = Array.from({ length: 300 }, (_, i) => ({ x: 100 + (i % 30) * 36, y: 100 + Math.floor(i / 30) * 40, d: i, cat: 'education', name: '長い施設名の学校' + i }));
  const r = PS.select(items, opts({ height: 300 }));
  assert.ok(r.labels.size > 0 && r.labels.size <= 14);
  const rects = [...r.labels].map((i) => PS.labelRect(items[i].x, items[i].y, items[i].name));
  for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
    const A = rects[a], B = rects[b];
    assert.ok(!(A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1), 'overlap');
  }
});

test('高度段階: 引くと一般施設の点/文字が消え、ランドマークは残る', () => {
  const gen = grid(100, 'shopping', 'S'), lm = [{ x: 600, y: 360, d: 5, cat: 'tourism', name: '住吉大社' }];
  assert.equal(PS.select(gen, opts({ height: 5000 })).points.size, 0);
  assert.equal(PS.select(gen, opts({ height: 800 })).labels.size, 0);
  assert.ok(PS.select(gen, opts({ height: 300 })).labels.size > 0);
  const r = PS.select(lm, opts({ height: 2000 }));
  assert.ok(r.points.has(0) && r.labels.has(0));
  assert.equal(PS.select(lm, opts({ height: 6000 })).labels.size, 0);
  assert.equal(PS.select(lm, opts({ height: 6000 })).points.size, 1);
});

test('画面外は選ばれない', () => {
  const items = [{ x: -500, y: 10, d: 1, cat: 'public', name: 'x' }, { x: 5000, y: 10, d: 1, cat: 'public', name: 'y' }];
  assert.equal(PS.select(items, opts()).points.size, 0);
});

test('選択中は予算・高度・画面外でも点と名前を維持する', () => {
  const items = grid(500, 'public', 'P');
  items.push({ x: 5000, y: 5000, d: 99999, cat: 'shopping', name: '選択店', selected: true });
  const r = PS.select(items, opts({ height: 9000 }));
  const i = items.length - 1;
  assert.ok(r.points.has(i) && r.labels.has(i));
});

test('優先度: 同じセルならランドマークが一般施設に勝つ', () => {
  const items = [{ x: 100, y: 100, d: 1, cat: 'shopping', name: 'a' }, { x: 100, y: 100, d: 9, cat: 'tourism', name: 'b' }];
  const r = PS.select(items, opts());
  assert.ok(r.points.has(1) && !r.points.has(0));
});
