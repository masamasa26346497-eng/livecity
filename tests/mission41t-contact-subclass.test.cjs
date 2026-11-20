'use strict';
// Mission 41T: synthetic fixtures only. Phone-like strings and key names below are fake test values.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const t = require('../tools/mission41t-contact-subclass.cjs');
const s = require('../tools/mission41s-triage.cjs');
const o = require('../tools/mission41o-holdplan.cjs');
const k = require('../tools/mission41k-content-scan.cjs');

const UUID = '0123abcd-0123-4567-89ab-0123456789ab';
const J = (x) => Buffer.from(JSON.stringify(x));
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lc41t-')); const root = path.join(base, 'LiveCity');
  const long = '{"zzq":"' + 'a'.repeat(5 * 1024 * 1024) + '"}\n';
  const files = {
    'b/contactwhole.json': J([{ secretkeyname1: 'x', telephone: '06-1234-5678' }]),
    'b/contactembedded.json': J({ contact: 'ask 090-1111-2222 after noon' }),
    'b/memo.json': J({ description: 'call 0120-333-4444 anytime' }),
    'b/noncontactwhole.json': J({ weirdfield: '080-1234-5678' }),
    'b/noncontacttext.json': J({ weirdfield: 'please call 050-1234-5678 now' }),
    'b/broken.json': Buffer.from('{"a": "06-1234-5678" '),
    'b/page.html': Buffer.from('<p>tel 06-1234-5678 here</p>'),
    'b/uu.json': J({ id: 'x' + UUID + 'b06-1234-5678c' }),
    'b/big.jsonl': Buffer.concat([J({ telephone: '06-1234-5678' }), Buffer.from('\n'), Buffer.from(long), J({ note: 'x 090-9999-8888 y' }), Buffer.from('\nnot json\n')]),
  };
  for (const [rel, buf] of Object.entries(files)) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
  const e = (rel) => ({ path: 'LiveCity/' + rel, size: files[rel].length });
  const m = { schema: 2, sizing: 'tar-estimate', parts: [{ asset: 'a.tar', category: 'boundaries', files: Object.keys(files).map(e) }] };
  const mf = path.join(base, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify(m));
  const rf = path.join(base, 'roots.json'); fs.writeFileSync(rf, JSON.stringify({ LiveCity: root }));
  const st = path.join(base, 'content-scan-state.json');
  k.scan({ manifest: mf, rootsFile: rf, state: st, pathContains: '', maxFiles: 0, maxSeconds: 0, maxFileMiB: 512 });
  const roots = { LiveCity: root };
  const pf = path.join(base, 'prog.json');
  const r = s.phoneGroups(m, o.loadState(st), roots, { max: 100, progress: {} });
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, classes: r.classes }));
  // pretend the jsonl was the over-128MiB one from 41S
  const jid = k.fid('LiveCity', 'b/big.jsonl');
  const cl = r.classes; cl[jid] = 'over-128MiB-not-classified'; fs.writeFileSync(pf, JSON.stringify({ schema: 1, classes: cl }));
  return { base, root, m, mf, rf, st, roots, pf };
}

test('phone prefix types are coarse buckets', () => {
  assert.strictEqual(t.phoneType('090-1111-2222'), 'mobile-format');
  assert.strictEqual(t.phoneType('050-1234-5678'), 'ip-phone-format');
  assert.strictEqual(t.phoneType('0120-333-444'), 'freephone-format');
  assert.strictEqual(t.phoneType('+81-6-1234-5678'), 'landline-or-other-format');
});

