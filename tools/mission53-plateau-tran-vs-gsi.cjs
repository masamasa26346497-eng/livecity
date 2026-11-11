// Mission 53: official PLATEAU tran (road) polygons vs GSI water / road-edge (Okawa-Nakanoshima window).
// Usage: node tools/mission53-plateau-tran-vs-gsi.cjs <dir with tran_*.gml> [out.json]
// Read-only. No layer is shifted; rigid shifts are only *searched* to see whether an offset would help.
const fs = require('fs');
const path = require('path');
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320; // same as geoToThree() in osaka_3d_buildings.html
const toLocal = (lat, lon) => [(lon - CLON) * Math.cos(CLAT * Math.PI / 180) * MPD, -((lat - CLAT) * MPD)];

function pip(x, z, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}

function parseTran(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter(n => /^tran_.*\.gml$/.test(n))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /<tran:(Road|TrafficArea|AuxiliaryTrafficArea) gml:id="([^"]+)">([\s\S]*?)<\/tran:\1>/g;
    for (const m of s.matchAll(re)) {
      const fn = (m[3].match(/<tran:function[^>]*>(\d+)</) || [])[1] || null;
      for (const p of m[3].matchAll(/<gml:exterior>[\s\S]*?<gml:posList>([^<]+)<\/gml:posList>/g)) {
        const n = p[1].trim().split(/\s+/).map(Number);
        const ring = [];
        for (let i = 0; i + 2 < n.length; i += 3) ring.push(toLocal(n[i], n[i + 1]));
        out.push({ mesh: f, id: m[2], cls: m[1], fn, ring });
      }
    }
  }
  return out;
}

function segDist(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = dx * dx + dz * dz;
  let t = l ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz);
}

function run(dir, gsiPath) {
  const g = JSON.parse(fs.readFileSync(gsiPath, 'utf8'));
  const bb = g.bboxLocal;
  const water = g.water.map(w => w.outer);
  const inWin = (x, z) => x > bb.minX && x < bb.maxX && z > bb.minZ && z < bb.maxZ;
  const polys = parseTran(dir).filter(p => p.ring.some(([x, z]) => inWin(x, z)));
  const pts = [];
  for (const p of polys) {
    const c = p.ring.reduce((a, q) => [a[0] + q[0] / p.ring.length, a[1] + q[1] / p.ring.length], [0, 0]);
    for (const q of p.ring.concat([c])) if (inWin(q[0], q[1])) pts.push({ x: q[0], z: q[1], id: p.id, fn: p.fn });
  }
  const wbox = water.map(r => r.reduce((b, [x, z]) => [Math.min(b[0], x), Math.max(b[1], x), Math.min(b[2], z), Math.max(b[3], z)], [1e9, -1e9, 1e9, -1e9]));
  const inWater = (x, z) => water.some((r, i) => { const b = wbox[i]; return x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3] && pip(x, z, r); });
  // shift search on a thinned sample (every k-th point) to stay fast; baseline uses all points
  const thin = pts.filter((_, i) => i % Math.max(1, Math.ceil(pts.length / 4000)) === 0);
  const count = (dx, dz, arr) => { let n = 0; for (const p of (arr || pts)) if (inWater(p.x + dx, p.z + dz)) n++; return n; };
  const base = count(0, 0);
  const baseThin = count(0, 0, thin);
  let best = { dx: 0, dz: 0, n: baseThin, sampleSize: thin.length };
  for (let dx = -12; dx <= 12; dx += 3) {
    for (let dz = -12; dz <= 12; dz += 3) {
      const n = count(dx, dz, thin);
      if (n < best.n) best = { dx, dz, n, sampleSize: thin.length };
    }
  }
  const lines = g.lines.filter(l => l.length > 1);
  const dist = [];
  for (const p of thin.slice(0, 1500)) {
    let d = 1e9;
    for (const l of lines) {
      for (let i = 0; i + 1 < l.length; i++) {
        const a = l[i], b = l[i + 1];
        if (Math.abs(a[0] - p.x) > 60 && Math.abs(b[0] - p.x) > 60) continue;
        d = Math.min(d, segDist(p.x, p.z, a, b));
      }
    }
    dist.push(d);
  }
  dist.sort((a, b) => a - b);
  const q = f => (dist.length ? +dist[Math.min(dist.length - 1, Math.floor(dist.length * f))].toFixed(2) : null);
  const inWaterPts = pts.filter(p => inWater(p.x, p.z));
  const byFn = {};
  for (const p of inWaterPts) byFn[p.fn] = (byFn[p.fn] || 0) + 1;
  return {
    roadPolygonsInWindow: polys.length,
    samplePoints: pts.length,
    inGsiWater: base,
    inGsiWaterPct: +(100 * base / Math.max(1, pts.length)).toFixed(2),
    inWaterByRoadFunction: byFn,
    bestRigidShiftWithin12m: best,
    edgeDistM: { n: dist.length, p50: q(0.5), p90: q(0.9), p999: q(0.999) },
    sampleInWater: inWaterPts.slice(0, 8)
  };
}

if (require.main === module) {
  const r = run(process.argv[2], path.join(__dirname, '..', 'public/mission50-data/gsi-okawa-nakanoshima.json'));
  console.log(JSON.stringify(r, null, 1));
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(r, null, 1));
}
module.exports = { run, parseTran, toLocal, pip };
