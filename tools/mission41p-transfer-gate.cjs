'use strict';
// Mission 41P: fail-closed transfer gate. OFFLINE, READ-ONLY. Never uploads, packs, copies, moves or deletes anything.
// Output has ONLY anonymous ids (8 hex), categories, extensions and counts. No path, name or value.
//   node tools/mission41p-transfer-gate.cjs allowlist-template --out <NEW dir>
//   node tools/mission41p-transfer-gate.cjs evaluate --manifest m.json [--state s.json] [--allowlist a.json] [--gates g.json] [--hold-id 8hex,..]
// A file is "eligible for owner approval" ONLY when ALL hold:
//   1. its id is in an owner-reviewed allowlist (reviewedBy + reviewedOn filled, ids only)
//   2. its status under the CURRENT scanner/detectors is scanned-no-pattern (not findings, not binary/unscanned, not stale, not changed, not reached-never)
//   3. it is not a hold candidate (findings, the always-held id, --hold-id)
//   4. all three gates are true in the gates file: licenceApproved, noSecretsReviewed, noPersonalDataReviewed
// Even then `uploadAllowed` stays false: transfer is a separate, owner-approved phase. With the default (all gates false) the eligible count is always 0.
const fs = require('node:fs');
const path = require('node:path');
const h = require('./mission41o-holdplan.cjs');
const k = require('./mission41k-content-scan.cjs');

const ID_RE = /^[0-9a-f]{8}$/;
const GATE_NAMES = ['licenceApproved', 'noSecretsReviewed', 'noPersonalDataReviewed'];

function readGates(g) {
  const out = {};
  for (const n of GATE_NAMES) out[n] = !!(g && g[n] === true); // anything but literal true is closed
  return out;
}
function checkAllowlist(a) {
  const problems = [];
  if (!a) return { present: false, ok: false, ids: [], problems: ['no-allowlist'] };
  if (a.kind !== 'transfer-allowlist') problems.push('wrong-kind');
  if (!String(a.reviewedBy || '').trim()) problems.push('reviewedBy-empty');
  if (!String(a.reviewedOn || '').trim()) problems.push('reviewedOn-empty');
  const ids = Array.isArray(a.ids) ? a.ids : [];
  if (!Array.isArray(a.ids)) problems.push('ids-not-array');
  const bad = ids.filter((x) => !ID_RE.test(String(x)));
  if (bad.length) problems.push('invalid-ids:' + bad.length);
  return { present: true, ok: problems.length === 0, ids: ids.filter((x) => ID_RE.test(String(x))), problems };
}

function evaluate(m, stateInfo, holdIds, allowlist, gates) {
  const rows = h.classifyAll(m, stateInfo);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hold = new Set(holdIds);
  for (const r of rows) if (r.status === 'findings') hold.add(r.id);
  const g = readGates(gates);
  const al = checkAllowlist(allowlist);
  const reasons = {};
  const bump = (x) => { reasons[x] = (reasons[x] || 0) + 1; };
  const eligibleIds = [];
  for (const id of new Set(al.ids)) {
    const r = byId.get(id);
    if (!r) { bump('allowlisted-but-not-in-manifest'); continue; }
    if (hold.has(id)) { bump('hold-candidate'); continue; }
    if (r.status !== 'scanned-no-pattern') { bump('status-' + r.status); continue; }
    eligibleIds.push(id);
  }
  const blockedBy = [];
  if (!al.ok) blockedBy.push('allowlist-missing-or-invalid');
  for (const n of GATE_NAMES) if (!g[n]) blockedBy.push('gate-closed:' + n);
  const open = blockedBy.length === 0;
  const eligible = open ? eligibleIds : [];
  const status = tallyStatus(rows);
  return { schema: 1, tool: 'mission41p-transfer-gate', mode: 'evaluate',
    uploadAllowed: false, // constant: this tool never authorizes a transfer
    gates: g, allowlist: { present: al.present, valid: al.ok, problems: al.problems, listed: al.ids.length },
    manifestFiles: rows.length, byStatus: status,
    classes: {
      holdCandidates: rows.filter((r) => hold.has(r.id)).length,
      unreviewed: rows.filter((r) => !hold.has(r.id) && r.status !== 'scanned-no-pattern').length,
      scannedNoPatternButNotAllowlisted: rows.filter((r) => !hold.has(r.id) && r.status === 'scanned-no-pattern' && !new Set(al.ids).has(r.id)).length,
      allowlistedAndScannedClean: eligibleIds.length },
    allowlistRejectedByReason: reasons,
    eligibleForOwnerApprovalCount: eligible.length, blockedBy,
    stateValid: stateInfo.valid, stateNote: stateInfo.reason,
    note: 'unreviewed (not scanned, binary, cloud-only, stale, changed, never reached) is NOT the same as hold candidate and is NEVER eligible. Not being a hold candidate does not make a file safe. eligible means only "the owner may now consider approving", not "upload".' };
}
function tallyStatus(rows) { const o = {}; for (const r of rows) o[r.status] = (o[r.status] || 0) + 1; return o; }

function allowlistTemplate() {
  return { schema: 1, kind: 'transfer-allowlist', reviewedBy: '', reviewedOn: '', ids: [],
    note: 'ids only (8 hex from the 41B manifest id scheme). Fill by hand AFTER reviewing each file. Empty reviewedBy/reviewedOn makes the list invalid. Never add paths, names or values.' };
}
function arg(argv, key) { const i = argv.indexOf(key); return i >= 0 ? argv[i + 1] : undefined; }
function run(argv) {
  const cmd = argv[0];
  if (cmd === 'allowlist-template') {
    const f = h.writeNew(arg(argv, '--out'), 'transfer-allowlist.json', allowlistTemplate());
    console.log('wrote a NEW empty allowlist template: ' + path.basename(f)); return 0;
  }
  if (cmd === 'evaluate') {
    const mf = arg(argv, '--manifest'); if (!mf) throw new Error('--manifest is required');
    const m = k.loadJson(mf);
    if (!m || m.schema !== 2 || !Array.isArray(m.parts)) throw new Error('manifest schema must be 2');
    const sf = arg(argv, '--state') || path.join(path.dirname(path.resolve(mf)), 'content-scan-state.json');
    const af = arg(argv, '--allowlist'); const gf = arg(argv, '--gates');
    const r = evaluate(m, h.loadState(sf), h.parseHoldIds(arg(argv, '--hold-id')), af ? k.loadJson(af) : null, gf ? k.loadJson(gf) : null);
    console.log(JSON.stringify(r, null, 1)); return r.eligibleForOwnerApprovalCount ? 0 : 3;
  }
  throw new Error('usage: allowlist-template | evaluate');
}
module.exports = { GATE_NAMES, readGates, checkAllowlist, evaluate, allowlistTemplate, run };
if (require.main === module) { try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(String(e.message).replace(/[A-Za-z]:\\[^\s'"]*|\/[^\s'"]+\/[^\s'"]*/g, '<path>')); process.exit(1); } }
