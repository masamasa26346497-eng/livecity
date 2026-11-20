'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const B = require('../tools/mission43d-ward-batch.cjs');
const T = require('../tools/mission43-ward-rebuild.cjs');
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'tools/mission43d-ward-batch.cjs');
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm43e-'));
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o)); };
const fp = [[0, 0], [10, 0], [10, 10], [0, 10]];

function fixture(mut, idFn) {
  const src = tmp(); const ds = [];
  wards.forEach((w, wi) => {
    const dir = path.join(src, 'osaka-' + w.id); const tiles = [];
    for (let t = 0; t < 2; t++) {
      const bs = [0, 1, 2].map((k) => ({ id: idFn ? idFn(wi, t, k) : 'bldg_' + wi + '-' + t + '-' + k + '-fx', fp, h: 10 }));
      wj(path.join(dir, 'tile_' + t + '_0.json'), { buildings: bs });
      tiles.push({ tx: t, tz: 0, count: 3, file: 'tile_' + t + '_0.json' });
    }
    wj(path.join(dir, 'manifest.json'), { wardCode: w.code, tiles });
    ds.push({ id: 'osaka-' + w.id, wardId: w.id, buildings: 6, tiles: 2 });
  });
  wj(path.join(src, 'manifest.json'), { datasets: ds });
  if (mut) mut(src);
  return src;
}
const cli = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8' });

test('audit: bad geometry (no footprint / non-finite height) makes the ward not ready', () => {
  const r = B.audit(fixture((s) => wj(path.join(s, 'osaka-kita/tile_0_0.json'), { buildings: [{ id: 'bldg_a-fx', fp: [[0, 0]], h: 5 }, { id: 'bldg_b-fx', fp, h: null }, { id: 'bldg_c-fx', fp, h: 3 }] })));
  assert.ok(r.wards.kita.issues.includes('bad-geometry'));
  assert.strictEqual(r.ready, false);
  assert.ok(r.wards.chuo.ready);
});

test('audit: cross-ward duplicate ids are a warning only; data untouched, ready unaffected', () => {
  const r = B.audit(fixture(null, (wi, t, k) => 'bldg_shared-' + t + '-' + k));
  assert.strictEqual(r.ready, true);
  assert.ok(r.warnings.crossWardDuplicateIds > 0);
  assert.ok(!/bldg_/.test(JSON.stringify(r)));
});

test('audit: missing root manifest / empty tile list / absent ward are not ready', () => {
  const noRoot = B.audit(fixture((s) => fs.rmSync(path.join(s, 'manifest.json'))));
  assert.strictEqual(noRoot.ready, false);
  const empty = B.audit(fixture((s) => wj(path.join(s, 'osaka-kita/manifest.json'), { wardCode: wards.find((w) => w.id === 'kita').code, tiles: [] })));
  assert.ok(empty.wards.kita.issues.includes('no-tiles-listed'));
});

