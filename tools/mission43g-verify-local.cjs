#!/usr/bin/env node
'use strict';
// Mission 43G: read-only verification of a 43F output root (PC-only wards converted to local 3D Tiles).
//   node tools/mission43g-verify-local.cjs --out-root <43F root> [--src <legacy buildings dir>] [--wards a,b]
// Writes nothing, uploads nothing, deletes nothing. status.json is never trusted on its own: every ward is re-verified from the
// files on disk (43 verifyDir + ids/attrs identity + link scan; with --src also the 43D audit and canonical-id identity with the source).
// Output = ward ids, counts and reason kinds only (no paths, no building ids, no file names).
const fs = require('fs');
const path = require('path');
const B = require('./mission43d-ward-batch.cjs');
const T = require('./mission43-ward-rebuild.cjs');
const C = require('./mission43f-pc-convert.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = 'livecity.mission43g.verify/1';
const GATES = { licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false, uploadAllowed: 0 };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const registry = () => readJson(path.join(ROOT, 'config/wards/registry.json')).wards;
const PC_ONLY = () => registry().filter((w) => w.id !== 'sumiyoshi'); // sumiyoshi is Git-tracked (43D), not a 43F ward
const err = (msg, code) => Object.assign(new Error(msg), { code });
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (child, parent) => { const r = path.relative(norm(path.resolve(parent)), norm(path.resolve(child))); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };
const kind = (m) => String(m).replace(/:.*$/, '').replace(/[^A-Za-z0-9 _>.=()/-]/g, '').slice(0, 60);

// ---- root checks (fail-closed). Returns the resolved root or throws a coded, path-free error.
function checkRoot(outRoot) {
  if (!outRoot) throw err('--out-root required', 2);
  const o = path.resolve(outRoot);
  if (inside(o, ROOT) || inside(ROOT, o)) throw err('root-inside-repository', 4);
  const st = lst(o);
  if (!st) throw err('root-missing', 4);
  if (st.isSymbolicLink() || !st.isDirectory()) throw err('root-not-real-directory', 4);
  try { if (norm(fs.realpathSync(o)) !== norm(o)) throw err('root-path-through-link', 4); } catch (e) { if (e.code === 4) throw e; throw err('root-unresolvable', 4); }
  let marker; try { marker = readJson(path.join(o, C.MARKER)); } catch (e) { throw err('root-marker-missing-or-broken', 4); }
  if (!marker || marker.schema !== C.SCHEMA) throw err('root-marker-foreign', 4);
  const ids = registry().map((w) => w.id);
  for (const e of fs.readdirSync(o, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw err('root-contains-link', 4);
    const okName = e.name === C.MARKER || e.name === 'status.json' || e.name === 'status.json.tmp' || e.name === '_calibration' || ids.some((id) => new RegExp('^' + id + '-a[1-9]$').test(e.name));
    if (!okName) throw err('root-contains-unrelated-entry', 4);
  }
  return o;
}
function readStatusStrict(o) {
  const p = path.join(o, 'status.json');
  const st = lst(p);
  if (!st) return { status: null, problem: 'status-missing' };
  if (!st.isFile()) return { status: null, problem: 'status-not-file' };
  let s; try { s = readJson(p); } catch (e) { return { status: null, problem: 'status-broken-json' }; }
  if (!s || s.schema !== C.SCHEMA || !s.wards || typeof s.wards !== 'object') return { status: null, problem: 'status-wrong-schema' };
  return { status: s, problem: null };
}
// number of links / non-regular entries anywhere under a ward dir
function linkScan(dir) {
  let n = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isSymbolicLink() || (!e.isFile() && !e.isDirectory())) { n++; continue; } if (e.isDirectory()) walk(path.join(d, e.name)); } };
  walk(dir); return n;
}
// ids/ and attrs/ must describe the same canonical id set, tile by tile (tampering with one side is caught)
function idsAttrsIdentity(dir) {
  const bad = [];
  const idsDir = path.join(dir, 'ids'), attrsDir = path.join(dir, 'attrs');
  const idFiles = fs.readdirSync(idsDir).filter((f) => /^t_.*\.json$/.test(f));
  const attrFiles = new Set(fs.readdirSync(attrsDir).filter((f) => f.endsWith('.json')));
  if (idFiles.length !== attrFiles.size) bad.push('ids/attrs tile sets differ');
  const wardCode = String(readJson(path.join(dir, 'source.json')).wardCode);
  for (const f of idFiles) {
    if (!attrFiles.has(f)) { bad.push('attrs tile missing'); continue; }
    const a = readJson(path.join(idsDir, f)); const list = Array.isArray(a) ? a : (a.ids || []);
    const att = readJson(path.join(attrsDir, f));
    const byId = att.byId || {};
    if (Object.keys(byId).length !== list.length || !list.every((id) => Object.prototype.hasOwnProperty.call(byId, id))) bad.push('ids/attrs identity differs');
    if (att.wardCode != null && String(att.wardCode) !== wardCode) bad.push('attrs wardCode differs from source.json');
  }
  return [...new Set(bad)];
}

