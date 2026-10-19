'use strict';
// Mission 41O: fail-closed HOLD proposal from the 41B manifest + 41K state, staged-scan progress, tar cross-check, UUID-shape triage.
// OFFLINE, READ-ONLY. No upload, no network. Source files and existing tars are never modified, moved or deleted.
// Output contains ONLY anonymous ids (sha256(root:rel) first 8 hex), categories, extensions, sizes and counts. Never a path, name, value or context.
//   node tools/mission41o-holdplan.cjs progress  --manifest m.json [--state s.json] [--slice 5000]
//   node tools/mission41o-holdplan.cjs propose   --manifest m.json [--state s.json] [--hold-id 8hex[,..]] [--write-dir <NEW dir>]
//   node tools/mission41o-holdplan.cjs approve   --proposal p.json --confirm-hold --out <NEW dir>   (writes a 41N-compatible ids-only plan)
//   node tools/mission41o-holdplan.cjs tar-check --manifest m.json --tar-dir <dir> [--state s.json] [--hold-id ..]
//   node tools/mission41o-holdplan.cjs uuid-shape --manifest m.json --roots-file r.json [--state s.json] [--category building-tiles] [--max-files N]
// Fail closed: ONLY a file scanned by the CURRENT detector set with zero detections is "scanned-no-pattern", and even that is NOT safe/approved.
// Everything else (findings, unscanned, not reached, stale state, size changed) is unreviewed; files with findings and the always-held id are HOLD candidates.
// Holding a file out is the conservative direction; approving a file for transfer is never done here. All gates stay false.
const fs = require('node:fs');
const path = require('node:path');
const k = require('./mission41k-content-scan.cjs');
const l = require('./mission41l-triage.cjs');
const d = require('./mission41d-pack.cjs');
const f41 = require('./mission41f-pack-local.cjs');
const n41 = require('./mission41n-exclude.cjs');

const ALWAYS_HOLD = ['e6b68bd7'];
const ID_RE = /^[0-9a-f]{8}$/;
const MIB = 1024 * 1024;
const GATES = { licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false };

function parseHoldIds(s) {
  const extra = s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (!extra.every((x) => ID_RE.test(x))) throw new Error('--hold-id must be 8-hex ids (comma separated)');
  return [...new Set([...ALWAYS_HOLD, ...extra])];
}
function loadState(file) {
  if (!file || !fs.existsSync(file)) return { state: null, valid: false, reason: 'no-state-file' };
  const st = k.loadJson(file);
  if (!st || !st.files) return { state: null, valid: false, reason: 'unreadable-state' };
  if (st.scannerVersion !== k.SCANNER_VERSION || st.detectorFingerprint !== k.detectorFingerprint()) return { state: st, valid: false, reason: 'old-scanner-or-detector' };
  return { state: st, valid: true, reason: null };
}

// status per manifest file: findings | scanned-no-pattern | unscanned | not-reached | stale-state | changed-since-manifest
function classifyAll(m, stateInfo) {
  const rows = [];
  for (const f of k.manifestFiles(m)) {
    const { root, rel } = k.splitPath(f.path);
    const id = k.fid(root, rel); let status; let detections = null; let reason = null;
    const e = stateInfo.valid ? stateInfo.state.files[k.skey(root, rel)] : undefined;
    if (!stateInfo.state) status = 'not-reached';
    else if (!stateInfo.valid) status = 'stale-state';
    else if (!e) status = 'not-reached';
    else if (e.size !== undefined && f.size !== undefined && e.size !== f.size) status = 'changed-since-manifest';
    else if (e.status === 'scanned') {
      const real = Object.entries(e.counts || {}).filter(([x]) => x !== 'email-example-domain-ignored');
      if (real.length) { status = 'findings'; detections = Object.fromEntries(real); } else status = 'scanned-no-pattern';
    } else { status = 'unscanned'; reason = e.reason || 'unknown'; }
    rows.push({ id, category: f.category, ext: k.extOf(rel) || '(none)', bytes: f.size || 0, status, reason, detections });
  }
  return rows;
}
const tally = (rows, keyFn) => { const o = {}; for (const r of rows) { const x = keyFn(r); o[x] = (o[x] || 0) + 1; } return o; };

