'use strict';
// Mission 41K: synthetic fixtures only. Not run on real data or under PowerShell 5.1.
// Secret-shaped strings are assembled at run time so this file itself contains none.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const k = require('../tools/mission41k-content-scan.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc41k-'));
const put = (d, rel, data) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), data); };
const A = (n, c) => c.repeat(n);
const GOOGLE = 'AI' + 'za' + A(35, 'A');
const GH = 'gh' + 'p_' + A(36, 'b');
const AWS = 'AK' + 'IA' + A(16, 'C');
const SK = 'sk' + '-' + A(40, 'd');
const JWT = 'ey' + 'J' + A(20, 'a') + '.ey' + 'J' + A(20, 'b') + '.' + A(20, 'c');
const PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const MAIL = 'owner.person' + '@' + 'private-host.jp';
const TEL = '06-' + '1234-' + '5678';

function setup(files, manifestExtra) {
  const root = tmp(); const work = tmp();
  const leaf = 'LiveCity';
  const base = path.join(root, leaf);
  const list = [];
  for (const [rel, data, cat] of files) { put(base, rel, data); list.push({ cat: cat || 'cat-a', path: leaf + '/' + rel, size: Buffer.byteLength(data) }); }
  const byCat = {};
  for (const f of list) (byCat[f.cat] = byCat[f.cat] || []).push({ path: f.path, size: f.size });
  const manifest = { schema: 2, parts: Object.entries(byCat).map(([category, fl]) => ({ category, files: fl })), unsplittable: [], ...(manifestExtra || {}) };
  const mf = path.join(work, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify(manifest));
  const rf = path.join(work, 'roots.json'); fs.writeFileSync(rf, JSON.stringify({ [leaf]: base }));
  return { base, work, mf, rf, leaf };
}
const opts = (s, extra) => ({ manifest: s.mf, rootsFile: s.rf, state: path.join(s.work, 'st.json'), pathContains: '', maxFiles: 0, maxSeconds: 0, maxFileMiB: 512, ...(extra || {}) });

test('detects secrets and personal patterns; output has ids/counts only (no path, value or fingerprint)', () => {
  const s = setup([
    ['data/a.json', JSON.stringify({ key: GOOGLE, gh: GH, aws: AWS, openai: SK, jwt: JWT, mail: MAIL, tel: TEL }) + '\n' + PEM + '\n'],
    ['data/clean.json', '{"height":12.5,"name":"building"}'],
  ]);
  const r = k.scan(opts(s));
  const f = r.filesWithFindings;
  assert.strictEqual(f.length, 1);
  for (const t of ['google-api-key', 'github-token', 'aws-access-key', 'openai-anthropic-style-key', 'jwt', 'pem-private-key', 'email-address', 'jp-phone-number']) assert.strictEqual(f[0].detections[t], 1, t);
  const dump = JSON.stringify(r);
  for (const v of [GOOGLE, GH, AWS, SK, JWT, MAIL, TEL, 'data/a.json', s.base]) assert.ok(!dump.includes(v), 'leaked: ' + v.slice(0, 6));
  assert.deepStrictEqual(r.gates, { noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false });
  assert.match(r.verdict, /DETECTIONS/);
  assert.ok(r.caveats.some((c) => /false positives/.test(c)));
  const sum = JSON.stringify(k.summarize([], { selected: 0 }, 0, {}));
  assert.ok(!sum.includes(s.base));
});

test('a clean scan never opens a gate; example e-mails are not counted as detections', () => {
  const s = setup([['x.txt', 'contact: someone@example.com noreply 12345 2020-10-01'], ['y.json', '{"a":1}']]);
  const r = k.scan(opts(s));
  assert.strictEqual(r.filesWithFindingsTotal, 0);
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.gates.noSecretsReviewed, false);
  assert.strictEqual(r.gates.noPersonalDataReviewed, false);
  assert.match(r.verdict, /not proof of absence/);
});

