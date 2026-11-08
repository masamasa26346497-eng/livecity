#!/usr/bin/env node
'use strict';
// Mission 145: town (町名 / 丁目) label anchors for all 24 wards, from the e-Stat / CODH census small-area boundary GeoJSON.
//
//   node tools/mission145-build-towns.cjs --input <小地域GeoJSON (e-Stat / Geoshape)> [--out public/mission145-data/towns-24.json] [--force]
//
//   Input  : GeoJSON FeatureCollection, properties KEY_CODE (9/11 digits), S_NAME (official name), CITY_NAME. Read-only; CC BY 4.0 (e-Stat / CODH).
//   Output : labels only (representative point per official unit, in the Live City local frame znorth-neg-v1). No boundaries are republished.
//   Nothing is invented: a unit appears only if it exists in the input and its first 5 KEY_CODE digits match one of the 24 ward codes.
//   Label point = the interior point farthest from the polygon edge (inside the largest part, outside its holes), NOT the building centre
//   and not the bbox centre, so L-shaped / multi-part towns still get a label that sits on their own land.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const r1 = (v) => Math.round(v * 10) / 10;
const CHOME = /^(.*?)([一二三四五六七八九十〇]+|[0-9０-９]+)丁目$/;
const KANJI = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanjiToInt(s) {
  if (/^[0-9０-９]+$/.test(s)) return parseInt(s.normalize('NFKC'), 10);
  if (s.indexOf('十') < 0) { let n = 0; for (const ch of s) n = n * 10 + KANJI[ch]; return n; }
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  return m ? (m[1] ? KANJI[m[1]] : 1) * 10 + (m[2] ? KANJI[m[2]] : 0) : null;
}
/** "長居東四丁目" -> { base: "長居東", chome: 4 }; units without 丁目 -> { base: name, chome: null }. */
function splitName(name) {
  const m = CHOME.exec(String(name).normalize('NFKC').replace(/\s+/g, ''));
  if (!m || !m[1]) return { base: String(name).trim(), chome: null };
  const n = kanjiToInt(m[2]);
  return n == null ? { base: String(name).trim(), chome: null } : { base: m[1], chome: n };
}
function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]); return a / 2; }
function inRing(x, z, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return c;
}
function edgeDist(x, z, r) {
  let best = Infinity;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const ax = r[j][0], az = r[j][1], dx = r[i][0] - ax, dz = r[i][1] - az, l2 = dx * dx + dz * dz;
    let t = l2 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (ax + t * dx), z - (az + t * dz)); if (d < best) best = d;
  }
  return best;
}
/** Interior point farthest from the edges of poly = { outer, holes }. Coarse grid then two refinements. */
function labelPoint(poly) {
  const rings = [poly.outer].concat(poly.holes || []);
  const inside = (x, z) => inRing(x, z, poly.outer) && !(poly.holes || []).some((h) => inRing(x, z, h));
  const dist = (x, z) => Math.min.apply(null, rings.map((r) => edgeDist(x, z, r)));
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of poly.outer) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
  let best = null, bd = -1, N = 24, bx0 = x0, bx1 = x1, bz0 = z0, bz1 = z1;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i <= N; i++) for (let k = 0; k <= N; k++) {
      const x = bx0 + ((bx1 - bx0) * i) / N, z = bz0 + ((bz1 - bz0) * k) / N;
      if (!inside(x, z)) continue;
      const d = dist(x, z); if (d > bd) { bd = d; best = [x, z]; }
    }
    if (!best) break;
    const sx = (bx1 - bx0) / N, sz = (bz1 - bz0) / N; bx0 = best[0] - sx; bx1 = best[0] + sx; bz0 = best[1] - sz; bz1 = best[1] + sz;
  }
  return best ? { x: r1(best[0]), z: r1(best[1]), clearanceM: r1(bd) } : null;
}
/** GeoJSON geometry -> [{ outer, holes }] in local metres (largest first). */
function geometryToPolys(geom, proj) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  const cv = (ring) => ring.map((c) => { const w = proj(c[1], c[0]); return [w.x, w.z]; });
  return polys.map((rs) => ({ outer: cv(rs[0]), holes: rs.slice(1).map(cv) })).filter((p) => p.outer.length >= 4)
    .sort((a, b) => Math.abs(ringArea(b.outer)) - Math.abs(ringArea(a.outer)));
}

