#!/usr/bin/env node
'use strict';
// Mission 37G: 大阪市24区の境界・区コード・建物元データ件数を 1 ファイルにまとめる（読み取り専用の変換）。
//   入力: public/map-data/osaka-city/boundaries/ward-classification-polygons.json  （国土数値情報 N03、国土交通省）
//         public/map-data/osaka-city/buildings/manifest.json                        （citywide 建物元データの件数）
//   出力: public/mission37g-data/osaka-24-wards.json
// 座標は znorth-neg-v1 の局所メートル（x, z）のまま。形状は新規に作らない。変換・投影定数には触れない。
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const bnd = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/boundaries/ward-classification-polygons.json'), 'utf8'));
const man = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/buildings/manifest.json'), 'utf8'));
const r1 = (n) => Math.round(n * 10) / 10;
const ring = (r) => r.map((p) => [r1(p[0]), r1(p[1])]);

const bySrc = new Map(man.datasets.map((d) => [d.wardCode, d]));
const wards = bnd.wards.map((w) => {
  const ds = bySrc.get(w.wardCode) || {};
  return {
    wardId: w.wardId, wardCode: w.wardCode, wardName: w.wardName,
    bbox: w.bbox,
    sourceBuildings: ds.buildings == null ? null : ds.buildings,
    sourceTiles: ds.tiles == null ? null : ds.tiles,
    polygons: w.polygons.map((p) => ({ outer: ring(p.outer), holes: (p.holes || []).map(ring) })),
  };
}).sort((a, b) => a.wardCode.localeCompare(b.wardCode));

const out = {
  mission: '37G',
  coordinateConvention: bnd.coordinateConvention,
  source: bnd.metadata && bnd.metadata.sourceMetadata ? bnd.metadata.sourceMetadata : null,
  cityCode: man.cityCode, cityName: man.cityName,
  sourceBuildingsTotal: man.buildingCount, sourceTilesTotal: man.tileCount,
  wardCount: wards.length,
  wards,
};
const dir = path.join(root, 'public/mission37g-data');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'osaka-24-wards.json'), JSON.stringify(out));
console.log('wards', wards.length, 'bytes', fs.statSync(path.join(dir, 'osaka-24-wards.json')).size);
