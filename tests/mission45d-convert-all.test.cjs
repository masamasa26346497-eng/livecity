'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../tools/mission45d-convert-all.cjs');
const C = require('../tools/mission43f-pc-convert.cjs');
const L = require('../tools/mission40b-legacy-tiles-batch.cjs');
const ROOT = path.join(__dirname, '..');
const REPO_BLD = path.join(ROOT, 'public/map-data/osaka-city/buildings');
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm45d-'));
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
test.afterEach(() => L.setSource(REPO_BLD));

// synthetic 24-ward legacy dir: 2 tiles x 3 buildings per ward = 144 buildings
function fixture() {
  const src = tmp(); const ds = [];
  wards.forEach((w, wi) => {
    const dir = path.join(src, 'osaka-' + w.id); const tiles = [];
    for (let t = 0; t < 2; t++) {
      const bs = [0, 1, 2].map((k) => ({ id: 'bldg_' + String(wi).padStart(2, '0') + t + k + '-fixture', fp: [[t * 600, 0], [t * 600 + 10, 0], [t * 600 + 10, 10], [t * 600, 10]], h: 10, repX: 5 + t * 600, repZ: 5 }));
      wj(path.join(dir, 'tile_' + t + '_0.json'), { buildings: bs });
      tiles.push({ tx: t, tz: 0, count: 3, file: 'tile_' + t + '_0.json' });
    }
    wj(path.join(dir, 'manifest.json'), { wardCode: w.code, coordinateConvention: 'znorth-neg-v1', tiles });
    ds.push({ id: 'osaka-' + w.id, wardId: w.id, buildings: 6, tiles: 2 });
  });
  wj(path.join(src, 'manifest.json'), { datasets: ds });
  return src;
}
const newOut = () => path.join(tmp(), 'out');
const synthSumiyoshi = (src) => (dir) => { L.setSource(src); return L.convertWard('sumiyoshi', { out: dir, force: true }); };
const fp = (src) => C.scanWardSource(src, 'abeno').fingerprint;

test('default is a strict read-only plan: nothing is created', () => {
  const src = fixture(); const out = newOut();
  const r = A.run({ src, outRoot: out });
  assert.strictEqual(r.mode, 'plan'); assert.strictEqual(r.wrote, 0); assert.strictEqual(r.sourceBuildings, 144);
  assert.strictEqual(r.plan.pc23Pending, 23); assert.strictEqual(r.uploadAllowed, 0);
  assert.ok(!fs.existsSync(out));
});

test('--execute without --approved is refused and creates nothing', () => {
  const src = fixture(); const out = newOut();
  assert.throws(() => A.run({ src, outRoot: out, execute: true }), (e) => e.code === 2);
  assert.throws(() => A.run({ src, outRoot: out, approved: true }), (e) => e.code === 2);
  assert.ok(!fs.existsSync(out));
});

test('bad audit (a ward missing) => refused even with execute+approved; nothing created', () => {
  const src = fixture(); fs.rmSync(path.join(src, 'osaka-abeno'), { recursive: true });
  const out = newOut();
  const r = A.run({ src, outRoot: out, execute: true, approved: true, sumiyoshiRun: synthSumiyoshi(src) });
  assert.strictEqual(r.mode, 'refused'); assert.strictEqual(r.auditReady, false); assert.strictEqual(r.complete, false);
  assert.ok(!fs.existsSync(out));
});

test('invalid output roots are rejected: inside repo, inside source, foreign non-empty, missing parent, link', () => {
  const src = fixture();
  assert.throws(() => A.checkRoot(path.join(ROOT, 'temp-out-45d'), src), (e) => e.code === 4);
  assert.throws(() => A.checkRoot(path.join(src, 'out'), src), (e) => e.code === 4);
  assert.throws(() => A.checkRoot(path.join(tmp(), 'no', 'parent'), src), (e) => e.code === 4);
  const foreign = tmp(); fs.writeFileSync(path.join(foreign, 'precious.txt'), 'x');
  assert.throws(() => A.checkRoot(foreign, src), (e) => e.code === 4);
  assert.strictEqual(fs.readFileSync(path.join(foreign, 'precious.txt'), 'utf8'), 'x');
  if (process.platform !== 'win32') {
    const real = tmp(); const link = path.join(tmp(), 'lnk'); fs.symlinkSync(real, link);
    assert.throws(() => A.checkRoot(link, src), (e) => e.code === 4);
    const rootWithLink = tmp(); fs.symlinkSync(real, path.join(rootWithLink, 'pc23'));
    assert.throws(() => A.checkRoot(rootWithLink, src), (e) => e.code === 4);
  }
});