async function build({ geojson, wards, wardPolys }) {
  const { latLonToLiveCityWorld } = await import(path.join(ROOT, 'tools/lib/livecity-coordinate-system.js'));
  const byCode = new Map(wards.map((w) => [String(w.wardCode), w]));
  const towns = [], skipped = { noKey: 0, otherCity: 0, noGeometry: 0, noPoint: 0, duplicateKey: 0 }, seen = new Set();
  for (const f of geojson.features || []) {
    const pr = f.properties || {}, key = String(pr.KEY_CODE || '').trim();
    if (!/^\d{9}(\d{2})?$/.test(key)) { skipped.noKey++; continue; }
    const ward = byCode.get(key.slice(0, 5));
    if (!ward) { skipped.otherCity++; continue; }
    if (!pr.S_NAME || !f.geometry) { skipped.noGeometry++; continue; }
    if (seen.has(key)) { skipped.duplicateKey++; continue; }
    const polys = geometryToPolys(f.geometry, latLonToLiveCityWorld);
    const lp = polys.length ? labelPoint(polys[0]) : null;
    if (!lp) { skipped.noPoint++; continue; }
    seen.add(key);
    const name = String(pr.S_NAME).trim(), sp = splitName(name);
    towns.push({ k: key, n: name, b: sp.base, c: sp.chome, w: ward.wardId, x: lp.x, z: lp.z, a: Math.round(Math.abs(ringArea(polys[0].outer))), cl: lp.clearanceM });
  }
  towns.sort((a, b) => a.w.localeCompare(b.w) || a.k.localeCompare(b.k));
  const byWard = {}; for (const t of towns) byWard[t.w] = (byWard[t.w] || 0) + 1;
  let outside = 0;
  if (wardPolys) {
    const W = new Map(wards.map((w) => [w.wardId, w]));
    for (const t of towns) { const w = W.get(t.w); if (w && w.polygons && !w.polygons.some((p) => inRing(t.x, t.z, p.outer))) outside++; }
  }
  return {
    schema: 'livecity.mission145.towns/1', mission: '145', generatedAt: new Date().toISOString(), coordinateConvention: 'znorth-neg-v1',
    source: '国勢調査 町丁・字等別境界データ（総務省統計局 e-Stat / CODH Geoshape）', license: 'CC BY 4.0',
    note: 'labels only: representative interior points. Boundaries are NOT republished here. Units come only from the input file.',
    counts: { towns: towns.length, wardsWithTowns: Object.keys(byWard).length, byWard, labelPointOutsideN03WardPolygon: outside, skipped },
    towns,
  };
}

async function main() {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  if (!opt('input')) { console.error('ERROR: --input <小地域GeoJSON> required'); process.exit(2); }
  const out = path.resolve(opt('out') || path.join(ROOT, 'public/mission145-data/towns-24.json'));
  if (fs.existsSync(out) && !a.includes('--force')) { console.error('ERROR: ' + out + ' exists; pass --force to regenerate'); process.exit(2); }
  const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
  const j = await build({ geojson: JSON.parse(fs.readFileSync(path.resolve(opt('input')), 'utf8')), wards, wardPolys: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(j));
  console.log(JSON.stringify(Object.assign({ out }, j.counts), null, 1));
  const missing = wards.filter((w) => !j.counts.byWard[w.wardId]).map((w) => w.wardName);
  if (missing.length) console.log('wards with NO towns in the input (' + missing.length + '): ' + missing.join(', '));
}
module.exports = { build, splitName, labelPoint, geometryToPolys, inRing, kanjiToInt };
if (require.main === module) main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
