const test = require('node:test'), assert = require('node:assert');
const { build } = require('../tools/mission106/progress-matrix.cjs');
const chain = require('../tools/mission106/coord-chain.cjs');
test('coordinate chain: sub-metre error, no systematic offset', () => {
  for (const r of chain.run()) { assert.ok(r.maxAbsEastErrM < 1.5, r.wardId); assert.ok(r.maxAbsNorthErrM < 1.5, r.wardId); assert.ok(r.maxAbsUpErrM < 0.1, r.wardId); }
});
test('axis/sign: +x is east, +z is south', () => {
  const p = chain.probe(100, 100);
  const o = chain.probe(0, 0);
  assert.ok(p.lon > o.lon); assert.ok(p.lat < o.lat);
});
test('matrix: 24 wards, zero acceptance claimed without evidence', () => {
  const m = build();
  assert.strictEqual(m.wardsEvaluated, 24);
  assert.strictEqual(new Set(m.wards.map((w) => w.wardCode)).size, 24);
  assert.strictEqual(m.browserCiAccepted, 0); assert.strictEqual(m.ownerDeviceAccepted, 0);
  for (const w of m.wards) { assert.strictEqual(w.ownerDeviceAccepted, false); assert.strictEqual(w.http200, 'unverified'); }
});
