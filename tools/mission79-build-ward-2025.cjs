#!/usr/bin/env node
// Mission 79: PLATEAU 2025 (v5) CityGML -> ward 3D Tiles + legacy ID crosswalk + geometric alignment check.
//
//   Inputs (all from the 2025 original; NOT from pre-processed legacy building JSON):
//     --jsonl  <file>   output of tools/mission36k-convert-citygml-runtime.mjs on 2025 bldg GML (gml:id kept verbatim)
//     --tran   <dir>    dir with 2025 tran GML (optional; enables road-vs-building alignment check)
//     --ward   <id>     ward id in config/wards/registry.json (N03 polygon point-in-polygon classification)
//     --out    <dir>    MUST NOT exist or be empty (build() wipes its out dir; we refuse to touch existing data)
//     --legacy <dir>    optional legacy tileset dir containing attrs/*.json (e.g. public/mission37h-3dtiles/nishi-sample)
//                       READ ONLY. Used for ID crosswalk + per-building offset. Legacy IDs are never rewritten.
//   Output: <out>/{tileset.json,tiles,lod,ids,attrs,build-report.json,source.json,crosswalk.*,alignment.json}
//   Coordinates: znorth-neg-v1 (x east, z south-positive, metres, origin CLAT/CLON of config/areas/osaka-city.json).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { build } = require('./mission37b-build-3dtiles.cjs');

const ROOT = path.join(__dirname, '..');
const TILE = 500;
const r1 = (v) => Math.round(v * 10) / 10;

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function inWard(x, z, ward) {
  const bb = ward.bbox;
  if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) return false;
  return ward.polygons.some((p) => pointInRing(x, z, p.outer) && !(p.holes || []).some((h) => pointInRing(x, z, h)));
}
function centroid(fp) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
    const f = fp[j][0] * fp[i][1] - fp[i][0] * fp[j][1];
    a += f; cx += (fp[j][0] + fp[i][0]) * f; cz += (fp[j][1] + fp[i][1]) * f;
  }
  if (Math.abs(a) < 1e-6) return [fp.reduce((s, p) => s + p[0], 0) / fp.length, fp.reduce((s, p) => s + p[1], 0) / fp.length];
  return [cx / (3 * a), cz / (3 * a)];
}

// ---- tran (road) polygons: lod1MultiSurface rings -> runtime coords -------------------------------------
function projectLatLon(lat, lon, p) {
  return [(lon - p.centerLon) * Math.cos(p.centerLat * Math.PI / 180) * p.metersPerDegree, -(lat - p.centerLat) * p.metersPerDegree];
}
function parseTranRoads(xml, projection) {
  const roads = [];
  const roadRe = /<tran:Road\b[\s\S]*?<\/tran:Road>/g;
  let m;
  while ((m = roadRe.exec(xml))) {
    const rings = [];
    const re = /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
    let q;
    while ((q = re.exec(m[0]))) {
      const n = q[1].trim().split(/\s+/).map(Number);
      const dim = n.length % 3 === 0 ? 3 : 2;
      const ring = [];
      for (let i = 0; i + dim - 1 < n.length; i += dim) {
        // EPSG:6697 serialises lat lon; verify instead of assuming
        if (!(n[i] > 20 && n[i] < 50 && n[i + 1] > 120 && n[i + 1] < 150)) throw new Error('tran axis order is not lat,lon');
        ring.push(projectLatLon(n[i], n[i + 1], projection));
      }
      if (ring.length >= 4) rings.push(ring);
    }
    if (rings.length) roads.push(rings);
  }
  return roads;
}

