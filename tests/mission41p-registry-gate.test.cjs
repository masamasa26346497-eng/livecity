'use strict';
// Mission 41P: synthetic fixtures only. No network, no real data. Phone-like strings are fake.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reg = require('../tools/mission41p-registry-check.cjs');
const gate = require('../tools/mission41p-transfer-gate.cjs');
const h = require('../tools/mission41o-holdplan.cjs');
const k = require('../tools/mission41k-content-scan.cjs');

const ROOT = path.resolve(__dirname, '..');
const REG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/source-registry.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

test('committed registry is consistent: URLs found in evidence files, scripts exist, nothing approved', () => {
  assert.deepStrictEqual(reg.check(REG, ROOT), []);
  assert.ok(REG.entries.length >= 15);
  assert.ok(REG.entries.every((e) => e.approved === false));
  assert.ok(REG.entries.filter((e) => e.licenceClaim).every((e) => e.licenceClaim.verifiedAgainstPrimary === false));
  const r = reg.report(REG);
  assert.strictEqual(r.licenceApproved, 0);
  assert.ok(r.reconstructability.unknown > 0 && r.reconstructability.candidate > 0);
});

test('registry gate rejects guessed URL, approved licence, missing script, unknown-with-URL, bad dependency, local path', () => {
  const base = () => clone(REG);
  const probe = (mut) => { const r = base(); mut(r.entries.find((e) => e.id === 'plateau-citygml-bldg')); return reg.check(r, ROOT); };
  assert.ok(probe((e) => { e.sourceUrl = 'https://example.invalid/guess'; }).some((p) => /not found in urlEvidence/.test(p)));
  assert.ok(probe((e) => { e.approved = true; }).some((p) => /approved must be false/.test(p)));
  assert.ok(probe((e) => { e.licenceClaim.verifiedAgainstPrimary = true; }).some((p) => /verifiedAgainstPrimary/.test(p)));
  assert.ok(probe((e) => { e.scripts.push('tools/does-not-exist.js'); }).some((p) => /script not found/.test(p)));
  assert.ok(probe((e) => { e.dependsOn.push('nope'); }).some((p) => /dependsOn unknown/.test(p)));
  assert.ok(probe((e) => { e.reconstructability = 'unknown'; }).some((p) => /unknown must not have sourceUrl/.test(p)));
  assert.ok(probe((e) => { e.notes = 'C:\\Users\\x\\data'; }).some((p) => /absolute/.test(p)));
  assert.ok(probe((e) => { e.basis = ''; }).some((p) => /basis/.test(p)));
});

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lc41p-')); const root = path.join(base, 'LiveCity');
  const files = {
    'a/clean1.json': Buffer.from('{"a":1}'), 'a/clean2.json': Buffer.from('{"b":2}'), 'a/held.json': Buffer.from('tel 06-1234-5678 end'),
    'a/bin.glb': Buffer.from('glTF\x02\x00\x00\x00', 'latin1'), 'a/later.txt': Buffer.from('hello') };
  for (const [rel, buf] of Object.entries(files)) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
  const e = (rel) => ({ path: 'LiveCity/' + rel, size: files[rel].length });
  const m = { schema: 2, sizing: 'tar-estimate', parts: [{ asset: 'x.tar', category: 'cat', files: Object.keys(files).map(e) }] };
  const mf = path.join(base, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify(m));
  const rf = path.join(base, 'roots.json'); fs.writeFileSync(rf, JSON.stringify({ LiveCity: root }));
  return { m, mf, rf, st: path.join(base, 'content-scan-state.json'), id: (rel) => k.fid('LiveCity', rel), base };
}
const scan = (x, maxFiles) => k.scan({ manifest: x.mf, rootsFile: x.rf, state: x.st, pathContains: '', maxFiles: maxFiles || 0, maxSeconds: 0, maxFileMiB: 512 });
const OPEN = { licenceApproved: true, noSecretsReviewed: true, noPersonalDataReviewed: true };
const goodList = (x, rels) => ({ kind: 'transfer-allowlist', reviewedBy: 'owner', reviewedOn: '2026-01-01', ids: rels.map(x.id) });

test('all gates false: nothing is eligible, even a fully scanned clean allowlisted file; uploadAllowed is always false', () => {
  const x = fixture(); scan(x);
  const r = gate.evaluate(x.m, h.loadState(x.st), h.ALWAYS_HOLD, goodList(x, ['a/clean1.json']), null);
  assert.strictEqual(r.uploadAllowed, false);
  assert.strictEqual(r.eligibleForOwnerApprovalCount, 0);
  assert.ok(r.blockedBy.includes('gate-closed:licenceApproved'));
  assert.strictEqual(r.classes.allowlistedAndScannedClean, 1); // visible, but still blocked
  // gate values other than literal true stay closed
  const r2 = gate.evaluate(x.m, h.loadState(x.st), h.ALWAYS_HOLD, goodList(x, ['a/clean1.json']), { licenceApproved: 'true', noSecretsReviewed: 1, noPersonalDataReviewed: true });
  assert.strictEqual(r2.eligibleForOwnerApprovalCount, 0);
});

