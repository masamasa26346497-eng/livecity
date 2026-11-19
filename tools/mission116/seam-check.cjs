#!/usr/bin/env node
'use strict';
// Mission 118: read-only seam check between two wards' layers (e.g. chuo clipVersion 2 next to a neighbour still at clipVersion 1).
//   node tools/mission116/seam-check.cjs --a <layers dir A> --b <layers dir B> [--tol 3]
// Line layers only. Reports:
//   overlap : vertices of one ward lying inside the OTHER ward's polygon (v1 keeps one outside neighbour vertex -> duplicated drawing)
//   gap     : A's line END points sitting on A's boundary with no B vertex within tol metres (visible cut)
// Writes nothing.
const fs = require('fs');
const path = require('path');
const LINES = ['roads', 'waterways', 'railways'];
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
function ringHas(r, x, z) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
const inPolys = (polys, x, z) => polys.some((p) => ringHas(p.outer, x, z) && !(p.holes || []).some((h) => ringHas(h, x, z)));
function lines(dir) {
  const out = [];
  for (const l of LINES) {
    const j = read(path.join(dir, l + '.json'));
    if (j) for (const f of j.features || []) if (f.kind !== 'area' && f.p && f.p.length > 1) out.push({ layer: l, p: f.p });
  }
  return out;
}
/** linesA/B = [{p:[[x,z],...]}]; polysA/B = ward polygons [{outer,holes}]; tol in metres. */
function seam(linesA, linesB, polysA, polysB, tol) {
  tol = tol || 3;
  const cell = tol, grid = new Map();
  for (const f of linesB) for (const q of f.p) {
    const k = Math.floor(q[0] / cell) + ',' + Math.floor(q[1] / cell);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(q);
  }
  const near = (x, z) => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const q of grid.get((cx + i) + ',' + (cz + j)) || []) if (Math.hypot(q[0] - x, q[1] - z) <= tol) return true;
    }
    return false;
  };
  let overlapBinA = 0, overlapAinB = 0, ends = 0, gaps = 0;
  for (const f of linesB) for (const q of f.p) if (inPolys(polysA, q[0], q[1])) overlapBinA++;
  for (const f of linesA) for (const q of f.p) if (inPolys(polysB, q[0], q[1])) overlapAinB++;
  const eps = 0.5;
  for (const f of linesA) {
    for (const q of [f.p[0], f.p[f.p.length - 1]]) {
      const edge = !inPolys(polysA, q[0] + eps, q[1]) || !inPolys(polysA, q[0] - eps, q[1]) || !inPolys(polysA, q[0], q[1] + eps) || !inPolys(polysA, q[0], q[1] - eps);
      if (!edge) continue;
      ends++;
      if (!near(q[0], q[1])) gaps++;
    }
  }
  return { tolM: tol, verticesOfBInsideA: overlapBinA, verticesOfAInsideB: overlapAinB, boundaryEndsOfA: ends, boundaryEndsOfAWithoutNeighbourWithinTol: gaps };
}
function main() {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  if (!opt('a') || !opt('b')) { console.error('usage: --a <layers dir> --b <layers dir> [--tol 3]'); process.exit(2); }
  const W = read(path.join(__dirname, '..', '..', 'public/mission37g-data/osaka-24-wards.json')).wards;
  const polys = (d) => { const r = read(path.join(d, 'layers-report.json')); const w = r && W.find((x) => x.wardId === r.ward); return w ? w.polygons : null; };
  const pa = polys(opt('a')), pb = polys(opt('b'));
  if (!pa || !pb) { console.error('layers-report.json with a known ward is required in both dirs'); process.exit(2); }
  console.log(JSON.stringify(seam(lines(opt('a')), lines(opt('b')), pa, pb, opt('tol') ? parseFloat(opt('tol')) : 3), null, 1));
}
module.exports = { seam, inPolys, lines };
if (require.main === module) main();
