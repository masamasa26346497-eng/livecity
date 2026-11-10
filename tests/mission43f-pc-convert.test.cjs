'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../tools/mission43f-pc-convert.cjs');
const L = require('../tools/mission40b-legacy-tiles-batch.cjs');
const ROOT = path.join(__dirname, '..');
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm43f-'));
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
const REPO_BLD = path.join(ROOT, 'public/map-data/osaka-city/buildings');
test.afterEach(() => L.setSource(REPO_BLD));

// synthetic 24-ward legacy dir (2 tiles x 3 buildings). dupAcross: ward 0 and 1 share one id.
function fixture(mut) {
  const src = tmp(); const ds = [];
  wards.forEach((w, wi) => {
    const dir = path.join(src, 'osaka-' + w.id); const tiles = [];
    for (let t = 0; t < 2; t++) {
      const bs = [0, 1, 2].map((k) => ({ id: 'bldg_' + String(wi).padStart(2, '0') + t + k + '-fixture', fp: [[0, 0], [10, 0], [10, 10], [0, 10]], h: 10, repX: 5 + t * 600, repZ: 5 }));
      bs.forEach((b) => { b.fp = b.fp.map(([x, z]) => [x + t * 600 + b.id.length * 0, z]); });
      wj(path.join(dir, 'tile_' + t + '_0.json'), { buildings: bs });
      tiles.push({ tx: t, tz: 0, count: 3, file: 'tile_' + t + '_0.json' });
    }
    wj(path.join(dir, 'manifest.json'), { wardCode: w.code, coordinateConvention: 'znorth-neg-v1', tiles });
    ds.push({ id: 'osaka-' + w.id, wardId: w.id, buildings: 6, tiles: 2 });
  });
  wj(path.join(src, 'manifest.json'), { datasets: ds });
  if (mut) mut(src);
  return src;
}
const newOut = () => path.join(tmp(), 'out');
const PC = wards.map((w) => w.id).filter((id) => id !== 'sumiyoshi');
const firstPc = PC[0];

test('default is a strict dry-run: nothing is created', () => {
  const src = fixture(); const out = newOut();
  const r = C.runConvert({ src, outRoot: out });
  assert.strictEqual(r.mode, 'dry-run'); assert.strictEqual(r.results.length, 1); assert.strictEqual(r.results[0].state, 'dry-run');
  assert.ok(!fs.existsSync(out));
  assert.strictEqual(r.pcOnlyWards, 23); assert.strictEqual(r.uploadAllowed, 0); assert.strictEqual(r.published, false);
});

test('invalid audit (missing ward) => refused, nothing converted, even with execute', () => {
  const src = fixture((s) => fs.rmSync(path.join(s, 'osaka-' + firstPc), { recursive: true }));
  const out = newOut();
  const r = C.runConvert({ src, outRoot: out, execute: true, wards: PC[1] });
  assert.strictEqual(r.mode, 'refused'); assert.strictEqual(r.auditReady, false); assert.strictEqual(r.converted, 0);
  assert.ok(!fs.existsSync(out));
});

test('execute: 1-ward sandbox converts, verifies, writes anonymous status; source untouched', () => {
  const src = fixture(); const out = newOut();
  const before = C.scanWardSource(src, firstPc).fingerprint;
  const r = C.runConvert({ src, outRoot: out, execute: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r.results));
  assert.strictEqual(r.results[0].state, 'ok'); assert.strictEqual(r.results[0].buildings, 6);
  assert.strictEqual(C.scanWardSource(src, firstPc).fingerprint, before);
  const st = C.readStatus(out); assert.strictEqual(st.wards[firstPc].state, 'ok');
  const rep = JSON.parse(fs.readFileSync(path.join(out, firstPc + '-a1', 'verify-report.json'), 'utf8'));
  assert.strictEqual(rep.ok, true); assert.strictEqual(rep.crossWard.idsRewritten, 0); assert.strictEqual(rep.approvedForPublication, false);
  assert.ok(!/\/tmp\/|bldg_/.test(JSON.stringify(r) + JSON.stringify(st) + JSON.stringify(rep)));
  assert.strictEqual(r.rerunTargets.length, 22);
});

