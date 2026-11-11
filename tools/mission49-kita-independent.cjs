#!/usr/bin/env node
'use strict';
// Mission 49: independent check of tracked Kita (Yodogawa side) PLATEAU buildings against public GSI vector tiles
// (WA water area, RdEdg road edges, BldA buildings). Read-only. Footprints are recovered from the tracked 3D Tiles GLBs.
//   node tools/mission49-kita-independent.cjs --ts public/mission37h-3dtiles/kita-sample --ref temp/gsi49/kita-sample --out data/reports/mission49/kita.json
// Same questions as the old Three.js fixes: (a) do buildings sit in water (Okawa 29% symptom), (b) do buildings cross
// real road edges (RdEdg, the road boundary adopted in 31G ALIGNMENT-RESET), (c) is there a rigid shift that lowers (a)+(b)?
// GSI BldA is the control: its own footprints should show the baseline for (a)/(b) with a perfectly consistent source.
const fs = require('fs'), path = require('path');
const M = require('./lib/mission46d-mvt.cjs');
const G = require('./lib/mission49-glb-footprints.cjs');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const TS = arg('--ts', 'public/mission37h-3dtiles/kita-sample'), REF = arg('--ref', 'temp/gsi49/kita-sample');
const OUT = arg('--out', 'data/reports/mission49/kita.json');

function loadRef(dir) {
  const L = { WA: [], RdEdg: [], BldA: [] };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.pbf'))) {
    const [z, x, y] = f.replace('.pbf', '').split('_').map(Number);
    const layers = M.decodeMvt(fs.readFileSync(path.join(dir, f)));
    for (const k of Object.keys(L)) if (layers[k]) for (const ft of M.layerToLocal(layers[k], z, x, y)) L[k].push(ft);
  }
  return L;
}
function pipEO(x, z, rings) { // even-odd across all rings of one feature
  let c = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
const bboxOf = (rings) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const r of rings) for (const [x, z] of r) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); } return [a, b, c, d]; };
function area(r) { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(s) / 2; }

const ref = loadRef(REF);
const fps = G.allFootprints(TS).map((b) => ({ id: b.id, ring: b.ring }));
const bld = ref.BldA.map((f, i) => ({ id: 'gsi' + i, ring: f.rings[0] })).filter((b) => b.ring && b.ring.length >= 3);

// --- water raster (1 m) ---
let X0 = 1e9, Z0 = 1e9, X1 = -1e9, Z1 = -1e9;
for (const b of fps) for (const [x, z] of b.ring) { X0 = Math.min(X0, x); Z0 = Math.min(Z0, z); X1 = Math.max(X1, x); Z1 = Math.max(Z1, z); }
const PAD = 60; X0 = Math.floor(X0 - PAD); Z0 = Math.floor(Z0 - PAD); X1 = Math.ceil(X1 + PAD); Z1 = Math.ceil(Z1 + PAD);
const W = X1 - X0 + 1, H = Z1 - Z0 + 1;
const water = new Uint8Array(W * H);
for (const f of ref.WA) {
  if (f.type !== 3) continue;
  const bb = bboxOf(f.rings);
  for (let z = Math.max(Z0, Math.floor(bb[1])); z <= Math.min(Z1, Math.ceil(bb[3])); z++)
    for (let x = Math.max(X0, Math.floor(bb[0])); x <= Math.min(X1, Math.ceil(bb[2])); x++)
      if (pipEO(x + 0.5, z + 0.5, f.rings)) water[(z - Z0) * W + (x - X0)] = 1;
}
let waterCells = 0; for (const v of water) waterCells += v;
const isWater = (x, z) => { const ix = Math.floor(x) - X0, iz = Math.floor(z) - Z0; return ix >= 0 && iz >= 0 && ix < W && iz < H && water[iz * W + ix] === 1; };

