'use strict';
// Mission 156: fixture-only unit tests (no network). Real-data evidence lives in MISSION156_README.md.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const lockReal = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/reports/mission79/source-lock.json'), 'utf8'));
let L;
test.before(async () => { L = await import('../tools/mission156/lib.mjs'); });

test('rights gate accepts the real 2025 Osaka-shi PLATEAU lock', () => {
  const g = L.rightsGate(lockReal);
  assert.deepStrictEqual(g.reasons, []);
  assert.strictEqual(g.ok, true);
});

test('rights gate refuses 27999 Expo, wrong host, wrong license, missing etag, missing lock', () => {
  const clone = (f) => { const c = JSON.parse(JSON.stringify(lockReal)); f(c); return c; };
  assert.strictEqual(L.rightsGate(clone((c) => { c.package.name = 'plateau-27999-expo-2025'; })).ok, false);
  assert.strictEqual(L.rightsGate(clone((c) => { c.resource.url = 'https://example.com/x.zip'; })).ok, false);
  assert.strictEqual(L.rightsGate(clone((c) => { c.license.id = 'cc-by-nc'; })).ok, false);
  assert.strictEqual(L.rightsGate(clone((c) => { delete c.http.etag; })).ok, false);
  assert.strictEqual(L.rightsGate(clone((c) => { c.resource.url = 'https://assets.cms.plateau.reearth.io/27999_x.zip'; })).ok, false);
  assert.strictEqual(L.rightsGate(null).ok, false);
});

test('duplicate canonical id detection across and within wards', () => {
  assert.strictEqual(L.findDuplicateIds({ a: ['x', 'y'], b: ['z'] }).length, 0);
  const d = L.findDuplicateIds({ a: ['x', 'y'], b: ['y', 'z'] });
  assert.deepStrictEqual(d, [{ id: 'y', wards: ['a', 'b'] }]);
  assert.strictEqual(L.findDuplicateIds({ a: ['x', 'x'] }).length, 1);
});

test('ward status: never complete without HTTP200 + browser + full meshes + orientation', () => {
  const ok = { meshesPlanned: 4, meshesFetched: 4, sourceBuildings: 10, convertedBuildings: 8, orientationOk: true };
  assert.strictEqual(L.wardStatus(undefined), 'pending');
  assert.strictEqual(L.wardStatus({ error: 'boom' }), 'failed');
  assert.strictEqual(L.wardStatus({ ...ok, meshesFetched: 2 }), 'partial');
  assert.strictEqual(L.wardStatus({ ...ok, convertedBuildings: 0, sourceBuildings: 3 }), 'partial');
  assert.strictEqual(L.wardStatus({ ...ok, orientationOk: null }), 'converted-orientation-unverified');
  assert.strictEqual(L.wardStatus(ok), 'converted');
  assert.strictEqual(L.wardStatus({ ...ok, http200Verified: true }), 'served');
  assert.strictEqual(L.wardStatus({ ...ok, http200Verified: true, browserVerified: true }), 'complete');
});

test('summary: allComplete requires all 24 wards complete; compares with past declared count', () => {
  const done = { meshesPlanned: 1, meshesFetched: 1, sourceBuildings: 5, convertedBuildings: 5, orientationOk: true, http200Verified: true, browserVerified: true };
  const prog = {};
  for (let i = 0; i < 23; i++) prog['w' + i] = done;
  assert.strictEqual(L.summarize(prog, {}).allComplete, false);
  prog.w23 = done;
  const s = L.summarize(prog, {});
  assert.strictEqual(s.allComplete, true);
  assert.strictEqual(s.convertedBuildingsTotal, 120);
  assert.strictEqual(s.declaredPast, 574213);
  // planned-but-missing wards keep the summary honest
  const planned = {}; for (let i = 0; i < 24; i++) planned['p' + i] = {};
  assert.strictEqual(L.summarize({ p0: done }, planned).allComplete, false);
});

test('resume: skip only converted wards with same ETag and existing output; interrupted/changed source re-runs', () => {
  const p = { meshesPlanned: 3, meshesFetched: 3, convertedBuildings: 9, sourceEtag: 'e1' };
  assert.strictEqual(L.shouldSkip(p, 'e1', true), true);
  assert.strictEqual(L.shouldSkip(p, 'e2', true), false);   // source changed
  assert.strictEqual(L.shouldSkip(p, 'e1', false), false);  // output lost (fresh runner)
  assert.strictEqual(L.shouldSkip({ ...p, error: 'x' }, 'e1', true), false);
  assert.strictEqual(L.shouldSkip({ ...p, meshesFetched: 1 }, 'e1', true), false);
  assert.strictEqual(L.shouldSkip(undefined, 'e1', true), false);
});

test('source lock covers all 24 wards with at least one mesh (offline plan)', async () => {
  const { selectMeshes } = await import('../tools/mission79-run.mjs');
  const area = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/areas/osaka-city.json'), 'utf8'));
  const polys = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/processed/osaka-city/boundaries/ward-classification-polygons.json'), 'utf8'));
  assert.strictEqual(polys.wards.length, 24);
  for (const w of polys.wards) assert.ok(selectMeshes(lockReal, w, area.projection).meshes.length > 0, w.wardId);
});
