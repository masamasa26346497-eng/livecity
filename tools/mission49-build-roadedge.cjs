#!/usr/bin/env node
'use strict';
// Mission 49: export GSI optimal_bvmap-v1 RdEdg (road edge) lines for a small local window as plain JSON for the Cesium viewer.
// Restores the 31G ALIGNMENT-RESET idea ("GSI road edge is the authoritative road outline") as an optional, default-OFF layer.
// Input is the git-ignored GSI tile cache written by tools/mission46d-fetch-gsi-tiles.cjs. Local metres, znorth-neg (same as geoToThree).
//   node tools/mission49-build-roadedge.cjs --ref temp/gsi49/kita-sample --label kita-sample --bbox minX,maxX,minZ,maxZ --out public/mission49-data
// Source/licence: GSI vector tile (基盤地図情報を含む). Cite 国土地理院 when published; the terms are CC BY 4.0 compatible (not independently verified here).
const fs = require('fs'), path = require('path');
const M = require('./lib/mission46d-mvt.cjs');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const REF = arg('--ref'), LABEL = arg('--label'), OUT = arg('--out', 'public/mission49-data');
const bb = (arg('--bbox') || '').split(',').map(Number);
if (!REF || !LABEL || bb.length !== 4 || !bb.every(Number.isFinite) || !/^[a-z0-9-]{2,40}$/.test(LABEL)) { console.error('usage: --ref <dir> --label <id> --bbox minX,maxX,minZ,maxZ [--out dir]'); process.exit(2); }
const [minX, maxX, minZ, maxZ] = bb;
const inB = (p) => p[0] >= minX && p[0] <= maxX && p[1] >= minZ && p[1] <= maxZ;
const r1 = (v) => Math.round(v * 10) / 10;
const lines = []; let tiles = 0;
for (const f of fs.readdirSync(REF).filter((x) => x.endsWith('.pbf'))) {
  const [z, x, y] = f.replace('.pbf', '').split('_').map(Number);
  const layers = M.decodeMvt(fs.readFileSync(path.join(REF, f)));
  if (!layers.RdEdg) continue; tiles++;
  for (const ft of M.layerToLocal(layers.RdEdg, z, x, y)) for (const ring of ft.rings) {
    // keep runs of points inside the window
    let run = [];
    for (const p of ring) { if (inB(p)) run.push([r1(p[0]), r1(p[1])]); else { if (run.length > 1) lines.push(run); run = []; } }
    if (run.length > 1) lines.push(run);
  }
}
const doc = {
  mission: '49', id: LABEL, kind: 'gsi-road-edge', coordinateSystem: 'znorth-neg-v1 (x east m, z south m, origin CLAT/CLON)', unit: 'm',
  bboxLocal: { minX, maxX, minZ, maxZ },
  source: '国土地理院 ベクトルタイル optimal_bvmap-v1 (RdEdg 道路縁), https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/16/{x}/{y}.pbf',
  credit: '国土地理院（基盤地図情報を含む）', fetchedTiles: tiles, zoom: 16,
  note: '道路縁の実測線。OSM 中心線・PLATEAU 建物輪郭とは定義が異なる（SOURCE_SEMANTICS_DIFFERENCE）。窓の外は未収録。',
  lines,
};
fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, 'gsi-roadedge-' + LABEL + '.json');
fs.writeFileSync(file, JSON.stringify(doc));
console.log(JSON.stringify({ file, lines: lines.length, points: lines.reduce((s, l) => s + l.length, 0), bytes: fs.statSync(file).size }));