// interior sample points (3 m grid, inside polygon)
function interior(b, step) {
  const bb = bboxOf([b.ring]); const pts = [];
  for (let z = bb[1] + step / 2; z < bb[3]; z += step) for (let x = bb[0] + step / 2; x < bb[2]; x += step) if (pipEO(x, z, [b.ring])) pts.push([x, z]);
  if (!pts.length) { let cx = 0, cz = 0; for (const p of b.ring) { cx += p[0]; cz += p[1]; } pts.push([cx / b.ring.length, cz / b.ring.length]); }
  return pts;
}
function waterStats(list, dx, dz, keep) {
  let pts = 0, wet = 0, bw = 0, bw20 = 0; const wetIds = [];
  for (const b of list) {
    const p = b._pts || (b._pts = interior(b, 3)); let w = 0;
    for (const [x, z] of p) if (isWater(x + dx, z + dz)) w++;
    pts += p.length; wet += w;
    if (w > 0) bw++;
    if (w / p.length >= 0.2) { bw20++; if (keep) wetIds.push({ id: b.id, frac: +(w / p.length).toFixed(2) }); }
  }
  return { samples: pts, wetSamples: wet, wetPct: +(100 * wet / pts).toFixed(3), buildingsWithAnyWater: bw, buildingsOver20pctWater: bw20, wetIds };
}

// --- road edge crossing ---
const CELL = 40, eg = new Map(); const key = (i, j) => i + ',' + j;
const edges = [];
for (const f of ref.RdEdg) for (const r of f.rings) for (let i = 0; i + 1 < r.length; i++) edges.push([r[i][0], r[i][1], r[i + 1][0], r[i + 1][1]]);
edges.forEach((e, n) => {
  const a = Math.floor(Math.min(e[0], e[2]) / CELL), b = Math.floor(Math.max(e[0], e[2]) / CELL), c = Math.floor(Math.min(e[1], e[3]) / CELL), d = Math.floor(Math.max(e[1], e[3]) / CELL);
  for (let i = a; i <= b; i++) for (let j = c; j <= d; j++) { const k = key(i, j); if (!eg.has(k)) eg.set(k, []); eg.get(k).push(n); }
});
function segX(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1x = bx - ax, d1z = bz - az, d2x = dx - cx, d2z = dz - cz, den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * d2z - (cz - az) * d2x) / den, u = ((cx - ax) * d1z - (cz - az) * d1x) / den;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999 ? t : null;
}
// crossing = a footprint side that properly intersects a road-edge segment, penetration >= MINPEN (m) to ignore touching
function crossStats(list, dx, dz, keep) {
  let crossB = 0, cross = 0; const ids = [];
  for (const b of list) {
    const r = b.ring; let hit = 0;
    for (let i = 0; i < r.length; i++) {
      const ax = r[i][0] + dx, az = r[i][1] + dz, bx = r[(i + 1) % r.length][0] + dx, bz = r[(i + 1) % r.length][1] + dz;
      const seen = new Set();
      const i0 = Math.floor(Math.min(ax, bx) / CELL), i1 = Math.floor(Math.max(ax, bx) / CELL), j0 = Math.floor(Math.min(az, bz) / CELL), j1 = Math.floor(Math.max(az, bz) / CELL);
      for (let ci = i0; ci <= i1; ci++) for (let cj = j0; cj <= j1; cj++) for (const n of eg.get(key(ci, cj)) || []) {
        if (seen.has(n)) continue; seen.add(n);
        const e = edges[n]; if (segX(ax, az, bx, bz, e[0], e[1], e[2], e[3]) !== null) hit++;
      }
    }
    if (hit) { crossB++; cross += hit; if (keep) ids.push(b.id); }
  }
  return { buildings: list.length, buildingsCrossingRoadEdge: crossB, crossPct: +(100 * crossB / list.length).toFixed(2), crossings: cross, ids };
}