test('resume: ok ward is never re-converted/overwritten; next ward goes on', () => {
  const src = fixture(); const out = newOut();
  C.runConvert({ src, outRoot: out, execute: true });
  const f = path.join(out, firstPc + '-a1', 'verify-report.json'); const m = fs.statSync(f).mtimeMs;
  const r2 = C.runConvert({ src, outRoot: out, execute: true, next: 2 });
  assert.deepStrictEqual(r2.results.map((x) => x.state), ['ok', 'ok']);
  assert.ok(!r2.results.some((x) => x.ward === firstPc));
  assert.strictEqual(fs.statSync(f).mtimeMs, m);
  const r3 = C.runConvert({ src, outRoot: out, execute: true, wards: firstPc });
  assert.strictEqual(r3.results[0].state, 'already-ok');
});

test('failure: recorded, stops, partial dir untouched, retry uses a NEW attempt dir', () => {
  const src = fixture(); const out = newOut();
  const boom = () => { throw new Error('/secret/path/bldg_deadbeef'); };
  const r = C.runConvert({ src, outRoot: out, execute: true, convert: boom });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.results[0].state, 'failed'); assert.strictEqual(r.results[0].reason, 'convert-error');
  assert.ok(!/secret|deadbeef/.test(JSON.stringify(r)));
  fs.writeFileSync(path.join(out, firstPc + '-a1', 'keep.txt'), 'x');
  assert.ok(r.rerunTargets.includes(firstPc));
  const r2 = C.runConvert({ src, outRoot: out, execute: true });
  assert.strictEqual(r2.results[0].state, 'ok'); assert.strictEqual(r2.results[0].attempt, 2);
  assert.ok(fs.existsSync(path.join(out, firstPc + '-a1', 'keep.txt')));
});

test('source changed during conversion => failed (source-changed), not ok', () => {
  const src = fixture(); const out = newOut();
  const mutating = (id, o) => { const r = L.convertWard(id, o); fs.appendFileSync(path.join(src, 'osaka-' + id, 'manifest.json'), ' '); return r; };
  const r = C.runConvert({ src, outRoot: out, execute: true, convert: mutating });
  assert.strictEqual(r.results[0].state, 'failed'); assert.strictEqual(r.results[0].reason, 'source-changed');
});

test('rejections: git-tracked ward, unknown ward, over max buildings', () => {
  const src = fixture(); const out = newOut();
  const r = C.runConvert({ src, outRoot: out, wards: 'sumiyoshi,nowhere,' + firstPc, maxWardBuildings: 5 });
  assert.strictEqual(r.results[0].reason, 'git-tracked-use-43D-run');
  assert.strictEqual(r.results[1].reason, 'not-in-registry');
  assert.strictEqual(r.results[2].reason, 'over-max-ward-buildings');
});

test('wrong coordinate convention => rejected before any directory is created', () => {
  const src = fixture((s) => { const m = path.join(s, 'osaka-' + firstPc, 'manifest.json'); const j = JSON.parse(fs.readFileSync(m, 'utf8')); j.coordinateConvention = 'other'; fs.writeFileSync(m, JSON.stringify(j)); });
  const out = newOut();
  const r = C.runConvert({ src, outRoot: out, execute: true });
  assert.strictEqual(r.results[0].reason, 'bad-coordinate-convention'); assert.ok(!fs.existsSync(path.join(out, firstPc + '-a1')));
});

test('output root: inside repo, inside/around source, non-empty, foreign marker => refused', () => {
  const src = fixture(); const ok = C.checkSource(src);
  assert.throws(() => C.checkOutRoot(path.join(ROOT, 'public', 'x-out'), ok), (e) => e.code === 4);
  assert.throws(() => C.checkOutRoot(path.join(ROOT, 'temp', 'x-out'), ok), (e) => e.code === 4);
  assert.throws(() => C.checkOutRoot(path.join(src, 'out'), ok), (e) => e.code === 4);
  const ne = path.join(tmp(), 'o'); fs.mkdirSync(ne); fs.writeFileSync(path.join(ne, 'file.txt'), 'x');
  assert.throws(() => C.checkOutRoot(ne, ok), (e) => e.code === 4);
  const fm = path.join(tmp(), 'o'); fs.mkdirSync(fm); fs.writeFileSync(path.join(fm, C.MARKER), '{"schema":"other"}');
  assert.throws(() => C.checkOutRoot(fm, ok), (e) => e.code === 4);
  const noParent = path.join(tmp(), 'missing', 'o');
  assert.throws(() => C.checkOutRoot(noParent, ok), (e) => e.code === 4);
  const empty = path.join(tmp(), 'o'); fs.mkdirSync(empty);
  assert.ok(C.checkOutRoot(empty, ok).out);
});

