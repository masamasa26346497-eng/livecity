// tests/park-lod.test.js
// [見た目改善 Mission12] tools/lib/park-lod.js の純粋ロジック（面積分類・band・可視・opacity・面積計算）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARK_AREA_LARGE_M2, PARK_AREA_MEDIUM_M2, classifyParkArea,
  PARK_LOD_BANDS, parkLodBand, parkClassVisible, PARK_TIER_OPACITY, parkTierOpacity,
  ringAreaXZ, polygonAreaWithHoles, countByParkClass,
} from '../tools/lib/park-lod.js';

test('classifyParkArea: 100,000 / 10,000 m² の3段階しきい値', () => {
  assert.equal(PARK_AREA_LARGE_M2, 100000);
  assert.equal(PARK_AREA_MEDIUM_M2, 10000);
  assert.equal(classifyParkArea(250000), 'large');
  assert.equal(classifyParkArea(100000), 'large');
  assert.equal(classifyParkArea(99999), 'medium');
  assert.equal(classifyParkArea(10000), 'medium');
  assert.equal(classifyParkArea(9999), 'small');
  assert.equal(classifyParkArea(0), 'small');
  assert.equal(classifyParkArea(-5), 'small');
  assert.equal(classifyParkArea(NaN), 'small');
  assert.equal(classifyParkArea(Infinity), 'small');
});

test('parkLodBand: FAR>9000 / MID 3500-9000 / NEAR<=3500（道路LODと一致）', () => {
  assert.deepEqual(PARK_LOD_BANDS, { farM: 9000, midM: 3500 });
  assert.equal(parkLodBand(20000), 'far');
  assert.equal(parkLodBand(9001), 'far');
  assert.equal(parkLodBand(9000), 'mid');
  assert.equal(parkLodBand(3501), 'mid');
  assert.equal(parkLodBand(3500), 'near');
  assert.equal(parkLodBand(0), 'near');
  assert.equal(parkLodBand(NaN), 'near');
});

test('parkClassVisible: FAR=large only / MID=large+medium / NEAR=all', () => {
  // FAR
  assert.equal(parkClassVisible('large', 15000), true);
  assert.equal(parkClassVisible('medium', 15000), false);
  assert.equal(parkClassVisible('small', 15000), false);
  // MID
  assert.equal(parkClassVisible('large', 5000), true);
  assert.equal(parkClassVisible('medium', 5000), true);
  assert.equal(parkClassVisible('small', 5000), false);
  // NEAR
  assert.equal(parkClassVisible('large', 2000), true);
  assert.equal(parkClassVisible('medium', 2000), true);
  assert.equal(parkClassVisible('small', 2000), true);
});

test('parkClassVisible: band 境界（9000 / 3500）で正しく切り替わる', () => {
  assert.equal(parkClassVisible('medium', 9000), true, '9000 は MID');
  assert.equal(parkClassVisible('medium', 9001), false, '9001 は FAR');
  assert.equal(parkClassVisible('small', 3500), true, '3500 は NEAR');
  assert.equal(parkClassVisible('small', 3501), false, '3501 は MID');
});

test('parkTierOpacity: NEAR>MID>=FAR、large は遠景でも下限を確保（消えない）', () => {
  for (const cls of ['large', 'medium', 'small']) {
    const near = parkTierOpacity(cls, 1000), mid = parkTierOpacity(cls, 5000), far = parkTierOpacity(cls, 15000);
    assert.ok(near >= 0.72 && near <= 0.86, `${cls} near=${near}`);
    assert.ok(mid <= near, `${cls} mid(${mid}) > near(${near})`);
    assert.ok(far <= mid, `${cls} far(${far}) > mid(${mid})`);
  }
  // large は FAR でも 0.35 以上（薄すぎて消えない）
  assert.ok(parkTierOpacity('large', 15000) >= 0.35, 'large FAR opacity が薄すぎる');
  assert.equal(PARK_TIER_OPACITY.large.near, 0.80);
});

test('ringAreaXZ: 正方形の面積（shoelace）', () => {
  assert.equal(ringAreaXZ([[0, 0], [100, 0], [100, 100], [0, 100]]), 10000);
  assert.equal(ringAreaXZ([[0, 0], [0, 100], [100, 100], [100, 0]]), 10000, '巻き順に依存しない（絶対値）');
  assert.equal(ringAreaXZ([[0, 0], [1, 1]]), 0, '2点は 0');
});

test('polygonAreaWithHoles: 外周 - 穴', () => {
  const outer = [[0, 0], [100, 0], [100, 100], [0, 100]]; // 10000
  const hole = [[25, 25], [75, 25], [75, 75], [25, 75]];  // 2500
  assert.equal(polygonAreaWithHoles(outer, [hole]), 7500);
  assert.equal(polygonAreaWithHoles(outer, []), 10000);
  assert.equal(polygonAreaWithHoles(outer), 10000);
});

test('countByParkClass: feature 配列を面積クラスで集計、合計 = total', () => {
  const feats = [
    { p: [[0, 0], [400, 0], [400, 400], [0, 400]] },   // 160,000 → large
    { p: [[0, 0], [150, 0], [150, 150], [0, 150]] },   // 22,500 → medium
    { p: [[0, 0], [50, 0], [50, 50], [0, 50]] },       // 2,500 → small
    { p: [[0, 0], [1, 1]] },                            // 頂点不足 → invalid + small
  ];
  const c = countByParkClass(feats);
  assert.equal(c.large, 1);
  assert.equal(c.medium, 1);
  assert.equal(c.small, 2);
  assert.equal(c.invalid, 1);
  assert.equal(c.total, 4);
  assert.equal(c.large + c.medium + c.small, c.total);
});
