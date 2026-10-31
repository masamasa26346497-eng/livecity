#!/usr/bin/env node
'use strict';
// Mission 51: tracked PLATEAU footprints (recovered from GLB) vs tracked GSI WA water polygons + RdEdg lines inside the
// Mission 50 Okawa/Nakanoshima window. Read-only, no download, no shift applied.
// Per building: vertices inside water, deepest vertex (m from nearest water edge), 3 m grid wet fraction, road-edge crossings.
const fs = require('fs');
const G = require('./lib/mission49-glb-footprints.cjs');
const D = JSON.parse(fs.readFileSync('public/mission50-data/gsi-okawa-nakanoshima.json', 'utf8'));
const B = D.bboxLocal, M = 60;
const inWin = (x, z) => x > B.minX + M && x < B.maxX - M && z > B.minZ + M && z < B.maxZ - M;
const sets = ['kita-sample', 'chuo-sample', 'nishi-sample'];
const fps = [];
for (const s of sets) for (const b of G.allFootprints('public/mission37h-3dtiles/' + s)) if (inWin(b.ring[0][0], b.ring[0][1])) fps.push({ set: s, id: b.id, ring: b.ring });
const W = D.water.map((w) => [w.outer, ...(w.holes || [])]);
const pip = (x, z, rs) => { let c = false; for (const r of rs) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
const segs = []; for (const rs of W) for (const r of rs) for (let i = 0; i + 1 < r.length; i++) segs.push([r[i][0], r[i][1], r[i + 1][0], r[i + 1][1]]);
const dSeg = (x, z, s) => { const dx = s[2] - s[0], dz = s[3] - s[1], l = dx * dx + dz * dz; let t = l ? ((x - s[0]) * dx + (z - s[1]) * dz) / l : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(x - s[0] - t * dx, z - s[1] - t * dz); };
const dWater = (x, z) => { let m = 1e9; for (const s of segs) m = Math.min(m, dSeg(x, z, s)); return m; };
const inWater = (x, z) => W.some((rs) => pip(x, z, rs));
const ls = []; for (const l of D.lines) for (let i = 0; i + 1 < l.length; i++) ls.push([l[i][0], l[i][1], l[i + 1][0], l[i + 1][1]]);
const cross = (a, b, c, d, e, f, g, h) => { const d1x = c - a, d1z = d - b, d2x = g - e, d2z = h - f, den = d1x * d2z - d1z * d2x; if (Math.abs(den) < 1e-9) return false; const t = ((e - a) * d2z - (f - b) * d2x) / den, u = ((e - a) * d1z - (f - b) * d1x) / den; return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999; };
const out = []; let vIn = 0, vTot = 0;
for (const b of fps) {
  const r = b.ring; let nIn = 0, maxIn = 0;
  for (const [x, z] of r) { vTot++; if (inWater(x, z)) { nIn++; vIn++; maxIn = Math.max(maxIn, dWater(x, z)); } }
  const xs = r.map((p) => p[0]), zs = r.map((p) => p[1]); let pts = 0, wet = 0;
  for (let z = Math.min(...zs) + 1.5; z < Math.max(...zs); z += 3) for (let x = Math.min(...xs) + 1.5; x < Math.max(...xs); x += 3) if (pip(x, z, [r])) { pts++; if (inWater(x, z)) wet++; }
  let rc = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    for (const s of ls) {
      if (Math.max(s[0], s[2]) < Math.min(p[0], q[0]) || Math.min(s[0], s[2]) > Math.max(p[0], q[0]) || Math.max(s[1], s[3]) < Math.min(p[1], q[1]) || Math.min(s[1], s[3]) > Math.max(p[1], q[1])) continue;
      if (cross(p[0], p[1], q[0], q[1], s[0], s[1], s[2], s[3])) rc++;
    }
  }
  let minShore = 1e9; for (const [x, z] of r) minShore = Math.min(minShore, dWater(x, z));
  const c = r.reduce((a, p) => [a[0] + p[0] / r.length, a[1] + p[1] / r.length], [0, 0]);
  out.push({ set: b.set, id: b.id, c: c.map((v) => +v.toFixed(1)), verts: r.length, vertsInWater: nIn, minShoreM: +minShore.toFixed(1), maxDepthIntoWaterM: +maxIn.toFixed(1), samples: pts, wetSamples: wet, wetFrac: pts ? +(wet / pts).toFixed(3) : 0, roadEdgeCrossings: rc });
}
const wetB = out.filter((o) => o.wetSamples > 0);
const sum = {
  generated: new Date().toISOString(), window: B, marginM: M, buildings: out.length, bySet: sets.map((s) => ({ set: s, n: out.filter((o) => o.set === s).length })),
  waterPolygons: D.water.length, roadEdgeLines: D.lines.length, vertices: vTot, verticesInWater: vIn, verticesInWaterPct: +(100 * vIn / vTot).toFixed(2),
  buildingsWithAnyWaterSample: wetB.length, buildingsOver20pctWet: out.filter((o) => o.wetFrac >= 0.2).length, buildingsOver50pctWet: out.filter((o) => o.wetFrac >= 0.5).length,
  buildingsCrossingRoadEdge: out.filter((o) => o.roadEdgeCrossings > 0).length,
  medianMaxDepthWetM: wetB.length ? wetB.map((o) => o.maxDepthIntoWaterM).sort((a, b) => a - b)[wetB.length >> 1] : null,
  nearestToShoreM: out.map((o) => o.minShoreM).sort((a, b) => a - b).slice(0, 10), within10mOfShore: out.filter((o) => o.minShoreM < 10).length, within30mOfShore: out.filter((o) => o.minShoreM < 30).length,
  worstWet: wetB.slice().sort((a, b) => b.wetFrac - a.wetFrac).slice(0, 15),
};
const sc = (dx, dz) => { let w = 0, p = 0; for (const b of fps) for (const q of b.ring) { p++; if (inWater(q[0] + dx, q[1] + dz)) w++; } return +(w / p * 100).toFixed(2); };
const grid = []; for (let dx = -12; dx <= 12; dx += 3) for (let dz = -12; dz <= 12; dz += 3) grid.push({ dx, dz, vertsInWaterPct: sc(dx, dz) });
sum.shift = { rangeM: 12, stepM: 3, atZero: grid.find((g) => !g.dx && !g.dz), best: grid.slice().sort((a, b) => a.vertsInWaterPct - b.vertsInWaterPct)[0] };
fs.mkdirSync('data/reports/mission51', { recursive: true });
fs.writeFileSync('data/reports/mission51/okawa-plateau-vs-gsi.json', JSON.stringify({ summary: sum, buildings: out }, null, 1));
console.log(JSON.stringify(sum, null, 1));