test('binary, archive, glb/pbf and NUL-containing files are UNSCANNED, never safe', () => {
  const s = setup([
    ['m.glb', Buffer.concat([Buffer.from('glTF'), Buffer.from([0, 1, 2, 3]), Buffer.from(GOOGLE)])],
    ['t.pbf', Buffer.from('xx' + GOOGLE)],
    ['n.zip', Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0])],
    ['noext', Buffer.from([65, 66, 0, 0, 67])],
    ['ok.json', '{}'],
  ]);
  const r = k.scan(opts(s));
  assert.strictEqual(r.byStatus.scanned, 1);
  assert.strictEqual(r.byStatus.unscanned, 4);
  assert.strictEqual(r.complete, false);
  assert.ok(r.unscanned.byReason['archive-not-opened'] >= 1);
  assert.ok(r.unscanned.byReason['binary-format-not-inspected'] >= 2);
  assert.strictEqual(r.filesWithFindingsTotal, 0, 'binary content is not scanned, so no claim');
  assert.match(r.verdict, /NOT scanned/);
});

test('streaming: a secret split across a chunk boundary is found exactly once; large file is not loaded whole', () => {
  const pad = A(1024 * 1024 - 10, ' ');
  const s = setup([['big.txt', pad + GOOGLE + A(50, ' ')]]);
  const r = k.scan(opts(s));
  assert.strictEqual(r.detectorTotals['google-api-key'], 1);
  const s2 = setup([['two.txt', GOOGLE + A(1024 * 1024, ' ') + GOOGLE]]);
  assert.strictEqual(k.scan(opts(s2)).detectorTotals['google-api-key'], 2);
});

test('over the read limit -> unscanned (not skipped silently); no catastrophic regex time on long base64', () => {
  const s = setup([['huge.txt', A(3 * 1024 * 1024, 'a')]]);
  const r = k.scan(opts(s, { maxFileMiB: 1 }));
  assert.strictEqual(r.unscanned.byReason['over-size-limit'], 1);
  const t = Date.now();
  const s2 = setup([['b64.txt', A(2 * 1024 * 1024, 'A')]]);
  k.scan(opts(s2));
  assert.ok(Date.now() - t < 15000, 'regexes must stay linear-ish');
});

test('resume: state caches unchanged files, rescans changed ones; state holds no content/paths/values', () => {
  const s = setup([['a.json', '{"k":"' + GOOGLE + '"}'], ['b.json', '{}']]);
  const o = opts(s);
  const r1 = k.scan(o);
  assert.strictEqual(r1.stats.processedThisRun, 2);
  const r2 = k.scan(o);
  assert.strictEqual(r2.stats.processedThisRun, 0);
  assert.strictEqual(r2.stats.resumedFromState, 2);
  assert.strictEqual(r2.filesWithFindingsTotal, 1);
  const stateText = fs.readFileSync(o.state, 'utf8');
  for (const v of [GOOGLE, 'a.json', s.base]) assert.ok(!stateText.includes(v));
  fs.writeFileSync(path.join(s.base, 'b.json'), '{"changed":true,"pad":"xxxxxxxx"}');
  const r3 = k.scan(o);
  assert.strictEqual(r3.stats.processedThisRun, 1);
});

test('--max-files stops early and the next run continues; unreached files are reported as notReached', () => {
  const s = setup([['1.json', '{}'], ['2.json', '{}'], ['3.json', '{}']]);
  const o = opts(s, { maxFiles: 2 });
  const r1 = k.scan(o);
  assert.strictEqual(r1.stats.stoppedEarly, 'max-files');
  assert.strictEqual(r1.byStatus.notReached, 1);
  assert.strictEqual(r1.complete, false);
  const r2 = k.scan({ ...o, maxFiles: 0 });
  assert.strictEqual(r2.byStatus.notReached, 0);
  assert.strictEqual(r2.byStatus.scanned, 3);
  assert.strictEqual(r2.complete, true);
});

test('path-contains (stage 1) limits the scope; unreadable / missing / cloud-only files stay unscanned', () => {
  const s = setup([['fukushima/a.json', '{}'], ['kita/b.json', '{}'], ['fukushima/cloud.json', '{}']]);
  const skip = path.join(s.work, 'skip.txt'); fs.writeFileSync(skip, 'LiveCity/fukushima/cloud.json\n');
  fs.unlinkSync(path.join(s.base, 'kita', 'b.json'));
  const r = k.scan(opts(s, { pathContains: 'fukushima', skipFile: skip }));
  assert.strictEqual(r.stats.selected, 2);
  assert.strictEqual(r.unscanned.byReason['cloud-only-not-read'], 1);
  const r2 = k.scan(opts(s, { state: path.join(s.work, 'st2.json') }));
  assert.strictEqual(r2.unscanned.byReason['unreadable-or-cloud-only'], 1);
  assert.strictEqual(r2.complete, false);
});

