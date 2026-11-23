const test = require('node:test'), assert = require('node:assert');
test('borderPoints: 区境のみ・ward重複除去・N件', async () => {
  const { borderPoints } = await import('../tools/cloud/qa-border-points.mjs');
  const rows = [{ kind: 'ward-center', ward: 'a', lat: 1, lon: 2 }, { kind: 'ward-border', ward: 'a|b', lat: 34.1, lon: 135.1 }, { kind: 'ward-border', ward: 'a|b', lat: 34.1, lon: 135.1 }, { kind: 'ward-border', ward: 'b|c', lat: 34.2, lon: 135.2 }, { kind: 'ward-border', ward: 'c|d', lat: 34.3, lon: 135.3 }];
  const p = borderPoints({ sweep: { rows } }, 2);
  assert.deepStrictEqual(p.map((x) => x.ward), ['a|b', 'b|c']);
  assert.deepStrictEqual(borderPoints({}, 2), []);
  assert.deepStrictEqual(borderPoints({ sweep: { rows: [{ kind: 'ward-border', ward: 'x', lat: NaN, lon: 1 }] } }), []);
});
