// tests/major-building-lod.test.js
// [Mission27] tools/lib/major-building-lod.js の純粋ロジック。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAJOR_MIN_HEIGHT_M, MAJOR_MIN_FP_AREA_M2, MID_MAX_M, HIDE_NEAR_M,
  fpAreaXZ, isMajorBuilding, bandForDistance, bucketVisibility, auditMajorBuildingLod,
} from '../tools/lib/major-building-lod.js';

test('[Mission27] 閾値定数', () => {
  assert.equal(MAJOR_MIN_HEIGHT_M, 30);
  assert.equal(MAJOR_MIN_FP_AREA_M2, 3000);
  assert.equal(MID_MAX_M, 9000);
  assert.equal(HIDE_NEAR_M, 4000);
});

test('[Mission27] fpAreaXZ', () => {
  assert.equal(fpAreaXZ([[0, 0], [10, 0], [10, 10], [0, 10]]), 100);
  assert.equal(fpAreaXZ([[0, 0], [0, 10], [10, 10], [10, 0]]), 100); // 巻き方向不問
  assert.equal(fpAreaXZ([[0, 0], [1, 1]]), 0);
});

test('[Mission27] isMajorBuilding: height>=30 OR area>=3000 OR landmark', () => {
  assert.equal(isMajorBuilding({ dz: 35, fp: [[0, 0], [5, 0], [5, 5], [0, 5]] }), true, '35m は major');
  assert.equal(isMajorBuilding({ dz: 20, fp: [[0, 0], [5, 0], [5, 5], [0, 5]] }), false, '20m/25m² は minor');
  // 60m四方 = 3600m² > 3000
  assert.equal(isMajorBuilding({ dz: 8, fp: [[0, 0], [60, 0], [60, 60], [0, 60]] }), true, '大footprint は major');
  assert.equal(isMajorBuilding({ id: 'b1', dz: 10, fp: [[0, 0], [5, 0], [5, 5], [0, 5]] }, { landmarkIds: new Set(['b1']) }), true, 'landmark は major');
  assert.equal(isMajorBuilding({ id: 'b2', dz: 10, fp: [[0, 0], [5, 0], [5, 5], [0, 5]] }, { landmarkIds: new Set(['b1']) }), false);
  assert.equal(isMajorBuilding({ h: 40, fp: [[0, 0], [5, 0], [5, 5], [0, 5]] }), true, 'h フィールドも見る');
  assert.equal(isMajorBuilding(null), false);
});

test('[Mission27] bandForDistance / bucketVisibility', () => {
  assert.equal(bandForDistance(12000), 'far');
  assert.equal(bandForDistance(9000.1), 'far');
  assert.equal(bandForDistance(9000), 'mid');
  assert.equal(bandForDistance(6000), 'mid');
  assert.equal(bandForDistance(4000.1), 'mid');
  assert.equal(bandForDistance(4000), 'near');
  assert.equal(bandForDistance(1000), 'near');
  assert.equal(bandForDistance(Infinity), 'far');

  assert.deepEqual(bucketVisibility(12000), { band: 'far', minor: true, major: true });
  assert.deepEqual(bucketVisibility(6000), { band: 'mid', minor: false, major: true });
  assert.deepEqual(bucketVisibility(2000), { band: 'near', minor: false, major: false });
});

test('[Mission27] overlap 防止: どの距離でも minor と BuildingTileLayer は同時に出ない', () => {
  // NEAR(<4000) で BuildingTileLayer が実体表示 → minor も major も false
  for (const r of [500, 2000, 3999]) {
    const v = bucketVisibility(r);
    assert.equal(v.minor, false);
    assert.equal(v.major, false);
  }
  // MID で minor(全建物密度) は出ない = 3重表示にならない
  for (const r of [4001, 6000, 9000]) assert.equal(bucketVisibility(r).minor, false);
});

test('[Mission27] auditMajorBuildingLod: 分布集計 + 区別', () => {
  const wards = [{ wardId: 'a', polygons: [{ outer: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] }] }];
  const buildings = [];
  for (let i = 0; i < 100; i++) buildings.push({ id: 'm' + i, dz: 5, fp: [[i, i], [i + 3, i], [i + 3, i + 3], [i, i + 3]], repX: 100 + i, repZ: 100 });
  for (let i = 0; i < 10; i++) buildings.push({ id: 'h' + i, dz: 50, fp: [[500, 500], [505, 500], [505, 505], [500, 505]], repX: 500, repZ: 500 });
  buildings.push({ id: 'big', dz: 6, fp: [[0, 0], [70, 0], [70, 70], [0, 70]], repX: 40, repZ: 40 }); // area 4900
  const A = auditMajorBuildingLod({ buildings, landmarkIds: new Set(['m0']), wards });
  assert.equal(A.totalBuildings, 111);
  assert.equal(A.selectedMajor, 12, '高層10 + 大footprint1 + landmark1');
  assert.equal(A.byCriterion.height, 10);
  assert.equal(A.byCriterion.area, 1);
  assert.equal(A.byCriterion.landmark, 1);
  assert.equal(A.byWard.a, 12);
  assert.ok(A.selectedFraction > 0 && A.selectedFraction < 1);
});
