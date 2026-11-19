#!/usr/bin/env node
'use strict';
// Mission 45D: one orchestrator for converting ALL 24 wards of the legacy building tiles to local 3D Tiles on the owner's PC.
//   node tools/mission45d-convert-all.cjs --src <legacy buildings dir> --out-root <NEW dir outside repo>            (plan: strict read-only)
//   node tools/mission45d-convert-all.cjs --src ... --out-root ... --execute --approved                              (convert + verify)
//   node tools/mission45d-convert-all.cjs --src ... --out-root ... --verify-only                                     (read-only re-proof)
// 23 PC-only wards -> 43F (convert + immediate per-ward verification, stops at first failure, resumable).
// Sumiyoshi (Git-tracked in the repo) -> 43D rebuild + regression against the committed 37B 9 tiles.
// Then 43G re-verifies every PC ward from the files on disk, and a completion proof is derived from the runtime audit
// (the total building count is NEVER a hard-coded constant). Local conversion != browser display != publication permission.
// Never uploads, commits, serves, deletes or overwrites. Input is read-only. Output = ward ids, counts and status kinds only.
const fs = require('fs');
const path = require('path');
const B = require('./mission43d-ward-batch.cjs');
const T = require('./mission43-ward-rebuild.cjs');
const C = require('./mission43f-pc-convert.cjs');
const G = require('./mission43g-verify-local.cjs');
const L = require('./mission40b-legacy-tiles-batch.cjs');

const ROOT = path.resolve(__dirname, '..');
const REPO_BLD = path.join(ROOT, 'public/map-data/osaka-city/buildings');
const SCHEMA = 'livecity.mission45d.convert-all/1';
const MARKER = '.livecity-45d-root.json';
const STATE = 'state.json';
const COMPLETION = 'completion.json';
const PC_SUB = 'pc23';
const MAX_ATTEMPTS = 9;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const registry = () => readJson(path.join(ROOT, 'config/wards/registry.json')).wards;
const err = (msg, code) => Object.assign(new Error(msg), { code });
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (child, parent) => { const r = path.relative(norm(path.resolve(parent)), norm(path.resolve(child))); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };
const freeBytes = (dir) => { try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch (e) { return null; } };

// ---- output root: outside repo/public and source, NEW or empty, or a previous 45D root (marker) holding only our entries.
function checkRoot(outRoot, src, { mustExist = false } = {}) {
  if (!outRoot) throw err('--out-root required', 2);
  const o = path.resolve(outRoot);
  if (inside(o, ROOT) || inside(ROOT, o)) throw err('output root must be outside the repository (and public/)', 4);
  if (inside(o, src) || inside(src, o)) throw err('output root and source must be separate trees', 4);
  const parent = path.dirname(o);
  const pst = lst(parent);
  if (!pst || !pst.isDirectory() || pst.isSymbolicLink()) throw err('output parent must be an existing real directory', 4);
  try { if (norm(fs.realpathSync(parent)) !== norm(parent)) throw err('output parent path goes through a link/junction', 4); } catch (e) { if (e.code === 4) throw e; throw err('output parent not resolvable', 4); }
  const st = lst(o);
  if (!st) { if (mustExist) throw err('output root does not exist', 4); return { out: o, exists: false, resume: false }; }
  if (!st.isDirectory() || st.isSymbolicLink()) throw err('output root must be a real directory', 4);
  const ents = fs.readdirSync(o, { withFileTypes: true });
  for (const e of ents) if (e.isSymbolicLink()) throw err('output root contains a link/junction; refusing', 4);
  if (!ents.length) { if (mustExist) throw err('output root is empty', 4); return { out: o, exists: true, resume: false }; }
  let marker = null; try { marker = readJson(path.join(o, MARKER)); } catch (e) { /* foreign */ }
  const allowed = (n) => n === MARKER || n === STATE || n === STATE + '.tmp' || n === COMPLETION || n === COMPLETION + '.tmp' || n === PC_SUB || /^sumiyoshi-a[1-9]$/.test(n);
  if (!marker || marker.schema !== SCHEMA || !ents.every((e) => allowed(e.name))) throw err('output root exists and is not empty/foreign; refusing', 4);
  return { out: o, exists: true, resume: true };
}
function writeJsonAtomic(o, name, obj) {
  const tmp = path.join(o, name + '.tmp');
  const st = lst(tmp); if (st && st.isSymbolicLink()) throw err('refusing to write through a link', 4);
  fs.writeFileSync(tmp, JSON.stringify(B.assertAnonymous(obj), null, 1) + '\n');
  fs.renameSync(tmp, path.join(o, name));
}
function readState(o) {
  try { const s = readJson(path.join(o, STATE)); return s && s.schema === SCHEMA ? s : null; } catch (e) { return null; }
}

