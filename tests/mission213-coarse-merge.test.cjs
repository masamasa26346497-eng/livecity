'use strict';
// Mission 213: coarsen() の opt-in 統合(LC_COARSE_MERGE)。既定は従来出力と同一。
const test = require('node:test'), assert = require('node:assert');
const { coarsen, envCoarseMerge } = require('../tools/mission37b-build-3dtiles.cjs');
const sq = (x, z, s) => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];
const feats = [
  { id: 'bldg_a', fp: sq(0, 0, 5), z0: 0, h: 6 }, { id: 'bldg_b', fp: sq(8, 0, 5), z0: 0, h: 10 },
  { id: 'bldg_big', fp: sq(100, 100, 30), z0: 0, h: 20 }, { id: 'bldg_far', fp: sq(500, 500, 5), z0: 0, h: 5 },
];
test('merge 無し: 従来どおり全棟(minArea 0)が個別 bbox', () => {
  const o = coarsen(feats, 0);
  assert.deepStrictEqual(o.map((f) => f.id), feats.map((f) => f.id));
});
test('merge 有り: 近接する小建物は 1 箱、遠い小建物と大建物はそのまま、統合箱は bldg_ でない', () => {
  const o = coarsen(feats, 0, { cellM: 20, belowArea: 100 });
  assert.ok(o.some((f) => f.id === 'bldg_big'));
  const m = o.filter((f) => f.id.startsWith('lod1c_'));
  assert.strictEqual(m.length, 2); // (a,b) と far
  assert.ok(!o.some((f) => f.id === 'bldg_a' || f.id === 'bldg_b'));
  const ab = m.find((f) => f.merged === 2);
  assert.deepStrictEqual(ab.fp[0], [0, 0]); assert.deepStrictEqual(ab.fp[2], [13, 5]); // 和集合 bbox を超えない
  assert.ok(Math.abs(ab.h - 8) < 1e-9); // 面積加重平均(同面積 → 6,10 の平均)
});
test('envCoarseMerge: 形式不正は null(=OFF)', () => {
  const o = process.env.LC_COARSE_MERGE;
  try {
    delete process.env.LC_COARSE_MERGE; assert.strictEqual(envCoarseMerge(), null);
    process.env.LC_COARSE_MERGE = 'x'; assert.strictEqual(envCoarseMerge(), null);
    process.env.LC_COARSE_MERGE = '20:150'; assert.deepStrictEqual(envCoarseMerge(), { cellM: 20, belowArea: 150 });
  } finally { if (o === undefined) delete process.env.LC_COARSE_MERGE; else process.env.LC_COARSE_MERGE = o; }
});
