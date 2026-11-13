#!/usr/bin/env node
// Mission 195: translation-sensitive position audit (2025 PLATEAU, same source for bldg + tran).
//  A) raw CityGML lat/lon footprint -> projection  vs  pipeline output fp  (pipeline fidelity, metres)
//  B) building footprint centroids vs road (tran) polygons under dx/dz shifts: a correct alignment has a low hit rate at (0,0)
//  C) control points (name, lon, lat): local stats of A and B
// Read-only. Usage: node lod2-position-audit.mjs --work temp/mission79/kita-work --out report.json
import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const work = opt('work', 'temp/mission79/kita-work');
const jsonl = opt('jsonl', path.join(work, 'kita.jsonl'));
const outF = opt('out', null);
const P = { centerLat: 34.604208, centerLon: 135.52502, m: 111320 };
const proj = (lat, lon) => [(lon - P.centerLon) * Math.cos(P.centerLat * Math.PI / 180) * P.m, -(lat - P.centerLat) * P.m];
const inRing = (x, z, r) => {
  let o = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) o = !o;
  }
  return o;
};
const pct = (v, p) => { if (!v.length) return null; const s = [...v].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); };
const stat = (v) => ({ n: v.length, p50: pct(v, 0.5), p95: pct(v, 0.95), max: pct(v, 1) });
const CP = [['Osaka Station', 135.4959, 34.7055], ['Umeda Sky Bldg', 135.4905, 34.7053], ['Chayamachi', 135.5002, 34.7096], ['Yodobashi Umeda', 135.4975, 34.7090]]
  .map(([n, lon, lat]) => ({ n, lon, lat, xz: proj(lat, lon) }));
const raw = new Map();
for (const f of fs.readdirSync(path.join(work, 'bldg')).filter((n) => /_bldg_.*\.gml$/.test(n))) {
  const xml = fs.readFileSync(path.join(work, 'bldg', f), 'utf8');
  const re = /<bldg:Building\b[^>]*gml:id="([^"]+)"[\s\S]*?<\/bldg:Building>/g;
  let m;
  while ((m = re.exec(xml))) {
    const fp = /<bldg:lod0FootPrint>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/.exec(m[0]);
    if (!fp) continue;
    const n = fp[1].trim().split(/\s+/).map(Number);
    const ring = [], zs = [];
    for (let i = 0; i + 2 < n.length; i += 3) { ring.push(proj(n[i], n[i + 1])); zs.push(n[i + 2]); }
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    raw.set(m[1], { ring, z: zs });
  }
}
const out = new Map();
for (const l of fs.readFileSync(jsonl, 'utf8').split('\n')) { if (!l) continue; const j = JSON.parse(l); out.set(j.id, j); }
const cen = (r) => [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
const dAll = [], per = CP.map(() => []);
let matched = 0, unmatched = 0;
for (const [id, j] of out) {
  const r = raw.get(id);
  if (!r) { unmatched++; continue; }
  matched++;
  const c1 = cen(r.ring), c2 = cen(j.fp);
  const d = Math.hypot(c1[0] - c2[0], c1[1] - c2[1]);
  dAll.push(d);
  CP.forEach((c, k) => { if (Math.hypot(c2[0] - c.xz[0], c2[1] - c.xz[1]) < 400) per[k].push(d); });
}
const roads = [];
for (const f of fs.readdirSync(path.join(work, 'tran')).filter((n) => /_tran_.*\.gml$/.test(n))) {
  const xml = fs.readFileSync(path.join(work, 'tran', f), 'utf8');
  const rr = /<tran:Road\b[\s\S]*?<\/tran:Road>/g;
  let m;
  while ((m = rr.exec(xml))) {
    const pr = /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
    let q;
    while ((q = pr.exec(m[0]))) {
      const n = q[1].trim().split(/\s+/).map(Number);
      const dim = n.length % 3 === 0 ? 3 : 2;
      const ring = [];
      for (let i = 0; i + dim - 1 < n.length; i += dim) ring.push(proj(n[i], n[i + 1]));
      if (ring.length < 4) continue;
      let x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
      for (const p of ring) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
      roads.push({ ring, bb: [x0, x1, z0, z1] });
    }
  }
}
const CELL = 100, grid = new Map();
roads.forEach((r, i) => {
  for (let x = Math.floor(r.bb[0] / CELL); x <= Math.floor(r.bb[1] / CELL); x++) {
    for (let z = Math.floor(r.bb[2] / CELL); z <= Math.floor(r.bb[3] / CELL); z++) {
      const k = x + '_' + z;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
  }
});
const onRoad = (x, z) => {
  const c = grid.get(Math.floor(x / CELL) + '_' + Math.floor(z / CELL));
  if (!c) return false;
  for (const i of c) {
    const b = roads[i].bb;
    if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) continue;
    if (inRing(x, z, roads[i].ring)) return true;
  }
  return false;
};
function scan(sel, step, R) {
  const pts = sel.map((j) => cen(j.fp));
  let zero = null, best = null, worst = null;
  for (let dx = -R; dx <= R; dx += step) {
    for (let dz = -R; dz <= R; dz += step) {
      let h = 0;
      for (const [x, z] of pts) if (onRoad(x + dx, z + dz)) h++;
      const rate = +(h * 100 / Math.max(1, pts.length)).toFixed(2);
      if (dx === 0 && dz === 0) zero = rate;
      if (!best || rate < best.rate) best = { dx, dz, rate };
      if (!worst || rate > worst.rate) worst = { dx, dz, rate };
    }
  }
  return { n: pts.length, hitRateAtZeroPct: zero, minHitRateShift: best, maxHitRateShift: worst };
}
const all = [...out.values()];
const report = {
  source: 'PLATEAU Osaka 2025 CityGML v5 (EPSG:6697 lat,lon,h), bldg+tran same mesh set, projection = osaka-city.json local-equirectangular',
  A_pipelineFidelity_m: { matched, unmatched, ...stat(dAll) },
  A_controlPoints: CP.map((c, k) => ({ name: c.n, lon: c.lon, lat: c.lat, x: +c.xz[0].toFixed(1), z: +c.xz[1].toFixed(1), nearbyBuildings: per[k].length, centroidDiff_m: stat(per[k]) })),
  roadPolygons: roads.length,
  B_ward: scan(all, 4, 28),
  B_controlPoints: CP.map((c) => ({ name: c.n, ...scan(all.filter((j) => Math.hypot(cen(j.fp)[0] - c.xz[0], cen(j.fp)[1] - c.xz[1]) < 400), 2, 20) })),
  verticalFootprintZ_m: stat([...raw.values()].map((r) => Math.min(...r.z))),
};
const s = JSON.stringify(report, null, 1);
if (outF) fs.writeFileSync(outF, s);
console.log(s);
