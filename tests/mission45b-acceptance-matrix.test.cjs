'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../tools/mission45b-acceptance-matrix.cjs');
const reg = require('../config/wards/registry.json').wards;
const counts = require('../config/mission45b-ward-source-counts.json').wards;

const realEv = (code, over) => Object.assign({
  code, kind: 'real', realSourceVerified: true, http200: true, webglPixelsChanged: true, clickedBuildingIdVerified: true,
  convertedBuildings: counts[code].sourceBuildings, convertedTiles: counts[code].sourceTiles, peakResidentWards: 1,
}, over || {});
const doc = (wards, over) => Object.assign({ schema: M.EVIDENCE_SCHEMA, wards }, over || {});

test('source counts table matches the ward registry and the audited totals', () => {
  assert.strictEqual(reg.length, 24);
  for (const w of reg) assert.strictEqual(counts[w.code] && counts[w.code].id, w.id, w.id);
  const b = reg.reduce((a, w) => a + counts[w.code].sourceBuildings, 0);
  const t = reg.reduce((a, w) => a + counts[w.code].sourceTiles, 0);
  assert.strictEqual(b, 574213);
  assert.strictEqual(t, 1097);
});

test('no evidence: 24 wards, none accepted, NOT-ACCEPTED, six wards partial from Git', () => {
  const m = M.build([]);
  assert.strictEqual(m.wardCount, 24);
  assert.strictEqual(m.acceptedWards, 0);
  assert.strictEqual(m.complete24, false);
  assert.strictEqual(m.verdict, 'NOT-ACCEPTED');
  assert.strictEqual(m.partialCoverageWards, 6);
  assert.strictEqual(m.fullCoverageWards, 0);
  assert.strictEqual(m.pcOnlyPendingWards, 18);
  assert.ok(m.wards.every((w) => w.missing.includes('real-evidence-absent(pc-only)')));
});

test('gates stay false and the matrix is anonymous', () => {
  const m = M.build([]);
  assert.deepStrictEqual(m.gates, { licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false, uploadAllowed: 0 });
  assert.strictEqual(m.uploaded, 0);
  assert.strictEqual(m.published, false);
  assert.throws(() => M.assertAnonymous({ p: 'C:\\Users\\x\\OneDrive' }), /not-anonymous/);
  assert.throws(() => M.assertAnonymous({ p: 'https://example.com/a' }), /not-anonymous/);
});

test('one fully verified real ward is accepted, others stay pending', () => {
  const m = M.build([doc([realEv('27103')])]);
  const f = m.wards.find((w) => w.ward === 'fukushima');
  assert.strictEqual(f.accepted, true);
  assert.strictEqual(f.coverage, 'full');
  assert.strictEqual(m.acceptedWards, 1);
  assert.strictEqual(m.complete24, false);
});

test('partial coverage (fewer buildings than source) is not accepted', () => {
  const m = M.build([doc([realEv('27103', { convertedBuildings: 100, convertedTiles: 3 })])]);
  const f = m.wards.find((w) => w.ward === 'fukushima');
  assert.strictEqual(f.coverage, 'partial');
  assert.strictEqual(f.accepted, false);
  assert.ok(f.missing.includes('coverage-partial'));
});

test('each of the four checks is required', () => {
  for (const k of M.CHECKS) {
    const m = M.build([doc([realEv('27103', { [k]: false })])]);
    const f = m.wards.find((w) => w.ward === 'fukushima');
    assert.strictEqual(f.accepted, false, k);
    assert.ok(f.missing.includes(k), k);
  }
});

test('synthetic and git-tracked-partial evidence never count toward acceptance', () => {
  const m = M.build([doc([realEv('27103', { kind: 'synthetic' }), realEv('27120', { kind: 'git-tracked-partial' })])]);
  assert.strictEqual(m.acceptedWards, 0);
  assert.strictEqual(m.ignoredEvidence.synthetic, 1);
  assert.strictEqual(m.ignoredEvidence.gitTrackedPartial, 1);
});

test('too many resident wards at once fails the memory-release criterion', () => {
  const m = M.build([doc([realEv('27103', { peakResidentWards: 24 })])]);
  const f = m.wards.find((w) => w.ward === 'fukushima');
  assert.strictEqual(f.accepted, false);
  assert.ok(f.missing.includes('too-many-resident-wards'));
});

test('evidence that flips a gate or claims upload is rejected as a whole', () => {
  for (const over of [{ gates: { licenceApproved: true } }, { gates: { uploadAllowed: 1 } }, { uploaded: true }, { published: true }]) {
    const m = M.build([doc([realEv('27103')], over)]);
    assert.strictEqual(m.acceptedWards, 0);
    assert.ok(m.rootProblems.length > 0);
  }
});

test('malformed, wrong-schema or unknown-ward evidence is rejected', () => {
  assert.strictEqual(M.build([null]).acceptedWards, 0);
  assert.strictEqual(M.build([{ schema: 'x', wards: [] }]).acceptedWards, 0);
  const unk = M.build([doc([realEv('27103'), { code: '99999' }])]);
  assert.strictEqual(unk.acceptedWards, 0);
  assert.ok(unk.rootProblems.includes('evidence-unknown-ward'));
  const bad = M.build([doc([realEv('27103', { http200: 'yes' })])]);
  assert.strictEqual(bad.acceptedWards, 0);
});

test('only all 24 fully verified real wards give complete24', () => {
  const all = reg.map((w) => realEv(w.code));
  const m = M.build([doc(all)]);
  assert.strictEqual(m.complete24, true);
  assert.strictEqual(m.verdict, 'ACCEPTED-24');
  const m23 = M.build([doc(all.slice(1))]);
  assert.strictEqual(m23.complete24, false);
  assert.strictEqual(m23.acceptedWards, 23);
});

test('CLI exits non-zero when not complete (never signals done early)', () => {
  assert.strictEqual(M.main([]), 1);
});
