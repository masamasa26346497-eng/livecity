'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const B = require('../tools/mission43d-ward-batch.cjs');
const T = require('../tools/mission43-ward-rebuild.cjs');
const ROOT = path.join(__dirname, '..');
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm43d-'));
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o)); };

// synthetic 24-ward legacy dir: 2 tiles x 3 buildings per ward
function fixture(mut) {
  const src = tmp(); const ds = [];
  wards.forEach((w, wi) => {
    const dir = path.join(src, 'osaka-' + w.id); const tiles = [];
    for (let t = 0; t < 2; t++) {
      const bs = [0, 1, 2].map((k) => ({ id: 'bldg_' + String(wi).padStart(2, '0') + t + k + '-fixture', fp: [[0, 0], [10, 0], [10, 10]], h: 10 }));
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

test('audit: clean synthetic 24 wards are ready, output is anonymous', () => {
  const r = B.audit(fixture());
  assert.strictEqual(r.ready, true); assert.strictEqual(r.readyWards, 24);
  assert.strictEqual(r.totals.buildings, 144);
  assert.ok(!/\/tmp\/|bldg_/.test(JSON.stringify(r)));
});

test('audit: missing ward / malformed JSON / duplicate IDs / wardCode mismatch / partial / extra file', () => {
  const src = fixture((s) => {
    fs.rmSync(path.join(s, 'osaka-kita'), { recursive: true });
    wj(path.join(s, 'osaka-chuo/tile_0_0.json'), '{ broken');
    wj(path.join(s, 'osaka-nishi/tile_1_0.json'), { buildings: [{ id: 'bldg_dup' }, { id: 'bldg_dup' }, { id: 'bldg_x' }] });
    const m = JSON.parse(fs.readFileSync(path.join(s, 'osaka-abeno/manifest.json'), 'utf8')); m.wardCode = '99999'; wj(path.join(s, 'osaka-abeno/manifest.json'), m);
    fs.rmSync(path.join(s, 'osaka-miyakojima/tile_1_0.json'));
    wj(path.join(s, 'osaka-taisho/untracked-extra.json'), { x: 1 });
  });
  const r = B.audit(src);
  assert.strictEqual(r.ready, false);
  assert.ok(r.wards.kita.issues.includes('ward-manifest-missing'));
  assert.ok(r.wards.chuo.issues.includes('json-syntax'));
  assert.ok(r.wards.nishi.issues.includes('duplicate-id'));
  assert.ok(r.wards.abeno.issues.includes('wardCode-mismatch'));
  assert.ok(r.wards.miyakojima.issues.includes('tiles-missing'));
  assert.ok(r.wards.taisho.ready, 'unlisted extra file does not affect readiness');
});

test('audit: stale root manifest (count differs) is flagged', () => {
  const src = fixture((s) => {
    const r = JSON.parse(fs.readFileSync(path.join(s, 'manifest.json'), 'utf8')); r.datasets[0].buildings = 999; wj(path.join(s, 'manifest.json'), r);
  });
  const r = B.audit(src);
  assert.ok(r.wards[wards[0].id].issues.includes('root-manifest-building-count'));
  assert.strictEqual(r.ready, false);
});

test('audit: unreadable / cloud-only tile is fatal-to-ready', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
  const src = fixture((s) => fs.chmodSync(path.join(s, 'osaka-kita/tile_0_0.json'), 0));
  const r = B.audit(src);
  assert.ok(r.wards.kita.issues.includes('unreadable-or-cloud-only')); assert.strictEqual(r.ready, false);
});

test('audit: bad src fails safe with no path in output', () => {
  const r = B.audit(path.join(os.tmpdir(), 'does-not-exist-m43d'));
  assert.strictEqual(r.ready, false); assert.ok(!JSON.stringify(r).includes('does-not-exist'));
  assert.strictEqual(B.audit(undefined).fatal, 'src-missing');
});

test('audit leaves the source untouched', () => {
  const src = fixture();
  const snap = () => fs.readdirSync(src, { recursive: true }).sort().map((f) => { const st = fs.statSync(path.join(src, f)); return f + ':' + st.mtimeMs + ':' + st.size; }).join('|');
  const a = snap(); B.audit(src); assert.strictEqual(snap(), a);
});

test('batch-plan: only Sumiyoshi is tracked-rebuildable; others unknown without PC output; nothing approved', () => {
  const p = B.batchPlan(null, null);
  assert.strictEqual(p.wards.length, 24);
  assert.strictEqual(p.summary['tracked-legacy-rebuildable'], 1);
  const s = p.wards.find((w) => w.ward === 'sumiyoshi');
  assert.strictEqual(s.status, 'tracked-legacy-rebuildable'); assert.strictEqual(s.minInputTiles, 52);
  assert.ok(Math.abs(s.estimatedOutputBytes - 40788694) / 40788694 < 0.01);
  const k = p.wards.find((w) => w.ward === 'kita');
  assert.strictEqual(k.status, 'not-ready'); assert.strictEqual(k.estimatedOutputBytes, 'unknown');
  assert.ok(p.wards.every((w) => w.approvedForTransfer === false));
  assert.deepStrictEqual(p.gates, { licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false, uploadAllowed: 0 });
});

test('batch-plan: with an audit output, ready PC wards become pc-only (still not approved)', () => {
  const p = B.batchPlan(null, B.audit(fixture()));
  const k = p.wards.find((w) => w.ward === 'kita');
  assert.strictEqual(k.status, 'pc-only');
  assert.strictEqual(k.estimatedOutputBytes, Math.round(6 * B.BYTES_PER_BUILDING));
  assert.ok(p.wards.every((w) => w.approvedForTransfer === false));
});

test('run: default dry-run writes nothing; PC-only ward fails closed; unsafe out-root refused', () => {
  const out = path.join(tmp(), 'o');
  const r = B.run('sumiyoshi,kita', out, false);
  assert.strictEqual(r.mode, 'dry-run');
  assert.strictEqual(r.results[0].wouldConvert.buildings, 35031);
  assert.strictEqual(r.results[1].state, 'fail-closed');
  assert.strictEqual(r.ok, false);
  assert.ok(!fs.existsSync(out));
  assert.throws(() => B.checkOutRoot(path.join(ROOT, 'public', 'x')), /outside the repository/);
  const ne = tmp(); fs.writeFileSync(path.join(ne, 'f'), '1');
  assert.throws(() => B.checkOutRoot(ne), /not empty/);
});

test('run --execute: Sumiyoshi 35,031 buildings end-to-end from Git-tracked tiles + regress vs committed 37B 9 tiles', () => {
  const out = path.join(tmp(), 'root');
  const r = B.run('all-tracked', out, true);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.results.length, 1);
  const s = r.results[0];
  assert.strictEqual(s.state, 'ok'); assert.strictEqual(s.buildings, 35031); assert.strictEqual(s.uniqueIds, 35031);
  assert.deepStrictEqual(s.regress37b, { glbIdentical: 9, idsIdentical: 9, statsIdentical: 9, of: 9 });
  assert.strictEqual(r.published, false); assert.strictEqual(r.uploaded, false); assert.strictEqual(r.uploadAllowed, 0);
  assert.ok(fs.existsSync(path.join(out, 'sumiyoshi', 'tileset.json')));
  assert.throws(() => B.run('sumiyoshi', out, true), /not empty/);
});

test('CLI exit codes', () => {
  const cli = path.join(ROOT, 'tools/mission43d-ward-batch.cjs');
  const code = (args) => { try { execFileSync('node', [cli, ...args], { stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  assert.strictEqual(code([]), 2);
  assert.strictEqual(code(['run', '--wards', 'sumiyoshi']), 2);
  assert.strictEqual(code(['audit', '--src', path.join(os.tmpdir(), 'nope-m43d')]), 1);
});

test('tool has no upload/network/delete code', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/mission43d-ward-batch.cjs'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/require\(['"](https?|net|child_process)['"]\)|fetch\(|rmSync|unlinkSync|rmdirSync|upload\(/.test(s));
});

test('viewer contract: 6 tracked wards partial, 18 without 3D; approved-only published; unload + stale-token contract', () => {
  const tracked = new Set(T.existingSets().filter((s) => s.tracked).map((s) => s.wardId).filter(Boolean));
  assert.strictEqual(tracked.size, 6);
  const m = T.buildManifest();
  assert.strictEqual(m.wards.filter((w) => w.groups.buildings3dInGit.state === 'in-Git').length, 6);
  assert.strictEqual(m.wards.filter((w) => w.groups.buildings3dInGit.state !== 'in-Git').length, 18);
  const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(/w\.approved === true/.test(html)); assert.ok(/unmountBuildings/.test(html)); assert.ok(/gen !== bldgGen/.test(html));
  const pub = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission40j-3dtiles/published.json'), 'utf8'));
  assert.deepStrictEqual(pub.wards, []);
  for (const s of T.existingSets().filter((x) => x.tracked)) assert.deepStrictEqual(s.refs.problems, [], s.rel);
});

test('licence evidence: third-party README not authoritative; every gate stays closed', () => {
  const e = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/mission43c-licence-evidence.json'), 'utf8'));
  assert.strictEqual(e.datasetSpecificLicenseVerified, false); assert.strictEqual(e.osmDatasetSpecificVerified, false);
  assert.strictEqual(e.licenceApproved, false); assert.strictEqual(e.uploadAllowed, 0);
  assert.ok(/NOT authoritative/.test(e.evidence.find((x) => x.id === 'third-party-gitbucket-readme').status));
});
