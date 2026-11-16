'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../tools/mission43-ward-rebuild.cjs');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('regress: Git-tracked Sumiyoshi 52 tiles rebuild and match committed 37B 9-tile numerically', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm43c-')), 'sumiyoshi');
  const r = T.regress(out);
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rebuilt.buildings, 35031);
  assert.strictEqual(r.rebuilt.uniqueIds, 35031);
  assert.strictEqual(r.rebuilt.skipped, 0);
  assert.strictEqual(r.rebuilt.fallbacks, 0);
  const c = r.vsCommitted9Tile;
  assert.strictEqual(c.refTiles, 9);
  assert.strictEqual(c.refBuildings, 10546);
  assert.strictEqual(c.refBuildingsFoundInRebuild, 10546);
  assert.strictEqual(c.glbByteIdentical, 9);
  assert.strictEqual(c.idsIdentical, 9);
  assert.strictEqual(c.leafStatsIdentical, 9);
  assert.strictEqual(r.published, false);
  assert.strictEqual(r.uploadAllowed, 0);
  // output lives outside the repo and is not tracked
  assert.ok(path.relative(ROOT, out).startsWith('..'));
});

test('regress CLI refuses a non-empty output dir (exit 4)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm43c-'));
  fs.writeFileSync(path.join(d, 'x'), '1');
  let code = 0;
  try { execFileSync('node', [path.join(ROOT, 'tools/mission43-ward-rebuild.cjs'), 'regress', '--out', d], { stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.strictEqual(code, 4);
});

test('tracked ward count stays 6 and no unapproved derived 3D is published', () => {
  const sets = T.existingSets().filter((s) => s.tracked);
  const wards = new Set(sets.map((s) => s.wardId).filter(Boolean));
  assert.strictEqual(wards.size, 6, [...wards].join(','));
  const pub = JSON.parse(read('public/mission40j-3dtiles/published.json'));
  assert.deepStrictEqual(pub.wards, []);
  assert.ok(!fs.existsSync(path.join(ROOT, 'public/mission40j-3dtiles')) || fs.readdirSync(path.join(ROOT, 'public/mission40j-3dtiles')).every((f) => f === 'published.json'));
});

test('viewer loader contract (static): on-demand, single ward at a time, approved-only published, localhost-only ext', () => {
  const h = read('public/mission37g-osaka-24ward-mvp.html');
  assert.ok(/w\.approved === true/.test(h), 'published wards need approved:true');
  assert.ok(/\/\^\(localhost\|127\\\.0\\\.0\\\.1\)\$\/\.test\(location\.hostname\)/.test(h), '?ext= is localhost-only');
  assert.ok(/bldgGen/.test(h) && /gen !== bldgGen/.test(h), 'generation token discards stale loads');
  assert.ok(/unmountBuildings/.test(h), 'previous ward tilesets are unloaded');
  assert.ok(/stats\.buildingState = 'unavailable'/.test(h), 'unserved wards are marked unavailable');
  assert.ok(/3D建物未整備/.test(h), 'unserved wards are labelled explicitly');
  // no network target outside same origin / known basemap for building data
  assert.ok(!/places\.googleapis|maps\.googleapis/.test(h));
});

test('mission43c-inspect.ps1: ASCII, read-only, exit codes checked, no copy/delete/upload', () => {
  const b = fs.readFileSync(path.join(ROOT, 'tools/mission43c-inspect.ps1'));
  for (const x of b) assert.ok(x < 128, 'non-ASCII byte');
  const s = b.toString('utf8');
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Compress-Archive|Invoke-WebRequest|Invoke-RestMethod|Set-Content|Out-File/i.test(s));
  assert.ok(/LASTEXITCODE/.test(s));
  assert.ok(/inspect --src/.test(s) && /preflight --src/.test(s));
});

test('inspect on empty GitHub-runner-like dir never reports ready', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm43c-'));
  const r = T.inspect(d);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.totals.wards, 0);
  const p = T.preflight(d);
  assert.strictEqual(p.wardsFound, 0);
  assert.strictEqual(p.eligibleForUpload, 0);
  assert.strictEqual(p.uploadAllowed, 0);
});

test('licence record: primary-source claims kept unverified, gates closed', () => {
  const j = JSON.parse(read('config/mission43c-licence-evidence.json'));
  assert.strictEqual(j.datasetSpecificLicenseVerified, false);
  assert.strictEqual(j.licenceApproved, false);
  assert.strictEqual(j.osmDatasetSpecificVerified, false);
  assert.strictEqual(j.uploadAllowed, 0);
  assert.ok(j.fetchedInThisRun === false);
  for (const e of j.evidence) assert.ok(/^https:\/\//.test(e.url) && e.status);
});