const r = {
  generated: new Date().toISOString(), source: 'PLATEAU 3D Tiles (tracked, footprints recovered from GLB) vs GSI optimal_bvmap-v1 z16 (WA, RdEdg, BldA)',
  window: { x: [X0, X1], z: [Z0, Z1] }, tiles: fs.readdirSync(REF).filter((x) => x.endsWith('.pbf')).length,
  counts: { plateauBuildings: fps.length, gsiBldA: bld.length, gsiWaterPolygons: ref.WA.length, gsiRdEdgSegments: edges.length, waterCells, waterAreaM2: waterCells },
};
// BldA clipped at tile borders -> drop tiny/degenerate slivers
const bldOk = bld.filter((b) => area(b.ring) > 4);
r.plateau = { water: waterStats(fps, 0, 0, true), roadEdge: crossStats(fps, 0, 0, true) };
r.gsiBldAControl = { water: waterStats(bldOk, 0, 0, true), roadEdge: crossStats(bldOk, 0, 0, true) };
// rigid shift search: objective = buildingsWithAnyWater-weighted wet samples + crossing buildings
const grid = [];
for (let dx = -24; dx <= 24; dx += 4) for (let dz = -24; dz <= 24; dz += 4) {
  const w = waterStats(fps, dx, dz, false), c = crossStats(fps, dx, dz, false);
  grid.push({ dx, dz, wetSamples: w.wetSamples, crossingBuildings: c.buildingsCrossingRoadEdge });
}
const score = (g) => g.wetSamples / r.plateau.water.samples * 100 + g.crossingBuildings / fps.length * 100;
const base = grid.find((g) => g.dx === 0 && g.dz === 0);
const best = grid.slice().sort((a, b) => score(a) - score(b))[0];
r.shiftSearch = { stepM: 4, rangeM: 24, atZero: { ...base, score: +score(base).toFixed(3) }, best: { ...best, score: +score(best).toFixed(3) }, minAtZero: best.dx === 0 && best.dz === 0 };
// fine search around zero (1 m) and per-quadrant search (2 m, +-8) to detect LOCAL drift that a global shift would hide
const fine = [];
for (let dx = -6; dx <= 6; dx += 1) for (let dz = -6; dz <= 6; dz += 1) {
  const w = waterStats(fps, dx, dz, false), c = crossStats(fps, dx, dz, false);
  fine.push({ dx, dz, wetSamples: w.wetSamples, crossingBuildings: c.buildingsCrossingRoadEdge });
}
const bestFine = fine.slice().sort((a, b) => score(a) - score(b))[0];
r.shiftSearch.fine = { rangeM: 6, stepM: 1, best: { ...bestFine, score: +score(bestFine).toFixed(3) }, minAtZero: bestFine.dx === 0 && bestFine.dz === 0 };
const cx = fps.map((b) => b.ring[0][0]).sort((a, b) => a - b)[fps.length >> 1], cz = fps.map((b) => b.ring[0][1]).sort((a, b) => a - b)[fps.length >> 1];
r.shiftSearch.quadrants = [];
for (const [qn, f] of [['NW', (b) => b.ring[0][0] < cx && b.ring[0][1] < cz], ['NE', (b) => b.ring[0][0] >= cx && b.ring[0][1] < cz], ['SW', (b) => b.ring[0][0] < cx && b.ring[0][1] >= cz], ['SE', (b) => b.ring[0][0] >= cx && b.ring[0][1] >= cz]]) {
  const sub = fps.filter(f); let bestQ = null;
  for (let dx = -8; dx <= 8; dx += 2) for (let dz = -8; dz <= 8; dz += 2) {
    const c = crossStats(sub, dx, dz, false), w = waterStats(sub, dx, dz, false);
    const s = w.wetSamples / Math.max(1, w.samples) * 100 + c.buildingsCrossingRoadEdge / sub.length * 100;
    if (!bestQ || s < bestQ.s) bestQ = { dx, dz, s: +s.toFixed(3), crossPct: c.crossPct, n: sub.length };
  }
  r.shiftSearch.quadrants.push({ quadrant: qn, ...bestQ });
}
// ownership of the water overlap: which tracked footprints are most wet (top 15), for visual inspection
r.plateau.water.wetIds = r.plateau.water.wetIds.sort((a, b) => b.frac - a.frac).slice(0, 15);
r.plateau.roadEdge.ids = r.plateau.roadEdge.ids.slice(0, 15);
r.gsiBldAControl.water.wetIds = r.gsiBldAControl.water.wetIds.slice(0, 5);
r.gsiBldAControl.roadEdge.ids = [];
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(r, null, 1));
console.log(JSON.stringify({ counts: r.counts, plateau: { w: { ...r.plateau.water, wetIds: undefined }, c: { ...r.plateau.roadEdge, ids: undefined } }, gsiControl: { w: { ...r.gsiBldAControl.water, wetIds: undefined }, c: { ...r.gsiBldAControl.roadEdge, ids: undefined } }, shift: r.shiftSearch }, null, 1));
