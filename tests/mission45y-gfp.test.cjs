'use strict';
// Mission 45Y: 地上輪郭オーバーレイの純ロジック + 座標基準の監査 + ビューアの配線（localhost 限定・既定 OFF）。ブラウザ実行は tools/experiments/mission45y_gfp_e2e.mjs。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const sb = {}; vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/mission45y-gfp.js'), 'utf8'), sb);
const G = sb.LC45Y;
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');

test('tilesNear: tile_<floor(x/500)>_<floor(z/500)> を半径内で列挙', () => {
  const t = G.tilesNear(-2250, -750, 100);
  assert.strictEqual(JSON.stringify(t), '[[-5,-2]]');
  assert.strictEqual(G.tilesNear(0, 0, 10).length, 4);   // 原点は 4 タイルの角
  assert.strictEqual(G.tileName(-5, -2), 'tile_-5_-2.json');
});
test('loops: 閉じた輪郭、頂点 <3 は除外、上限', () => {
  const l = G.loops([{ id: 'a', fp: [[0, 0], [1, 0], [1, 1]] }, { id: 'b', fp: [[0, 0]] }, { id: 'c', fp: [[0, 0], [2, 0], [2, 2], [0, 0]] }]);
  assert.strictEqual(l.length, 2);
  assert.strictEqual(JSON.stringify(l[0].ring[l[0].ring.length - 1]), '[0,0]');
  assert.strictEqual(l[1].ring.length, 4);
  assert.strictEqual(G.loops([{ fp: [[0, 0], [1, 0], [1, 1]] }, { fp: [[0, 0], [1, 0], [1, 1]] }], 1).length, 1);
});
test('roadInsideFraction: 貫通する道路と離れた道路を区別', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.ok(G.roadInsideFraction([[[-5, 5], [15, 5]]], [sq]).fraction > 0.3);
  assert.strictEqual(G.roadInsideFraction([[[-5, 20], [15, 20]]], [sq]).inside, 0);
});
test('座標基準の監査（住吉区の追跡済み公開データ）: 定数同一・高さ基準同一・道路が建物を貫く割合が小さい', () => {
  const r = require('../tools/mission45y-ground-audit.cjs').run();
  assert.strictEqual(r.constants.identical, true);
  assert.strictEqual(r.heightModel.nonZeroZ0Count, 0);
  assert.ok(r.footprints > 10000 && r.roadLines > 900);
  assert.ok(r.roadSamplesInsideFootprint.whole.fraction < 0.01, 'whole=' + r.roadSamplesInsideFootprint.whole.fraction);
  assert.match(r.scope, /NOT verified/);
});
test('ビューア: ?gfp=1 かつ localhost 限定・既定 OFF・元データは配信しない・既存の描画経路は不変', () => {
  assert.ok(html.includes('mission45y-gfp.js'));
  assert.match(html, /GFP_ON = typeof LC45Y !== 'undefined' && \/\^\(localhost\|127\\\.0\\\.0\\\.1\)\$\/\.test\(location\.hostname\) && q\.get\('gfp'\) === '1'/);
  assert.ok(html.includes('LAYER_H.roads)), width: 2, material: gfpMat, depthFailMaterial: gfpMat'));   // 道路と同じ高さ・同じ toCart
  assert.ok(html.includes("'map-data/osaka-city/buildings/osaka-' + k"));                                   // 既に公開配信されているタイルだけ
  assert.ok(html.includes('unsupported'));
  assert.ok(!/google/i.test(fs.readFileSync(path.join(ROOT, 'public/mission45y-gfp.js'), 'utf8')));
  // 45X の維持
  assert.ok(html.includes('singleCullSync'));
  assert.ok(html.includes("stats.wardVec = { ward: wc, state: 'no-layers'"));
});
test('E2E 結果（保存済み・住吉区・headless Linux）: 斜め・真上とも輪郭が ready で例外 0', () => {
  const p = path.join(ROOT, 'data/reports/mission45y/gfp-e2e.json');
  if (!fs.existsSync(p)) return;
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (r.skipped) return;
  for (const v of Object.values(r.views)) { assert.strictEqual(v.gfp.state, 'ready'); assert.ok(v.gfp.loops > 10000); }
  assert.deepStrictEqual(r.errors, []);
});
