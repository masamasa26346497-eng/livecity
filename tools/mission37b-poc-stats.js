#!/usr/bin/env node
'use strict';
// Mission 37B: Cesium POC 用の静的指標（ブラウザ不要）。
// 既存 public/map-data/osaka-city/buildings/{dataset}/ を読み取り専用で走査し、
// 指定タイルブロック（tx0..tx1, tz0..tz1）の棟数・タイル数・バイト数・頂点数を出力する。
// 使い方: node tools/mission37b-poc-stats.js [--dataset osaka-sumiyoshi] [--tx0 -2 --tx1 0 --tz0 -1 --tz1 1] [--best 3]
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const dataset = opt('dataset', 'osaka-sumiyoshi');
const dir = path.join(__dirname, '..', 'public', 'map-data', 'osaka-city', 'buildings', dataset);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

const best = parseInt(opt('best', '0'), 10);
if (best > 0) {
  // best×best タイルブロックのうち棟数最大のものを探す
  const c = new Map(manifest.tiles.map(t => [t.tx + ',' + t.tz, t.count]));
  let top = null;
  for (const t of manifest.tiles) {
    let sum = 0, n = 0;
    for (let i = 0; i < best; i++) for (let j = 0; j < best; j++) {
      const v = c.get((t.tx + i) + ',' + (t.tz + j));
      if (v) { sum += v; n++; }
    }
    if (!top || sum > top.sum) top = { tx0: t.tx, tz0: t.tz, tx1: t.tx + best - 1, tz1: t.tz + best - 1, sum, tiles: n };
  }
  console.log(JSON.stringify({ densestBlock: top }));
  process.exit(0);
}

const tx0 = +opt('tx0', -2), tx1 = +opt('tx1', 0), tz0 = +opt('tz0', -1), tz1 = +opt('tz1', 1);
let tiles = 0, buildings = 0, bytes = 0, verts = 0, ids = new Set(), dup = 0, maxH = 0, sumH = 0;
for (const t of manifest.tiles) {
  if (t.tx < tx0 || t.tx > tx1 || t.tz < tz0 || t.tz > tz1) continue;
  const f = path.join(dir, t.file);
  bytes += fs.statSync(f).size;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  tiles++;
  for (const b of d.buildings) {
    buildings++;
    verts += b.fp.length;
    if (ids.has(b.id)) dup++; else ids.add(b.id);
    sumH += b.h; if (b.h > maxH) maxH = b.h;
  }
}
console.log(JSON.stringify({ dataset, block: { tx0, tx1, tz0, tz1 }, tiles, buildings, uniqueIds: ids.size, duplicateIds: dup, bytes, footprintVertices: verts, avgHeight: +(sumH / buildings).toFixed(2), maxHeight: maxH }, null, 2));