test('unreviewed is not hold and not eligible; allowlisting a held/binary/unreached/stale file is rejected', () => {
  const x = fixture(); scan(x, 4); // later.txt or one more is not reached
  const si = h.loadState(x.st);
  const rows = h.classifyAll(x.m, si);
  const notReached = rows.filter((r) => r.status === 'not-reached');
  assert.ok(notReached.length >= 1);
  const al = goodList(x, ['a/held.json', 'a/bin.glb', 'a/clean1.json', 'a/clean2.json', 'a/later.txt']);
  const r = gate.evaluate(x.m, si, h.ALWAYS_HOLD, al, OPEN);
  assert.strictEqual(r.uploadAllowed, false);
  assert.ok(r.allowlistRejectedByReason['hold-candidate'] >= 1);
  assert.ok(r.allowlistRejectedByReason['status-unscanned'] >= 1);
  const eligibleMax = rows.filter((q) => q.status === 'scanned-no-pattern').length;
  assert.ok(r.eligibleForOwnerApprovalCount <= eligibleMax);
  assert.ok(r.classes.unreviewed >= 2); // binary + not reached are unreviewed, not hold
  // stale state: nothing eligible
  fs.writeFileSync(x.st, JSON.stringify({ schema: 1, scannerVersion: 'old', detectorFingerprint: 'x', files: {} }));
  const r3 = gate.evaluate(x.m, h.loadState(x.st), h.ALWAYS_HOLD, al, OPEN);
  assert.strictEqual(r3.eligibleForOwnerApprovalCount, 0);
});

test('open gates + valid allowlist: only allowlisted scanned-clean non-hold files become eligible (and upload is still not allowed)', () => {
  const x = fixture(); scan(x);
  const r = gate.evaluate(x.m, h.loadState(x.st), h.ALWAYS_HOLD, goodList(x, ['a/clean1.json', 'a/held.json', 'a/bin.glb']), OPEN);
  assert.strictEqual(r.eligibleForOwnerApprovalCount, 1);
  assert.strictEqual(r.uploadAllowed, false);
  assert.strictEqual(r.classes.scannedNoPatternButNotAllowlisted, 2); // clean2 + later.txt: clean scan alone is not approval
});

test('allowlist without reviewer, wrong kind or invalid ids is invalid and blocks everything', () => {
  const x = fixture(); scan(x);
  for (const bad of [{ kind: 'transfer-allowlist', reviewedBy: '', reviewedOn: '2026-01-01', ids: [x.id('a/clean1.json')] },
    { kind: 'other', reviewedBy: 'o', reviewedOn: 'd', ids: [x.id('a/clean1.json')] },
    { kind: 'transfer-allowlist', reviewedBy: 'o', reviewedOn: 'd', ids: ['not-hex'] }]) {
    const r = gate.evaluate(x.m, h.loadState(x.st), h.ALWAYS_HOLD, bad, OPEN);
    assert.strictEqual(r.eligibleForOwnerApprovalCount, 0);
    assert.ok(r.blockedBy.includes('allowlist-missing-or-invalid'));
  }
  assert.strictEqual(gate.evaluate(x.m, h.loadState(x.st), h.ALWAYS_HOLD, null, OPEN).eligibleForOwnerApprovalCount, 0);
});

test('41O proposal states that not-a-hold-candidate is not safe, and a changed file is not counted as reached', () => {
  const x = fixture(); scan(x);
  const p = h.propose(x.m, h.loadState(x.st), h.ALWAYS_HOLD);
  assert.strictEqual(p.transfer.uploadAllowed, false);
  assert.strictEqual(p.transfer.eligibleForPackOrUpload, 0);
  assert.strictEqual(p.transfer.notHoldCandidateMeansSafe, false);
  assert.ok(p.caveats.some((c) => /size \+ mtimeMs only/.test(c)));
  // change the manifest size of one file: it must not count as reached
  const m2 = clone(x.m); m2.parts[0].files[0].size += 5;
  const prog = h.progress(m2, h.loadState(x.st));
  assert.strictEqual(prog.byStatus['changed-since-manifest'], 1);
  assert.strictEqual(prog.reached, 4);
  assert.strictEqual(prog.complete, false);
});

test('CLI: template is empty and refuses to overwrite; evaluate output has no paths; tools make no network or delete calls', () => {
  const x = fixture(); scan(x);
  const out = path.join(x.base, 'new-dir');
  assert.strictEqual(gate.run(['allowlist-template', '--out', out]), 0);
  const t = JSON.parse(fs.readFileSync(path.join(out, 'transfer-allowlist.json'), 'utf8'));
  assert.deepStrictEqual(t.ids, []);
  assert.throws(() => gate.run(['allowlist-template', '--out', out]), /not empty/);
  const lines = []; const orig = console.log; console.log = (s) => lines.push(String(s));
  try { gate.run(['evaluate', '--manifest', x.mf, '--state', x.st]); } finally { console.log = orig; }
  const text = lines.join('\n');
  assert.ok(!text.includes('LiveCity') && !text.includes(x.base) && !/clean1/.test(text));
  for (const f of ['tools/mission41p-transfer-gate.cjs', 'tools/mission41p-registry-check.cjs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/node:https?|fetch\(|child_process|unlinkSync|rmSync|rmdirSync|renameSync|copyFileSync/.test(src), f);
  }
});
