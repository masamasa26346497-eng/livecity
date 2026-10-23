'use strict';
// Mission 41R: synthetic fixtures only. Phone/key-like strings below are fake test values.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const r = require('../tools/mission41r-review-summary.cjs');
const o = require('../tools/mission41o-holdplan.cjs');
const k = require('../tools/mission41k-content-scan.cjs');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const UUID = '0123abcd-0123-4567-89ab-0123456789ab';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lc41r-')); const root = path.join(base, 'LiveCity');
  const files = {
    'boundaries/held.json': Buffer.from(JSON.stringify({ tel: '06-1234-5678' })),
    'boundaries/clean.json': Buffer.from('{"a":1}'),
    'boundaries/secret.json': Buffer.from('{"k":"AIza' + 'A'.repeat(35) + '"}'),
    'tiles/uuidish.json': Buffer.from(JSON.stringify({ id: 'x' + UUID + 'b06-1234-5678c', n: [1] })),
    'tiles/free.json': Buffer.from('call 090-1234-5678 please'),
    'tiles/a.glb': Buffer.from('glTF\x02\x00\x00\x00', 'latin1'),
    'misc/a.zip': Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]),
    'misc/nul.txt': Buffer.from([0x68, 0x69, 0, 0, 0x6f]),
  };
  for (const [rel, buf] of Object.entries(files)) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
  const e = (rel) => ({ path: 'LiveCity/' + rel, size: files[rel].length });
  const m = { schema: 2, sizing: 'tar-estimate', parts: [
    { asset: 'lcdata-boundaries-001.tar', category: 'boundaries', files: [e('boundaries/held.json'), e('boundaries/clean.json'), e('boundaries/secret.json')] },
    { asset: 'lcdata-tiles-002.tar', category: 'building-tiles', files: [e('tiles/uuidish.json'), e('tiles/free.json'), e('tiles/a.glb')] },
    { asset: 'lcdata-misc-003.tar', category: 'other', files: [e('misc/a.zip'), e('misc/nul.txt')] }] };
  const mf = path.join(base, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify(m));
  const rf = path.join(base, 'roots.json'); fs.writeFileSync(rf, JSON.stringify({ LiveCity: root }));
  const x = { base, root, files, m, mf, rf, roots: { LiveCity: root }, st: path.join(base, 'content-scan-state.json') };
  k.scan({ manifest: mf, rootsFile: rf, state: x.st, pathContains: '', maxFiles: 0, maxSeconds: 0, maxFileMiB: 512 });
  return x;
}

test('summary: cohorts, unscanned held, gates false, nothing approved', () => {
  const x = fixture();
  const s = r.summarize(x.m, o.loadState(x.st), {});
  assert.strictEqual(s.uploadAllowed, false); assert.strictEqual(s.eligibleForPackOrUpload, 0);
  for (const v of Object.values(s.gates)) assert.strictEqual(v, false);
  assert.strictEqual(s.progress.complete, true);
  assert.strictEqual(s.findings.files, 4);
  assert.strictEqual(s.findings.byKind.secret, 1);
  assert.strictEqual(s.findings.byDetectorType['jp-phone-number'], 3);
  assert.strictEqual(s.notApproved.scannedNoPattern, 1);
  assert.match(s.notApproved.note, /NOT approved/);
  assert.strictEqual(s.unscanned.files, 3);
  assert.strictEqual(s.unscanned.byReason['archive-not-opened'], 1);
  assert.strictEqual(s.unscanned.byReason['binary-content'], 1);
  assert.strictEqual(s.unscanned.byReason['binary-format-not-inspected'], 1);
  assert.strictEqual(s.unscanned.archives.files, 1);
  assert.strictEqual(s.unscanned.glb.files, 1);
  assert.match(s.unscanned.glb.note, /BIN chunk .* NOT safe/);
  assert.strictEqual(s.unscanned.status, 'HOLD / needs review (always)');
  assert.strictEqual(s.sanitizePlan.autoApply, false);
  assert.strictEqual(s.licenceLedger.approved, false);
  assert.strictEqual(s.findings.shapeClass.requested, false);
});