test('synthetic 24-ward E2E: convert -> verify -> complete (24/24, buildings equal), source untouched, anonymous, resumable', () => {
  const src = fixture(); const out = newOut();
  const before = fp(src);
  const r = A.run({ src, outRoot: out, execute: true, approved: true, sumiyoshiRun: synthSumiyoshi(src) });
  assert.strictEqual(r.kind, 'synthetic');
  assert.strictEqual(r.complete, true, JSON.stringify(r.problems));
  assert.strictEqual(r.convertedWards, 24); assert.strictEqual(r.verifiedWards, 24);
  assert.strictEqual(r.sourceBuildings, 144); assert.strictEqual(r.convertedBuildings, 144); assert.strictEqual(r.failures, 0);
  assert.strictEqual(r.published, false); assert.strictEqual(r.uploadAllowed, 0);
  assert.strictEqual(fp(src), before);
  const s = JSON.stringify(r);
  assert.ok(!/[A-Za-z]:\\|\/tmp\/|bldg_/.test(s), 'no path / id in output');
  assert.ok(fs.existsSync(path.join(out, 'completion.json')));
  // nothing written into the repo
  assert.ok(!fs.existsSync(path.join(ROOT, 'temp-out-45d')));
  // resume: nothing is converted again, no new attempt directories appear
  const names = (d) => fs.readdirSync(d).sort().join(',');
  const snap = names(out) + '|' + names(path.join(out, 'pc23'));
  const r2 = A.run({ src, outRoot: out, execute: true, approved: true, sumiyoshiRun: synthSumiyoshi(src) });
  assert.strictEqual(r2.complete, true);
  assert.ok(r2.steps.every((x) => x.state === 'already-ok' || x.state === undefined));
  assert.strictEqual(names(out) + '|' + names(path.join(out, 'pc23')), snap);
  // read-only re-proof
  const v = A.run({ src, outRoot: out, verifyOnly: true, sumiyoshiRun: synthSumiyoshi(src) });
  assert.strictEqual(v.complete, true);
});

test('verify-only detects tampering (a GLB removed) and never reports complete', () => {
  const src = fixture(); const out = newOut();
  A.run({ src, outRoot: out, execute: true, approved: true, sumiyoshiRun: synthSumiyoshi(src) });
  const d = path.join(out, 'pc23', 'abeno-a1', 'tiles');
  const glb = fs.readdirSync(d).find((f) => f.endsWith('.glb'));
  fs.rmSync(path.join(d, glb));
  const v = A.run({ src, outRoot: out, verifyOnly: true, sumiyoshiRun: synthSumiyoshi(src) });
  assert.strictEqual(v.complete, false); assert.ok(v.failures > 0);
});

test('a failing ward stops the run: no complete claim, earlier verified wards are kept', () => {
  const src = fixture();
  // corrupt one PC ward after the audit would pass: duplicate non-ASCII bad geometry is caught by audit => refused (fail-closed)
  fs.writeFileSync(path.join(src, 'osaka-kita', 'tile_0_0.json'), '{ not json');
  const out = newOut();
  const r = A.run({ src, outRoot: out, execute: true, approved: true, sumiyoshiRun: synthSumiyoshi(src) });
  assert.strictEqual(r.mode, 'refused'); assert.ok(!fs.existsSync(out));
});

test('real Git-tracked Sumiyoshi path: rebuilt + 37B regression ok; PC source mismatch (fixture) => NOT complete', () => {
  const src = fixture(); const out = newOut();
  const r = A.run({ src, outRoot: out, execute: true, approved: true });
  const st = A.readState(out);
  assert.strictEqual(st.sumiyoshi.state, 'ok', JSON.stringify(st.sumiyoshi));
  assert.strictEqual(st.sumiyoshi.buildings, 35031);
  assert.strictEqual(st.sumiyoshi.regress37b.identical, true);
  assert.strictEqual(r.kind, 'real');
  assert.strictEqual(r.complete, false); // fixture Sumiyoshi has 6 buildings, Git-tracked has 35,031: must not be reported as equal
  assert.ok(r.problems.some((p) => /^sumiyoshi:/.test(p)));
});

