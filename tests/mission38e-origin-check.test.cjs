'use strict';
// Mission 38E: znorth-neg-v1 原点の静的検証（外部通信なし）。
// 建物 footprint 重心をローカルXZ→緯度経度へ逆変換し、平野区の実在範囲に入るか確認する。
// 範囲は地理的な目安（平野区は概ね北緯34.58–34.66 / 東経135.50–135.60）で、公式境界ではない。PLATEAU原典照合ではない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { repPoint } = require('../tools/mission38e-build-subset.cjs');
const ROOT = path.join(__dirname, '..');
const B = path.join(ROOT, 'public/__test__/ward-poc/buildings');
const proj = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/areas/osaka-city.json'), 'utf8')).projection;
const TILES = ['5_-3', '5_-4', '6_-3', '6_-4'];
const load = (d, k) => JSON.parse(fs.readFileSync(path.join(B, d, 'tile_' + k + '.json'), 'utf8')).buildings;

function toLatLon(x, z) {
  return {
    lat: proj.centerLat - z / proj.metersPerDegree,
    lon: x / (Math.cos(proj.centerLat * Math.PI / 180) * proj.metersPerDegree) + proj.centerLon,
  };
}

test('逆変換した全棟の緯度経度が平野区の地理的目安範囲に入る', () => {
  let n = 0;
  for (const k of TILES) {
    for (const b of load('osaka-hirano', k)) {
      const [x, z] = repPoint(b.fp);
      const { lat, lon } = toLatLon(x, z);
      assert.ok(lat > 34.58 && lat < 34.66 && lon > 135.50 && lon < 135.60, `${b.id} ${lat},${lon}`);
      n++;
    }
  }
  assert.equal(n, 4695);
});

test('投影定数が37B/37C/設定で一致（原点が分岐していない）', () => {
  assert.equal(proj.centerLat, 34.604208);
  assert.equal(proj.centerLon, 135.52502);
  assert.equal(proj.metersPerDegree, 111320);
});

test('平野区subsetのIDが住吉区・東住吉区テストデータと重複しない', () => {
  const mine = new Set();
  for (const k of TILES) for (const b of load('osaka-hirano', k)) mine.add(b.id);
  let overlap = 0;
  for (const d of ['osaka-sumiyoshi', 'osaka-higashisumiyoshi']) {
    for (const f of fs.readdirSync(path.join(B, d))) {
      if (!f.startsWith('tile_')) continue;
      for (const b of JSON.parse(fs.readFileSync(path.join(B, d, f), 'utf8')).buildings) if (mine.has(b.id)) overlap++;
    }
  }
  assert.equal(overlap, 0);
});
