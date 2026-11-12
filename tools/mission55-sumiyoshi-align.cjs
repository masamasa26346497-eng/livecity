// Mission 55: one small area where every source is committed (Sumiyoshi 9 tile).
// Buildings (PLATEAU LOD1 footprints, legacy tiles) vs GSI road edge (RdEdg lines) vs OSM road centrelines vs OSM waterways.
// Read-only. All layers already share one frame: znorth-neg-v1 (x east m, z south m, origin CLAT/CLON, MPD 111320).
// Usage: node tools/mission55-sumiyoshi-align.cjs [out.json]
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const FRAME = { CLAT: 34.604208, CLON: 135.525020, MPD: 111320, axes: 'x east, z south, metres' };

const tileDir = 'public/map-data/osaka-city/buildings/osaka-sumiyoshi';
const setDir = 'public/mission37b-3dtiles/osaka-sumiyoshi-9tile';
const tileNames = fs.readdirSync(path.join(root, setDir, 'ids')).map((f) => f.replace(/\.json$/, '')).filter((n) => n.startsWith('t_')); // t_tx_tz (g_* are LOD groups)
const blds = [];
for (const n of tileNames) {
  const m = n.match(/^t_(-?\d+)_(-?\d+)$/);
  const t = rd(`${tileDir}/tile_${m[1]}_${m[2]}.json`);
  for (const b of t.buildings) blds.push(b);
}
const gsi = rd('public/mission49-data/gsi-roadedge-sumiyoshi-9tile.json').lines;
const roads = rd('public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json').features.filter((f) => f.kind === 'line' && f.p);
const water = rd('public/mission37c-layers/osaka-sumiyoshi-9tile/waterways.json').features.filter((f) => f.p);

function pip(x, z, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function lenInside(a, b, ring, dx, dz) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(L / 0.5));
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    if (pip(a[0] + (b[0] - a[0]) * t + dx, a[1] + (b[1] - a[1]) * t + dz, ring)) k++;
  }
  return L * k / n;
}
function bbox(r) {
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (const [x, z] of r) { if (x < a) a = x; if (x > c) c = x; if (z < b) b = z; if (z > d) d = z; }
  return [a, b, c, d];
}
const polys = blds.map((b) => ({ id: b.id, ring: b.fp, bb: bbox(b.fp) }));
const CELL = 100, grid = new Map();
polys.forEach((p, i) => {
  for (let gx = Math.floor((p.bb[0] - 12) / CELL); gx <= Math.floor((p.bb[2] + 12) / CELL); gx++)
    for (let gz = Math.floor((p.bb[1] - 12) / CELL); gz <= Math.floor((p.bb[3] + 12) / CELL); gz++) {
      const k = gx + ',' + gz;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
});
const near = (x, z) => grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL)) || [];

function edgeInside(lines, dx, dz) {
  let total = 0, inside = 0;
  const hit = new Set();
  for (const ln of lines) for (let i = 0; i + 1 < ln.length; i++) {
    const a = ln[i], b = ln[i + 1];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    const cand = new Set(near((a[0] + b[0]) / 2 + dx, (a[1] + b[1]) / 2 + dz));
    near(a[0] + dx, a[1] + dz).forEach((c) => cand.add(c));
    near(b[0] + dx, b[1] + dz).forEach((c) => cand.add(c));
    for (const ci of cand) {
      const p = polys[ci];
      if (Math.max(a[0], b[0]) + dx < p.bb[0] || Math.min(a[0], b[0]) + dx > p.bb[2] || Math.max(a[1], b[1]) + dz < p.bb[1] || Math.min(a[1], b[1]) + dz > p.bb[3]) continue;
      const l = lenInside(a, b, p.ring, dx, dz);
      if (l > 0) { inside += l; hit.add(p.id); }
    }
  }
  return { total, inside, hit };
}
const pct = (a, b) => +(100 * a / b).toFixed(2);
const g0 = edgeInside(gsi, 0, 0);
const r0 = edgeInside(roads.map((f) => f.p), 0, 0);
const w0 = edgeInside(water.map((f) => f.p), 0, 0);
const sweep = [];
for (let dx = -8; dx <= 8; dx += 2) for (let dz = -8; dz <= 8; dz += 2) sweep.push({ dx, dz, insideM: +edgeInside(gsi, dx, dz).inside.toFixed(1) });
sweep.sort((a, b) => a.insideM - b.insideM);
const at0 = sweep.find((s) => s.dx === 0 && s.dz === 0);
const rep = {
  mission: 55, area: 'osaka-sumiyoshi 9 tile', frame: FRAME,
  sources: {
    buildings: 'PLATEAU Osaka-shi 2024 CityGML LOD1 footprints (same tiles as the committed 3D Tiles)',
    roadEdge: 'GSI optimal_bvmap-v1 RdEdg outline lines (public/mission49-data); no polygon surface',
    roadCentre: 'OSM road centrelines (public/mission37c-layers); width is cosmetic',
    water: 'OSM waterways (public/mission37c-layers); no GSI WA polygon in this window',
  },
  buildings: blds.length, tiles: tileNames.length,
  gsiRoadEdge: { lines: gsi.length, lengthM: Math.round(g0.total), insideBuildingM: +g0.inside.toFixed(1), pctInside: pct(g0.inside, g0.total), buildingsTouched: g0.hit.size },
  osmCentreline: { lines: roads.length, lengthM: Math.round(r0.total), insideBuildingM: +r0.inside.toFixed(1), pctInside: pct(r0.inside, r0.total), buildingsTouched: r0.hit.size },
  osmWaterways: { features: water.length, lengthM: Math.round(w0.total), insideBuildingM: +w0.inside.toFixed(1), buildingsTouched: w0.hit.size },
  gsiShiftSweep: { atZero: at0.insideM, best3: sweep.slice(0, 3), worst: sweep[sweep.length - 1] },
  note: 'Edge-in-building length is a conflict metric. Elevated roads, culverts and data-year differences are not classified. Source differences are not assumed to be a rigid shift.',
};
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(rep, null, 1));
console.log(JSON.stringify(rep, null, 1));