test('static: ps1 is ASCII, needs both flags, has no delete/copy/network commands; js has no network or delete calls', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'tools/mission45d-convert-all.ps1'));
  assert.ok(ps.every((b) => b < 128), 'PS5.1: ASCII only');
  const t = ps.toString('utf8');
  assert.ok(/-not \(\$Execute -and \$Approved\)/.test(t));
  assert.ok(/\| Out-Host/.test(t) && /\$LASTEXITCODE/.test(t));
  for (const bad of ['Remove-Item', 'Copy-Item', 'Move-Item', 'robocopy', 'Invoke-WebRequest', 'Invoke-RestMethod', 'curl', 'git push', 'git add']) assert.ok(!t.includes(bad), bad);
  const js = fs.readFileSync(path.join(ROOT, 'tools/mission45d-convert-all.cjs'), 'utf8');
  for (const bad of ['rmSync', 'unlinkSync', 'rmdirSync', "require('http", "require('https", "require('net", 'fetch(', 'child_process', 'copyFileSync']) assert.ok(!js.includes(bad), bad);
  assert.ok(!/\b(?:574213|574,213)\b/.test(js), 'total building count must come from the runtime audit');
});

// ---- Mission 45D hotfix: real nested Sumiyoshi output (B.run writes <attempt>/sumiyoshi), disk re-verification, 24/24 with the REAL Sumiyoshi.
// PC-source stand-in = the Git-tracked Sumiyoshi tiles copied into a temp dir (no owner data involved).
function fixtureRealSumiyoshi() {
  const src = fixture();
  fs.rmSync(path.join(src, 'osaka-sumiyoshi'), { recursive: true });
  fs.cpSync(path.join(REPO_BLD, 'osaka-sumiyoshi'), path.join(src, 'osaka-sumiyoshi'), { recursive: true });
  const rm = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  const d = rm.datasets.find((x) => x.wardId === 'sumiyoshi'); d.buildings = 35031; d.tiles = 52;
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify(rm));
  return src;
}
const realRun = (src, out) => A.run({ src, outRoot: out, execute: true, approved: true });

test('hotfix: real B.run output is nested (<attempt>/sumiyoshi) and verifySumiyoshi points there -> verified, 24/24 complete', () => {
  const src = fixtureRealSumiyoshi(); const out = newOut();
  const r = realRun(src, out);
  const st = A.readState(out);
  assert.strictEqual(st.sumiyoshi.state, 'ok', JSON.stringify(st.sumiyoshi));
  const attempt = path.join(out, 'sumiyoshi-a' + st.sumiyoshi.attempt);
  assert.ok(fs.existsSync(path.join(attempt, 'sumiyoshi', 'tileset.json')), 'real output is nested');
  assert.ok(!fs.existsSync(path.join(attempt, 'tileset.json')), 'not flat');
  assert.strictEqual(A.sumiyoshiOutDir(attempt), path.join(attempt, 'sumiyoshi'));
  const audit = require('../tools/mission43d-ward-batch.cjs').audit(src);
  const sv = A.verifySumiyoshi(out, src, st.sumiyoshi, audit, wards);
  assert.strictEqual(sv.state, 'verified', JSON.stringify(sv.reasons));
  assert.strictEqual(sv.buildings, 35031);
  assert.strictEqual(r.kind, 'real'); assert.strictEqual(r.sumiyoshi.state, 'verified');
  assert.strictEqual(r.convertedWards, 24); assert.strictEqual(r.complete, true, JSON.stringify(r.problems));
  const names = fs.readdirSync(out).sort().join(',');
  const r2 = realRun(src, out);
  assert.strictEqual(r2.complete, true); assert.strictEqual(fs.readdirSync(out).sort().join(','), names);
  assert.ok(r2.steps.some((x) => x.ward === 'sumiyoshi' && x.state === 'already-ok'));
});

