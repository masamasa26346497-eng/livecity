'use strict';
// Mission 41U: synthetic fixtures only. Phone-like strings and key names below are fake test values.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const u = require('../tools/mission41u-review-ledger.cjs');
const t = require('../tools/mission41t-contact-subclass.cjs');
const s = require('../tools/mission41s-triage.cjs');
const o = require('../tools/mission41o-holdplan.cjs');
const k = require('../tools/mission41k-content-scan.cjs');

const UUID = '0123abcd-0123-4567-89ab-0123456789ab';
const J = (x) => Buffer.from(JSON.stringify(x));
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lc41u-')); const root = path.join(base, 'LiveCity');
  // 1.2 MiB of 3-byte characters first: a 1 MiB chunk boundary must land inside the line, possibly inside a character.
  const pad = J({ zzq: 'あ'.repeat(400000) });
  const files = {
    'f/embedded.json': J({ contact: 'ask 090-1111-2222 after noon' }),
    'f/whole1.json': J({ telephone: '06-1234-5678' }),
    'f/whole2.json': J({ telephone: '06-1234-5678' }),
    'b/jp.jsonl': Buffer.concat([pad, Buffer.from('\n'), J({ '電話': '06-1234-5678' }), Buffer.from('\n')]),
    'b/idish.jsonl': Buffer.concat([J({ id: 'x' + UUID + 'b06-1234-5678c' }), Buffer.from('\n'), J({ id: 'y' + UUID + 'd06-1234-5678e' }), Buffer.from('\n')]),
    'b/memo.json': J({ description: 'call 0120-333-4444 anytime' }),
  };
  for (const [rel, buf] of Object.entries(files)) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
  const cat = (rel) => (rel.startsWith('f/') ? 'facilities' : 'boundaries');
  const m = { schema: 2, sizing: 'tar-estimate', parts: ['facilities', 'boundaries'].map((c) => ({ asset: c + '.tar', category: c,
    files: Object.keys(files).filter((r) => cat(r) === c).map((r) => ({ path: 'LiveCity/' + r, size: files[r].length })) })) };
  const mf = path.join(base, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify(m));
  const rf = path.join(base, 'roots.json'); fs.writeFileSync(rf, JSON.stringify({ LiveCity: root }));
  const st = path.join(base, 'content-scan-state.json');
  k.scan({ manifest: mf, rootsFile: rf, state: st, pathContains: '', maxFiles: 0, maxSeconds: 0, maxFileMiB: 512 });
  const roots = { LiveCity: root };
  const r = s.phoneGroups(m, o.loadState(st), roots, { max: 100, progress: {} });
  const cl = r.classes;
  for (const rel of ['b/jp.jsonl', 'b/idish.jsonl']) cl[k.fid('LiveCity', rel)] = 'over-128MiB-not-classified';
  for (const rel of ['f/embedded.json', 'f/whole1.json', 'f/whole2.json', 'b/memo.json']) cl[k.fid('LiveCity', rel)] = 'free-text/contact';
  const pf = path.join(base, 'prog.json'); fs.writeFileSync(pf, JSON.stringify({ schema: 1, classes: cl }));
  return { base, root, m, mf, rf, st, roots, pf };
}
const id = (rel) => k.fid('LiveCity', rel);

test('idish-only: id-shaped matches are reported separately; raw phone matches are NOT zero', () => {
  const x = fixture();
  const out = t.subclass(x.m, o.loadState(x.st), x.roots, s.loadProgress(x.pf), { idsMax: 12, maxSeconds: 60 });
  const row = out.ids.find((i) => i.id === id('b/idish.jsonl'));
  assert.strictEqual(row.class, 'jsonl:idish-only');
  assert.strictEqual(row.hitsBucket, '0');                 // legacy name: non-id candidates only
  assert.strictEqual(row.nonIdPhoneCandidateBucket, '0');
  assert.strictEqual(row.idShapedStringBucket, '2-5');
  assert.strictEqual(row.rawPhoneMatchesBucket, '2-5');
  assert.strictEqual(row.rawPhoneMatchesZero, false);
  assert.ok(out.metricMeaning.hitsBucket.includes('does NOT mean'));
});

test('jsonl is split on bytes and decoded as UTF-8: a non-ASCII contact key across a chunk boundary is still a contact key', () => {
  const x = fixture();
  const out = t.subclass(x.m, o.loadState(x.st), x.roots, s.loadProgress(x.pf), { idsMax: 12, maxSeconds: 60 });
  const row = out.ids.find((i) => i.id === id('b/jp.jsonl'));
  assert.strictEqual(row.class, 'jsonl:contact-key-whole-value');
});