test('no value, key name, path or file name appears in the output', () => {
  const x = fixture();
  const text = JSON.stringify(r.summarize(x.m, o.loadState(x.st), { maxIds: 50 }));
  assert.ok(!/LiveCity|held\.json|secret\.json|06-1234|090-1234|AIza|lcdata-|lc41r-|\/tmp|\\\\/.test(text));
  assert.ok(!/"tel"|"k"/.test(text));
});

test('priority ids are capped (default 12, hard limit 50), secret first, ids are 8-hex', () => {
  const x = fixture();
  const one = r.summarize(x.m, o.loadState(x.st), { maxIds: 1 });
  assert.strictEqual(one.priorityReview.ids.length, 1);
  assert.strictEqual(one.priorityReview.ids[0].kind, 'secret');
  assert.strictEqual(one.priorityReview.of, 4);
  const big = r.summarize(x.m, o.loadState(x.st), { maxIds: 9999 });
  assert.ok(big.priorityReview.cap <= r.MAX_IDS_LIMIT);
  assert.ok(big.priorityReview.ids.every((i) => /^[0-9a-f]{8}$/.test(i.id) && i.status === 'HOLD-needs-human-review'));
  assert.strictEqual(r.summarize(x.m, o.loadState(x.st), {}).priorityReview.cap, 12);
});

test('owner HOLD and UUID-shape candidate stay distinct and held; absent ids are reported as absent', () => {
  const x = fixture();
  const s = r.summarize(x.m, o.loadState(x.st), {});
  assert.strictEqual(s.holdDistinction.ownerHold.id, 'e6b68bd7');
  assert.strictEqual(s.holdDistinction.uuidShapeCandidate.id, 'a0d64b19');
  assert.strictEqual(s.holdDistinction.ownerHold.inState, false);
  assert.match(s.holdDistinction.uuidShapeCandidate.status, /still HOLD/);
  assert.strictEqual(s.findings.verdict.startsWith('none'), true);
});

test('--shape labels are candidates only and read locally; sources are unchanged', () => {
  const x = fixture();
  const before = Object.fromEntries(Object.keys(x.files).map((rel) => [rel, sha(fs.readFileSync(path.join(x.root, ...rel.split('/'))))]));
  const s = r.summarize(x.m, o.loadState(x.st), { shape: true, roots: x.roots, shapeMax: 10 });
  assert.strictEqual(s.findings.shapeClass.phoneFindingFiles, 3);
  assert.strictEqual(s.findings.shapeClass.byClass['inside-uuid-like-id-only'] >= 1 || s.findings.shapeClass.byClass['id-or-numeric-shape-only'] >= 1, true);
  assert.ok(s.findings.shapeClass.byClass['contact-key-or-free-text-present'] >= 1);
  assert.match(s.findings.shapeClass.note, /never clears/);
  for (const rel of Object.keys(x.files)) assert.strictEqual(sha(fs.readFileSync(path.join(x.root, ...rel.split('/')))), before[rel]);
  assert.strictEqual(s.uploadAllowed, false);
});

test('stale / missing state: everything unreviewed, still uploadAllowed:false', () => {
  const x = fixture();
  fs.writeFileSync(x.st, JSON.stringify({ schema: 1, scannerVersion: 'old', detectorFingerprint: 'x', files: {} }));
  const s = r.summarize(x.m, o.loadState(x.st), {});
  assert.strictEqual(s.stateValid, false); assert.strictEqual(s.findings.files, 0);
  assert.strictEqual(s.notInPlace.files, 8); assert.strictEqual(s.uploadAllowed, false);
});

test('write-dir refuses a non-empty folder; ps1 is ASCII, read-only, no destructive commands', () => {
  const x = fixture();
  const d = path.join(x.base, 'out');
  const f = r.writeNew(d, 'review-summary.json', { a: 1 });
  assert.ok(fs.existsSync(f));
  assert.throws(() => r.writeNew(d, 'review-summary.json', { a: 2 }), /not empty/);
  const ps = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41r-review.ps1'), 'latin1');
  assert.ok(!/[^\x00-\x7f]/.test(ps));
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod|curl|Expand-Archive/i.test(ps));
  const js = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41r-review-summary.cjs'), 'utf8');
  assert.ok(!/node:https?|node:net|fetch\(|unlinkSync|rmSync|renameSync|appendFileSync/.test(js));
});