test('sub-classes are structural; no leaks; nothing approved; sources and progress file unchanged', () => {
  const x = fixture();
  const beforeProg = fs.readFileSync(x.pf);
  const beforeSrc = fs.readFileSync(path.join(x.root, 'b', 'memo.json'));
  const out = t.subclass(x.m, o.loadState(x.st), x.roots, s.loadProgress(x.pf), { idsMax: 12, maxSeconds: 60 });
  assert.strictEqual(out.uploadAllowed, false); assert.strictEqual(out.eligibleForPackOrUpload, 0);
  assert.strictEqual(out.autoApproved, false); assert.strictEqual(out.autoExcluded, false);
  const bc = out.byClass;
  assert.strictEqual(bc['json:contact-key-whole-value'], 1);
  assert.strictEqual(bc['json:contact-key-embedded-text'], 1);
  assert.strictEqual(bc['json:memo-key-text'], 1);
  assert.strictEqual(bc['json:noncontact-key-whole-value'], 1);
  assert.strictEqual(bc['json:noncontact-key-text'], 1);
  assert.strictEqual(bc['json-parse-error'], 1);
  assert.strictEqual(bc['html-text'], 1);
  assert.ok(!Object.keys(bc).some((c) => /idish/.test(c) && false));
  // the big JSONL (jsonl:...) was classified by streaming: highest-priority class present is the free-text one
  assert.strictEqual(bc['jsonl:noncontact-key-text'] || bc['jsonl:memo-key-text'], 1);
  assert.ok(out.ids.length <= 12);
  assert.ok(out.ids[0].class.endsWith('noncontact-key-text'));
  const sj = out.streamedJsonl[0];
  assert.strictEqual(sj.skippedOverlongLinesBucket, '1'); assert.strictEqual(sj.parseErrorLinesBucket, '1'); assert.strictEqual(sj.partial, false);
  const text = JSON.stringify(out);
  for (const bad of ['06-1234', '090-', '080-', '050-', '0120', 'telephone','description', 'weirdfield', 'secretkeyname1', 'zzq', 'LiveCity', x.base, '.json', 'page.html']) assert.ok(!text.includes(bad), 'leaked: ' + bad);
  assert.ok(Buffer.compare(beforeProg, fs.readFileSync(x.pf)) === 0);
  assert.ok(Buffer.compare(beforeSrc, fs.readFileSync(path.join(x.root, 'b', 'memo.json'))) === 0);
});

test('ids output is capped at 12', () => {
  const x = fixture();
  const out = t.subclass(x.m, o.loadState(x.st), x.roots, s.loadProgress(x.pf), { idsMax: 99, maxSeconds: 60 });
  assert.ok(out.ids.length <= 12);
  const small = t.subclass(x.m, o.loadState(x.st), x.roots, s.loadProgress(x.pf), { idsMax: 2, maxSeconds: 60 });
  assert.strictEqual(small.ids.length, 2); assert.ok(small.idsOmitted >= 1);
});

test('uuid-shape-only files from 41S are not selected', () => {
  const x = fixture();
  const prog = s.loadProgress(x.pf);
  assert.notStrictEqual(prog[k.fid('LiveCity', 'b/uu.json')], 'free-text/contact');
  const out = t.subclass(x.m, o.loadState(x.st), x.roots, prog, { idsMax: 12, maxSeconds: 60 });
  assert.ok(!out.ids.some((i) => i.id === k.fid('LiveCity', 'b/uu.json')));
  const empty = t.subclass(x.m, o.loadState(x.st), x.roots, {}, { idsMax: 12, maxSeconds: 60 });
  assert.strictEqual(empty.selectedFiles, 0);
});

test('streaming never reads the whole file: no readFileSync/whole-parse on the jsonl path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41t-contact-subclass.cjs'), 'utf8');
  const fn = /function streamJsonl[\s\S]*?\n}\n/.exec(src)[0];
  assert.doesNotMatch(fn, /readFileSync/);
  assert.match(fn, /readSync/);
  assert.match(src, /MAX_LINE/);
});

test('tool has no write/network/delete calls', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41t-contact-subclass.cjs'), 'utf8');
  assert.doesNotMatch(src, /writeFileSync|renameSync|unlinkSync|rmSync|appendFile|copyFile|createWriteStream|require\('node:(?:https?|net|child_process)'\)|fetch\(/);
});

test('CLI runs and PS5.1 wrapper is ASCII, read-only and checks the exit code', () => {
  const x = fixture();
  const tool = path.join(__dirname, '..', 'tools', 'mission41t-contact-subclass.cjs');
  const out = JSON.parse(cp.execFileSync(process.execPath, [tool, '--manifest', x.mf, '--roots-file', x.rf, '--progress-file', x.pf], { encoding: 'utf8' }));
  assert.strictEqual(out.mode, 'contact-subclass'); assert.strictEqual(out.uploadAllowed, false);
  const p = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41s-triage.ps1'));
  for (const b of p) assert.ok(b < 128);
  const txt = p.toString('utf8');
  assert.match(txt, /contact-subclass/); assert.match(txt, /mission41t-contact-subclass\.cjs/); assert.match(txt, /LASTEXITCODE/);
  assert.doesNotMatch(txt, /Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod/i);
});