// ---- Sumiyoshi (Git-tracked): 43D rebuild + regression vs committed 37B, then disk re-verification against the PC source.
function convertSumiyoshi(o, opts) {
  let n = 1; while (n <= MAX_ATTEMPTS && lst(path.join(o, 'sumiyoshi-a' + n))) n++;
  if (n > MAX_ATTEMPTS) return { state: 'failed', reason: 'too-many-attempts' };
  const dir = path.join(o, 'sumiyoshi-a' + n);
  L.setSource(REPO_BLD); // 43F leaves the global source pointing at the PC folder; Sumiyoshi must read the Git-tracked tiles
  try {
    if (opts.sumiyoshiRun) { // test seam: converts a synthetic ward the same way, without the Git-tracked regression
      const c = opts.sumiyoshiRun(dir);
      return { state: 'ok', attempt: n, buildings: c.buildings, regress37b: 'skipped-synthetic' };
    }
    const r = B.run('sumiyoshi', dir, true);
    const x = r.results[0];
    if (!x || x.state !== 'ok') return { state: 'failed', attempt: n, reason: (x && x.reason) || 'rebuild-or-regress-failed' };
    const rg = x.regress37b;
    const regOk = rg && rg.of > 0 && rg.glbIdentical === rg.of && rg.idsIdentical === rg.of && rg.statsIdentical === rg.of;
    if (!regOk) return { state: 'failed', attempt: n, reason: 'regress-37b-mismatch' };
    return { state: 'ok', attempt: n, buildings: x.buildings, regress37b: { of: rg.of, identical: true } };
  } catch (e) {
    return { state: 'failed', attempt: n, reason: 'convert-error' };
  } finally { L.setSource(REPO_BLD); }
}
// B.run(id, outRoot) writes the real output ONE level deeper: <outRoot>/<id>. The synthetic test seam writes flat into outRoot.
// The tileset location is resolved from what is actually on disk (nested preferred); nothing else is ever accepted.
const SOURCE_COMPARE = /^(building count differs from audited source|canonical id set differs from source)$/;
function sumiyoshiOutDir(attemptDir) {
  const nested = path.join(attemptDir, 'sumiyoshi');
  const ns = lst(nested);
  if (ns && ns.isDirectory() && !ns.isSymbolicLink() && lst(path.join(nested, 'tileset.json'))) return nested;
  if (lst(path.join(attemptDir, 'tileset.json'))) return attemptDir; // flat (test seam only)
  return null;
}
function verifySumiyoshi(o, src, entry, audit, reg) {
  const w = reg.find((x) => x.id === 'sumiyoshi');
  if (!entry || entry.state !== 'ok') return { state: 'absent', reasons: ['no-ok-entry'] };
  const attemptDir = path.join(o, 'sumiyoshi-a' + entry.attempt);
  const st = lst(attemptDir);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return { state: 'not-ready', reasons: ['dir-missing'], integrity: true };
  if (G.linkScan(attemptDir)) return { state: 'not-ready', reasons: ['link-in-output'], integrity: true };
  const dir = sumiyoshiOutDir(attemptDir);
  if (!dir) return { state: 'not-ready', reasons: ['tileset-missing'], integrity: true };
  const aw = audit.wards.sumiyoshi;
  if (!aw || !aw.ready) return { state: 'not-ready', reasons: ['source-ward-not-audit-ready'] };
  try {
    // buildings must equal the PC source count and the canonical id set must equal the PC source id set (also proves Git == PC data)
    const v = C.verifyWard(dir, src, 'sumiyoshi', w.code, { buildings: aw.buildings.found });
    const reasons = v.problems.slice();
    G.idsAttrsIdentity(dir).forEach((p) => reasons.push(p));
    const uniq = [...new Set(reasons)];
    // integrity = some problem is damage/missing output; a pure Git-vs-PC source difference cannot be fixed by converting again
    return { state: reasons.length ? 'not-ready' : 'verified', reasons: uniq, integrity: uniq.length > 0 && !uniq.every((r) => SOURCE_COMPARE.test(r)), buildings: v.ids, uniqueIds: v.uniqueIds, glb: v.glb, bytes: v.bytes };
  } catch (e) { return { state: 'not-ready', reasons: ['verification-error'], integrity: true }; }
}

