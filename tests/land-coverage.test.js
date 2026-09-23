// tests/land-coverage.test.js
// [見た目改善 Mission21] tools/lib/land-coverage.js の純粋ロジック。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DREAM_ISLAND, KEY_PLACES,
  indexWardPolygons, wardAt, ringBbox, ringAreaXZ,
  clipPolygonToRect, triangulateLandTile, buildLandSurface, validateLandSurface,
  auditLandCoverage, findLandGapClusters, auditKeyPlaces,
  SEA_MASK, pointInRing,
} from '../tools/lib/land-coverage.js';

// 小さな手作り区（正方形 + 穴）
const WARDS_FIXTURE = [
  { wardId: 'alpha', polygons: [{ outer: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], holes: [[[400, 400], [600, 400], [600, 600], [400, 600]]] }] },
  { wardId: 'beta', polygons: [{ outer: [[1000, 0], [2500, 0], [2500, 800], [1000, 800]] }] },
];

test('[Mission21] wardAt: outer 内は wardId、穴の中と外は null', () => {
  const iw = indexWardPolygons(WARDS_FIXTURE);
  assert.equal(wardAt(200, 200, iw), 'alpha');
  assert.equal(wardAt(500, 500, iw), null, '穴の中は陸でない');
  assert.equal(wardAt(1500, 400, iw), 'beta');
  assert.equal(wardAt(3000, 3000, iw), null, '範囲外');
});

test('[Mission21] ringBbox / ringAreaXZ', () => {
  const sq = [[0, 0], [10, 0], [10, 20], [0, 20]];
  const bb = ringBbox(sq);
  assert.deepEqual([bb.minX, bb.maxX, bb.minZ, bb.maxZ], [0, 10, 0, 20]);
  assert.equal(ringAreaXZ(sq), 200);
});

test('[Mission21] clipPolygonToRect: 矩形外の三角形は null / またぐ三角形は凸クリップ', () => {
  const tri = [[-100, -100], [50, -100], [50, 50]];
  assert.equal(clipPolygonToRect(tri, { minX: 200, maxX: 300, minZ: 200, maxZ: 300 }), null);
  const clipped = clipPolygonToRect(tri, { minX: 0, maxX: 100, minZ: 0, maxZ: 100 });
  assert.ok(clipped && clipped.length >= 3);
  for (const [x, z] of clipped) {
    assert.ok(x >= -1e-6 && x <= 100 + 1e-6 && z >= -1e-6 && z <= 100 + 1e-6, 'クリップ結果が矩形外');
  }
});

test('[Mission21] triangulateLandTile: 上向き三角形のみ / NaN 無し / タイル対角以下', () => {
  const outer = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];
  const rect = { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 };
  const { positions, triangleCount } = triangulateLandTile(outer, [], rect);
  assert.ok(triangleCount >= 2);
  assert.equal(positions.length, triangleCount * 6);
  for (let i = 0; i + 6 <= positions.length; i += 6) {
    const [ax, az, bx, bz, cx, cz] = positions.slice(i, i + 6);
    assert.ok([ax, az, bx, bz, cx, cz].every(Number.isFinite), 'NaN 頂点');
    const cross = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    assert.ok(cross > 0, 'znorth-neg-v1 で上向き (+Y) でない三角形');
    const e = Math.max(Math.hypot(bx - ax, bz - az), Math.hypot(cx - bx, cz - bz), Math.hypot(ax - cx, az - cz));
    assert.ok(e <= 1000 * Math.SQRT2 + 1, 'タイル対角を超える辺');
  }
});

test('[Mission21] triangulateLandTile: 穴は塗らない', () => {
  const outer = [[0, 0], [900, 0], [900, 900], [0, 900]];
  const hole = [[300, 300], [600, 300], [600, 600], [300, 600]];
  const rect = { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 };
  const { positions } = triangulateLandTile(outer, [hole], rect);
  // 穴の中心 (450,450) がどの三角形にも含まれない
  let covered = false;
  for (let i = 0; i + 6 <= positions.length; i += 6) {
    const [ax, az, bx, bz, cx, cz] = positions.slice(i, i + 6);
    const d1 = (450 - bx) * (az - bz) - (ax - bx) * (450 - bz);
    const d2 = (450 - cx) * (bz - cz) - (bx - cx) * (450 - cz);
    const d3 = (450 - ax) * (cz - az) - (cx - ax) * (450 - az);
    if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) { covered = true; break; }
  }
  assert.equal(covered, false, '穴が塗られている');
});

