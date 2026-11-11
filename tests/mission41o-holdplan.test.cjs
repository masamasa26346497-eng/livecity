'use strict';
// Mission 41O: synthetic fixtures only (no real data). Phone-like values below are fake test strings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const o = require('../tools/mission41o-holdplan.cjs');
const k = require('../tools/mission41k-content-scan.cjs');
const f41 = require('../tools/mission41f-pack-local.cjs');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const UUID = '0123abcd-0123-4567-89ab-0123456789ab';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lc41o-')); const root = path.join(base, 'LiveCity');
  const files = {
    'boundaries/held.json': Buffer.from(JSON.stringify({ phone: '06-1234-5678' })),
    'boundaries/clean.json': Buffer.from('{"a":1}'),
    'tiles/uuidish.json': Buffer.from(JSON.stringify({ id: 'x' + UUID + '-0123-4567-8901', n: [1] })),
    'tiles/free.json': Buffer.from('call 090-1234-5678 please'),
    'tiles/a.glb': Buffer.from('glTF\x02\x00\x00\x00', 'latin1'),
    'misc/later.txt': Buffer.from('hello'),
  };
  for (const [rel, buf] of Object.entries(files)) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
  const e = (rel) => ({ path: 'LiveCity/' + rel, size: files[rel].length });
  const m = { schema: 2, sizing: 'tar-estimate', parts: [
    { asset: 'lcdata-boundaries-001.tar', category: 'boundaries', files: [e('boundaries/held.json'), e('boundaries/clean.json')] },
    { asset: 'lcdata-tiles-002.tar', category: 'building-tiles', files: [e('tiles/uuidish.json'), e('tiles/free.json'), e('tiles/a.glb')] },
    { asset: 'lcdata-misc-003.tar', category: 'other', files: [e('misc/later.txt')] }] };
  const mf = path.join(base, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify(m));
  const rf = path.join(base, 'roots.json'); fs.writeFileSync(rf, JSON.stringify({ LiveCity: root }));
  return { base, root, files, m, mf, rf, roots: { LiveCity: root }, st: path.join(base, 'content-scan-state.json'), id: (rel) => k.fid('LiveCity', rel) };
}
const scanAll = (x, maxFiles) => k.scan({ manifest: x.mf, rootsFile: x.rf, state: x.st, pathContains: '', maxFiles: maxFiles || 0, maxSeconds: 0, maxFileMiB: 512 });

test('no state / stale state: nothing is treated as scanned or safe', () => {
  const x = fixture();
  const none = o.progress(x.m, o.loadState(x.st));
  assert.strictEqual(none.reached, 0); assert.strictEqual(none.notReached, 6); assert.strictEqual(none.complete, false);
  fs.writeFileSync(x.st, JSON.stringify({ schema: 1, scannerVersion: 'old', detectorFingerprint: 'x', files: { zz: { status: 'scanned', counts: {} } } }));
  const si = o.loadState(x.st);
  assert.strictEqual(si.valid, false);
  const rows = o.classifyAll(x.m, si);
  assert.ok(rows.every((r) => r.status === 'stale-state'));
  const p = o.propose(x.m, si, o.ALWAYS_HOLD);
  assert.strictEqual(p.unreviewed.count, 6 - p.holdCandidates.count);
  assert.strictEqual(p.complete, false);
});

test('propose: every detected file is a hold candidate; clean/unscanned/not-reached are unreviewed, never safe', () => {
  const x = fixture();
  scanAll(x, 5); // 5 of 6 reached; misc/later.txt not reached
  const si = o.loadState(x.st); assert.strictEqual(si.valid, true);
  const p = o.propose(x.m, si, o.ALWAYS_HOLD);
  const ids = new Set(p.holdIds);
  assert.ok(ids.has(x.id('boundaries/held.json')) && ids.has(x.id('tiles/free.json')));
  assert.ok(!ids.has(x.id('boundaries/clean.json')));
  assert.strictEqual(p.totals.byStatus['scanned-no-pattern'], 2);
  assert.strictEqual(p.totals.byStatus.unscanned, 1);
  assert.strictEqual(p.totals.byStatus['not-reached'], 1);
  assert.ok(p.unreviewed.count === 2); // the glb and the file not reached; hold candidates are counted separately
  assert.strictEqual(p.complete, false);
  assert.strictEqual(p.approved, false); assert.strictEqual(p.autoApproved, false); assert.strictEqual(p.autoExcluded, false);
  for (const v of Object.values(p.gates)) assert.strictEqual(v, false);
  const text = JSON.stringify(p);
  assert.ok(!/LiveCity|held\.json|06-1234|090-1234|lcdata-/.test(text), 'no path, name or value');
  assert.ok(p.impactIfAllHeld.after.files < p.impactIfAllHeld.before.files);
});

test('the known HOLD id is always held (even if the scan found nothing) and reported when absent from the manifest', () => {
  const x = fixture();
  const clean = x.id('boundaries/clean.json');
  const p = o.propose(x.m, o.loadState(x.st), [clean, 'e6b68bd7']);
  assert.ok(p.holdIds.includes(clean));
  assert.deepStrictEqual(p.alwaysHoldNotInManifest, ['e6b68bd7']);
  assert.ok(o.parseHoldIds('').includes('e6b68bd7'));
  assert.ok(o.parseHoldIds('aaaaaaaa').includes('e6b68bd7'));
  assert.throws(() => o.parseHoldIds('xyz'));
});

