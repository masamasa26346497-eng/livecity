'use strict';
// Mission 39B: 3D 建物は選択された区だけ mount する。静的な配線の確認＋保存済み実 Chrome QA 結果の整合。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');

test('起動時に tileset を読まない（建物レイヤーの mount は何も取得しない）', () => {
  const m = html.match(/const buildingLayer = \{[\s\S]*?applyVisible/);
  assert.ok(m);
  assert.doesNotMatch(m[0], /Cesium3DTileset\.fromUrl/);
  assert.doesNotMatch(html, /EXTRA_NEAR_M|updateExtraNear|exGate/, 'カメラ近接のポーリングは廃止');
});

test('区ごとの mount/unmount は generation token で古い非同期結果を捨てる', () => {
  assert.match(html, /const gen = \+\+bldgGen/);
  assert.match(html, /if \(gen !== bldgGen\) \{ try \{ ts\.destroy\(\)/);
  assert.match(html, /function unmountBuildings\(\)[\s\S]*scene\.primitives\.remove\(tileset\)[\s\S]*scene\.primitives\.remove\(e\.tileset\)/);
});

test('区選択・セレクト・未整備区の表示が配線されている', () => {
  assert.match(html, /id="sel-bldg-ward"/);
  assert.match(html, /建物を表示しない/);
  assert.match(html, /3D建物未整備/);
  assert.match(html, /selected = w; setBuildingWard\(w\.wardCode\)/);
});

test('POI 予算・LRU・座標定数・課金ロックは触っていない', () => {
  assert.match(html, /maxCachedWards: 3/);
  assert.match(html, /poiSyncAll/);
  assert.doesNotMatch(html, /googleapis\.com|maps\.google/);
});

const qaFile = path.join(ROOT, 'data/reports/mission39b-ward-select/ward-select-qa.json');
test('保存済み実 Chrome QA: 全段階 pass・JS 例外 0・Google 通信 0', { skip: !fs.existsSync(qaFile) }, () => {
  const q = JSON.parse(fs.readFileSync(qaFile, 'utf8'));
  assert.equal(q.fatal, undefined);
  assert.equal(q.steps[0].tilesets, 0, '初期は 0 区');
  for (const s of q.steps) assert.notEqual(s.pass, false, s.label);
  assert.equal(q.jsErrorCount, 0);
  assert.equal(q.googleRequestCount, 0);
  assert.ok(q.loop.tilesets.every((n) => n === 1), '繰り返し切替で tileset が増えない');
});
