#!/usr/bin/env node
// Mission 40N: read-only coordinate-consistency diagnostic (buildings vs OSM layers vs N03 ward polygon vs 3D Tiles frame).
//
//   node tools/mission40n-coord-diagnose.cjs --buildings <dir with tile_*.json> --layers <osaka-city dir with roads/ ...>
//        [--ward fukushima] [--range 60] [--step 5]
//   or for a single pre-cut layer file:  --roads-json <roads.json>
//
// Checks (nothing is written, nothing is moved):
//  1. 3D Tiles frame round trip: local(x,z) -> lon/lat -> ECEF -> tile ENU -> back; error must be << 1 m.
//  2. Offset search: shift the road polylines by (dx,dz) over a window and count how many road sample points fall INSIDE
//     building footprints. A real systematic shift shows a clear minimum away from (0,0); a correctly registered but
//     elevated/overlapping road (viaduct, tunnel mouth) keeps its minimum at (0,0) and a nonzero baseline.
//  3. Building representative points vs the N03 ward polygon (when --ward is given).
// Elevated roads are NOT removed or moved; the report only quantifies.
'use strict';
const fs = require('fs'), path = require('path');
const B = require('./mission37b-build-3dtiles.cjs');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320, COS = Math.cos(CLAT * Math.PI / 180);

function parseArgs(argv) {
  const a = { range: 60, step: 5, tile: 500 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--buildings') a.buildings = argv[++i];
    else if (k === '--layers') a.layers = argv[++i];
    else if (k === '--roads-json') a.roadsJson = argv[++i];
    else if (k === '--ward') a.ward = argv[++i];
    else if (k === '--range') a.range = Number(argv[++i]);
    else if (k === '--step') a.step = Number(argv[++i]);
    else if (k === '--wards') a.wards = argv[++i];
  }
  return a;
}

/** 1. frame round trip. Returns max error in metres for a few points around the given local position. */
function frameRoundTrip(cx, cz) {
  const frame = B.makeFrame(B.localToLon(cx), B.localToLat(cz));
  const toLonLat = (x, z) => [B.localToLon(x), B.localToLat(z)];
  let maxErr = 0;
  for (const [dx, dz, h] of [[0, 0, 0], [250, 250, 0], [-250, 250, 30], [250, -250, 100], [-250, -250, 5]]) {
    const [lo, la] = toLonLat(cx + dx, cz + dz);
    const enu = B.toEnu ? B.toEnu(frame, lo, la, h) : null;
    if (!enu) return null;
    // expected: east = dx, north = -dz (z is south-positive). ENU of a small offset vs flat local metres.
    const eErr = Math.abs(enu[0] - dx * 1), nErr = Math.abs(enu[1] - (-dz));
    // local metres use a flat MPD scale; ENU is geodesic. They agree to sub-metre over 500 m tiles.
    maxErr = Math.max(maxErr, eErr, nErr, Math.abs(enu[2] - h) < 5 ? 0 : 999);
  }
  return maxErr;
}

function pip(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function readBuildings(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    const j = readJson(path.join(dir, f));
    for (const b of j.buildings || []) {
      if (!Array.isArray(b.fp) || b.fp.length < 3) continue;
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (const p of b.fp) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; }
      out.push({ id: b.id, fp: b.fp, h: b.h, minX, maxX, minZ, maxZ, repX: b.repX, repZ: b.repZ });
    }
  }
  return out;
}

/** Grid index of building bboxes: cell size 50 m. */
function indexBuildings(bs, cell = 50) {
  const g = new Map();
  for (const b of bs) {
    for (let cx = Math.floor(b.minX / cell); cx <= Math.floor(b.maxX / cell); cx++)
      for (let cz = Math.floor(b.minZ / cell); cz <= Math.floor(b.maxZ / cell); cz++) {
        const k = cx + ',' + cz; (g.get(k) || g.set(k, []).get(k)).push(b);
      }
  }
  return { g, cell };
}
function insideAny(idx, x, z) {
  const list = idx.g.get(Math.floor(x / idx.cell) + ',' + Math.floor(z / idx.cell));
  if (!list) return false;
  for (const b of list) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && pip(b.fp, x, z)) return true;
  return false;
}

function sampleLines(features, spacing = 6) {
  const pts = [];
  for (const f of features) {
    if (f.kind && f.kind !== 'line') continue;
    const p = f.p; if (!Array.isArray(p)) continue;
    for (let i = 0; i + 1 < p.length; i++) {
      const dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1], len = Math.hypot(dx, dz), n = Math.max(1, Math.floor(len / spacing));
      for (let k = 0; k < n; k++) pts.push([p[i][0] + dx * k / n, p[i][1] + dz * k / n, f.tier || f.highway || '']);
    }
  }
  return pts;
}