function verifyWardOnDisk(o, w, entry, ctx) {
  const reasons = [];
  if (!entry) return { ward: w.id, state: 'absent', reasons: ['no-status-entry'] };
  if (entry.state !== 'ok') return { ward: w.id, state: 'not-ready', reasons: ['status-state-' + String(entry.state).replace(/[^a-z-]/g, '').slice(0, 20)] };
  const attempt = Number.isInteger(entry.attempt) ? entry.attempt : null;
  if (!attempt || attempt < 1 || attempt > 9) return { ward: w.id, state: 'not-ready', reasons: ['status-bad-attempt'] };
  const dir = path.join(o, w.id + '-a' + attempt);
  const st = lst(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return { ward: w.id, state: 'not-ready', reasons: ['status-claims-ok-but-dir-missing'] };
  try {
    if (linkScan(dir)) return { ward: w.id, state: 'not-ready', reasons: ['link-in-output'] };
    let v;
    if (ctx.src) {
      const aw = ctx.audit.wards[w.id];
      if (!aw || !aw.ready) return { ward: w.id, state: 'not-ready', reasons: ['source-ward-not-audit-ready'] };
      v = C.verifyWard(dir, ctx.src, w.id, w.code, { buildings: aw.buildings.found });
      v.problems.forEach((p) => reasons.push(kind(p)));
    } else {
      const r = T.verifyDir(dir);
      v = { ids: r.ids, uniqueIds: r.uniqueIds, glb: r.glbOk, bytes: r.bytes };
      r.problems.filter((p) => !/^size /.test(p)).forEach((p) => reasons.push(kind(p)));
      if (r.wardCode !== w.code) reasons.push('wardCode mismatch');
      if (r.uniqueIds !== r.ids) reasons.push('output ids not unique');
      if (!r.glbOk) reasons.push('no glb');
    }
    if (!reasons.length) {
      if (entry.buildings !== v.ids) reasons.push('status-count-differs-from-disk');
      idsAttrsIdentity(dir).forEach((p) => reasons.push(kind(p)));
      let rep = null; try { rep = readJson(path.join(dir, 'verify-report.json')); } catch (e) { /* checked below */ }
      if (!rep || rep.ok !== true) reasons.push('verify-report-missing-or-not-ok');
      else if (rep.published === true || rep.approvedForPublication === true || rep.uploadAllowed) reasons.push('verify-report-claims-publication');
    }
    const bad = reasons.length > 0;
    return { ward: w.id, state: bad ? 'not-ready' : 'verified', reasons: [...new Set(reasons)], buildings: v.ids, uniqueIds: v.uniqueIds, glb: v.glb, bytes: v.bytes, attempt };
  } catch (e) {
    return { ward: w.id, state: 'not-ready', reasons: ['verification-error'] };
  }
}

function verifyRoot(opts) {
  const o = checkRoot(opts.outRoot);
  const ctx = { src: null, audit: null };
  const rootProblems = [];
  if (opts.src) {
    ctx.src = C.checkSource(opts.src);
    ctx.audit = B.audit(ctx.src);
    if (!ctx.audit.ready) rootProblems.push('source-audit-not-ready');
  }
  const { status, problem } = readStatusStrict(o);
  if (problem) rootProblems.push(problem);
  const pc = PC_ONLY();
  let scope = pc;
  if (opts.wards) {
    const want = String(opts.wards).split(',').map((s) => s.trim()).filter(Boolean);
    scope = want.map((id) => pc.find((w) => w.id === id) || null);
    if (!scope.length || scope.some((x) => !x)) rootProblems.push('ward-not-pc-only-or-unknown');
    scope = scope.filter(Boolean);
  }
  const wards = [];
  for (const w of scope) {
    if (!status) { wards.push({ ward: w.id, state: 'absent', reasons: ['no-usable-status'] }); continue; }
    if (ctx.src && !ctx.audit.ready) { wards.push({ ward: w.id, state: 'not-ready', reasons: ['source-audit-not-ready'] }); continue; }
    wards.push(verifyWardOnDisk(o, w, status.wards[w.id], ctx));
  }
  const verified = wards.filter((x) => x.state === 'verified');
  const complete = !opts.wards && rootProblems.length === 0 && verified.length === pc.length;
  return B.assertAnonymous({
    schema: SCHEMA, readOnly: true, wrote: 0, uploaded: 0, uploadAllowed: 0, published: false, approvedForPublication: false, gates: GATES,
    sourceChecked: !!ctx.src, auditReadyWards: ctx.audit ? ctx.audit.readyWards : null,
    rootProblems, scopeWards: scope.length, verifiedWards: verified.length, notReadyWards: wards.filter((x) => x.state === 'not-ready').length,
    absentWards: wards.filter((x) => x.state === 'absent').length, verifiedBuildings: verified.reduce((a, x) => a + x.buildings, 0),
    pcOnlyWardsExpected: pc.length, complete,
    ok: rootProblems.length === 0 && verified.length > 0 && verified.length === scope.length,
    wards,
    note: 'status.json is never trusted alone. A verified ward is not approved for publication or transfer; gates stay false.',
  });
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const r = verifyRoot({ outRoot: opt('out-root'), src: opt('src'), wards: opt('wards') });
    console.log(JSON.stringify(r, null, 1));
    process.exit(r.ok ? 0 : 3);
  } catch (e) {
    const own = Number.isInteger(e.code);
    console.log(JSON.stringify({ schema: SCHEMA, readOnly: true, ok: false, fatal: own ? e.message : 'verification-failed' }, null, 1));
    process.exit(own ? e.code : 1);
  }
}
module.exports = { verifyRoot, checkRoot, readStatusStrict, linkScan, idsAttrsIdentity, verifyWardOnDisk, PC_ONLY, SCHEMA, GATES };
if (require.main === module) main();
