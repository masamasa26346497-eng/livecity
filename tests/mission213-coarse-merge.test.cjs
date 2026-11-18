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
test('安全フィルタ: 道路幅(gap>gapM)で離れた建物は統合せず元 id の個別 bbox、近接は統合', () => {
  const road = [
    { id: 'bldg_n1', fp: sq(0, 0, 5), z0: 0, h: 6 }, { id: 'bldg_n2', fp: sq(6, 0, 5), z0: 0, h: 6 },   // 1m 差で連結
    { id: 'bldg_s1', fp: sq(0, 15, 5), z0: 0, h: 6 },                                                    // 10m の道路を挟む
  ];
  const o = coarsen(road, 0, { cellM: 40, belowArea: 100, gapM: 3, minFill: 0.6 });
  const m = o.filter((f) => f.id.startsWith('lod1c_'));
  assert.strictEqual(m.length, 1); assert.strictEqual(m[0].merged, 2);
  assert.ok(m[0].fp[2][1] <= 5 + 1e-9);                       // 道路側(z>5)へ広がらない
  assert.ok(o.some((f) => f.id === 'bldg_s1'));               // 分離側は個別 bbox にフォールバック
});
test('安全フィルタ: 充填率が minFill 未満(L字など)の成分は統合しない', () => {
  const L = [{ id: 'bldg_p', fp: sq(0, 0, 9), z0: 0, h: 6 }, { id: 'bldg_q', fp: sq(10, 10, 9), z0: 0, h: 6 }]; // 対角: 隙間 1m で連結だが充填率 0.5
  const o = coarsen(L, 0, { cellM: 40, belowArea: 100, gapM: 3, minFill: 0.6 });
  assert.deepStrictEqual(o.map((f) => f.id).sort(), ['bldg_p', 'bldg_q']);
});
test('envCoarseMerge: 4 項目形式', () => {
  const o = process.env.LC_COARSE_MERGE;
  try { process.env.LC_COARSE_MERGE = '20:150:3:0.6'; assert.deepStrictEqual(envCoarseMerge(), { cellM: 20, belowArea: 150, gapM: 3, minFill: 0.6 }); }
  finally { if (o === undefined) delete process.env.LC_COARSE_MERGE; else process.env.LC_COARSE_MERGE = o; }
});
test('道路回避: gap が道路に掛かる成分は統合せず、掛からなければ統合(roadTest 注入)', () => {
  const f = [{ id: 'bldg_a', fp: sq(0, 0, 8), z0: 0, h: 6 }, { id: 'bldg_b', fp: sq(9, 0, 8), z0: 0, h: 6 }];
  const m = { cellM: 40, belowArea: 100, gapM: 3, minFill: 0.1 };
  assert.strictEqual(coarsen(f, 0, { ...m, roadTest: () => false }).filter((o) => o.id.startsWith('lod1c_')).length, 1);
  const r = coarsen(f, 0, { ...m, roadTest: (x) => x > 8 && x < 9 });   // 建物間の 1m の隙間が道路
  assert.strictEqual(r.filter((o) => o.id.startsWith('lod1c_')).length, 0);
  assert.deepStrictEqual(r.map((o) => o.id).sort(), ['bldg_a', 'bldg_b']);
});
