const test = require('node:test');
const assert = require('node:assert');
test('ext index never over-claims', async () => {
  const { buildExtIndex } = await import('../tools/mission178/make-ext-index.mjs');
  const w = (b) => ({ present: true, buildings: b, tiles: 52, bytes: 1, treeSha256: 'x', duplicateIds: 0, missingMeshes: 0, browserVerified: true });
  const a = { source: 's', wards: { sumiyoshi: w(1), chuo: w(2) } };
  const i = buildExtIndex(a, { wards: { sumiyoshi: { wardCode: '27120' }, chuo: { wardCode: '27128' } } });
  assert.equal(i.wards.length, 2);
  assert.equal(i.verified, false);
  assert.equal(i.standaloneVerified24, false);
  assert.equal(i.ui37gVerified, false);
  assert.equal(i.roadRiverAlignmentVerified, false);
  assert.equal(i.published, false);
  assert.equal(i.wards[0].wardCode, '27120');
});