// ---- completion proof (anonymous aggregates only). Called after convert and by --verify-only.
function proof(o, src, audit, opts) {
  const reg = registry();
  const state = readState(o) || { sumiyoshi: null };
  const pcRoot = path.join(o, PC_SUB);
  let pcV = null; const problems = [];
  if (lst(pcRoot)) { try { pcV = G.verifyRoot({ outRoot: pcRoot, src }); } catch (e) { problems.push('pc23-root-unverifiable'); } } else problems.push('pc23-root-missing');
  const sv = verifySumiyoshi(o, src, state.sumiyoshi, audit, reg);
  const pcVerified = pcV ? pcV.verifiedWards : 0;
  const pcBuildings = pcV ? pcV.verifiedBuildings : 0;
  const sumVerified = sv.state === 'verified' ? 1 : 0;
  const sourceBuildings = audit.totals.buildings; // runtime audit, not a constant
  const wardSum = Object.values(audit.wards).reduce((a, w) => a + (w.buildings.found || 0), 0);
  if (wardSum !== sourceBuildings) problems.push('audit-totals-inconsistent');
  const converted = pcBuildings + (sumVerified ? sv.buildings : 0);
  if (pcV) pcV.rootProblems.forEach((p) => problems.push('pc23:' + p));
  if (pcV && pcV.verifiedWards !== reg.length - 1) problems.push('pc23:not-all-wards-verified(' + pcV.verifiedWards + '/' + (reg.length - 1) + ')');
  if (!sumVerified) problems.push('sumiyoshi:' + (sv.reasons || []).join(','));
  const regressOk = opts.synthetic ? true : !!(state.sumiyoshi && state.sumiyoshi.regress37b && state.sumiyoshi.regress37b.identical === true);
  if (!regressOk) problems.push('sumiyoshi:regress-37b-not-proven');
  const convertedWards = pcVerified + sumVerified;
  const complete = problems.length === 0 && convertedWards === 24 && pcVerified + sumVerified === 24 && converted === sourceBuildings && audit.ready === true && regressOk;
  return B.assertAnonymous({
    schema: SCHEMA, kind: opts.synthetic ? 'synthetic' : 'real', readOnly: true, uploaded: 0, uploadAllowed: 0, published: false, approvedForPublication: false, gates: G.GATES,
    auditReady: audit.ready === true, sourceBuildings, convertedBuildings: converted, convertedWards, verifiedWards: convertedWards, totalWards: 24,
    pc23: { verifiedWards: pcVerified, verifiedBuildings: pcBuildings, notReady: pcV ? pcV.notReadyWards : null, absent: pcV ? pcV.absentWards : null },
    sumiyoshi: { state: sv.state, buildings: sv.buildings == null ? null : sv.buildings, regress37b: opts.synthetic ? 'skipped-synthetic' : (regressOk ? 'identical-to-committed-9-tiles' : 'not-proven') },
    failures: problems.length, problems: [...new Set(problems)].slice(0, 20),
    warnings: { crossWardDuplicateIds: audit.warnings ? audit.warnings.crossWardDuplicateIds : null, policy: 'warning only; ids are never rewritten or dropped; internal key = wardCode:originalId' },
    complete,
    scope: 'LOCAL CONVERSION ONLY. This is neither browser display of 24 wards nor permission to publish; licence / secret / personal-data gates stay false.',
  });
}

