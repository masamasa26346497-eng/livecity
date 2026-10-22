'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../tools/mission43-ward-rebuild.cjs');
const tool = path.join(__dirname, '../tools/mission43-ward-rebuild.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm43-'));
const idsOf = (dir) => {
  const s = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!/^t_/.test(f)) continue;
    const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const id of (Array.isArray(a) ? a : a.ids)) s.add(id);
  }
  return s;
};

test('manifest: 24 wards, gates closed, nothing transferred', () => {
  const m = T.buildManifest();
  assert.strictEqual(m.wards.length, 24);
  assert.strictEqual(new Set(m.wards.map((w) => w.code)).size, 24);
  assert.strictEqual(m.gates.licenceApproved, false);
  assert.strictEqual(m.gates.uploadAllowed, 0);
  assert.strictEqual(m.transferredNow.files, 0);
  assert.strictEqual(m.summary.wardsLegacyTilesCompleteInGit, 1);
  assert.strictEqual(m.wards.find((w) => w.ward === 'sumiyoshi').groups.legacyBuildingTilesInGit.state, 'in-Git-complete');
  assert.ok(!JSON.stringify(m).match(/[A-Za-z]:\\|\/home\//), 'no absolute paths');
});

test('rebuild fails closed for a ward whose legacy tiles are not tracked', () => {
  assert.throws(() => T.rebuild('fukushima', path.join(tmp(), 'o')), /FAIL-CLOSED/);
  assert.throws(() => T.rebuild('nope', path.join(tmp(), 'o')), /unknown ward/);
});

test('rebuild refuses a non-empty output dir', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'x'), '1');
  assert.throws(() => T.rebuild('sumiyoshi', d), /not empty/);
});

test('end-to-end: Sumiyoshi (Git-tracked legacy tiles) -> verified tileset', () => {
  const out = path.join(tmp(), 'sumiyoshi');
  const r = T.rebuild('sumiyoshi', out);
  assert.strictEqual(r.verify.ok, true, r.verify.problems.join(';'));
  assert.strictEqual(r.convert.buildings, 35031);
  assert.strictEqual(r.convert.skipped, 0);
  assert.strictEqual(r.verify.uniqueIds, r.verify.ids);
  assert.ok(r.verify.glbOk >= 52);
  assert.ok(r.verify.bytes < 60 * 1048576);
  const committed = idsOf(path.join(__dirname, '../public/mission37b-3dtiles/osaka-sumiyoshi-9tile/ids'));
  const rebuilt = idsOf(path.join(out, 'ids'));
  assert.ok(committed.size > 10000);
  for (const id of committed) assert.ok(rebuilt.has(id));
});

test('verify detects a corrupted GLB and a missing uri target', () => {
  const out = path.join(tmp(), 's');
  T.rebuild('sumiyoshi', out);
  const glb = fs.readdirSync(path.join(out, 'tiles')).find((f) => f.endsWith('.glb'));
  fs.writeFileSync(path.join(out, 'tiles', glb), Buffer.from('not a glb at all, sorry!!'));
  const v = T.verifyDir(out);
  assert.strictEqual(v.ok, false);
  assert.ok(v.problems.some((p) => /bad glb/.test(p)));
  fs.rmSync(path.join(out, 'lod'), { recursive: true });
  assert.ok(T.verifyDir(out).problems.some((p) => /missing/.test(p)));
});

test('preflight: anonymous counts only, eligible/upload stay 0 even with all gates true', () => {
  const src = tmp();
  fs.mkdirSync(path.join(src, 'osaka-kita'));
  fs.writeFileSync(path.join(src, 'osaka-kita', 'tile_0_0.json'), '{}');
  fs.mkdirSync(path.join(src, 'osaka-osm-fallback'));
  fs.writeFileSync(path.join(src, 'osaka-osm-fallback', 'a.json'), '{}');
  fs.writeFileSync(path.join(src, 'backup.tar'), 'x');
  const g = path.join(tmp(), 'g.json');
  fs.writeFileSync(g, JSON.stringify({ licenceApproved: true, noSecretsReviewed: true, noPersonalDataReviewed: true }));
  const p = T.preflight(src, g);
  assert.strictEqual(p.wardsFound, 1);
  assert.strictEqual(p.otherFolders.files, 1);
  assert.strictEqual(p.riskyFileCounts.archives, 1);
  assert.strictEqual(p.eligibleForUpload, 0);
  assert.strictEqual(p.uploadAllowed, 0);
  assert.ok(!JSON.stringify(p).includes(src), 'no source path in output');
  assert.strictEqual(T.preflight(src).gates.licenceApproved, false);
});

test('tool never deletes/uploads and has no secrets', () => {
  const s = fs.readFileSync(tool, 'utf8');
  assert.ok(!/rmSync|unlinkSync|\.rm\(|rmdirSync/.test(s));
  assert.ok(!/upload\(|createWriteStream|Authorization|api[_-]?key/i.test(s));
  assert.ok(/method: 'HEAD'/.test(s));
});

test('CLI: rebuild exit code 3 on fail-closed', () => {
  let code = 0;
  try { execFileSync('node', [tool, 'rebuild', '--ward', 'kita', '--out', path.join(tmp(), 'k')], { stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.strictEqual(code, 3);
});