function progress(m, stateInfo, slice) {
  slice = slice || 5000;
  const rows = classifyAll(m, stateInfo);
  const total = rows.length;
  const reached = rows.filter((r) => r.status !== 'not-reached' && r.status !== 'stale-state').length;
  const remaining = total - reached;
  return { tool: 'mission41o-holdplan', mode: 'progress', total, reached, notReached: remaining, percent: total ? Math.round((reached / total) * 1000) / 10 : 0,
    stateValid: stateInfo.valid, stateNote: stateInfo.reason, byStatus: tally(rows, (r) => r.status),
    unscannedByReason: tally(rows.filter((r) => r.status === 'unscanned'), (r) => r.reason),
    sliceSize: slice, slicesRemaining: Math.ceil(remaining / slice), complete: remaining === 0,
    note: 'reached means "looked at", not "reviewed"; scanned-no-pattern is not safe and unscanned is not safe', gates: { ...GATES } };
}

function impact(m, ids) {
  const idSet = new Set(ids);
  const sum = (ps) => ({ files: ps.reduce((a, p) => a + p.files.length, 0), bytes: ps.reduce((a, p) => a + p.files.reduce((x, y) => x + y.size, 0), 0), tarEstimate: ps.reduce((a, p) => a + d.tarEstimate(p.files), 0) });
  return { before: sum(f41.selectForPack(m, {}).parts), after: sum(f41.selectForPack(m, { excludeIds: idSet }).parts) };
}

function propose(m, stateInfo, holdIds) {
  const rows = classifyAll(m, stateInfo);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hold = new Map();
  for (const r of rows) if (r.status === 'findings') hold.set(r.id, { id: r.id, category: r.category, ext: r.ext, bytes: r.bytes, why: 'detected-by-41K', detections: r.detections });
  const alwaysMissing = [];
  for (const id of holdIds) {
    const r = byId.get(id);
    if (!r) { alwaysMissing.push(id); continue; }
    const cur = hold.get(id);
    if (cur) cur.why = 'detected-by-41K+owner-HOLD';
    else hold.set(id, { id, category: r.category, ext: r.ext, bytes: r.bytes, why: 'owner-HOLD', detections: r.detections });
  }
  const holdList = [...hold.values()].sort((a, b) => a.id.localeCompare(b.id));
  const unreviewed = rows.filter((r) => r.status !== 'scanned-no-pattern' && !hold.has(r.id));
  const holdIdsOut = holdList.map((h) => h.id);
  return { schema: 1, tool: 'mission41o-holdplan', kind: 'hold-proposal', proposalOnly: true, approved: false,
    state: { valid: stateInfo.valid, note: stateInfo.reason },
    totals: { manifestFiles: rows.length, byStatus: tally(rows, (r) => r.status) },
    holdCandidates: { count: holdList.length, bytes: holdList.reduce((a, h) => a + h.bytes, 0), byCategory: tally(holdList, (h) => h.category), byExtension: tally(holdList, (h) => h.ext), files: holdList.slice(0, 1000) },
    holdIds: holdIdsOut, alwaysHoldNotInManifest: alwaysMissing,
    unreviewed: { count: unreviewed.length, byStatus: tally(unreviewed, (r) => r.status), byCategory: tally(unreviewed, (r) => r.category),
      note: 'NOT hold candidates only because nothing was detected or nothing was looked at. They are unreviewed, not safe; a human decision is still required for every transfer.' },
    impactIfAllHeld: impact(m, holdIdsOut),
    complete: rows.every((r) => r.status === 'findings' || r.status === 'scanned-no-pattern'),
    gates: { ...GATES }, autoApproved: false, autoExcluded: false,
    caveats: ['a hold list built from an incomplete or stale scan is a MINIMUM: more files may need holding after the scan completes',
      'detections are pattern matches (false positives exist); holding them out is conservative and reversible, and does not clear anything else',
      'this proposal is not accepted by 41F directly: run the approve command with --confirm-hold to write a 41N-compatible ids-only plan'] };
}

