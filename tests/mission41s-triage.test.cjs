'use strict';
// Mission 41S: synthetic fixtures only. Key/phone-like strings below are fake test values.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const s = require('../tools/mission41s-triage.cjs');
const r = require('../tools/mission41r-review-summary.cjs');
const o = require('../tools/mission41o-holdplan.cjs');
const k = require('../tools/mission41k-content-scan.cjs');

const UUID = '0123abcd-0123-4567-89ab-0123456789ab';
const RANDOM = 'Qx7' + 'kP2mZ9' + 'vL4wR8tY1' + 'nB6cD3fG5hJ';
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lc41s-')); const root = path.join(base, 'LiveCity');
  const files = {
    'facilities/ph.js': Buffer.from('var a = {"password": "your-password-here"};'),
    'facilities/rnd.js': Buffer.from('var a = {"api_key": "' + RANDOM + '"};'),
    'facilities/unk.js': Buffer.from('var a = {"secret": "shortval1"};'),
    'tiles/uu.json': Buffer.from(JSON.stringify({ id: 'x' + UUID + 'b06-1234-5678c' })),
    'tiles/free.json': Buffer.from('call 090-1234-5678 please'),
    'tiles/a.glb': Buffer.from('glTF\x02\x00\x00\x00', 'latin1'),
  };
  for (const [rel, buf] of Object.entries(files)) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
  const e = (rel) => ({ path: 'LiveCity/' + rel, size: files[rel].length });
  const m = { schema: 2, sizing: 'tar-estimate', parts: [
    { asset: 'a.tar', category: 'facilities', files: [e('facilities/ph.js'), e('facilities/rnd.js'), e('facilities/unk.js')] },
    { asset: 'b.tar', category: 'building-tiles', files: [e('tiles/uu.json'), e('tiles/free.json'), e('tiles/a.glb')] }] };
  const mf = path.join(base, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify(m));
  const rf = path.join(base, 'roots.json'); fs.writeFileSync(rf, JSON.stringify({ LiveCity: root }));
  const st = path.join(base, 'content-scan-state.json');
  k.scan({ manifest: mf, rootsFile: rf, state: st, pathContains: '', maxFiles: 0, maxSeconds: 0, maxFileMiB: 512 });
  return { base, root, m, mf, rf, st, roots: { LiveCity: root } };
}
const idOf = (rel) => k.fid('LiveCity', rel);

test('value shapes are coarse and default to unknown', () => {
  assert.strictEqual(s.valueShape('your-password-here'), 'placeholder-shaped');
  assert.strictEqual(s.valueShape('${MY_VAR}'), 'reference-shaped');
  assert.strictEqual(s.valueShape(RANDOM), 'random-shaped-candidate');
  assert.strictEqual(s.valueShape('shortval1'), 'unknown');
});

test('credential: resolves targets, never prints values/paths/names, never approves', () => {
  const x = fixture();
  const out = s.credential(x.m, o.loadState(x.st), x.roots, []);
  assert.strictEqual(out.targets, 3);
  assert.strictEqual(out.uploadAllowed, false);
  const by = Object.fromEntries(out.items.map((i) => [i.id, i]));
  assert.strictEqual(by[idOf('facilities/ph.js')].valueShape, 'all-placeholder-or-reference-shaped');
  assert.strictEqual(by[idOf('facilities/rnd.js')].valueShape, 'random-shaped-candidate-present');
  assert.strictEqual(by[idOf('facilities/unk.js')].valueShape, 'unknown');
  for (const i of out.items) { assert.strictEqual(i.autoApproved, false); assert.strictEqual(i.autoExcluded, false); assert.match(i.status, /HOLD/); assert.strictEqual(i.manifestCategory, 'facilities'); }
  const text = JSON.stringify(out);
  for (const bad of [RANDOM, 'your-password-here', 'shortval1', 'api_key', 'LiveCity', x.base, 'ph.js', 'rnd.js', 'facilities/']) assert.ok(!text.includes(bad), 'leaked: ' + bad);
  assert.ok(out.ownerGuidance.join(' ').match(/rotate/));
});