test('provenance: mixed-origin categories are flagged, never approved', () => {
  const s = setup([
    ['plateau-mesh/a.json', '{"src":"PLATEAU CityGML"}', '3dtiles-output'],
    ['osm-fallback/b.json', '{"x":"OpenStreetMap ODbL"}', '3dtiles-output'],
    ['plain/c.json', '{}', 'misc'],
  ]);
  const r = k.scan(opts(s));
  const t = r.provenance.find((p) => p.category === '3dtiles-output');
  assert.strictEqual(t.mixedOrigin, true);
  assert.ok(t.originCandidates.plateau >= 1 && t.originCandidates.osm >= 1);
  for (const p of r.provenance) { assert.strictEqual(p.approved, false); assert.strictEqual(p.redistributionAllowed, null); assert.strictEqual(p.status, 'owner-confirm-required'); }
  assert.strictEqual(r.provenance.find((p) => p.category === 'misc').unmarkedFiles, 1);
});

test('source files are never modified; report is a new file; lookup prints one path only on request', () => {
  const s = setup([['a.json', '{"k":"' + GOOGLE + '"}']]);
  const before = crypto.createHash('sha256').update(fs.readFileSync(path.join(s.base, 'a.json'))).digest('hex');
  const mt = fs.statSync(path.join(s.base, 'a.json')).mtimeMs;
  const out = path.join(s.work, 'rep');
  const orig = console.log; const logged = [];
  console.log = (x) => logged.push(String(x));
  let code;
  try { code = k.run(['scan', '--manifest', s.mf, '--roots-file', s.rf, '--state', path.join(s.work, 'st.json'), '--out', out]); } finally { console.log = orig; }
  assert.strictEqual(code, 2);
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(s.base, 'a.json'))).digest('hex'), before);
  assert.strictEqual(fs.statSync(path.join(s.base, 'a.json')).mtimeMs, mt);
  const joined = logged.join('\n');
  assert.ok(!joined.includes(GOOGLE) && !joined.includes('a.json') && !joined.includes(s.base), 'console has no path/value');
  assert.strictEqual(fs.readdirSync(out).filter((n) => n.startsWith('content-scan-report-')).length, 1);
  const id = k.fid('LiveCity', 'a.json');
  logged.length = 0; console.log = (x) => logged.push(String(x));
  try { assert.strictEqual(k.run(['lookup', '--manifest', s.mf, '--id', id]), 0); } finally { console.log = orig; }
  assert.strictEqual(logged[0], 'LiveCity/a.json');
});

test('manifest schema must be 2', () => {
  const s = setup([['a.json', '{}']], { schema: 1 });
  assert.throws(() => k.scan(opts(s)), /schema must be 2/);
});

test('source: no network, no delete/move/copy of data, ps1 is ASCII with the staged options', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41k-content-scan.cjs'), 'utf8');
  assert.ok(!/require\(['"](node:)?(http|https|net|dgram|tls|child_process)['"]\)|fetch\(/.test(src));
  assert.ok(!/\b(unlinkSync|rmSync|rmdirSync|copyFileSync|appendFileSync)\b/.test(src));
  assert.ok(!/renameSync/.test(src.replace(/fs\.renameSync\(tmp, file\)/, '')), 'rename only for our own state file');
  const ps = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41k-content-scan.ps1'), 'utf8');
  assert.ok(!/[^\x00-\x7f]/.test(ps), 'ASCII only');
  assert.ok(/\$Stage/.test(ps) && /-Stage All/.test(ps) && /fukushima/.test(ps) && /-MaxFiles/.test(ps) && /0x400000/.test(ps));
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod|Set-Content/i.test(ps));
  const open = (ps.match(/\{/g) || []).length, close = (ps.match(/\}/g) || []).length;
  assert.strictEqual(open, close);
});