test('hotfix: GLB removed after state ok -> proof fails closed; rerun makes a NEW attempt non-destructively and completes', () => {
  const src = fixtureRealSumiyoshi(); const out = newOut();
  assert.strictEqual(realRun(src, out).complete, true);
  const tiles1 = path.join(out, 'sumiyoshi-a1', 'sumiyoshi', 'tiles');
  const glb = fs.readdirSync(tiles1).find((f) => f.endsWith('.glb'));
  fs.rmSync(path.join(tiles1, glb));
  const v = A.run({ src, outRoot: out, verifyOnly: true });
  assert.strictEqual(v.complete, false); assert.ok(v.problems.some((p) => /^sumiyoshi:/.test(p)));
  const plan = A.run({ src, outRoot: out });
  assert.match(plan.plan.sumiyoshi, /new-attempt/);
  assert.ok(!fs.readdirSync(out).includes('sumiyoshi-a2'), 'plan writes nothing');
  const r = realRun(src, out);
  assert.strictEqual(r.complete, true, JSON.stringify(r.problems));
  assert.strictEqual(A.readState(out).sumiyoshi.attempt, 2);
  assert.ok(fs.existsSync(path.join(out, 'sumiyoshi-a1', 'sumiyoshi', 'tileset.json')), 'old attempt kept');
  assert.ok(!fs.existsSync(path.join(tiles1, glb)), 'old attempt not repaired in place');
});

test('hotfix: damaged ids on disk is caught; recorded state alone never counts as done', () => {
  const src = fixtureRealSumiyoshi(); const out = newOut();
  realRun(src, out);
  const ids = path.join(out, 'sumiyoshi-a1', 'sumiyoshi', 'ids');
  fs.writeFileSync(path.join(ids, fs.readdirSync(ids).find((f) => /^t_.*\.json$/.test(f))), '{ broken'); // g_* are coarse-LOD sidecars (not checked by design)
  assert.strictEqual(A.run({ src, outRoot: out, verifyOnly: true }).complete, false);
});

test('hotfix: pure Git-vs-PC source mismatch is reported but not retried endlessly', () => {
  const src = fixture(); const out = newOut(); // fixture Sumiyoshi has 6 buildings
  realRun(src, out);
  const names = fs.readdirSync(out).sort().join(',');
  const r2 = realRun(src, out);
  assert.strictEqual(r2.complete, false);
  assert.strictEqual(fs.readdirSync(out).sort().join(','), names, 'no new attempt for a deterministic source mismatch');
});

// ---- Mission 45D safety fix: default output outside OneDrive, absolute OutRoot, sync-root refusal (static; PS5.1 not runnable here).
test('ps1 safety: default OutRoot under LOCALAPPDATA, abs path resolve, OneDrive roots refused on convert, no full path in error', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'tools/mission45d-convert-all.ps1'));
  assert.ok(buf.every((b) => b < 128));
  const t = buf.toString('utf8');
  assert.ok(t.includes("[string]$OutRoot = ''"));
  assert.ok(!t.includes("$OutRoot = '.."));
  assert.ok(t.includes('LiveCity-3DTiles-Out-24') && t.includes('$env:LOCALAPPDATA'));
  assert.ok(t.includes('if (-not $env:LOCALAPPDATA) { throw'), 'fail-closed');
  assert.ok(t.includes('IsPathRooted'));
  for (const v of ['$env:OneDrive,', '$env:OneDriveConsumer', '$env:OneDriveCommercial', "'OneDrive'"]) assert.ok(t.includes(v), v);
  assert.ok(t.includes("if ($Step -eq 'convert') { throw 'Output folder is inside a OneDrive"));
  assert.ok(t.includes('ReparsePoint'));
  assert.ok(/-not \(\$Execute -and \$Approved\)/.test(t));
  assert.ok(!t.includes('Looked for') && !/Source folder not found[^\n]*\$src/.test(t));
  assert.ok(/\$LegacyBuildings/.test(t) && !/\$Src\b/.test(t));
  assert.ok(!fs.readFileSync(path.join(ROOT, 'MISSION45D_README.md'), 'utf8').includes('-Src '));
});
