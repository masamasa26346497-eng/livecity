// Mission 48: road/river centerline vs building footprint overlap, same local plane (read-only).
// Measures length of road/river polyline lying inside building footprints, and searches for a
// systematic rigid shift (dx,dz) that minimises it. A real global offset would show a clear minimum != 0.
const fs = require('fs');
const path = require('path');
const P = path.join(__dirname, '..', 'public') + '/';
const out = process.argv[2] || path.join(__dirname, '..', 'data/reports/mission48-overlap/overlap.json');

const bdir = P + 'map-data/osaka-city/buildings/osaka-sumiyoshi/';
const blds = [];
for (const f of fs.readdirSync(bdir)) {
  if (!/^tile_.*\.json$/.test(f)) continue;
  const t = JSON.parse(fs.readFileSync(bdir + f));
  for (const b of t.buildings) blds.push(b);
}
// spatial grid of footprints
const CELL = 50, grid = new Map();
const key = (i, j) => i + ',' + j;
for (const b of blds) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const [x, z] of b.fp) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  b._bb = [x0, z0, x1, z1];
  for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
    for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
      const k = key(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(b);
    }
}
function inPoly(x, z, fp) {
  let c = false;
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
    const [xi, zi] = fp[i], [xj, zj] = fp[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function insideAny(x, z) {
  const c = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!c) return null;
  for (const b of c) {
    const bb = b._bb;
    if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) continue;
    if (inPoly(x, z, b.fp)) return b;
  }
  return null;
}
const STEP = 1; // metres sampling along polyline
function overlap(features, dx, dz, collect) {
  let total = 0, inside = 0;
  const hits = collect ? new Map() : null;
  for (const f of features) {
    const p = f.p;
    for (let i = 0; i + 1 < p.length; i++) {
      const ax = p[i][0] + dx, az = p[i][1] + dz, bx = p[i + 1][0] + dx, bz = p[i + 1][1] + dz;
      const L = Math.hypot(bx - ax, bz - az); const n = Math.max(1, Math.round(L / STEP));
      const s = L / n;
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n; const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        total += s;
        const b = insideAny(x, z);
        if (b) { inside += s; if (hits) { const h = hits.get(f.id) || { id: f.id, tier: f.tier, highway: f.highway, name: f.name || (f.source && f.source.name), len: 0, bldgs: new Set() }; h.len += s; h.bldgs.add(b.id); hits.set(f.id, h); } }
      }
    }
  }
  return { total, inside, hits };
}
const res = { buildings: blds.length };
for (const layer of ['roads', 'waterways']) {
  const d = JSON.parse(fs.readFileSync(P + 'mission37c-layers/osaka-sumiyoshi-9tile/' + layer + '.json'));
  const feats = d.features;
  const base = overlap(feats, 0, 0, true);
  // shift search +-12 m, 1 m grid
  const grid2 = [];
  let best = { dx: 0, dz: 0, pct: base.inside / base.total };
  for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) {
    const r = overlap(feats, dx, dz, false); const pct = r.inside / r.total;
    grid2.push([dx, dz, +(pct * 100).toFixed(3)]);
    if (pct < best.pct) best = { dx, dz, pct };
  }
  const worst = [...base.hits.values()].sort((a, b) => b.len - a.len).slice(0, 15)
    .map(h => ({ id: h.id, tier: h.tier, highway: h.highway, name: h.name, lenInsideM: +h.len.toFixed(1), buildings: h.bldgs.size }));
  res[layer] = {
    features: feats.length, totalLenM: +base.total.toFixed(0), insideBuildingM: +base.inside.toFixed(0),
    insidePct: +(100 * base.inside / base.total).toFixed(3),
    bestShift: { dx: best.dx, dz: best.dz, insidePct: +(100 * best.pct).toFixed(3) },
    shiftGridPct: grid2, worst,
  };
  console.log(layer, 'total', res[layer].totalLenM, 'inside', res[layer].insideBuildingM, res[layer].insidePct + '%', 'best shift', JSON.stringify(res[layer].bestShift));
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(res, null, 1));