test('audit: output never contains path or id even when the folder holds tricky names', () => {
  const r = B.audit(fixture((s) => wj(path.join(s, 'osaka-kita/C-Users-secret OneDrive.json'), { x: 1 })));
  assert.ok(!/OneDrive|secret|bldg_|\/tmp\//.test(JSON.stringify(r)));
});

test('batch-plan: PC audit that is not overall-ready never yields pc-only (even if a ward looks clean)', () => {
  const a = B.audit(fixture((s) => wj(path.join(s, 'osaka-nishi/tile_1_0.json'), '{ broken')));
  assert.strictEqual(a.ready, false); assert.ok(a.wards.kita.ready);
  const p = B.batchPlan(null, a);
  assert.strictEqual(p.summary['pc-only'], 0);
  assert.strictEqual(p.wards.find((w) => w.ward === 'kita').status, 'not-ready');
  assert.strictEqual(p.wards.find((w) => w.ward === 'sumiyoshi').status, 'tracked-legacy-rebuildable');
});

test('batch-plan: fatal/failed audit => nothing PC-usable; wrong schemas rejected', () => {
  const p = B.batchPlan(null, B.audit(undefined));
  assert.strictEqual(p.summary['pc-only'], 0);
  assert.throws(() => B.batchPlan(null, { schema: 'x' }), /unexpected schema/);
  assert.throws(() => B.batchPlan({ schema: 'x' }, null), /unexpected schema/);
});

test('batch-plan: inspect-only requires ok and a clean ward', () => {
  const src = fixture();
  const good = B.batchPlan(T.inspect(src), null);
  assert.strictEqual(good.wards.find((w) => w.ward === 'kita').status, 'pc-only');
  const bad = fixture((s) => wj(path.join(s, 'osaka-kita/tile_0_0.json'), { buildings: [{ id: 'bldg_a-fx', fp: [[0, 0]], h: 5 }] }));
  const p = B.batchPlan(T.inspect(bad), null);
  assert.strictEqual(p.wards.find((w) => w.ward === 'kita').status, 'not-ready');
  assert.ok(p.wards.every((w) => w.approvedForTransfer === false));
});

test('batch-plan: tracked count has file evidence; the 18 wards without input stay unknown/blocked', () => {
  const p = B.batchPlan(null, null);
  const s = p.wards.find((w) => w.ward === 'sumiyoshi');
  assert.strictEqual(s.trackedEvidence.tilesOnDisk, 52); assert.strictEqual(s.trackedEvidence.buildingsInManifest, 35031);
  const others = p.wards.filter((w) => w.ward !== 'sumiyoshi');
  assert.strictEqual(others.length, 23);
  assert.ok(others.every((w) => w.status === 'not-ready' && w.minInputTiles === 'unknown' && w.estimatedOutputBytes === 'unknown' && w.runnableOnGitHub === false));
  assert.strictEqual(p.gates.uploadAllowed, 0);
});

test('CLI: audit-plan on a clean fixture exits 0, anonymous, writes nothing; bad src exits 1 with no path', () => {
  const src = fixture();
  const before = fs.readdirSync(src, { recursive: true }).length;
  const ok = cli(['audit-plan', '--src', src]);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.ok(!ok.stdout.includes(src) && !/bldg_/.test(ok.stdout));
  assert.strictEqual(JSON.parse(ok.stdout).uploadAllowed, 0);
  assert.strictEqual(fs.readdirSync(src, { recursive: true }).length, before);
  const nope = path.join(os.tmpdir(), 'secret-folder-m43e');
  const bad = cli(['audit-plan', '--src', nope]);
  assert.strictEqual(bad.status, 1);
  assert.ok(!(bad.stdout + bad.stderr).includes('secret-folder'));
  const w = cli(['audit', '--src', src, '--write', path.join(nope, 'x', 'y.json')]);
  assert.ok(!(w.stdout + w.stderr).includes('secret-folder'));
});

test('run --execute refuses a non-empty out-root before touching anything', () => {
  const ne = tmp(); fs.writeFileSync(path.join(ne, 'keep.txt'), 'keep');
  assert.throws(() => B.run('sumiyoshi', ne, true), /not empty/);
  assert.strictEqual(fs.readFileSync(path.join(ne, 'keep.txt'), 'utf8'), 'keep');
});

test('PS5.1 wrapper: ASCII only, read-only, uses Out-Host + LASTEXITCODE, no write/copy/delete commands', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'tools/mission43e-audit.ps1'));
  assert.ok(buf.every((b) => b < 128));
  const s = buf.toString('utf8').replace(/<#[\s\S]*?#>/, '');
  assert.ok(/Out-Host/.test(s) && /\$LASTEXITCODE/.test(s));
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Set-Content|Out-File|Invoke-WebRequest|Invoke-RestMethod|>\s*\$/.test(s));
  assert.ok((s.match(/\(/g) || []).length === (s.match(/\)/g) || []).length);
  assert.ok((s.match(/\{/g) || []).length === (s.match(/\}/g) || []).length);
});

test('viewer/published-gate smoke: 6 tracked wards partial, none published, gates closed', () => {
  const pub = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission40j-3dtiles/published.json'), 'utf8'));
  assert.deepStrictEqual(pub.wards, []);
  assert.strictEqual(T.existingSets().filter((s) => s.tracked && s.wardId).length >= 6, true);
  const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(/w\.approved === true/.test(html));
  const e = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/mission43c-licence-evidence.json'), 'utf8'));
  assert.strictEqual(e.licenceApproved, false); assert.strictEqual(e.uploadAllowed, 0);
});