/** 2. offset search. */
function offsetSearch(bs, linePts, range, step) {
  const idx = indexBuildings(bs), rows = [];
  // limit to sample points near buildings to keep this fast
  const near = linePts.filter((q) => insideAny(idx, q[0], q[1]) || true);
  for (let dx = -range; dx <= range; dx += step) for (let dz = -range; dz <= range; dz += step) {
    let hit = 0;
    for (const q of near) if (insideAny(idx, q[0] + dx, q[1] + dz)) hit++;
    rows.push({ dx, dz, insideRatio: near.length ? hit / near.length : 0 });
  }
  const zero = rows.find((r) => r.dx === 0 && r.dz === 0);
  // ties resolve to zero offset: only a strictly lower overlap counts as evidence of a shift
  const best = rows.reduce((m, r) => (r.insideRatio < m.insideRatio ? r : m), zero || rows[0]);
  return { samples: near.length, zero, best, improvementPct: zero && zero.insideRatio > 0 ? +(100 * (zero.insideRatio - best.insideRatio) / zero.insideRatio).toFixed(1) : 0 };
}

function verdict(os) {
  if (!os.samples) return 'no-road-samples';
  const away = Math.hypot(os.best.dx, os.best.dz);
  if (away === 0) return 'registered: minimum overlap is at zero offset (no systematic shift). Remaining overlap = elevated / tunnel / mapping noise';
  if (os.improvementPct >= 30 && away >= 5) return `possible-systematic-shift: overlap drops ${os.improvementPct}% at offset dx=${os.best.dx}, dz=${os.best.dz} (${away.toFixed(1)} m)`;
  return `weak: best offset (${os.best.dx},${os.best.dz}) improves only ${os.improvementPct}%; not conclusive`;
}

function loadRoads(a, bbox) {
  if (a.roadsJson) return readJson(a.roadsJson).features || [];
  const dir = path.join(a.layers, 'roads'), mp = path.join(dir, 'manifest.json');
  const size = fs.existsSync(mp) ? (readJson(mp).tileSize || 2000) : 2000;
  const seen = new Set(), out = [];
  for (let tx = Math.floor(bbox.minX / size); tx <= Math.floor(bbox.maxX / size); tx++)
    for (let tz = Math.floor(bbox.minZ / size); tz <= Math.floor(bbox.maxZ / size); tz++) {
      const p = path.join(dir, `tile_${tx}_${tz}.json`); if (!fs.existsSync(p)) continue;
      for (const f of readJson(p).features || []) if (f && f.p && !seen.has(f.id)) { seen.add(f.id); out.push(f); }
    }
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.buildings || !(a.layers || a.roadsJson)) { console.error('usage: --buildings <dir> (--layers <dir> | --roads-json <file>) [--ward id]'); process.exit(1); }
  const bs = readBuildings(a.buildings);
  const bbox = bs.reduce((m, b) => ({ minX: Math.min(m.minX, b.minX), maxX: Math.max(m.maxX, b.maxX), minZ: Math.min(m.minZ, b.minZ), maxZ: Math.max(m.maxZ, b.maxZ) }), { minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9 });
  const roads = loadRoads(a, bbox);
  const pts = sampleLines(roads).filter((q) => q[0] >= bbox.minX && q[0] <= bbox.maxX && q[1] >= bbox.minZ && q[1] <= bbox.maxZ);
  const report = { mission: '40N', buildings: bs.length, bboxLocal: bbox, roadFeatures: roads.length, frameRoundTripMaxErrM: frameRoundTrip((bbox.minX + bbox.maxX) / 2, (bbox.minZ + bbox.maxZ) / 2) };
  report.all = offsetSearch(bs, pts, a.range, a.step);
  report.all.verdict = verdict(report.all);
  const noViaduct = pts.filter((q) => q[2] !== 'major' && q[2] !== 'motorway' && q[2] !== 'trunk');
  report.localAndMid = offsetSearch(bs, noViaduct, a.range, a.step);
  report.localAndMid.verdict = verdict(report.localAndMid);
  if (a.ward && a.wards !== undefined || a.ward) {
    const wp = a.wards || path.join(__dirname, '..', 'public', 'mission37g-data', 'osaka-24-wards.json');
    const w = (readJson(wp).wards || []).find((x) => x.wardId === a.ward);
    if (w && w.polygons) {
      let inside = 0, total = 0;
      for (const b of bs) { if (!Number.isFinite(b.repX)) continue; total++; if (w.polygons.some((poly) => pip(poly[0] || poly, b.repX, b.repZ))) inside++; }
      report.n03 = { ward: a.ward, repPointsInsidePolygonPct: total ? +(100 * inside / total).toFixed(1) : null, total };
    } else report.n03 = { ward: a.ward, status: 'ward-not-found-or-no-polygons' };
  }
  console.log(JSON.stringify(report, null, 2));
}
module.exports = { parseArgs, frameRoundTrip, pip, readBuildings, indexBuildings, insideAny, sampleLines, offsetSearch, verdict };
if (require.main === module) { try { main(); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); } }