test('[Mission21] buildLandSurface: merged geometry / タイル分割 / giant triangle 無し', () => {
  const r = buildLandSurface({ wards: WARDS_FIXTURE, tileM: 1000, includeDreamIsland: false });
  assert.ok(r.triangleCount >= 4);
  assert.equal(r.positions.length % 6, 0);
  const v = validateLandSurface(r.positions, { tileM: 1000 });
  assert.equal(v.ok, true, v.errors.join(' / '));
  assert.equal(v.stats.nan, 0);
  assert.equal(v.stats.giant, 0);
  assert.equal(v.stats.downfacing, 0);
  assert.ok(r.tiles >= 3, 'タイル横断で分割されていない（巨大 1 枚 mesh の疑い）');
});

test('[Mission21] validateLandSurface: giant triangle / downfacing / NaN を検出', () => {
  // 5km 級の 1 枚三角形
  const giant = [0, 0, 5000, 0, 0, 5000];
  const vg = validateLandSurface(giant, { tileM: 1000 });
  assert.equal(vg.ok, false);
  assert.ok(vg.stats.giant >= 1);

  const nan = [0, 0, 100, 0, NaN, 100];
  assert.equal(validateLandSurface(nan, { tileM: 1000 }).stats.nan, 1);
});

test('[Mission21] DREAM_ISLAND: 保守的コア / SEA_MASK と重ならない / konohana', () => {
  assert.equal(DREAM_ISLAND.ward, 'konohana');
  const bb = ringBbox(DREAM_ISLAND.outer);
  // 夢洲コアの代表点が SEA_MASK の外（＝海として塗られない側）
  const cx = (bb.minX + bb.maxX) / 2, cz = (bb.minZ + bb.maxZ) / 2;
  assert.equal(pointInRing(cx, cz, SEA_MASK), false, '夢洲コアが SEA_MASK に食い込んでいる');
  assert.ok(ringAreaXZ(DREAM_ISLAND.outer) < 3e6, '夢洲コアが大きすぎる（保守的でない）');
  assert.ok(ringAreaXZ(DREAM_ISLAND.outer) > 5e5, '夢洲コアが小さすぎる');
});

test('[Mission21] auditLandCoverage: fixture で 100% covered / 穴は land に数えない', () => {
  const a = auditLandCoverage({ wards: WARDS_FIXTURE, cellM: 50, seaMask: null, includeDreamIsland: false });
  assert.equal(a.coveragePercent, 100);
  assert.equal(a.missingLandSamples, 0);
  assert.ok(a.byWard.alpha && a.byWard.beta);
  // alpha は 1000x1000 - 200x200 穴 = 0.96 km²
  assert.ok(a.byWard.alpha.samples * 50 * 50 < 1.0e6);
});

test('[Mission21] findLandGapClusters: 陸に囲まれた欠落を unexplained として検出', () => {
  // 中央に穴の空いた 3km 角の区（穴 = N03 欠落を模す）
  const donut = [{ wardId: 'ring', polygons: [{
    outer: [[0, 0], [3000, 0], [3000, 3000], [0, 3000]],
    holes: [[[1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000]]],
  }] }];
  const clusters = findLandGapClusters({ wards: donut, cellM: 100, seaMask: null, includeDreamIsland: false });
  assert.ok(clusters.length >= 1);
  const c = clusters[0];
  assert.ok(c.landNeighborFrac > 0.5, '陸に囲まれた欠落と判定されていない');
  assert.ok(c.unexplained, 'C 原因の内部欠落が unexplained になっていない');
});

test('[Mission21] KEY_PLACES: 人工島・港湾・河口を網羅（>=10 地点）', () => {
  assert.ok(KEY_PLACES.length >= 10);
  for (const id of ['yumeshima', 'maishima', 'sakishima', 'nanko', 'tempozan']) {
    assert.ok(KEY_PLACES.some((k) => k.id === id), `KEY_PLACES に ${id} が無い`);
  }
});

test('[Mission21] auditKeyPlaces: fixture 陸地点は covered', () => {
  const kp = auditKeyPlaces(
    [{ wardId: 'z', polygons: [{ outer: [[-20000, -20000], [20000, -20000], [20000, 20000], [-20000, 20000]] }] }],
    null, DREAM_ISLAND, null,
  );
  assert.ok(kp.every((k) => k.covered), '全域が陸の fixture で covered でない地点がある');
});
