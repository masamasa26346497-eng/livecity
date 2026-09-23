// tests/landmark-registry.test.js
// [見た目改善 Mission11] tools/lib/landmark-registry.js の純粋データ・純粋ロジック。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANDMARK_SEED, LANDMARK_CATEGORIES, LANDMARK_IMPORTANCE, LANDMARK_MODEL_TYPES, SUSPICIOUS_HEIGHT_M,
  findDuplicateIds, hasFiniteAnchor, isSuspiciousHeight, validateSeed,
  pointInRing, ringBboxXZ, ringAreaXZ, centroidXZ,
  resolveLandmarkBuildings, getLandmarkStyle, LANDMARK_STYLE, LANDMARK_SHADE_CEIL,
} from '../tools/lib/landmark-registry.js';

test('LANDMARK_SEED: 重複 id 0 / 全エントリが必須フィールドを持つ', () => {
  assert.deepEqual(findDuplicateIds(LANDMARK_SEED), []);
  const v = validateSeed(LANDMARK_SEED);
  assert.equal(v.ok, true, v.errors.join(' / '));
  assert.ok(LANDMARK_SEED.length >= 14, 'シードが少なすぎる');
});

test('LANDMARK_SEED: category / importance が enum、座標が有限、suspicious height なし', () => {
  for (const s of LANDMARK_SEED) {
    assert.ok(LANDMARK_CATEGORIES.includes(s.category), `${s.id}: category ${s.category}`);
    assert.ok(LANDMARK_IMPORTANCE.includes(s.importance), `${s.id}: importance ${s.importance}`);
    assert.ok(hasFiniteAnchor(s), `${s.id}: anchor 非有限`);
    assert.ok(!isSuspiciousHeight(s.height), `${s.id}: height ${s.height} が異常値`);
    assert.ok(/^(way|node|relation)\/\d+$/.test(s.osm), `${s.id}: osm ref ${s.osm}`);
  }
});

test('LANDMARK_SEED: 指示書の必須ランドマークを含む', () => {
  const ids = new Set(LANDMARK_SEED.map((s) => s.id));
  for (const need of ['osaka-castle', 'abeno-harukas', 'umeda-sky-building', 'kyocera-dome-osaka',
    'tsutenkaku', 'sakishima-cosmo-tower', 'atc', 'kaiyukan', 'grand-front-osaka', 'universal-studios-japan',
    'nakanoshima-festival-tower', 'osaka-city-hall']) {
    assert.ok(ids.has(need), `シードに ${need} が無い`);
  }
});

test('isSuspiciousHeight: > 500m を検出、null / 通常値は false', () => {
  assert.equal(isSuspiciousHeight(29997), true);
  assert.equal(isSuspiciousHeight(SUSPICIOUS_HEIGHT_M + 1), true);
  assert.equal(isSuspiciousHeight(300), false);
  assert.equal(isSuspiciousHeight(null), false);
  assert.equal(isSuspiciousHeight(undefined), false);
  assert.equal(isSuspiciousHeight(NaN), false);
});

test('pointInRing / ringBboxXZ / ringAreaXZ / centroidXZ', () => {
  const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.equal(pointInRing(50, 50, sq), true);
  assert.equal(pointInRing(150, 50, sq), false);
  const bb = ringBboxXZ(sq);
  assert.deepEqual([bb.minX, bb.maxX, bb.minZ, bb.maxZ], [0, 100, 0, 100]);
  assert.equal(ringAreaXZ(sq), 10000);
  assert.deepEqual(centroidXZ(sq), [50, 50]);
});

test('resolveLandmarkBuildings A: 内包 + 高さ一致 → resolved(containment)', () => {
  const seed = { anchorX: 5, anchorZ: 5, height: 100 };
  const b = { id: 'b1', fp: [[0, 0], [10, 0], [10, 10], [0, 10]], dz: 95 };
  const r = resolveLandmarkBuildings(seed, [b]);
  assert.equal(r.resolved, true);
  assert.equal(r.method, 'containment');
  assert.deepEqual(r.buildingIds, ['b1']);
});

test('resolveLandmarkBuildings: 内包しても高さが大きく違えば unresolved（誤識別回避）', () => {
  const seed = { anchorX: 5, anchorZ: 5, height: 200 };
  const b = { id: 'b1', fp: [[0, 0], [10, 0], [10, 10], [0, 10]], dz: 12 }; // 京セラドームのような乖離
  const r = resolveLandmarkBuildings(seed, [b]);
  assert.equal(r.resolved, false);
  assert.match(r.reason, /height mismatch/);
});

test('resolveLandmarkBuildings: suspicious height の建物は候補にしない', () => {
  const seed = { anchorX: 5, anchorZ: 5, height: 300 };
  const b = { id: 'b1', fp: [[0, 0], [10, 0], [10, 10], [0, 10]], dz: 29997 };
  const r = resolveLandmarkBuildings(seed, [b]);
  assert.equal(r.resolved, false);
});

test('resolveLandmarkBuildings B: 距離のみの nearest 割当はしない（30m内でも一意でなければ unresolved）', () => {
  const seed = { anchorX: 0, anchorZ: 0, height: 100 };
  const b1 = { id: 'b1', fp: [[8, 8], [12, 8], [12, 12], [8, 12]], dz: 100 };
  const b2 = { id: 'b2', fp: [[-12, -12], [-8, -12], [-8, -8], [-12, -8]], dz: 95 };
  const r = resolveLandmarkBuildings(seed, [b1, b2]);
  assert.equal(r.resolved, false);
  assert.match(r.reason, /ambiguous/);
  // 一意なら resolved（proximity-height-unique）
  const r2 = resolveLandmarkBuildings(seed, [b1]);
  assert.equal(r2.resolved, true);
  assert.equal(r2.method, 'proximity-height-unique');
});

test('resolveLandmarkBuildings: height 未知 + 内包なし → unresolved（概算で紐付けない）', () => {
  const seed = { anchorX: 500, anchorZ: 500, height: null };
  const b = { id: 'b1', fp: [[0, 0], [10, 0], [10, 10], [0, 10]], dz: 50 };
  const r = resolveLandmarkBuildings(seed, [b]);
  assert.equal(r.resolved, false);
  assert.deepEqual(r.buildingIds, []);
});

test('getLandmarkStyle: detail / cityLOD の明度係数、cityLOD の方が控えめ', () => {
  const d = getLandmarkStyle('detail'), c = getLandmarkStyle('cityLOD');
  assert.ok(d.wallMul > 1 && d.roofMul > 1);
  assert.ok(c.wallMul >= 1 && c.wallMul <= d.wallMul);
  assert.ok(d.wallMul <= 1.08 && d.roofMul <= 1.1, 'landmark 強調が派手すぎる');
  assert.equal(c.edgeMul, 1, 'cityLOD は edge なし');
  assert.ok(LANDMARK_SHADE_CEIL > 1.09 && LANDMARK_SHADE_CEIL <= 1.15);
});

test('LANDMARK_STYLE / LANDMARK_MODEL_TYPES: 将来の GLTF 差し替え用の型', () => {
  assert.ok(LANDMARK_MODEL_TYPES.includes('PROCEDURAL'));
  assert.ok(LANDMARK_MODEL_TYPES.includes('GLTF'));
  assert.ok(LANDMARK_MODEL_TYPES.includes('LOD2'));
  assert.ok(Object.isFrozen(LANDMARK_STYLE));
});
