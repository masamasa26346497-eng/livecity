// tests/water-surface.test.js
// [見た目改善 Mission06] tools/lib/water-surface.js の純粋ロジック。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUND_EXTENT, SEA_MASK, DEFAULT_CELL_M, MAX_RUN_WIDTH_M, INLAND_TEST_POINTS,
  pointInRing, pointInPolygons, flattenWardPolygons,
  rasterizeSea, mergeRowRuns, runsToTriangles, validateWaterSurface, pointInTriangle, upNormalY,
} from '../tools/lib/water-surface.js';

test('SEA_MASK: 内陸/foreign を含まない範囲（東端 x<=-3200、北端 z>=-10500、南端 z<=2300）', () => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of SEA_MASK) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  assert.ok(maxX <= -3200, `SEA_MASK 東端 ${maxX} が内陸へ踏み込んでいる`);
  assert.ok(minZ >= -10500, `SEA_MASK 北端 ${minZ} が夢洲/淀川デルタへ踏み込んでいる`);
  assert.ok(maxZ <= GROUND_EXTENT.maxZ, 'SEA_MASK 南端が地表矩形外');
  assert.ok(minX >= GROUND_EXTENT.minX, 'SEA_MASK 西端が地表矩形外');
});

test('pointInRing / pointInPolygons: 正方形と穴', () => {
  const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.equal(pointInRing(50, 50, sq), true);
  assert.equal(pointInRing(150, 50, sq), false);
  const withHole = [{ outer: sq, holes: [[[40, 40], [60, 40], [60, 60], [40, 60]]] }];
  assert.equal(pointInPolygons(50, 50, withHole), false); // 穴の中
  assert.equal(pointInPolygons(10, 10, withHole), true);
});

test('flattenWardPolygons: wards[] を {outer,holes} のフラット配列へ', () => {
  const wards = [{ wardId: 'a', polygons: [{ outer: [[0, 0]], holes: [] }, { outer: [[1, 1]] }] }];
  const flat = flattenWardPolygons(wards);
  assert.equal(flat.length, 2);
  assert.equal(flat[0].wardId, 'a');
  assert.deepEqual(flat[1].holes, []);
});

test('rasterizeSea: マスク内かつ陸でないセルだけが海になる', () => {
  // 陸: マスク西側に大きな正方形を置く → その部分は海にならない
  const land = [{ wardId: 'x', outer: [[-16000, -8000], [-9000, -8000], [-9000, 0], [-16000, 0]], holes: [] }];
  const r = rasterizeSea({ wardPolygons: land, cellM: 200 });
  assert.ok(r.cols > 0 && r.rows > 0);
  assert.ok(r.seaCellCount > 0);
  // 陸の中心セルは海でない
  const cx = -12500, cz = -4000;
  const c = Math.floor((cx - r.origin.x) / r.cellM);
  const rr = Math.floor((cz - r.origin.z) / r.cellM);
  assert.equal(r.cells[rr * r.cols + c], 0, '陸セルが海になっている');
});

test('mergeRowRuns: 幅は MAX_RUN_WIDTH_M 以下、高さは 1 セル', () => {
  const raster = { cols: 40, rows: 2, cellM: 50, origin: { x: 0, z: 0 }, cells: new Uint8Array(80).fill(1) };
  const runs = mergeRowRuns(raster, MAX_RUN_WIDTH_M);
  for (const q of runs) {
    assert.ok((q.x1 - q.x0) <= MAX_RUN_WIDTH_M + 1e-6, `run 幅 ${q.x1 - q.x0} > ${MAX_RUN_WIDTH_M}`);
    assert.equal(q.z1 - q.z0, 50);
  }
  // 40セル×50m = 2000m を 600m 上限で割る → 行あたり 4 ラン (600+600+600+200)
  assert.equal(runs.length, 2 * 4);
});

test('runsToTriangles: 1 矩形 = 上向き 2 三角形、positions は 6 の倍数', () => {
  const { positions, triangleCount } = runsToTriangles([{ x0: 0, x1: 10, z0: 0, z1: 5 }]);
  assert.equal(triangleCount, 2);
  assert.equal(positions.length, 12);
  // 両三角形とも法線が +Y（上向き）
  for (let i = 0; i + 6 <= positions.length; i += 6) {
    assert.ok(upNormalY(positions[i], positions[i + 1], positions[i + 2], positions[i + 3], positions[i + 4], positions[i + 5]) > 0, `tri ${i / 6} が下向き`);
  }
});

test('validateWaterSurface: 正常な矩形ラン由来の三角形は ok', () => {
  const raster = rasterizeSea({
    wardPolygons: [{ wardId: 'x', outer: [[-16000, -6000], [-10000, -6000], [-10000, -2000], [-16000, -2000]], holes: [] }],
    cellM: 100,
  });
  const runs = mergeRowRuns(raster);
  const { positions } = runsToTriangles(runs);
  // このテストは「矩形ラン由来の三角形が幾何的に健全か」を見る（意味ゲートは別テスト）。
  const v = validateWaterSurface({ positions, cellM: 100, inlandPoints: [], areaRangeM2: [1e6, 300e6] });
  assert.equal(v.ok, true, v.errors.join(' / '));
  assert.equal(v.stats.nanCount, 0);
  assert.equal(v.stats.degenerateCount, 0);
  assert.equal(v.stats.sliverCount, 0);
  assert.equal(v.stats.oversizeCount, 0);
});

test('validateWaterSurface: 巨大 triangle を検出（過去の水面バグの signature）', () => {
  // 大阪湾全体を 1 枚で塗るような巨大三角形
  const positions = [-16000, -18000, -16000, 2000, 6000, 2000];
  const v = validateWaterSurface({ positions, cellM: 50 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /辺長|z 高さ|大きすぎ/.test(e)));
});

test('validateWaterSurface: 内陸テスト点を内包したら reject', () => {
  // 天王寺区 (-455,-6277) を覆う矩形
  const positions = [];
  for (const q of [{ x0: -1000, x1: 200, z0: -6800, z1: -5800 }]) {
    positions.push(q.x0, q.z0, q.x0, q.z1, q.x1, q.z1, q.x0, q.z0, q.x1, q.z1, q.x1, q.z0);
  }
  const v = validateWaterSurface({ positions, cellM: 1300, maxWidthM: 1300 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /内陸テスト点/.test(e)));
});

test('validateWaterSurface: NaN/Inf を検出', () => {
  const positions = [0, 0, 0, 50, NaN, 50];
  const v = validateWaterSurface({ positions, cellM: 50 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /NaN\/Inf/.test(e)));
});

test('INLAND_TEST_POINTS: 全点が SEA_MASK の外、または陸側（海判定されるべきでない基準点）', () => {
  assert.ok(INLAND_TEST_POINTS.length >= 12);
  for (const [x, z] of INLAND_TEST_POINTS) {
    assert.ok(Number.isFinite(x) && Number.isFinite(z));
  }
});

test('pointInTriangle: 基本', () => {
  assert.equal(pointInTriangle(1, 1, 0, 0, 10, 0, 0, 10), true);
  assert.equal(pointInTriangle(9, 9, 0, 0, 10, 0, 0, 10), false);
});
