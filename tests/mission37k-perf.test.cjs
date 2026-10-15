'use strict';
// Mission 37K: 静的テスト（ブラウザ実行ではない）。POI の近傍のみ生成・停止中タイマーの抑制・距離閾値の維持を固定する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');

test('POI は近傍のみ生成し、遠方は破棄する（sync）', () => {
  assert.match(html, /function poiSyncAll\(\)/);
  assert.match(html, /POI_PROJECT_MAX = 600/);
  assert.match(html, /layer\.pts\.remove\(e\.px\)/);
  assert.match(html, /layer\.labels\.remove\(e\.lb\)/);
});

test('距離閾値は 37G/37J のまま（点 12000/飲食 3000、ラベル 1400/観光 4000）', () => {
  assert.match(html, /DistanceDisplayCondition\(0, r\.category === 'dining' \? 3000 : 12000\)/);
  assert.match(html, /DistanceDisplayCondition\(0, id === 'spots' \? 4000 : 1400\)/);
  assert.match(html, /const ptMax = r\.category === 'dining' \? 3000 : 12000/);
  assert.match(html, /e\.lbMax = layer\.id === 'spots' \? 4000 : 1400/);
});

test('区別ファイルの飲食店はラベルを作らない（従来仕様）', () => {
  assert.match(html, /!\(e\.fromWard && r\.category === 'dining'\)/);
});

test('定期処理はカメラ停止中は実処理しない', () => {
  assert.match(html, /function makeCamGate\(\)/);
  assert.match(html, /if \(mmGate\(\)\) mmDraw\(\)/);
  assert.doesNotMatch(html, /updateExtraNear|exGate/, '39B: 追加 tileset のカメラ常時ポーリングは廃止');
  assert.doesNotMatch(html, /setInterval\(mmDraw, 500\)/);
});

test('課金ロックと requestRenderMode は変更していない', () => {
  assert.match(html, /requestRenderMode: false/);
  assert.doesNotMatch(html, /maps\.googleapis\.com|places\.googleapis\.com/);
});