// ---- main driver
function run(opts) {
  const stage = typeof opts.onStage === 'function' ? opts.onStage : () => {}; // 45U: stage names only (no paths / ids)
  const execute = !!opts.execute, approved = !!opts.approved;
  if (opts.sumiyoshiRun) opts = Object.assign({}, opts, { synthetic: true }); // the test seam can never produce a "real" proof
  if (execute && !approved) throw err('--execute requires --approved (explicit owner approval). Nothing was done.', 2);
  if (opts.approved && !execute && !opts.verifyOnly) throw err('--approved without --execute does nothing; refusing', 2);
  stage('45d:source-check');
  const src = C.checkSource(opts.src);
  stage('45d:source-audit');
  const audit = B.audit(src); // auditReady re-checked in THIS run
  if (!audit.ready) {
    return B.assertAnonymous({ schema: SCHEMA, mode: 'refused', auditReady: false, fatal: audit.fatal || null, readyWards: audit.readyWards || 0, rootProblemKinds: audit.rootProblemKinds || [],
      wardIssues: Object.fromEntries(Object.entries(audit.wards || {}).filter(([, w]) => !w.ready).map(([k, w]) => [k, w.issues])), converted: 0, complete: false, uploadAllowed: 0 });
  }
  const reg = registry();
  stage('45d:out-root-check');
  const dest = checkRoot(opts.outRoot, src, { mustExist: !!opts.verifyOnly });
  if (opts.verifyOnly) { stage('45d:proof'); return proof(dest.out, src, audit, opts); }

  const prev = dest.resume ? readState(dest.out) : null;
  // done = recorded ok AND the output on disk re-verifies now. A pure source mismatch is not retried (deterministic); damage is (new attempt dir).
  const sumCheck = prev && prev.sumiyoshi && prev.sumiyoshi.state === 'ok' ? verifySumiyoshi(dest.out, src, prev.sumiyoshi, audit, reg) : null;
  const sumDone = !!sumCheck && (sumCheck.state === 'verified' || sumCheck.integrity === false);
  const pcStatus = dest.resume ? C.readStatus(path.join(dest.out, PC_SUB)) : null;
  const pcIds = reg.filter((w) => w.id !== 'sumiyoshi').map((w) => w.id);
  const pcPending = pcIds.filter((id) => !(pcStatus && pcStatus.wards[id] && pcStatus.wards[id].state === 'ok'));
  const est = Math.round(audit.totals.buildings * B.BYTES_PER_BUILDING);
  const free = freeBytes(path.dirname(dest.out));
  const plan = { sumiyoshi: sumDone ? 'already-ok' : (sumCheck ? 'would-rebuild-new-attempt(disk-verification-failed)' : 'would-rebuild-from-git-tracked-tiles'), pc23Pending: pcPending.length, estimatedBytes: est, freeBytes: free, enoughDisk: free == null ? null : free >= est * 2 };
  if (!execute) {
    // strict dry-run: 43F dry-run only inspects (creates nothing)
    const probe = dest.exists ? path.join(dest.out, PC_SUB) : dest.out + '-probe'; // never created: dry-run only inspects
    const d = pcPending.length ? C.runConvert({ src, outRoot: probe, wards: pcPending.join(',') }) : null;
    return B.assertAnonymous({ schema: SCHEMA, mode: 'plan', auditReady: true, totalWards: 24, sourceBuildings: audit.totals.buildings, plan, pc23DryRun: d ? { ok: d.ok, results: d.results.map((r) => ({ ward: r.ward, state: r.state, reason: r.reason })) } : null,
      warnings: { crossWardDuplicateIds: audit.warnings.crossWardDuplicateIds }, wrote: 0, uploadAllowed: 0, published: false,
      next: 'add --execute --approved to convert into a local folder outside the repo' });
  }
  if (free != null && free < est * 2) throw err('insufficient free disk for the estimated output', 4);

  if (!dest.exists) fs.mkdirSync(dest.out); // NOT recursive: parent must already exist
  if (!dest.resume) fs.writeFileSync(path.join(dest.out, MARKER), JSON.stringify({ schema: SCHEMA, note: 'Local 3D Tiles conversion root (24 wards). Not for Git/public.' }), { flag: 'wx' });
  const state = prev || { schema: SCHEMA, sumiyoshi: null, published: false, uploadAllowed: 0 };
  const steps = [];

  if (!sumDone) {
    const r = convertSumiyoshi(dest.out, opts);
    state.sumiyoshi = r; writeJsonAtomic(dest.out, STATE, state);
    steps.push({ ward: 'sumiyoshi', state: r.state, reason: r.reason || null, buildings: r.buildings });
    if (r.state !== 'ok') return finish(dest.out, src, audit, opts, steps, 'stopped-at-sumiyoshi');
  } else steps.push({ ward: 'sumiyoshi', state: 'already-ok' });

  if (pcPending.length) {
    // 43F converts ward by ward in registry order and verifies each ward immediately; it stops at the first failure.
    const pcOut = path.join(dest.out, PC_SUB);
    const r = C.runConvert({ src, outRoot: pcOut, wards: pcPending.join(','), execute: true });
    L.setSource(REPO_BLD);
    if (r.mode === 'refused') return finish(dest.out, src, audit, opts, steps, 'pc23-refused');
    r.results.forEach((x) => steps.push({ ward: x.ward, state: x.state, reason: x.reason || null, buildings: x.buildings }));
    if (!r.ok) return finish(dest.out, src, audit, opts, steps, 'stopped-at-first-failure');
  }
  return finish(dest.out, src, audit, opts, steps, 'converted');
}
function finish(o, src, audit, opts, steps, stage) {
  const p = proof(o, src, audit, opts);
  writeJsonAtomic(o, COMPLETION, p);
  return B.assertAnonymous(Object.assign({ mode: 'execute', stage, steps }, p));
}

function main() {
  const argv = process.argv.slice(2);
  const has = (k) => argv.includes('--' + k);
  const opt = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const r = run({ src: opt('src'), outRoot: opt('out-root'), execute: has('execute'), approved: has('approved'), verifyOnly: has('verify-only') });
    console.log(JSON.stringify(r, null, 1));
    if (r.mode === 'refused') process.exit(1);
    if (r.mode === 'plan') process.exit(r.plan.enoughDisk === false || (r.pc23DryRun && !r.pc23DryRun.ok) ? 3 : 0);
    process.exit(r.complete ? 0 : 3);
  } catch (e) {
    const own = Number.isInteger(e.code);
    console.error(own ? e.message : 'error: operation failed (details suppressed so no path or id is printed)');
    process.exit(own ? e.code : 1);
  }
}
module.exports = { run, proof, checkRoot, convertSumiyoshi, verifySumiyoshi, sumiyoshiOutDir, readState, SCHEMA, MARKER };
if (require.main === module) main();
