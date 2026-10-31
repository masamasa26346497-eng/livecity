#!/usr/bin/env node
'use strict';
// Mission 43F: offline, read-only-input / local-output-only LOD1 -> Cesium 3D Tiles conversion for the PC-only wards.
//   node tools/mission43f-pc-convert.cjs --src <legacy buildings dir> --out-root <NEW dir outside repo> [--wards a,b | --next N]
//                                        [--calibrate] [--max-ward-buildings N] [--execute]
//   node tools/mission43f-pc-convert.cjs status --out-root <dir>
// Default is a strict dry-run (nothing is created, converted or written). Only --execute converts.
// Reuses: 43D audit/batchPlan (auditReady is re-checked in THIS process), 40B convertWard/setSource, 43 verifyDir/regress.
// Never uploads, packs, publishes, commits, deletes or overwrites. Output (stdout, status.json) holds ward ids, counts and
// issue kinds only: no paths, no building ids. Gates stay false; a converted ward is NOT approved for publication.
const fs = require('fs');
const path = require('path');
const B = require('./mission43d-ward-batch.cjs');
const T = require('./mission43-ward-rebuild.cjs');
const L = require('./mission40b-legacy-tiles-batch.cjs');

const ROOT = path.resolve(__dirname, '..');
const MARKER = '.livecity-43f-root.json';
const STATUS = 'status.json';
const SCHEMA = 'livecity.mission43f.convert/1';
const DEFAULT_MAX_WARD_BUILDINGS = 150000;
const MAX_ATTEMPTS = 9;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const reg = () => readJson(path.join(ROOT, 'config/wards/registry.json')).wards;
const err = (msg, code) => Object.assign(new Error(msg), { code });
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
function isInside(child, parent) {
  const rel = path.relative(norm(path.resolve(parent)), norm(path.resolve(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---- ward-namespaced internal key (Mission 40E contract: wardCode + original id). The original id is never rewritten.
const internalKey = (wardCode, id) => String(wardCode) + ':' + String(id);

// ---- paths / safety -------------------------------------------------------------------------------------------------
function lstatOrNull(p) { try { return fs.lstatSync(p); } catch (e) { return null; } }
function checkSource(src) {
  if (!src) throw err('--src required', 2);
  const s = path.resolve(src);
  const st = lstatOrNull(s);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) throw err('source must be an existing real directory (no symlink/junction)', 5);
  if (isInside(s, ROOT) || isInside(ROOT, s)) throw err('source must be outside the repository (this tool is for PC-only data)', 5);
  return s;
}
// any symlink/junction under a ward source dir => refuse (cannot prove read-only provenance)
function scanWardSource(srcDir, wardId) {
  const d = path.join(srcDir, 'osaka-' + wardId);
  const st = lstatOrNull(d);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return { ok: false, reason: 'ward-dir-missing-or-link' };
  let bytes = 0, files = 0; const parts = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isSymbolicLink()) return { ok: false, reason: 'symlink-in-source' };
    if (!e.isFile()) { if (e.isDirectory()) return { ok: false, reason: 'unexpected-subdirectory' }; continue; }
    const fst = fs.lstatSync(path.join(d, e.name));
    if (fst.isSymbolicLink()) return { ok: false, reason: 'symlink-in-source' };
    bytes += fst.size; files++; parts.push(e.name + '|' + fst.size + '|' + Math.round(fst.mtimeMs));
  }
  parts.sort();
  return { ok: true, bytes, files, fingerprint: require('crypto').createHash('sha256').update(parts.join('\n')).digest('hex') };
}
// out-root: outside repo/public and src, a NEW dir or an empty one, or a previous 43F root (marker) holding only our entries.
function checkOutRoot(outRoot, src) {
  if (!outRoot) throw err('--out-root required', 2);
  const o = path.resolve(outRoot);
  if (isInside(o, ROOT) || isInside(ROOT, o)) throw err('output root must be outside the repository (and public/)', 4);
  if (isInside(o, src) || isInside(src, o)) throw err('output root and source must be separate trees', 4);
  const parent = path.dirname(o);
  const pst = lstatOrNull(parent);
  if (!pst || !pst.isDirectory() || pst.isSymbolicLink()) throw err('output parent must be an existing real directory', 4);
  try { if (norm(fs.realpathSync(parent)) !== norm(parent)) throw err('output parent path goes through a link/junction', 4); } catch (e) { if (e.code === 4) throw e; throw err('output parent not resolvable', 4); }
  const st = lstatOrNull(o);
  let resume = false;
  if (st) {
    if (!st.isDirectory() || st.isSymbolicLink()) throw err('output root must be a real directory', 4);
    const entries = fs.readdirSync(o);
    // 43G audit: a planted link (e.g. status.json.tmp -> elsewhere) would let writeFileSync follow it; any link in the root is refused.
    for (const e of fs.readdirSync(o, { withFileTypes: true })) if (e.isSymbolicLink()) throw err('output root contains a link/junction; refusing', 4);
    if (entries.length) {
      let marker = null; try { marker = readJson(path.join(o, MARKER)); } catch (e) { /* foreign */ }
      const ids = reg().map((w) => w.id);
      const allowed = (n) => n === MARKER || n === STATUS || n === STATUS + '.tmp' || n === '_calibration' || ids.some((id) => new RegExp('^' + id + '-a[1-9]$').test(n));
      if (!marker || marker.schema !== SCHEMA || !entries.every(allowed)) throw err('output root exists and is not empty/foreign; refusing', 4);
      resume = true;
    }
  }
  return { out: o, exists: !!st, resume };
}
function freeBytes(dir) { try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch (e) { return null; } }

// ---- status (anonymous, resumable) ----------------------------------------------------------------------------------
function readStatus(out) {
  try { const s = readJson(path.join(out, STATUS)); return s && s.schema === SCHEMA && s.wards ? s : null; } catch (e) { return null; }
}
function writeStatus(out, st) {
  const tmp = path.join(out, STATUS + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(B.assertAnonymous(st), null, 1) + '\n');
  fs.renameSync(tmp, path.join(out, STATUS));
}

// ---- cross-ward duplicate ids: anonymous summary only (counts per ward pair); ids are never altered or dropped -------------
function tileIdsOfWard(srcDir, wardId, fn) {
  const d = path.join(srcDir, 'osaka-' + wardId);
  const m = readJson(path.join(d, 'manifest.json'));
  for (const t of m.tiles || []) {
    const f = path.join(d, typeof t.file === 'string' ? path.basename(t.file) : 'tile_' + t.tx + '_' + t.tz + '.json');
    const tile = readJson(f);
    for (const b of tile.buildings || []) if (b && typeof b.id === 'string') fn(b.id);
  }
}
function crossWardSummary(srcDir, wardIds) {
  const owner = new Map(); // id -> bitmask of ward indexes
  wardIds.forEach((w, i) => tileIdsOfWard(srcDir, w, (id) => owner.set(id, (owner.get(id) || 0) | (1 << i))));
  const pairs = {}; let dupIds = 0;
  for (const mask of owner.values()) {
    if ((mask & (mask - 1)) === 0) continue; // single ward
    dupIds++;
    const ws = wardIds.filter((_, i) => mask & (1 << i));
    for (let a = 0; a < ws.length; a++) for (let b = a + 1; b < ws.length; b++) { const k = ws[a] + '|' + ws[b]; pairs[k] = (pairs[k] || 0) + 1; }
  }
  return { duplicateIds: dupIds, pairs, policy: 'warning only: ids are neither rewritten nor dropped. The viewer mounts one ward at a time and keys sidecars per tileset; internal key = wardCode:originalId' };
}
// number of this ward's ids that also exist in other wards (potential boundary double display), counts only
function overlapCounts(srcDir, wardId, otherIds) {
  const mine = new Set(); tileIdsOfWard(srcDir, wardId, (id) => mine.add(id));
  const per = {};
  for (const o of otherIds) { let n = 0; tileIdsOfWard(srcDir, o, (id) => { if (mine.has(id)) n++; }); if (n) per[o] = n; }
  return per;
}

// ---- per-ward verification (existing 43 verifier + id-set identity with the read-only source) ---------------------------
function verifyWard(outDir, srcDir, wardId, wardCode, expect) {
  const v = T.verifyDir(outDir);
  const problems = v.problems.filter((p) => !/^size /.test(p)); // preview cap is a hosting concern, not a conversion defect
  const warnings = v.problems.filter((p) => /^size /.test(p)).map(() => 'over-60MiB-preview-cap');
  if (v.wardCode !== wardCode) problems.push('wardCode mismatch');
  if (v.uniqueIds !== v.ids) problems.push('output ids not unique');
  if (v.ids !== expect.buildings) problems.push('building count differs from audited source');
  if (v.glbOk === 0) problems.push('no glb');
  // canonicalId identity: output ids == source ids (no rewrite, no drop, no new ids)
  const outIds = L.idSet(outDir); const srcIds = new Set(); tileIdsOfWard(srcDir, wardId, (id) => srcIds.add(id));
  if (outIds.size !== srcIds.size || ![...srcIds].every((id) => outIds.has(id))) problems.push('canonical id set differs from source');
  // geometry: every attrs record has a finite height and finite representative point
  let badAttr = 0;
  const ad = path.join(outDir, 'attrs');
  for (const f of fs.readdirSync(ad)) {
    if (!f.endsWith('.json')) continue;
    for (const r of Object.values(readJson(path.join(ad, f)).byId || {})) if (!(Number.isFinite(r[0]) && Number.isFinite(r[2]) && Number.isFinite(r[3]))) badAttr++;
  }
  if (badAttr) problems.push('non-finite attrs: ' + badAttr);
  return { ok: problems.length === 0, problems: problems.map((p) => String(p).replace(/:.*$/, '').slice(0, 60)), warnings, glb: v.glbOk, tileUris: v.tileUris, ids: v.ids, uniqueIds: v.uniqueIds, bytes: v.bytes };
}

// ---- main driver ----------------------------------------------------------------------------------------------------
function plan(opts) {
  const src = checkSource(opts.src);
  const audit = B.audit(src); // auditReady re-checked in this very run
  if (!audit.ready) {
    return { schema: SCHEMA, mode: 'refused', auditReady: false, fatal: audit.fatal || null, readyWards: audit.readyWards || 0, rootProblemKinds: audit.rootProblemKinds || [],
      wardIssues: Object.fromEntries(Object.entries(audit.wards || {}).filter(([, w]) => !w.ready).map(([k, w]) => [k, w.issues])), converted: 0, gates: audit.gates, uploadAllowed: 0 };
  }
  const bp = B.batchPlan(null, audit);
  return { src, audit, bp };
}

function runConvert(opts) {
  const execute = !!opts.execute;
  const p = plan(opts);
  if (p.mode === 'refused') return B.assertAnonymous(p);
  const { src, audit, bp } = p;
  const dest = checkOutRoot(opts.outRoot, src);
  const maxB = Number.isFinite(opts.maxWardBuildings) ? opts.maxWardBuildings : DEFAULT_MAX_WARD_BUILDINGS;
  const prev = dest.resume ? readStatus(dest.out) : null;
  const done = (id) => prev && prev.wards[id] && prev.wards[id].state === 'ok';
  const pcOnly = bp.wards.filter((w) => w.status === 'pc-only').map((w) => w.ward);
  const R = reg();

  let targets;
  if (opts.wards) targets = String(opts.wards).split(',').map((s) => s.trim()).filter(Boolean);
  else targets = pcOnly.filter((id) => !done(id)).slice(0, Number.isInteger(opts.next) && opts.next > 0 ? opts.next : 1); // default: ONE ward sandbox
  if (!targets.length) throw err('no target ward (--wards or --next)', 2);

  const cross = crossWardSummary(src, R.map((w) => w.id));
  const free = freeBytes(path.dirname(dest.out));
  const results = []; const statusWards = Object.assign({}, prev ? prev.wards : {});
  let cal = null;

  if (execute) {
    if (!dest.exists) fs.mkdirSync(dest.out); // NOT recursive: parent must already exist
    if (!dest.resume) fs.writeFileSync(path.join(dest.out, MARKER), JSON.stringify({ schema: SCHEMA, note: 'Local 3D Tiles conversion root. Not for Git/public.' }), { flag: 'wx' });
    if (opts.calibrate && !fs.existsSync(path.join(dest.out, '_calibration'))) {
      // proves this machine's converter still reproduces the committed 37B 9 tiles from the Git-tracked Sumiyoshi tiles.
      L.setSource(path.join(ROOT, 'public/map-data/osaka-city/buildings'));
      try { const r = T.regress(path.join(dest.out, '_calibration')); cal = { ok: r.ok, buildings: r.rebuilt.buildings, glbIdentical: r.vsCommitted9Tile.glbByteIdentical, of: r.vsCommitted9Tile.refTiles }; }
      catch (e) { cal = { ok: false, reason: 'calibration-error' }; }
      finally { L.setSource(src); }
      if (!cal.ok) throw err('calibration against committed 37B failed; not converting', 3);
    }
  }
  L.setSource(src);
  const convert = opts.convert || L.convertWard;

  for (const id of targets) {
    const w = R.find((x) => x.id === id);
    if (!w) { results.push({ ward: id, state: 'rejected', reason: 'not-in-registry' }); continue; }
    if (done(id)) { results.push({ ward: id, state: 'already-ok', reason: 'never re-converted or overwritten' }); continue; }
    const pw = bp.wards.find((x) => x.ward === id);
    if (pw.status !== 'pc-only') { results.push({ ward: id, state: 'rejected', reason: pw.status === 'tracked-legacy-rebuildable' ? 'git-tracked-use-43D-run' : 'not-pc-only-ready' }); continue; }
    const aw = audit.wards[id];
    if (aw.buildings.found > maxB) { results.push({ ward: id, state: 'rejected', reason: 'over-max-ward-buildings', buildings: aw.buildings.found, max: maxB }); continue; }
    const est = Math.round(aw.buildings.found * B.BYTES_PER_BUILDING);
    const scan = scanWardSource(src, id);
    if (!scan.ok) { results.push({ ward: id, state: 'rejected', reason: scan.reason }); continue; }
    let conv = null; try { conv = readJson(path.join(src, 'osaka-' + id, 'manifest.json')).coordinateConvention; } catch (e) { /* audit already vetted */ }
    if (conv !== 'znorth-neg-v1') { results.push({ ward: id, state: 'rejected', reason: 'bad-coordinate-convention' }); continue; } // converter would throw; never reached with a created dir
    if (free != null && free < est * 2) { results.push({ ward: id, state: 'rejected', reason: 'insufficient-free-disk', estimatedBytes: est }); continue; }
    if (!execute) { results.push({ ward: id, state: 'dry-run', wouldConvert: { tiles: aw.tiles.found, buildings: aw.buildings.found, estimatedBytes: est, sourceBytes: scan.bytes } }); continue; }

    let n = 1; while (n <= MAX_ATTEMPTS && fs.existsSync(path.join(dest.out, id + '-a' + n))) n++;
    if (n > MAX_ATTEMPTS) { results.push({ ward: id, state: 'rejected', reason: 'too-many-attempts' }); continue; }
    const dir = path.join(dest.out, id + '-a' + n);
    let entry;
    try {
      fs.mkdirSync(dir); // non-recursive, fails if present: no overwrite
      const c = convert(id, { out: dir, force: true });
      const after = scanWardSource(src, id);
      if (!after.ok || after.fingerprint !== scan.fingerprint) throw err('source-changed', 6);
      if (c.skipped) throw err('skipped-buildings', 7);
      const v = verifyWard(dir, path.join(src), id, w.code, { buildings: aw.buildings.found });
      const overlap = overlapCounts(src, id, R.map((x) => x.id).filter((x) => x !== id && audit.wards[x] && audit.wards[x].ready));
      const ovTotal = Object.values(overlap).reduce((a, b) => a + b, 0);
      const rep = { schema: SCHEMA, ward: id, wardCode: w.code, ok: v.ok, convert: { tiles: c.tiles, buildings: c.buildings, uniqueIds: c.uniqueIds, fallbacks: c.fallbacks, totalBytes: c.totalBytes, ms: c.ms }, verify: v,
        crossWard: { idsAlsoInOtherWards: ovTotal, byWard: overlap, internalKey: 'wardCode:originalId', idsRewritten: 0, idsDropped: 0 },
        published: false, approvedForPublication: false, uploadAllowed: 0 };
      fs.writeFileSync(path.join(dir, 'verify-report.json'), JSON.stringify(B.assertAnonymous(rep), null, 1) + '\n', { flag: 'wx' });
      entry = { state: v.ok ? 'ok' : 'failed', attempt: n, reason: v.ok ? null : 'verification-failed', problems: v.ok ? undefined : v.problems, buildings: c.buildings, tiles: c.tiles, bytes: c.totalBytes, fallbacks: c.fallbacks, crossWardIds: ovTotal };
    } catch (e) {
      entry ={ state: 'failed', attempt: n, reason: Number.isInteger(e.code) && /^[a-z-]+$/.test(e.message) ? e.message : 'convert-error' };
    }
    statusWards[id] = entry;
    writeStatus(dest.out, { schema: SCHEMA, wards: statusWards, gates: audit.gates, published: false, uploadAllowed: 0 });
    results.push(Object.assign({ ward: id }, entry));
    if (entry.state === 'failed') break; // stop at first failure; partial dir is left untouched, next run uses a new attempt dir
  }
  const pending = pcOnly.filter((id) => !(statusWards[id] && statusWards[id].state === 'ok'));
  return B.assertAnonymous({
    schema: SCHEMA, mode: execute ? 'execute' : 'dry-run', auditReady: true, auditWards: audit.readyWards, gates: audit.gates, published: false, uploaded: false, uploadAllowed: 0,
    warnings: { crossWardDuplicateIds: cross.duplicateIds, pairs: cross.pairs, policy: cross.policy },
    calibration: cal, results, ok: results.every((r) => r.state === 'ok' || r.state === 'dry-run' || r.state === 'already-ok'),
    pcOnlyWards: pcOnly.length, rerunTargets: pending,
    note: 'Output stays in a local directory outside the repo. Not committed, not an Actions artifact, not served, not approved for publication.',
  });
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'convert';
  const has = (k) => argv.includes('--' + k);
  const opt = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    if (cmd === 'status') {
      const o = path.resolve(opt('out-root') || '');
      const s = readStatus(o);
      console.log(JSON.stringify(B.assertAnonymous(s || { schema: SCHEMA, wards: {}, note: 'no status' }), null, 1)); process.exit(0);
    }
    const r = runConvert({ src: opt('src'), outRoot: opt('out-root'), wards: opt('wards'), next: opt('next') ? parseInt(opt('next'), 10) : undefined,
      execute: has('execute'), calibrate: has('calibrate'), maxWardBuildings: opt('max-ward-buildings') ? parseInt(opt('max-ward-buildings'), 10) : undefined });
    console.log(JSON.stringify(r, null, 1));
    process.exit(r.mode === 'refused' ? 1 : (r.ok ? 0 : 3));
  } catch (e) {
    const own = Number.isInteger(e.code);
    console.error(own ? e.message : 'error: operation failed (details suppressed so no path or id is printed)');
    process.exit(own ? e.code : 1);
  }
}
module.exports = { runConvert, checkOutRoot, checkSource, scanWardSource, crossWardSummary, internalKey, verifyWard, readStatus, MARKER, SCHEMA };
if (require.main === module) main();