function writeNew(dir, name, obj) {
  const abs = path.resolve(dir);
  if (fs.existsSync(abs) && fs.readdirSync(abs).length) throw new Error('output folder is not empty (will not overwrite)');
  fs.mkdirSync(abs, { recursive: true });
  const file = path.join(abs, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 1), { flag: 'wx' });
  return file;
}
function approve(proposal, confirm, outDir) {
  if (!confirm) throw new Error('refused: pass --confirm-hold (this only HOLDS files back; it approves nothing)');
  if (!proposal || proposal.tool !== 'mission41o-holdplan' || proposal.kind !== 'hold-proposal' || !Array.isArray(proposal.holdIds) || !proposal.holdIds.every((x) => ID_RE.test(x))) throw new Error('not a 41O hold proposal');
  const plan = { schema: 1, tool: 'mission41n-exclude', excludeIds: proposal.holdIds, reason: '41O hold proposal confirmed by the owner (conservative hold)', excludedByOwnerRequest: true,
    note: 'ids only; holding out reviews nothing else', gates: { ...GATES } };
  return writeNew(outDir, 'exclusion-plan.json', plan);
}

// header-only cross-check of existing tars against hold candidates and review status; names never printed
function tarCheck(m, stateInfo, holdIds, tarDir) {
  const rows = classifyAll(m, stateInfo); const byId = new Map(rows.map((r) => [r.id, r]));
  const hold = new Set(holdIds); for (const r of rows) if (r.status === 'findings') hold.add(r.id);
  const out = [];
  let i = 0;
  for (const name of fs.readdirSync(tarDir).filter((x) => /\.tar$/i.test(x)).sort()) {
    i++;
    try {
      const t = n41.tarMemberIds(path.join(tarDir, name));
      let held = 0, unrev = 0, notInManifest = 0;
      for (const id of t.ids) {
        const r = byId.get(id);
        if (!r) { notInManifest++; continue; }
        if (hold.has(id)) held++;
        if (r.status !== 'scanned-no-pattern') unrev++;
      }
      out.push({ tar: i, members: t.count, holdCandidatesInside: held, unreviewedInside: unrev, membersNotInManifest: notInManifest, mustRepack: held > 0, safe: false });
    } catch (e) { out.push({ tar: i, error: 'unreadable-tar' }); }
  }
  return { tool: 'mission41o-holdplan', mode: 'tar-check', checked: out.length, rows: out, mustRepackCount: out.filter((r) => r.mustRepack).length, stateValid: stateInfo.valid,
    note: 'no tar is ever treated as safe: "safe" is always false. A tar with hold candidates must be re-created into a NEW folder; tars are never modified or deleted here.', gates: { ...GATES } };
}