test('credential: unknown ids and non-credential files are reported without reading', () => {
  const x = fixture();
  const out = s.credential(x.m, o.loadState(x.st), x.roots, ['deadbeef', idOf('tiles/free.json')]);
  const res = out.items.map((i) => i.result).sort();
  assert.deepStrictEqual(res, ['id-not-in-manifest', 'not-a-credential-assignment-finding']);
});

test('phone-groups: classes, cohorts, resume with cap, no leaks, sources unchanged', () => {
  const x = fixture();
  const before = fs.readFileSync(path.join(x.root, 'tiles', 'free.json'));
  const pf = path.join(x.base, 'prog.json');
  const r1 = s.phoneGroups(x.m, o.loadState(x.st), x.roots, { max: 1, progress: s.loadProgress(pf) });
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, classes: r1.classes }));
  assert.strictEqual(r1.out.processedThisRun, 1); assert.strictEqual(r1.out.remaining, 1);
  const r2 = s.phoneGroups(x.m, o.loadState(x.st), x.roots, { max: 5, progress: s.loadProgress(pf) });
  assert.strictEqual(r2.out.remaining, 0); assert.strictEqual(r2.out.processedThisRun, 1);
  assert.strictEqual(r2.out.byClass['id-or-numeric'], 1); // hit adjacent to letters, outside the UUID span
  assert.strictEqual(s.phoneClass('{"n":"none"}'), 'no-match-now'); assert.strictEqual(r2.out.byClass['free-text/contact'], 1);
  assert.strictEqual(r2.out.byCategory['building-tiles'], 2);
  assert.strictEqual(r2.out.uploadAllowed, false);
  const text = JSON.stringify(r2.out);
  for (const bad of [x.base, '090-1234', '06-1234', 'free.json', 'LiveCity']) assert.ok(!text.includes(bad), 'leaked: ' + bad);
  assert.ok(Buffer.compare(before, fs.readFileSync(path.join(x.root, 'tiles', 'free.json'))) === 0);
  assert.ok(!fs.readFileSync(pf, 'utf8').includes('/'));
});

test('CLI runs both modes', () => {
  const x = fixture();
  const t = path.join(__dirname, '..', 'tools', 'mission41s-triage.cjs');
  const a = JSON.parse(cp.execFileSync(process.execPath, [t, 'credential', '--manifest', x.mf, '--roots-file', x.rf], { encoding: 'utf8' }));
  assert.strictEqual(a.mode, 'credential');
  const b = JSON.parse(cp.execFileSync(process.execPath, [t, 'phone-groups', '--manifest', x.mf, '--roots-file', x.rf], { encoding: 'utf8' }));
  assert.strictEqual(b.mode, 'phone-groups');
});

test('41R note: 335 contact-key values, 116 phone-regex, 219 not phone-like; no blanket blanking', () => {
  const x = fixture();
  const sum = r.summarize(x.m, o.loadState(x.st), {});
  assert.match(sum.sanitizePlan.note, /335 contact-key string values/);
  assert.match(sum.sanitizePlan.note, /116/); assert.match(sum.sanitizePlan.note, /219/);
  assert.doesNotMatch(sum.sanitizePlan.note, /335 phone-shaped/);
  assert.match(sum.sanitizePlan.note, /NOT approved/);
  assert.strictEqual(sum.sanitizePlan.autoApply, false);
});

test('ps1 is ASCII, has no delete/copy/move commands and checks the exit code', () => {
  const p = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41s-triage.ps1'));
  for (const b of p) assert.ok(b < 128);
  const t = p.toString('utf8');
  assert.doesNotMatch(t, /Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod/i);
  assert.match(t, /LASTEXITCODE/);
});
