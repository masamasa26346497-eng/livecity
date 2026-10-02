// tests/footprint-ward-overlap.test.js
// P1-5 #5: footprint × Ward polygon 面積重複による救済分類（tools/lib/footprint-ward-overlap.js）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rescueByFootprintOverlap } from '../tools/lib/footprint-ward-overlap.js';

const ring = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
const wards = [
  { wardId: 'a', bbox: { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 }, polygons: [{ outer: ring(0, 0, 1000, 1000), holes: [] }] },
  { wardId: 'b', bbox: { minX: 1000, maxX: 2000, minZ: 0, maxZ: 1000 }, polygons: [{ outer: ring(1000, 0, 2000, 1000), holes: [] }] },
];

test('代表点は区外だが footprint の大半が区 a に重なる建物は a へ救済される', () => {
  // 建物中心 x=-2（区外）だが footprint が x∈[-12,8] で大半が区a(x>=0)側
  const fp = [[-12, 500], [8, 500], [8, 520], [-12, 520]];
  const r = rescueByFootprintOverlap(fp, wards, { grid: 20, minCoverage: 0.3 });
  assert.equal(r.wardId, 'a');
  assert.ok(r.coverage > 0.3);
});

test('footprint 全体が全区の外にある建物は救済されない（wardId=null）', () => {
  const fp = ring(-500, 500, -480, 520); // 完全に区外
  const r = rescueByFootprintOverlap(fp, wards, { grid: 12, minCoverage: 0.5 });
  assert.equal(r.wardId, null);
  assert.equal(r.coverage, 0);
  assert.equal(r.method, 'none');
});

test('minCoverage 未満の重なりでは救済しない', () => {
  // footprint x∈[-18,2]、区a(x>=0)に入るのは 2/20 = 10% 程度
  const fp = [[-18, 500], [2, 500], [2, 520], [-18, 520]];
  const r = rescueByFootprintOverlap(fp, wards, { grid: 20, minCoverage: 0.5 });
  assert.equal(r.wardId, null);
  assert.ok(r.coverage < 0.5);
});

test('不正フットプリント（頂点<3）は method:none', () => {
  const r = rescueByFootprintOverlap([[0, 0], [1, 1]], wards);
  assert.equal(r.method, 'none');
  assert.equal(r.wardId, null);
});