// Hit-rate of building centroids inside road polygons under candidate transforms of the road layer.
// Buildings do not sit on roads: the correct transform has the LOWEST hit rate; any mirror/rotation raises it.
// A second signal: distance from building footprint to the nearest road edge is smallest for the right transform.
function orientationScan(buildingPts, roads) {
  const cands = {
    identity: ([x, z]) => [x, z],
    flipX: ([x, z]) => [-x, z],
    flipZ: ([x, z]) => [x, -z],
    rot180: ([x, z]) => [-x, -z],
    swapXZ: ([x, z]) => [z, x],
  };
  // Transforms are applied about the data centroid so that they only test orientation, not translation.
  const all = roads.flat(2);
  const cx = all.reduce((s, p) => s + p[0], 0) / all.length, cz = all.reduce((s, p) => s + p[1], 0) / all.length;
  const res = {};
  for (const [name, f] of Object.entries(cands)) {
    const polys = roads.map((rings) => rings.map((ring) => ring.map((p) => { const t = f([p[0] - cx, p[1] - cz]); return [t[0] + cx, t[1] + cz]; })));
    const bbs = polys.map((rings) => { let x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18; for (const p of rings[0]) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); } return [x0, x1, z0, z1]; });
    let hit = 0;
    for (const [x, z] of buildingPts) {
      for (let i = 0; i < polys.length; i++) {
        const bb = bbs[i];
        if (x < bb[0] || x > bb[1] || z < bb[2] || z > bb[3]) continue;
        if (pointInRing(x, z, polys[i][0])) { hit++; break; }
      }
    }
    res[name] = { hits: hit, hitRatePct: +(hit * 100 / Math.max(1, buildingPts.length)).toFixed(2) };
  }
  const ranked = Object.entries(res).sort((a, b) => a[1].hits - b[1].hits);
  const best = ranked[0][0];
  const margin = ranked[1][1].hits - ranked[0][1].hits;
  return { candidates: res, bestTransform: best, orientationOk: best === 'identity' && margin > 0, margin };
}

// ---- legacy crosswalk (read only) ------------------------------------------------------------------------
function loadLegacy(dir) {
  const out = new Map(); // id -> {repX, repZ, h}
  const ad = path.join(dir, 'attrs');
  for (const f of fs.readdirSync(ad)) {
    const j = JSON.parse(fs.readFileSync(path.join(ad, f), 'utf8'));
    const fi = Object.fromEntries(j.fields.map((k, i) => [k, i]));
    for (const [id, a] of Object.entries(j.byId)) out.set(id, { repX: a[fi.repX], repZ: a[fi.repZ], h: a[fi.h] });
  }
  return out;
}
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

function crosswalk(newB, legacy, opts = {}) {
  const maxDist = opts.maxDist || 3; // metres between centroids to accept a geometric candidate
  const cell = 10;
  const grid = new Map();
  for (const [id, l] of legacy) {
    const k = Math.floor(l.repX / cell) + '_' + Math.floor(l.repZ / cell);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([id, l]);
  }
  const rows = [];
  const matchedLegacy = new Set();
  const stats = { exactId: 0, geometricCandidate: 0, newOnly: 0, ambiguous: 0 };
  const offsets = [];
  const heightDiffs = [];
  for (const b of newB) {
    const l = legacy.get(b.id);
    if (l) {
      stats.exactId++; matchedLegacy.add(b.id);
      const d = Math.hypot(l.repX - b.repX, l.repZ - b.repZ);
      offsets.push(d); heightDiffs.push(b.h - l.h);
      rows.push({ id2025: b.id, id2022: b.id, method: 'exact-gml-id', centroidDistM: r1(d) });
      continue;
    }
    const cx = Math.floor(b.repX / cell), cz = Math.floor(b.repZ / cell);
    const near = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const [id, lg] of grid.get((cx + dx) + '_' + (cz + dz)) || []) {
        if (matchedLegacy.has(id)) continue;
        const d = Math.hypot(lg.repX - b.repX, lg.repZ - b.repZ);
        if (d <= maxDist) near.push([id, d]);
      }
    }
    near.sort((a, c) => a[1] - c[1]);
    if (near.length === 1) { stats.geometricCandidate++; rows.push({ id2025: b.id, id2022: near[0][0], method: 'centroid-candidate', centroidDistM: r1(near[0][1]) }); }
    else if (near.length > 1) { stats.ambiguous++; rows.push({ id2025: b.id, id2022: null, method: 'ambiguous', candidates: near.slice(0, 3).map((n) => n[0]) }); }
    else { stats.newOnly++; rows.push({ id2025: b.id, id2022: null, method: 'new-in-2025' }); }
  }
  // geometric candidates are NOT confirmed identities: they are reported, never applied
  const legacyOnly = [...legacy.keys()].filter((id) => !matchedLegacy.has(id) && !rows.some((r) => r.id2022 === id));
  return {
    rows,
    summary: {
      buildings2025: newB.length, buildingsLegacy: legacy.size, ...stats,
      legacyOnly: legacyOnly.length,
      exactIdOffsetM: { median: median(offsets) === null ? null : r1(median(offsets)), p95: offsets.length ? r1([...offsets].sort((a, c) => a - c)[Math.floor(offsets.length * 0.95)]) : null, max: offsets.length ? r1(Math.max(...offsets)) : null },
      exactIdHeightDiffM: { median: median(heightDiffs) === null ? null : r1(median(heightDiffs)) },
      policy: 'IDs are never rewritten. exact-gml-id = same gml:id in both vintages (offset/height reported). centroid-candidate/ambiguous/new-in-2025/legacy-only are candidates for review only; legacy-only buildings are NOT declared demolished.',
    },
    legacyOnlyIds: legacyOnly,
  };
}

