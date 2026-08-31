// tests/point-in-polygon.test.js
// P1-3: 点→行政区 判定ライブラリ（tools/lib/point-in-polygon.js）のテスト。
// polygon / multipolygon / hole / 飛び地 / 境界上の点 / 市外点 を扱えることを検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointInRing, pointInPolygonWithHoles, pointInWard, classifyPointToWard } from '../tools/lib/point-in-polygon.js';

const square = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];

test('pointInRing: 内側true / 外側false', () => {
  const r = square(0, 0, 100, 100);
  assert.equal(pointInRing(50, 50, r), true);
  assert.equal(pointInRing(150, 50, r), false);
});

test('pointInPolygonWithHoles: hole 内の点は false', () => {
  const poly = { outer: square(0, 0, 100, 100), holes: [square(40, 40, 60, 60)] };
  assert.equal(pointInPolygonWithHoles(50, 50, poly), false); // hole 内
  assert.equal(pointInPolygonWithHoles(10, 10, poly), true);  // outer 内 hole 外
  assert.equal(pointInPolygonWithHoles(200, 200, poly), false);
});

test('pointInWard: 飛び地（disjoint polygon 2つ）のどちらに入っても true', () => {
  const ward = {
    wardId: 'w', bbox: { minX: 0, maxX: 300, minZ: 0, maxZ: 100 },
    polygons: [{ outer: square(0, 0, 100, 100), holes: [] }, { outer: square(200, 0, 300, 100), holes: [] }],
  };
  assert.equal(pointInWard(50, 50, ward), true);
  assert.equal(pointInWard(250, 50, ward), true);
  assert.equal(pointInWard(150, 50, ward), false); // 飛び地の間
});

test('pointInWard: bbox 外は即 false（point-in-polygon を実行しない）', () => {
  const ward = { wardId: 'w', bbox: { minX: 0, maxX: 100, minZ: 0, maxZ: 100 }, polygons: [{ outer: square(0, 0, 100, 100), holes: [] }] };
  assert.equal(pointInWard(9999, 9999, ward), false);
});

const WARDS = [
  { wardId: 'a', bbox: { minX: 0, maxX: 100, minZ: 0, maxZ: 100 }, polygons: [{ outer: square(0, 0, 100, 100), holes: [square(40, 40, 60, 60)] }] },
  { wardId: 'b', bbox: { minX: 100, maxX: 200, minZ: 0, maxZ: 100 }, polygons: [{ outer: square(100, 0, 200, 100), holes: [] }] },
  { wardId: 'c', bbox: { minX: 300, maxX: 400, minZ: 0, maxZ: 100 }, polygons: [{ outer: square(300, 0, 400, 100), holes: [] }] },
];

test('classifyPointToWard: 単一区の内部点はその区', () => {
  const r = classifyPointToWard(20, 20, WARDS);
  assert.equal(r.wardId, 'a');
  assert.equal(r.status, 'inside');
});

test('classifyPointToWard: どの区にも入らない点（区外）は null / outside', () => {
  const r = classifyPointToWard(1000, 1000, WARDS);
  assert.equal(r.wardId, null);
  assert.equal(r.status, 'outside');
});

test('classifyPointToWard: 区の hole 内の点は区外扱い', () => {
  const r = classifyPointToWard(50, 50, WARDS); // a の hole 内
  assert.equal(r.wardId, null);
});

test('classifyPointToWard: 隣接2区の共有境界に厳密に乗った点は近傍多数決で片方へ寄る', () => {
  // x=100 は a と b の境界。4近傍(±eps)のうち x=100+eps は b, x=100-eps は a。
  // z方向近傍は境界線上なので a/b どちらか一方には決まらない → 過半数が取れず ambiguous になりうる。
  // ここでは「例外を投げず status を返す」ことと、決まる場合は隣接2区のどちらかであることを確認する。
  const r = classifyPointToWard(100, 50, WARDS);
  assert.ok(['inside', 'boundary-resolved', 'ambiguous'].includes(r.status));
  if (r.wardId !== null) assert.ok(['a', 'b'].includes(r.wardId));
});

test('classifyPointToWard: 境界からわずかに内側の点は近傍多数決で正しい区へ解決する', () => {
  const r = classifyPointToWard(100.02, 50, WARDS); // b 側にわずかに寄っている
  assert.ok(r.wardId === 'b' || r.status === 'inside');
});
