#!/usr/bin/env node
'use strict';
// Mission 114: how much of each ward do the repo's road-edge / water windows actually cover? Read-only; no network.
// The orange line (GSI road edge, #c8801a) and the blue water faces in 37G come from fixed windows only
// (sumiyoshi 9-tile, kita sample, okawa/nakanoshima, sumiyoshi 57). Outside a window nothing is drawn (by design, no guessing).
// Usage: node tools/mission114/layer-coverage.cjs [--out data/reports/mission114/layer-coverage.json] [--cell 50]
const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '..', '..');
const J = (p) => JSON.parse(fs.readFileSync(path.join(repo, p), 'utf8'));

const ROAD_WINDOWS = ['public/mission49-data/gsi-roadedge-sumiyoshi-9tile.json', 'public/mission49-data/gsi-roadedge-kita-sample.json', 'public/mission50-data/gsi-okawa-nakanoshima.json'];
const WATER_WINDOWS = ['public/mission50-data/gsi-okawa-nakanoshima.json', 'public/mission57-data/gsi-sumiyoshi-9tile.json'];

function inBox(b, x, z) { return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ; }
function inRing(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
const inWard = (w, x, z) => (w.polygons || []).some((p) => inRing(p.outer, x, z) && !(p.holes || []).some((h) => inRing(h, x, z)));

function coverage(ward, windows, cell) {
  const b = ward.bbox; let total = 0, cov = 0;
  for (let x = b.minX + cell / 2; x < b.maxX; x += cell) {
    for (let z = b.minZ + cell / 2; z < b.maxZ; z += cell) {
      if (!inWard(ward, x, z)) continue;
      total++;
      if (windows.some((win) => inBox(win, x, z))) cov++;
    }
  }
  return { cells: total, coveredCells: cov, pct: total ? Math.round((cov / total) * 1000) / 10 : null };
}
function classify(pct) { return pct == null ? 'unknown' : pct >= 95 ? 'full' : pct > 0 ? 'partial-window' : 'none'; }

function run(cell) {
  cell = cell || 50;
  const wards = J('public/mission37g-data/osaka-24-wards.json').wards;
  const road = ROAD_WINDOWS.map((f) => Object.assign({ file: f }, J(f).bboxLocal));
  const water = WATER_WINDOWS.map((f) => Object.assign({ file: f }, J(f).bboxLocal));
  const out = wards.map((w) => {
    const r = coverage(w, road, cell), a = coverage(w, water, cell);
    return { wardId: w.wardId, wardCode: w.wardCode, roadEdge: Object.assign({}, r, { status: classify(r.pct) }), water: Object.assign({}, a, { status: classify(a.pct) }) };
  });
  const n = (k, s) => out.filter((o) => o[k].status === s).length;
  return {
    mission: 114, kind: 'repo-window-coverage', cellM: cell, coordinateConvention: 'znorth-neg-v1 (x east, z south-positive, metres)',
    explanation: 'GSI road edge (orange) and GSI water faces (blue) exist only inside fixed windows. Coverage = share of N03 ward area inside any window. 2025 private archives carry no layers/ (unverified).',
    windows: { road: road, water: water }, wards: out,
    summary: { roadFull: n('roadEdge', 'full'), roadPartial: n('roadEdge', 'partial-window'), roadNone: n('roadEdge', 'none'),
      waterFull: n('water', 'full'), waterPartial: n('water', 'partial-window'), waterNone: n('water', 'none') },
  };
}
module.exports = { inRing, inWard, coverage, classify, run, ROAD_WINDOWS, WATER_WINDOWS };
if (require.main === module) {
  const a = process.argv.slice(2); const o = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const rep = run(Number(o('cell', 50)));
  const out = path.resolve(repo, o('out', 'data/reports/mission114/layer-coverage.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rep, null, 1));
  console.log(JSON.stringify(rep.summary));
  for (const w of rep.wards) if (['nishi', 'fukushima', 'yodogawa'].includes(w.wardId)) console.log(w.wardId, 'road', w.roadEdge.pct + '%', 'water', w.water.pct + '%');
}