function prepareBuildings(jsonl, ward, excludeIds) {
  const tiles = new Map();
  const all = [];
  const stat = { read: 0, inWard: 0, outsideWard: 0, duplicate: 0, meshes: new Set(), excluded: 0, excludedIds: [] };
  const seen = new Set();
  for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
    if (!line) continue;
    const b = JSON.parse(line);
    stat.read++;
    if (seen.has(b.id)) { stat.duplicate++; continue; }
    seen.add(b.id);
    const [rx, rz] = centroid(b.fp);
    if (!inWard(rx, rz, ward)) { stat.outsideWard++; continue; }
    stat.inWard++; stat.meshes.add(b.sourceMesh);
    // Mission184 opt-in: strict gml:id match only (a real LOD2 exists). Everything else stays.
    if (excludeIds && excludeIds.has(b.id)) { stat.excluded++; stat.excludedIds.push(b.id); continue; }
    const key = Math.floor(rx / TILE) + '_' + Math.floor(rz / TILE);
    if (!tiles.has(key)) tiles.set(key, { tx: Math.floor(rx / TILE), tz: Math.floor(rz / TILE), buildings: [] });
    const rec = { id: b.id, fp: b.fp, z0: b.z0 || 0, dz: b.dz, h: b.h, usage: b.usage, ulabel: b.ulabel || '', repX: r1(rx), repZ: r1(rz), heightSource: b.heightSource };
    tiles.get(key).buildings.push(rec); all.push(rec);
  }
  return { tiles, all, stat };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
  const wardId = opt('ward'), jsonl = opt('jsonl'), outArg = opt('out');
  if (!wardId || !jsonl || !outArg) throw new Error('usage: --ward <id> --jsonl <file> --out <new dir> [--tran <dir>] [--legacy <dir>]');
  const out = path.resolve(outArg);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('refusing: --out exists and is non-empty: ' + out);
  if (/[\\/]public[\\/]map-data[\\/]/.test(out) || /mission37[bh]-3dtiles/.test(out)) throw new Error('refusing: --out must not be a legacy output location');

  const area = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/areas/osaka-city.json'), 'utf8'));
  const polys = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/processed/osaka-city/boundaries/ward-classification-polygons.json'), 'utf8'));
  if (polys.coordinateConvention !== 'znorth-neg-v1') throw new Error('coordinateConvention');
  const ward = polys.wards.find((w) => w.wardId === wardId);
  if (!ward) throw new Error('unknown ward ' + wardId);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/mission79/source-lock.json'), 'utf8'));

  let excludeIds = null;
  if (opt('exclude-ids')) {
    const j = JSON.parse(fs.readFileSync(opt('exclude-ids'), 'utf8'));
    const arr = Array.isArray(j) ? j : (j.assets ? j.assets.flatMap((a) => a.ids || []) : j.ids);
    if (!arr || !arr.length) throw new Error('--exclude-ids: no ids found');
    excludeIds = new Set(arr);
  }
  const { tiles, all, stat } = prepareBuildings(jsonl, ward, excludeIds);
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'm79-src-'));
  const mt = [];
  for (const t of [...tiles.values()].sort((a, b) => a.tx - b.tx || a.tz - b.tz)) {
    const file = `tile_${t.tx}_${t.tz}.json`;
    fs.writeFileSync(path.join(src, file), JSON.stringify({ tx: t.tx, tz: t.tz, tileSize: TILE, lod: 1, count: t.buildings.length, buildings: t.buildings }));
    mt.push({ tx: t.tx, tz: t.tz, file, count: t.buildings.length });
  }
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ coordinateConvention: 'znorth-neg-v1', tiles: mt }));
  // coarseMinArea 0: the coarse LOD keeps EVERY building (legacy default 100 m2 dropped small ones at far range)
  const t0 = Date.now();
  const report = build({ dataset: 'osaka-' + wardId + '-2025', srcDir: src, out, all: true, group: 4, coarseError: 40, coarseMinArea: 0 });
  const buildMs = Date.now() - t0;

  fs.mkdirSync(path.join(out, 'attrs'), { recursive: true });
  for (const t of tiles.values()) {
    const byId = {};
    for (const b of t.buildings) byId[b.id] = [b.h, b.usage || null, b.repX, b.repZ, b.z0];
    fs.writeFileSync(path.join(out, 'attrs', `t_${t.tx}_${t.tz}.json`), JSON.stringify({ tx: t.tx, tz: t.tz, count: t.buildings.length, fields: ['h', 'usage', 'repX', 'repZ', 'z0'], ward: wardId, wardCode: ward.wardCode, byId }));
  }

  // alignment (needs tran) ---------------------------------------------------------------------------------
  let alignment = { skipped: 'no --tran given' };
  const tranDir = opt('tran');
  if (tranDir) {
    const roads = [];
    for (const f of fs.readdirSync(tranDir).filter((n) => /_tran_.*\.gml$/i.test(n))) roads.push(...parseTranRoads(fs.readFileSync(path.join(tranDir, f), 'utf8'), area.projection));
    const pts = all.map((b) => [b.repX, b.repZ]);
    alignment = { roadPolygons: roads.length, buildingPoints: pts.length, ...(roads.length ? orientationScan(pts, roads) : { skipped: 'no roads parsed' }) };
  }
  fs.writeFileSync(path.join(out, 'alignment.json'), JSON.stringify(alignment, null, 1));

  let cw = null;
  const legacyDir = opt('legacy');
  if (legacyDir) {
    cw = crosswalk(all, loadLegacy(path.resolve(legacyDir)));
    fs.writeFileSync(path.join(out, 'crosswalk.json'), JSON.stringify(cw.summary, null, 1));
    fs.writeFileSync(path.join(out, 'crosswalk.jsonl'), cw.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(out, 'legacy-only-ids.json'), JSON.stringify(cw.legacyOnlyIds));
  }

  const sizeOf = (d) => fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).reduce((n, e) => n + fs.statSync(path.join(e.parentPath || e.path, e.name)).size, 0);
  const heightSources = {};
  for (const b of all) heightSources[b.heightSource] = (heightSources[b.heightSource] || 0) + 1;
  if (excludeIds) fs.writeFileSync(path.join(out, 'lod1-excluded-ids.json'), JSON.stringify({ note: 'Mission184: LOD1 omitted ONLY where a real LOD2 exists (strict gml:id match)', count: stat.excluded, ids: stat.excludedIds }));
  fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify({
    mission: '79', vintage: 2025, standard: 'PLATEAU CityGML v5 (uro 3.2), EPSG:6697 lat,lon',
    ward: ward.wardName, wardId, wardCode: ward.wardCode, generatedAt: new Date().toISOString(),
    source: lock.resource.url, sourceEtag: lock.http.etag, sourceBytes: lock.http.contentLength,
    attribution: lock.attribution, license: lock.license,
    sourceMeshes: [...stat.meshes].sort(), counts: { read: stat.read, inWard: stat.inWard, outsideWard: stat.outsideWard, duplicate: stat.duplicate, excludedForLod2: stat.excluded },
    heightSources, idPolicy: 'gml:id verbatim; no renumbering; 2022/2024 IDs untouched (see crosswalk.*)',
    coordinateConvention: 'znorth-neg-v1', coarseMinArea: 0,
    note: 'Partial unless sourceMeshes covers the ward. Not 27999 (Expo site) data.',
  }, null, 1));
  console.log(JSON.stringify({
    ward: wardId, ...stat, meshes: [...stat.meshes], tiles: tiles.size, buildings: report.totals.buildings, uniqueIds: report.totals.uniqueCanonicalIds,
    skipped: report.totals.skipped, fallbacks: report.totals.fallbacks, glbBytes: report.totals.glbBytes, totalBytes: sizeOf(out), buildMs,
    heightSources, alignment: alignment.candidates ? { best: alignment.bestTransform, ok: alignment.orientationOk, candidates: alignment.candidates } : alignment,
    crosswalk: cw && cw.summary, out,
  }, (k, v) => (v instanceof Set ? [...v] : v), 1));
  fs.rmSync(src, { recursive: true, force: true });
}

module.exports = { prepareBuildings, pointInRing, inWard, centroid, parseTranRoads, orientationScan, crosswalk, projectLatLon };
if (require.main === module) main();
