#!/usr/bin/env node
'use strict';
// Mission 73: 「道路は見えるのに建物が無い街区」の候補原因の一つ＝遠景 LOD(37B coarsen) による棟の脱落、を数える。READ-ONLY・ネットワークなし。
//   node tools/mission73-coarse-lod-loss.cjs [--src <buildings/osaka-<区> dir>] [--min-area 100] [--cell 100] [--out <json>]
// 既定 src は追跡済みの住吉区 52 tile。オーナー PC では --src に北区の旧タイルを指定できる。
// 出力は集計値のみ（ID・座標は出さない）。coarsen() は変換器と同一関数を使う。
// 見るもの: (a) coarse LOD で脱落する棟の割合、(b) 100m セル内で「棟はあるのに coarse では 0 棟」になるセルの割合。
// これは座標ずれではなく「遠景表示の仕様」の定量化。位置合わせの判定には使わない。
const fs = require('fs');
const path = require('path');
const B = require('./mission37b-build-3dtiles.cjs');

function args(argv) {
  const o = { src: path.join(__dirname, '..', 'public', 'map-data', 'osaka-city', 'buildings', 'osaka-sumiyoshi'), minArea: 100, cell: 100, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') o.src = argv[++i];
    else if (argv[i] === '--min-area') o.minArea = +argv[++i];
    else if (argv[i] === '--cell') o.cell = +argv[++i];
    else if (argv[i] === '--out') o.out = argv[++i];
  }
  return o;
}

function analyze(tiles, minArea, cell) {
  const full = new Map(), coarse = new Map();
  let total = 0, kept = 0;
  for (const t of tiles) {
    const feats = B.loadFeatures(t);
    const keptIds = new Set(B.coarsen(feats, minArea).map((f) => f.id));
    for (const f of feats) {
      let sx = 0, sz = 0;
      for (const p of f.fp) { sx += p[0]; sz += p[1]; }
      const key = Math.floor(sx / f.fp.length / cell) + ',' + Math.floor(sz / f.fp.length / cell);
      total++; full.set(key, (full.get(key) || 0) + 1);
      if (keptIds.has(f.id)) { kept++; coarse.set(key, (coarse.get(key) || 0) + 1); }
    }
  }
  let emptyCells = 0, sparseCells = 0;
  for (const [k, n] of full) {
    const c = coarse.get(k) || 0;
    if (c === 0) emptyCells++;
    else if (c / n < 0.5) sparseCells++;
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 10000) / 100 : null);
  return { buildings: total, keptInCoarse: kept, droppedPct: pct(total - kept, total), cellsWithBuildings: full.size,
    cellsEmptyInCoarse: emptyCells, cellsEmptyInCoarsePct: pct(emptyCells, full.size), cellsUnderHalfInCoarsePct: pct(sparseCells, full.size) };
}

function run(o) {
  const files = fs.readdirSync(o.src).filter((f) => /^tile_.*\.json$/.test(f));
  const tiles = files.map((f) => JSON.parse(fs.readFileSync(path.join(o.src, f), 'utf8')));
  const r = Object.assign({ schema: 'livecity.mission73.coarse-lod-loss/1', tiles: files.length, minAreaM2: o.minArea, cellM: o.cell },
    analyze(tiles, o.minArea, o.cell),
    { note: 'coarse LOD(group) は bbox<minArea の棟を捨てる。leaf は geometricError 0 のため、SSE が大きい/遠いと group が選ばれ小棟が消える。座標ずれの証拠ではない。' });
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(r, null, 2));
  return r;
}

if (require.main === module) console.log(JSON.stringify(run(args(process.argv.slice(2))), null, 2));
module.exports = { analyze, run, args };