test('source inside the repository is refused (this tool is PC-only)', () => {
  assert.throws(() => C.checkSource(REPO_BLD), (e) => e.code === 5);
  assert.throws(() => C.checkSource(ROOT), (e) => e.code === 5);
});

test('symlink in source / non-directory => refused', { skip: process.platform === 'win32' }, () => {
  const src = fixture();
  fs.symlinkSync(path.join(src, 'osaka-' + PC[1], 'manifest.json'), path.join(src, 'osaka-' + firstPc, 'tile_9_9.json'));
  assert.strictEqual(C.scanWardSource(src, firstPc).ok, false);
  const link = path.join(tmp(), 'lnk'); fs.symlinkSync(src, link);
  assert.throws(() => C.checkSource(link), (e) => e.code === 5);
  const out = newOut(); const r = C.runConvert({ src, outRoot: out, wards: firstPc });
  assert.strictEqual(r.results[0].reason, 'symlink-in-source');
});

test('cross-ward duplicate ids: warning only, ids untouched, namespaced keys are collision-free', () => {
  const src = fixture((s) => {
    const a = path.join(s, 'osaka-' + PC[0], 'tile_0_0.json'); const j = JSON.parse(fs.readFileSync(a, 'utf8')); const dup = 'bldg_shared-fixture';
    j.buildings[0].id = dup; fs.writeFileSync(a, JSON.stringify(j));
    const b = path.join(s, 'osaka-' + PC[1], 'tile_0_0.json'); const k = JSON.parse(fs.readFileSync(b, 'utf8'));
    k.buildings[0].id = dup; fs.writeFileSync(b, JSON.stringify(k));
  });
  const out = newOut();
  const r = C.runConvert({ src, outRoot: out, execute: true, wards: PC[0] });
  assert.strictEqual(r.auditReady, true); assert.strictEqual(r.warnings.crossWardDuplicateIds, 1);
  assert.deepStrictEqual(Object.keys(r.warnings.pairs).length, 1);
  assert.strictEqual(r.results[0].state, 'ok'); assert.strictEqual(r.results[0].crossWardIds, 1);
  const ids = JSON.parse(fs.readFileSync(path.join(out, PC[0] + '-a1', 'ids', 't_0_0.json'), 'utf8'));
  assert.ok(ids.includes('bldg_shared-fixture')); // original id kept verbatim
  const keys = new Set([C.internalKey('27111', 'bldg_shared-fixture'), C.internalKey('27112', 'bldg_shared-fixture')]);
  assert.strictEqual(keys.size, 2);
});

test('real Sumiyoshi (committed) converter path still reproduces 37B 9 tiles (calibration)', () => {
  const T = require('../tools/mission43-ward-rebuild.cjs');
  const r = T.regress(path.join(tmp(), 'sumi'));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.rebuilt.buildings, 35031);
});

test('safety: no network/upload/delete in the tool and wrapper; wrapper is ASCII and dry-run by default', () => {
  const js = fs.readFileSync(path.join(ROOT, 'tools/mission43f-pc-convert.cjs'), 'utf8');
  assert.ok(!/require\(['"](https?|net|dns|child_process)['"]\)|fetch\(|\bgit\b.*(add|push|commit)|rmSync|unlinkSync|rmdirSync/.test(js));
  const ps = fs.readFileSync(path.join(ROOT, 'tools/mission43f-convert.ps1'), 'utf8');
  assert.ok(![...ps].some((c) => c.charCodeAt(0) > 127));
  assert.ok(!/Remove-Item|Copy-Item|robocopy|Move-Item|Invoke-WebRequest|Invoke-RestMethod/i.test(ps));
  assert.ok(/\[switch\]\$Execute/.test(ps) && /Out-Host/.test(ps) && /\$LASTEXITCODE/.test(ps));
  assert.ok(!/\$LASTEXITCODE[^\n]*Out-Host/.test(ps));
});

test('published gate and viewer untouched: published.json has no approved ward', () => {
  const p = path.join(ROOT, 'public/mission40j-3dtiles/published.json');
  if (fs.existsSync(p)) assert.strictEqual((JSON.parse(fs.readFileSync(p, 'utf8')).wards || []).filter((w) => w && w.approved === true).length, 0);
  assert.ok(/approved === true/.test(fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8')));
});
