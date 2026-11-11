// Mission 54: official PLATEAU bldg LOD0 footprints (partial prefixes of 52350339 / 52350430) vs GSI water / road edge.
// Usage: node tools/mission54-bldg-vs-gsi.cjs <dir with bldg_*_prefix.part> [out.json]
// Read-only. Only COMPLETE <bldg:Building> elements inside a byte prefix are used. No layer is moved.
const fs = require('fs');
const path = require('path');
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320; // same as geoToThree() in osaka_3d_buildings.html
const toLocal = (lat, lon) => [(lon - CLON) * Math.cos(CLAT * Math.PI / 180) * MPD, -((lat - CLAT) * MPD)];
const dir = process.argv[2];
const outPath = process.argv[3];
const g = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'mission50-data', 'gsi-okawa-nakanoshima.json'), 'utf8'));
const bb = g.bboxLocal;
const inWin = (x, z) => x > bb.minX && x < bb.maxX && z > bb.minZ && z < bb.maxZ;

function pip(x, z, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}
const area = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * r[i][1] - r[i][0] * r[j][1]); return Math.abs(a / 2); };

function parse(file) {
  const s = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /<bldg:Building gml:id="([^"]+)">([\s\S]*?)<\/bldg:Building>/g;
  let m;
  while ((m = re.exec(s))) {
    const body = m[2];
    const fp = body.match(/<bldg:lod0FootPrint>[\s\S]*?<gml:posList>([^<]+)<\/gml:posList>/);
    if (!fp) continue;
    const n = fp[1].trim().split(/\s+/).map(Number);
    const ring = [];
    for (let i = 0; i + 2 < n.length; i += 3) ring.push(toLocal(n[i], n[i + 1]));
    const h = Number((body.match(/<bldg:measuredHeight[^>]*>([^<]+)</) || [])[1]);
    const usage = (body.match(/<bldg:usage[^>]*>(\d+)</) || [])[1] || null;
    out.push({ id: m[1], ring, h, usage, mesh: path.basename(file).slice(5, 13) });
  }
  return out;
}

const files = fs.readdirSync(dir).filter((n) => /^bldg_\d+_prefix\.part$/.test(n));
let all = [];
for (const f of files) all = all.concat(parse(path.join(dir, f)));
const ids = new Set(all.map((b) => b.id));
const blds = all.filter((b) => b.ring.some(([x, z]) => inWin(x, z)));

const water = g.water.map((w) => w.outer);
const wbox = water.map((r) => r.reduce((b, [x, z]) => [Math.min(b[0], x), Math.max(b[1], x), Math.min(b[2], z), Math.max(b[3], z)], [1e9, -1e9, 1e9, -1e9]));
const inWater = (x, z) => { for (let i = 0; i < water.length; i++) { const b = wbox[i]; if (x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3] && pip(x, z, water[i])) return true; } return false; };

function stats(dx, dz) {
  let nIn = 0, nHalf = 0, vIn = 0, vAll = 0;
  const bad = [];
  for (const b of blds) {
    let c = [0, 0];
    for (const p of b.ring) c = [c[0] + p[0] / b.ring.length, c[1] + p[1] / b.ring.length];
    let k = 0;
    for (const p of b.ring) { vAll++; if (inWater(p[0] + dx, p[1] + dz)) { vIn++; k++; } }
    const cw = inWater(c[0] + dx, c[1] + dz);
    if (cw) nIn++;
    if (k / b.ring.length >= 0.5) nHalf++;
    if (cw || k / b.ring.length >= 0.5) bad.push({ id: b.id, mesh: b.mesh, h: b.h, usage: b.usage, area: Math.round(area(b.ring)), centroidInWater: cw, vertsInWaterPct: Math.round(100 * k / b.ring.length), x: Math.round(c[0]), z: Math.round(c[1]) });
  }
  return { centroidInWater: nIn, halfVertsInWater: nHalf, vertsInWater: vIn, vertsTotal: vAll, bad };
}

function segDist(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = dx * dx + dz * dz;
  let t = l ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz);
}
const lines = g.lines.filter((l) => l.length > 1);
const dists = [];
for (const b of blds) {
  for (const p of b.ring) {
    let d = 1e9;
    for (const l of lines) for (let i = 0; i + 1 < l.length; i++) {
      const a = l[i], c = l[i + 1];
      if (Math.abs(a[0] - p[0]) > 40 && Math.abs(c[0] - p[0]) > 40) continue;
      d = Math.min(d, segDist(p[0], p[1], a, c));
    }
    dists.push(d);
  }
}
dists.sort((a, b) => a - b);
const q = (p) => dists.length ? +dists[Math.min(dists.length - 1, Math.floor(p * dists.length))].toFixed(2) : null;

const base = stats(0, 0);
const sweep = [];
for (let dx = -8; dx <= 8; dx += 2) for (let dz = -8; dz <= 8; dz += 2) {
  const s = stats(dx, dz);
  sweep.push({ dx, dz, centroidInWater: s.centroidInWater, vertsInWater: s.vertsInWater });
}
sweep.sort((a, b) => a.vertsInWater - b.vertsInWater);
const result = {
  files, completeBuildingsParsed: all.length, uniqueIds: ids.size, inWindow: blds.length,
  perMesh: Object.fromEntries(['52350339', '52350430'].map((k) => [k, blds.filter((b) => b.mesh === k).length])),
  baseline: { centroidInWater: base.centroidInWater, halfVertsInWater: base.halfVertsInWater, vertsInWater: base.vertsInWater, vertsTotal: base.vertsTotal, pctVertsInWater: +(100 * base.vertsInWater / Math.max(1, base.vertsTotal)).toFixed(2) },
  flagged: base.bad.slice(0, 40),
  vertexToRoadEdgeM: { n: dists.length, p10: q(0.1), p50: q(0.5), p90: q(0.9) },
  shiftSweepBest5: sweep.slice(0, 5), shiftSweepAtZero: sweep.find((s) => s.dx === 0 && s.dz === 0),
};
console.log(JSON.stringify(result, null, 1));
if (outPath) fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