test('review queue: cohorts, no leaks, nothing approved, sources unchanged', () => {
  const x = fixture();
  const before = fs.readFileSync(path.join(x.root, 'b', 'memo.json'));
  const out = u.summary(x.m, o.loadState(x.st), x.roots, s.loadProgress(x.pf), { idsMax: 12, maxSeconds: 60 });
  assert.strictEqual(out.selectedFiles, 6);
  const by = Object.fromEntries(out.cohorts.map((c) => [c.cohort, c]));
  assert.strictEqual(by['A-embedded-text-high-priority'].files, 1);
  assert.strictEqual(by['B-whole-value-source-license-pending'].files, 3);   // 2 json + the Japanese-key jsonl
  assert.strictEqual(by['C-id-shaped-recheck'].files, 1);
  assert.strictEqual(by['D-other-review'].files, 1);
  assert.strictEqual(by['B-whole-value-source-license-pending'].filesSharingAnIdenticalSizeWithAnotherFileBucket, '2-5');
  assert.deepStrictEqual(Object.keys(by['B-whole-value-source-license-pending'].byCategory).sort(), ['boundaries', 'facilities']);
  for (const f of ['uploadAllowed', 'autoApproved', 'autoExcluded', 'decisionsAffectGate', 'sanitizePlanApproved', 'dataLicenceFamiliesApproved']) assert.strictEqual(out[f], false, f);
  assert.strictEqual(out.eligibleForPackOrUpload, 0);
  assert.ok(out.openItems.filesWithFindings >= 6);
  assert.strictEqual(typeof out.openItems.findingFilesOutsideThisQueue, 'number');
  assert.strictEqual(out.defaultDecision, 'undecided');
  const text = JSON.stringify(out);
  for (const bad of ['06-1234', '090-', '0120', 'telephone', 'contact"', 'description', 'zzq', 'LiveCity', x.base, '.json', '.jsonl', '電']) assert.ok(!text.includes(bad), 'leaked: ' + bad);
  assert.ok(Buffer.compare(before, fs.readFileSync(path.join(x.root, 'b', 'memo.json'))) === 0);
});

test('decisions: template is created only on request, outside the repo, never overwritten; decisions never change a gate', () => {
  const x = fixture();
  const res = t.collect(x.m, o.loadState(x.st), x.roots, s.loadProgress(x.pf), { maxSeconds: 60 });
  assert.throws(() => u.initDecisions(path.join(__dirname, '..', 'tmp-decisions.json'), res), /outside the repository/);
  const gitDir = path.join(x.base, 'wt'); fs.mkdirSync(path.join(gitDir, '.git'), { recursive: true });
  assert.throws(() => u.initDecisions(path.join(gitDir, 'd.json'), res), /git work tree/);
  const d = path.join(x.base, 'owner', 'decisions.json');
  assert.ok(!fs.existsSync(d));
  const r = u.initDecisions(d, res);
  assert.strictEqual(r.entries, 6); assert.strictEqual(r.allUndecided, true);
  const body = JSON.parse(fs.readFileSync(d, 'utf8'));
  assert.ok(Object.values(body.decisions).every((v) => v === 'undecided'));
  assert.throws(() => u.initDecisions(d, res));             // wx: no overwrite
  body.decisions[id('f/embedded.json')] = 'owner-note-public-business-number';
  body.decisions[id('f/whole1.json')] = 'approve-and-upload';  // not in the vocabulary -> ignored
  body.decisions['deadbeef'] = 'keep-hold';                    // not in this queue -> ignored
  fs.writeFileSync(d, JSON.stringify(body));
  const out = u.summary(x.m, o.loadState(x.st), x.roots, s.loadProgress(x.pf), { idsMax: 12, maxSeconds: 60, decisionsFile: d });
  assert.strictEqual(out.decisionsFile.entriesUsed, 5 + 1 - 1);   // 4 undecided + 1 noted (the invalid one is dropped, so 5 valid entries)
  assert.strictEqual(out.decisionsFile.invalidDecisionValues, 1); assert.strictEqual(out.decisionsFile.idsNotInThisQueue, 1);
  assert.strictEqual(out.cohorts.find((c) => c.cohort.startsWith('A')).decisionCounts['owner-note-public-business-number'], 1);
  assert.strictEqual(out.uploadAllowed, false); assert.strictEqual(out.eligibleForPackOrUpload, 0); assert.strictEqual(out.decisionsAffectGate, false);
});

test('tool writes only via the wx template path; no delete/copy/network; CLI and PS5.1 wrapper', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41u-review-ledger.cjs'), 'utf8');
  assert.strictEqual((src.match(/writeFileSync/g) || []).length, 1);
  assert.match(src, /flag: 'wx'/);
  assert.doesNotMatch(src, /renameSync|unlinkSync|rmSync|appendFile|copyFile|createWriteStream|require\('node:(?:https?|net)'\)|fetch\(/);
  const x = fixture();
  const tool = path.join(__dirname, '..', 'tools', 'mission41u-review-ledger.cjs');
  const out = JSON.parse(cp.execFileSync(process.execPath, [tool, '--manifest', x.mf, '--roots-file', x.rf, '--progress-file', x.pf], { encoding: 'utf8' }));
  assert.strictEqual(out.mode, 'review-queue'); assert.strictEqual(out.uploadAllowed, false);
  const p = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41s-triage.ps1'));
  for (const b of p) assert.ok(b < 128);
  const txt = p.toString('utf8');
  assert.match(txt, /review-ledger/); assert.match(txt, /mission41u-review-ledger\.cjs/); assert.match(txt, /LASTEXITCODE/);
  assert.doesNotMatch(txt, /Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod/i);
});
