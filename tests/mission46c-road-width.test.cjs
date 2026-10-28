'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.resolve(__dirname, '../public/mission37g-osaka-24ward-mvp.html'), 'utf8');

// 実ページから 46C の純粋部分(帯・線幅関数)を切り出して評価する
function load() {
  const a = html.indexOf('const ROAD_BANDS'), b = html.indexOf('function addRoadPl');
  assert.ok(a > 0 && b > a);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(a, b) + '\nthis.f={roadScaleFor,roadW,set:(v)=>{roadScale=v}};', ctx);
  return ctx.f;
}
test('46C: scale shrinks monotonically with height and never reaches zero', () => {
  const f = load();
  const hs = [200, 800, 1500, 2500, 3500, 20000], sc = hs.map(f.roadScaleFor);
  assert.deepStrictEqual(sc, [1, 1, 0.8, 0.6, 0.45, 0.45]);
});
test('46C: near view keeps the original widths; far view shrinks but keeps minimums', () => {
  const f = load();
  f.set(1);
  assert.strictEqual(f.roadW(11), 11); assert.strictEqual(f.roadW(3), 3);
  f.set(0.45);
  assert.ok(f.roadW(11) < 11 && f.roadW(11) >= 2);
  assert.ok(f.roadW(1.8) >= 1);       // local は消さない
  assert.ok(f.roadW(3) >= 1);
});
test('46C: only roads.json is scaled; waterways/railways/gfp untouched; data not moved', () => {
  assert.match(html, /if \(file !== 'roads\.json'\) return coll\.add\(opts\)/);
  assert.match(html, /moveEnd\.addEventListener\(roadScaleSync\)/);
  assert.match(html, /q\.get\('rw'\) === '0'/);          // 従来表示への逃げ道
  assert.ok(!/addRoadPl\([^)]*toCart/.test(html));      // 座標生成は変更なし
  assert.match(html, /roadColls\.delete\(coll\)/);       // destroy でリークしない
});
test('46C: 46X/46Y and existing road styles preserved', () => {
  assert.match(html, /roadStyleWard/);
  assert.match(html, /width: 4\.5, casing: 1\.5/);
  assert.match(html, /gfp45y/);
});