test('progress is resumable: second slice reaches the rest', () => {
  const x = fixture();
  scanAll(x, 2);
  const a = o.progress(x.m, o.loadState(x.st), 2);
  assert.strictEqual(a.reached, 2); assert.strictEqual(a.slicesRemaining, 2);
  scanAll(x, 2); scanAll(x, 2);
  const b = o.progress(x.m, o.loadState(x.st), 2);
  assert.strictEqual(b.complete, true); assert.strictEqual(b.reached, 6);
});

test('approve needs --confirm-hold, writes a NEW ids-only 41N-compatible plan that 41F honours; sources untouched', () => {
  const x = fixture(); scanAll(x);
  const p = o.propose(x.m, o.loadState(x.st), o.ALWAYS_HOLD);
  assert.throws(() => o.approve(p, false, path.join(x.base, 'pl')), /confirm-hold/);
  assert.throws(() => o.approve({ tool: 'x' }, true, path.join(x.base, 'pl')), /not a 41O/);
  const before = sha(fs.readFileSync(path.join(x.root, 'boundaries', 'held.json')));
  const file = o.approve(p, true, path.join(x.base, 'pl'));
  assert.throws(() => o.approve(p, true, path.join(x.base, 'pl')), /not empty/);
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(plan.tool, 'mission41n-exclude'); assert.deepStrictEqual(plan.excludeIds, p.holdIds);
  const out = path.join(x.base, 'out');
  const res = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'mission41f-pack-local.cjs'), 'create', '--manifest', x.mf, '--roots-file', x.rf, '--out', out, '--exclude-plan', file], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, new RegExp('by exclusion plan: ' + p.holdIds.length + ' files'));
  assert.strictEqual(sha(fs.readFileSync(path.join(x.root, 'boundaries', 'held.json'))), before);
});

test('proposal file is not accepted by 41F directly (fail closed)', () => {
  const x = fixture(); scanAll(x);
  const dir = path.join(x.base, 'prop');
  const p = o.propose(x.m, o.loadState(x.st), o.ALWAYS_HOLD);
  const file = o.writeNew(dir, 'hold-proposal.json', p);
  const res = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'mission41f-pack-local.cjs'), 'create', '--manifest', x.mf, '--roots-file', x.rf, '--out', path.join(x.base, 'o2'), '--exclude-plan', file], { encoding: 'utf8' });
  assert.notStrictEqual(res.status, 0);
});

test('tar-check: flags tars holding candidates, counts unreviewed members, never calls a tar safe, prints no names; tars untouched', () => {
  const x = fixture(); scanAll(x, 5);
  const out = path.join(x.base, 'tars');
  const c = f41.create(x.m, x.roots, { outDir: out });
  assert.strictEqual(c.code, 0, JSON.stringify(c.report.problems));
  const tars = fs.readdirSync(out).filter((s) => s.endsWith('.tar'));
  const before = tars.map((t) => sha(fs.readFileSync(path.join(out, t))));
  const r = o.tarCheck(x.m, o.loadState(x.st), o.ALWAYS_HOLD, out);
  assert.strictEqual(r.checked, tars.length);
  assert.ok(r.mustRepackCount >= 2);
  assert.ok(r.rows.every((row) => row.safe === false));
  assert.ok(r.rows.some((row) => row.unreviewedInside > 0));
  assert.ok(!JSON.stringify(r).includes('lcdata-'));
  assert.deepStrictEqual(tars.map((t) => sha(fs.readFileSync(path.join(out, t)))), before);
});

test('uuid-shape: labels candidate false positives, never approves; free-text stays flagged', () => {
  const x = fixture(); scanAll(x);
  const r = o.uuidShape(x.m, o.loadState(x.st), x.roots, { category: 'building-tiles' });
  const byId = Object.fromEntries(r.files.map((f) => [f.id, f.class]));
  assert.strictEqual(byId[x.id('tiles/free.json')], 'free-text-or-field-present');
  assert.ok(r.files.every((f) => f.approved === false));
  assert.strictEqual(r.autoApproved, false);
  assert.ok(!/090-1234|LiveCity/.test(JSON.stringify(r)));
});

test('source and wiring: read-only, offline, ASCII-only ps1, no delete/copy commands, gates false', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41o-holdplan.cjs'), 'utf8');
  assert.ok(!/require\(['"]node:(?:http|https|net|dns|tls|child_process)['"]\)|fetch\(|unlinkSync|rmSync|renameSync|copyFileSync/.test(js));
  const ps = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41o-batch.ps1'));
  assert.ok(ps.every((b) => b < 128), 'ps1 must be ASCII only');
  const t = ps.toString('utf8');
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer/i.test(t));
  assert.ok(t.includes('mission41k-content-scan.ps1') && t.includes('-MaxFiles'));
  assert.strictEqual((t.match(/\{/g) || []).length, (t.match(/\}/g) || []).length);
});

test('41Q: ps1 helper functions do not leak node stdout into return values', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41o-batch.ps1'), 'utf8');
  const fn = t.match(/function Invoke-Progress [\s\S]*?\n\}/)[0];
  assert.ok(/\| Out-Host/.test(fn), 'node stdout must go to host');
  assert.ok(/return \[int\]\$LASTEXITCODE/.test(fn));
  const prop = t.match(/function Invoke-Propose [\s\S]*?\n\}/)[0];
  assert.ok(/& node @a \| Out-Host/.test(prop));
  assert.ok(/\$c = \[int\]\(@\(Invoke-Progress\)\[-1\]\)/.test(t));
  assert.ok(!/\$c = Invoke-Progress/.test(t));
});
