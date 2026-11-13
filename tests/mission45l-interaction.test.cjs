'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sb = {}; sb.window = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/mission45l-interaction.js'), 'utf8'), sb);
const L = sb.LC45L;
const html = fs.readFileSync(path.join(__dirname, '../public/mission37g-osaka-24ward-mvp.html'), 'utf8');

test('pointer 押下中は camera.changed が無くても操作中', () => {
  const ix = L.create();
  ix.pointerDown(1000);
  assert.strictEqual(ix.isActive(5000), true);
  ix.pointerUp(5000);
  assert.strictEqual(ix.isActive(5300), true);   // 慣性ぶんの 400ms
  assert.strictEqual(ix.isActive(5500), false);
});
test('wheel は 220ms 操作中', () => {
  const ix = L.create();
  ix.wheel(100);
  assert.ok(ix.isActive(300));
  assert.ok(!ix.isActive(400));
});
test('操作中フレームと静止フレームを分けて計測', () => {
  const ix = L.create();
  ix.pointerDown(0);
  for (let t = 16; t <= 160; t += 16) ix.frame(t, 16);
  ix.pointerUp(160);
  ix.frame(5000, 4800);   // 静止後の RR 描画（FPS に混ぜない）
  const s = ix.snapshot(5000);
  assert.strictEqual(s.gestureRenders, 10);
  assert.ok(s.fps > 55 && s.fps < 65);
  assert.strictEqual(s.maxMs, 16);
  assert.strictEqual(s.gestures, 1);
});
test('解像度変更は 1 ジェスチャー 1 回、復帰は無制限', () => {
  const ix = L.create();
  ix.pointerDown(0);
  assert.strictEqual(ix.allowResChange(10, false), true);
  assert.strictEqual(ix.allowResChange(20, false), false);
  assert.strictEqual(ix.allowResChange(30, true), true);
  assert.strictEqual(ix.snapshot(30).resChangesInGesture, 1);
  ix.pointerUp(40); ix.frame(2000, 16);   // 静止 → 新しいジェスチャーで予算が戻る
  ix.wheel(3000);
  assert.strictEqual(ix.allowResChange(3010, false), true);
});
test('long task は操作中だけ数える', () => {
  const ix = L.create();
  ix.noteLongTask(80, 0);
  ix.wheel(10); ix.noteLongTask(80, 20);
  assert.strictEqual(ix.snapshot(20).longTasksInGesture, 1);
});
test('snapshot に位置・ID・URL を含まない', () => {
  const s = JSON.stringify(L.create().snapshot(0));
  assert.ok(!/bldg_|https?:|"(lat|lon|lng|x|z)"/i.test(s));
});
test('37G ページ配線: 単一判定・percentageChanged 非上書き・延期・smooth A/B', () => {
  assert.match(html, /mission45l-interaction\.js/);
  assert.match(html, /q\.get\('smooth'\) !== '0'/);
  assert.ok(!/percentageChanged = 0\.05/.test(html));
  assert.match(html, /pointerdown/);
  assert.match(html, /'wheel'/);
  assert.match(html, /window\.__mission45l/);
  assert.match(html, /function scheduleLabels[\s\S]{0,200}isMoving\(\)/);
  assert.match(html, /allowResChange/);
});
