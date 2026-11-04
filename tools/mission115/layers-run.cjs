#!/usr/bin/env node
'use strict';
// Mission 115: per-ward road / water layers from the OWNER'S old OSM tiles, kept separate from the private 2025 building archives.
//   node tools/mission115/layers-run.cjs audit  --src <old osaka-city map-data dir> [--wards nishi,fukushima,yodogawa]
//   node tools/mission115/layers-run.cjs build  --src <...> --layers-root <dir outside repo/OneDrive> [--wards ...|ALL]
//   node tools/mission115/layers-run.cjs verify --layers-root <dir> [--wards ...|ALL] [--out report.json]
// Never writes the source; build delegates to 45I (new files only, existing ward layers/ skipped). Nothing is invented: a ward with no
// source data is reported "no-source-data". Network: none. Acceptance flags (served / browser) are always false here.
const fs = require('node:fs');
const path = require('node:path');
const B = require('../mission45i-build-layers-24.cjs');
const L = require('../mission40g-build-ward-layers.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT = ['nishi', 'fukushima', 'yodogawa'];
// geoToThree constants shared by the 2025 buildings, N03 wards and the layers (see osaka_3d_buildings.html geoToThree)
const PROJ = { CLAT: 34.604208, CLON: 135.52502, MPD: 111320 };
const CONVENTION = 'znorth-neg-v1';
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function wardList(arg) {
  const all = readJson(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json')).wards;
  if (!arg) return all.filter((w) => DEFAULT.includes(w.wardId));
  if (arg === 'ALL') return all;
  const ids = arg.split(',').map((s) => s.trim()).filter(Boolean);
  const pick = all.filter((w) => ids.includes(w.wardId));
  if (pick.length !== ids.length) throw Object.assign(new Error('unknown ward id in --wards'), { code: 2 });
  return pick;
}
/** Pure text read of the projection constants a page uses. */
function projectionConstants(html) {
  // names differ per page: PROJ { clat, clon, mpd } (37G) / SEARCH_CLAT, SEARCH_CLON, SEARCH_MPD (legacy)
  const g = (k) => { const m = new RegExp('(?:\\b|_)' + k + '\\s*[=:]\\s*(-?[0-9.]+)', 'i').exec(html); return m ? Number(m[1]) : null; };
  return { CLAT: g('clat'), CLON: g('clon'), MPD: g('mpd') };
}
function constantsReport() {
  const out = {};
  for (const f of ['public/mission37g-osaka-24ward-mvp.html', 'public/osaka_3d_buildings.html']) {
    try {
      const c = projectionConstants(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      out[f] = { found: c, matches: c.CLAT === PROJ.CLAT && c.CLON === PROJ.CLON && c.MPD === PROJ.MPD };
    } catch (e) { out[f] = { error: 'unreadable', matches: false }; }
  }
  return out;
}
/** local metres (x east, z south-positive) -> lon/lat with the shared constants. */
function localToLonLat(x, z) {
  const lat = PROJ.CLAT - z / PROJ.MPD;
  const lon = PROJ.CLON + x / (PROJ.MPD * Math.cos(PROJ.CLAT * Math.PI / 180));
  return { lat, lon };
}
function polyInRing(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
const inWard = (w, x, z) => (w.polygons || []).some((p) => polyInRing(p.outer, x, z) && !(p.holes || []).some((h) => polyInRing(h, x, z)));

/** Per-ward numeric verification of a generated layers/ dir. cell = grid size in metres. */
function verifyWard(ward, layersRoot, cell) {
  cell = cell || 100;
  const dir = path.join(layersRoot, ward.wardId, 'layers');
  const res = { ward: ward.wardId, wardCode: ward.wardCode, state: 'missing', layers: {}, checks: {} };
  if (!fs.existsSync(dir)) return res;
  const data = {};
  for (const l of ['roads', 'waterways', 'parks', 'railways']) {
    try {
      const j = readJson(path.join(dir, l + '.json'));
      data[l] = j;
      res.layers[l] = { count: j.count, features: (j.features || []).length, convention: j.coordinateConvention, clipped: j.clipped };
    } catch (e) { res.layers[l] = { status: 'absent' }; }
  }
  const conv = Object.values(res.layers).map((v) => v.convention).filter(Boolean);
  res.checks.conventionOk = conv.length > 0 && conv.every((c) => c === CONVENTION);
  const b = ward.bbox;
  const key = (x, z) => Math.floor((x - b.minX) / cell) + ',' + Math.floor((z - b.minZ) / cell);
  const touched = { roads: new Set(), waterways: new Set() };
  let outside = 0, total = 0;
  for (const l of ['roads', 'waterways']) {
    for (const f of ((data[l] || {}).features || [])) {
      for (const p of (f.p || [])) {
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) { res.checks.nonFinite = true; continue; }
        touched[l].add(key(p[0], p[1])); total++;
        if (p[0] < b.minX - 1 || p[0] > b.maxX + 1 || p[1] < b.minZ - 1 || p[1] > b.maxZ + 1) outside++;
      }
    }
  }
  let cells = 0;
  const covered = { roads: 0, waterways: 0 };
  for (let x = b.minX + cell / 2; x < b.maxX; x += cell) {
    for (let z = b.minZ + cell / 2; z < b.maxZ; z += cell) {
      if (!inWard(ward, x, z)) continue;
      cells++;
      const k = key(x, z);
      if (touched.roads.has(k)) covered.roads++;
      if (touched.waterways.has(k)) covered.waterways++;
    }
  }
  const pct = (n) => (cells ? Math.round((n / cells) * 1000) / 10 : null);
  res.coverage = { cellM: cell, wardCells: cells, roadCellsPct: pct(covered.roads), waterCellsPct: pct(covered.waterways) };
  res.checks.vertices = total;
  res.checks.verticesOutsideWardBBox = outside;
  res.checks.outsideBBoxPct = total ? Math.round((outside / total) * 10000) / 100 : null;
  const ll = localToLonLat((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2);
  res.checks.wardCentreLonLat = { lon: Math.round(ll.lon * 1e5) / 1e5, lat: Math.round(ll.lat * 1e5) / 1e5 };
  res.checks.wardCentreInOsaka = ll.lon > 135.3 && ll.lon < 135.7 && ll.lat > 34.4 && ll.lat < 34.9;
  const roads = (res.layers.roads || {}).features || 0;
  if (!roads) res.state = 'no-roads';
  else if (!res.checks.conventionOk || res.checks.nonFinite || res.checks.outsideBBoxPct > 5 || !res.checks.wardCentreInOsaka) res.state = 'check-failed';
  else res.state = 'generated-unverified-visually';
  return res;
}
function verify(layersRoot, wards, cell) {
  const rep = {
    schema: 'livecity.mission115.verify/1', generatedAt: new Date().toISOString(), projection: PROJ, convention: CONVENTION, constants: constantsReport(),
    wards: wards.map((w) => verifyWard(w, layersRoot, cell)),
    acceptance: { servedByPreview: false, browserRendered: false, ownerDeviceAccepted: 0, note: 'Static numeric checks only. Visual match of roads/water against the 2025 buildings must be observed on the owner PC (stats.vec45i + screenshot).' },
  };
  rep.summary = {
    requested: rep.wards.length,
    generated: rep.wards.filter((w) => w.state === 'generated-unverified-visually').length,
    missing: rep.wards.filter((w) => w.state === 'missing').length,
    failed: rep.wards.filter((w) => w.state === 'check-failed' || w.state === 'no-roads').length,
  };
  return rep;
}
function audit(src, wards) {
  const rep = { schema: 'livecity.mission115.audit/1', src: path.basename(src), license: 'OpenStreetMap contributors (ODbL) via old Live City tiles; keep private/localhost unless attribution + share-alike are met', wards: [] };
  for (const l of ['roads', 'waterways', 'parks', 'railways']) rep[l + 'Manifest'] = fs.existsSync(path.join(src, l, 'manifest.json'));
  for (const w of wards) {
    const e = { ward: w.wardId, layers: {} };
    for (const l of ['roads', 'waterways']) {
      const r = L.readLayer(src, l, w.bbox);
      e.layers[l] = { status: r.status, features: r.features.length, sourceTiles: r.stats && r.stats.sourceTiles, missingTiles: r.stats && r.stats.missingTiles };
    }
    rep.wards.push(e);
  }
  // Mission 116: readiness per ward. "ready" = roads AND waterways have source features; never confused with generated/accepted.
  const has = (e, l) => e.layers[l].features > 0;
  rep.summary = {
    requested: rep.wards.length,
    ready: rep.wards.filter((e) => has(e, 'roads') && has(e, 'waterways')).map((e) => e.ward),
    roadsOnly: rep.wards.filter((e) => has(e, 'roads') && !has(e, 'waterways')).map((e) => e.ward),
    noSource: rep.wards.filter((e) => !has(e, 'roads')).map((e) => ({ ward: e.ward, reason: e.layers.roads.status })),
    note: 'ready = source features exist; not generated, not verified, not rendered',
  };
  return rep;
}
function main() {
  const a = process.argv.slice(2), cmd = a[0];
  const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const wards = wardList(opt('wards'));
    let out;
    if (cmd === 'audit') {
      if (!opt('src')) throw Object.assign(new Error('--src required'), { code: 2 });
      out = audit(path.resolve(opt('src')), wards);
    } else if (cmd === 'build') {
      const cov = B.run({ src: opt('src'), layersRoot: opt('layers-root'), wards: wards.map((w) => w.wardId), margin: 0 });
      out = { build: { generated: cov.stages.generated, wards: cov.wards.map((w) => ({ ward: w.ward, stage: w.stage, note: w.note })) }, verify: verify(path.resolve(opt('layers-root')), wards) };
    } else if (cmd === 'verify') {
      if (!opt('layers-root')) throw Object.assign(new Error('--layers-root required'), { code: 2 });
      out = verify(path.resolve(opt('layers-root')), wards);
    } else throw Object.assign(new Error('usage: audit|build|verify'), { code: 2 });
    if (opt('out')) fs.writeFileSync(path.resolve(opt('out')), JSON.stringify(out, null, 1), { flag: 'wx' });
    console.log(JSON.stringify(out, null, 1));
    const v = out.verify || out;
    if (v.summary && v.summary.failed) process.exitCode = 3;
  } catch (e) { console.error('ERROR: ' + e.message); process.exit(Number.isInteger(e.code) ? e.code : 1); }
}
module.exports = { verifyWard, verify, audit, projectionConstants, constantsReport, localToLonLat, wardList, PROJ, CONVENTION };
if (require.main === module) main();