// UUID-shape triage: anonymous class per finding file; never approves
function uuidShape(m, stateInfo, roots, opts) {
  opts = opts || {}; const cat = opts.category || 'building-tiles';
  const rows = classifyAll(m, stateInfo).filter((r) => r.status === 'findings' && r.category === cat && r.detections && r.detections['jp-phone-number']);
  const byId = new Map();
  for (const f of k.manifestFiles(m)) { const { root, rel } = k.splitPath(f.path); byId.set(k.fid(root, rel), { root, rel }); }
  const out = []; const tl = {}; let done = 0;
  for (const r of rows) {
    if (opts.maxFiles && done >= opts.maxFiles) break;
    done++;
    const p = byId.get(r.id); const rootDir = roots[p.root]; let cls;
    if (!rootDir) cls = 'root-not-given';
    else {
      const full = path.join(rootDir, ...p.rel.split('/'));
      try {
        const st = fs.statSync(full);
        if (st.size > 128 * MIB) cls = 'over-128MiB-not-classified';
        else if (k.BINARY_EXT.has(r.ext)) cls = 'binary-not-classified';
        else {
          const classes = l.classifyMatches(fs.readFileSync(full).toString('latin1'), 'jp-phone-number');
          const keys = Object.keys(classes); const total = Object.values(classes).reduce((a, b) => a + b, 0);
          if (!total) cls = 'no-match-now';
          else if (keys.every((c) => /inside-uuid-like-id/.test(c))) cls = 'uuid-shape-only';
          else if (keys.every((c) => /inside-uuid-like-id|inside-numeric-list|adjacent-to-letters/.test(c))) cls = 'id-or-numeric-shape-only';
          else cls = 'free-text-or-field-present';
        }
      } catch (e) { cls = 'unreadable-or-cloud-only'; }
    }
    tl[cls] = (tl[cls] || 0) + 1;
    out.push({ id: r.id, class: cls, approved: false });
  }
  return { tool: 'mission41o-holdplan', mode: 'uuid-shape', category: cat, candidates: rows.length, processed: done, byClass: tl, files: out.slice(0, 500),
    note: 'a shape class is a CANDIDATE false-positive label only. Nothing is approved or removed from the hold list; the owner decides.', autoApproved: false, gates: { ...GATES } };
}

function arg(argv, key) { const i = argv.indexOf(key); return i >= 0 ? argv[i + 1] : undefined; }
function run(argv) {
  const cmd = argv[0];
  const manifestF = arg(argv, '--manifest');
  const stateF = arg(argv, '--state') || (manifestF ? path.join(path.dirname(path.resolve(manifestF)), 'content-scan-state.json') : undefined);
  const out = (o) => console.log(JSON.stringify(o, null, 1));
  if (cmd === 'approve') {
    const f = approve(k.loadJson(arg(argv, '--proposal')), argv.includes('--confirm-hold'), arg(argv, '--out'));
    console.log('wrote a NEW ids-only plan: ' + path.basename(f)); return 0;
  }
  if (!manifestF) throw new Error('--manifest is required');
  const m = k.loadJson(manifestF);
  if (!m || m.schema !== 2 || !Array.isArray(m.parts)) throw new Error('manifest schema must be 2');
  const si = loadState(stateF);
  if (cmd === 'progress') { const r = progress(m, si, Number(arg(argv, '--slice')) || 5000); out(r); return r.complete ? 0 : 3; }
  if (cmd === 'propose') {
    const p = propose(m, si, parseHoldIds(arg(argv, '--hold-id')));
    const dir = arg(argv, '--write-dir');
    if (dir) { const f = writeNew(dir, 'hold-proposal.json', p); console.log('wrote a NEW proposal: ' + path.basename(f)); }
    const hc = Object.assign({}, p.holdCandidates); const listed = hc.files.length; delete hc.files; hc.listedInFile = listed;
    out(Object.assign({}, p, { holdCandidates: hc })); return p.complete ? 0 : 3;
  }
  if (cmd === 'tar-check') { const r = tarCheck(m, si, parseHoldIds(arg(argv, '--hold-id')), arg(argv, '--tar-dir')); out(r); return r.mustRepackCount ? 2 : 0; }
  if (cmd === 'uuid-shape') { out(uuidShape(m, si, k.loadJson(arg(argv, '--roots-file')), { category: arg(argv, '--category'), maxFiles: Number(arg(argv, '--max-files')) || 0 })); return 0; }
  throw new Error('usage: progress | propose | approve | tar-check | uuid-shape');
}
module.exports = { ALWAYS_HOLD, parseHoldIds, loadState, classifyAll, progress, propose, approve, tarCheck, uuidShape, writeNew, run };
if (require.main === module) { try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(String(e.message).replace(/[A-Za-z]:\\[^\s'"]*|\/[^\s'"]+\/[^\s'"]*/g, '<path>')); process.exit(1); } }
