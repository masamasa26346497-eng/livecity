#!/usr/bin/env node
'use strict';
// Mission 129: the 21 wards NOT yet observed rendered (24 N03 wards minus nishi, fukushima, yodogawa), plus a read-only
// DATA-LEVEL check of an extracted 2025 ward directory. This is NOT browser/WebGL acceptance (browserAccepted is always false).
//   node tools/mission129/wards21.cjs --list
//   node tools/mission129/wards21.cjs --check <buildings-root> [--wards a,b] [--out new-file.json]
// Per ward (<root>/<ward>25/): tileset.json parses; every tiles/*.glb has a valid glTF magic + header length == file size;
// ids/*.json are arrays of bldg_* strings (no duplicates inside the ward); tileset root transform (if any) lies inside the ward bbox +1.5km
// using the existing geoToThree constants (CLAT/CLON/MPD are NOT changed). Writes only the optional --out (refuses to overwrite). No network.
const fs = require('fs');
const path = require('path');
const LAYOUT = require('../mission131/layout.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const OBSERVED = ['nishi', 'fukushima', 'yodogawa'];
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320;

function allWards() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
}
function target21() {
  return allWards().filter((w) => !OBSERVED.includes(w.wardId));
}
function ecefToLonLat(x, y, z) {
  const a = 6378137, e2 = 0.00669437999014, lon = Math.atan2(y, x), p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s);
    lat = Math.atan2(z + e2 * N * s, p);
  }
  return { lat: lat * 180 / Math.PI, lon: lon * 180 / Math.PI };
}
function toLocal(lat, lon) {
  return { x: (lon - CLON) * Math.cos(CLAT * Math.PI / 180) * MPD, z: -((lat - CLAT) * MPD) };
}
function checkWard(root, w, dirs) {
  const r = { ward: w.wardId, wardCode: w.wardCode, problems: [], browserAccepted: false };
  // Mission131: discover the real layout instead of assuming <ward>25/ (run 42240020830: 21 extracted, 0 found).
  const d0 = LAYOUT.discoverWard(root, w.wardId, dirs);
  if (!d0 || !d0.dir) {
    r.verdict = 'missing'; r.layout = d0 ? d0.layout : 'none';
    r.problems.push(d0 ? 'ambiguous layout (' + d0.candidates + ' candidates)' : 'no tileset.json attributable to this ward under the root');
    return r;
  }
  const dir = d0.dir; r.layout = d0.layout; r.rel = d0.rel;
  let ts;
  try { ts = JSON.parse(fs.readFileSync(path.join(dir, 'tileset.json'), 'utf8')); } catch (e) {
    r.verdict = 'data-problem'; r.problems.push('tileset.json unparseable'); return r;
  }
  const ls = (d, re) => { try { return fs.readdirSync(path.join(dir, d)).filter((n) => re.test(n)).sort(); } catch (e) { return []; } };
  const uris = (LAYOUT.contentUris(dir) || []).filter((u) => /\.glb$/i.test(u));
  const glbs = uris.length ? uris : ls('tiles', /\.glb$/).map((n) => 'tiles/' + n);
  let bad = 0;
  for (const g of glbs) {
    let b; try { b = fs.readFileSync(path.join(dir, ...g.split('/'))); } catch (e) { bad++; continue; }
    if (b.length < 20 || b.toString('latin1', 0, 4) !== 'glTF' || b.readUInt32LE(4) !== 2 || b.readUInt32LE(8) !== b.length) bad++;
  }
  const seen = new Set();
  let ids = 0, dup = 0, badId = 0;
  for (const f of ls('ids', /\.json$/)) {
    let a;
    try { a = JSON.parse(fs.readFileSync(path.join(dir, 'ids', f), 'utf8')); } catch (e) { badId++; continue; }
    if (!Array.isArray(a)) { badId++; continue; }
    for (const id of a) {
      ids++;
      if (typeof id !== 'string' || !/^bldg_/.test(id)) badId++;
      else if (seen.has(id)) dup++;
      else seen.add(id);
    }
  }
  r.tiles = glbs.length; r.invalidGlb = bad; r.ids = ids; r.duplicateIds = dup; r.invalidIds = badId;
  const t = ts.root && ts.root.transform;
  if (Array.isArray(t) && t.length === 16) {
    const ll = ecefToLonLat(t[12], t[13], t[14]), loc = toLocal(ll.lat, ll.lon), m = 1500, b = w.bbox;
    r.rootLocal = { x: +loc.x.toFixed(1), z: +loc.z.toFixed(1) };
    r.rootInsideWardBBox = loc.x >= b.minX - m && loc.x <= b.maxX + m && loc.z >= b.minZ - m && loc.z <= b.maxZ + m;
    if (!r.rootInsideWardBBox) r.problems.push('tileset root transform is outside the ward bbox (+1.5km)');
  } else r.rootInsideWardBBox = null;
  if (!glbs.length) r.problems.push('no GLB tiles');
  if (bad) r.problems.push(bad + ' invalid GLB');
  if (!ids) r.problems.push('no ids');
  if (dup) r.problems.push(dup + ' duplicate ids');
  if (badId) r.problems.push(badId + ' invalid ids');
  r.verdict = r.problems.length ? 'data-problem' : 'data-ok(not browser accepted)';
  return r;
}
function check(root, only, out) {
  const want = target21().filter((w) => !only || only.includes(w.wardId));
  const dirs = LAYOUT.findTilesetDirs(root);
  const rows = want.map((w) => checkWard(root, w, dirs));
  const sum = {
    schema: 'livecity.mission129.data-check/1', targetWards: want.length,
    dataOk: rows.filter((r) => /^data-ok/.test(r.verdict)).length,
    missing: rows.filter((r) => r.verdict === 'missing').map((r) => r.ward),
    problems: rows.filter((r) => r.verdict === 'data-problem').map((r) => r.ward),
    browserAcceptedWards: 0, rows
  };
  // Mission131: missing or problem wards are a FAILURE (run 42240020830 was green with missing = all 21).
  sum.strictOk = sum.dataOk === sum.targetWards && !sum.missing.length && !sum.problems.length;
  if (!sum.strictOk) sum.probe = LAYOUT.probeTree(root);
  if (out) {
    if (fs.existsSync(out)) throw new Error('refusing to overwrite ' + out);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(sum, null, 1), { flag: 'wx' });
  }
  return sum;
}
module.exports = { OBSERVED, target21, checkWard, check, ecefToLonLat, toLocal };
if (require.main === module) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  if (a.includes('--list')) {
    const l = target21();
    console.log(l.length + ' wards: ' + l.map((w) => w.wardId).join(','));
  } else if (opt('check')) {
    const s = check(opt('check'), opt('wards') ? opt('wards').split(',') : null, opt('out'));
    console.log(JSON.stringify({ ...s, rows: undefined }));
    for (const r of s.rows) console.log('| ' + r.ward + ' | ' + (r.layout || '-') + ' | ' + r.verdict + ' | ' + (r.tiles != null ? r.tiles + ' glb, ' + r.ids + ' ids' : '-') + ' | ' + r.problems.join('; ') + ' |');
    process.exit(s.strictOk ? 0 : 1);
  } else { console.error('usage: --list | --check <buildings-root> [--wards a,b] [--out file]'); process.exit(2); }
}
