// tests/building-visual-gap.test.js
// [Mission21C] sparse-mismatch 検出 / polygon-level duplicate 防止 / renderHeight 分離の純粋ロジック。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFootprintDensityGrid, isSparseMismatch, buildPlateauDedupIndex, isDuplicateOfPlateau,
  pointInRingXZ, toFallbackRecord, resolveOsmHeight,
  SPARSE_AREA_RATIO, SPARSE_MIN_OSM_COUNT, RENDER_UNKNOWN_HEIGHT_M,
} from '../tools/lib/osm-building-fallback.js';

const sq = (cx, cz, s) => [[cx, cz], [cx + s, cz], [cx + s, cz + s], [cx, cz + s]];

test('[Mission21C] buildFootprintDensityGrid: cell へ count/area 集計', () => {
  const g = buildFootprintDensityGrid([sq(10, 10, 10), sq(30, 30, 10), sq(120, 10, 10)], 100);
  assert.equal(g.get('0,0').count, 2);
  assert.equal(g.get('0,0').area, 200);
  assert.equal(g.get('1,0').count, 1);
});

test('[Mission21C] isSparseMismatch: OSM 面積 >> PLATEAU かつ OSM 棟数 >= 閾値', () => {
  // PLATEAU 1棟 200m² / OSM 8棟 2000m² → ratio 10 >= 2.5, count 8 >= 5 → true
  assert.equal(isSparseMismatch({ count: 1, area: 200 }, { count: 8, area: 2000 }), true);
  // OSM 棟数不足
  assert.equal(isSparseMismatch({ count: 1, area: 200 }, { count: 3, area: 5000 }), false);
  // 面積比不足
  assert.equal(isSparseMismatch({ count: 5, area: 3000 }, { count: 8, area: 4000 }), false);
  // PLATEAU 0（完全 hole）でも OSM が多ければ true
  assert.equal(isSparseMismatch(undefined, { count: 10, area: 3000 }), true);
});

test('[Mission21C] isDuplicateOfPlateau: centroid-in-polygon / bbox IoU（近接距離では判定しない）', () => {
  const plateau = [sq(0, 0, 20)]; // 0..20
  const idx = buildPlateauDedupIndex(plateau, 40);
  // OSM footprint が PLATEAU 内 → duplicate
  assert.equal(isDuplicateOfPlateau(sq(5, 5, 8), idx, 0.30), true);
  // OSM footprint が大きく重なる（IoU 高） → duplicate
  assert.equal(isDuplicateOfPlateau(sq(2, 2, 18), idx, 0.30), true);
  // OSM footprint が 15m 離れているだけ（重なりなし） → duplicate でない（近接では判定しない）
  assert.equal(isDuplicateOfPlateau(sq(35, 35, 8), idx, 0.30), false);
});

test('[Mission21C] pointInRingXZ', () => {
  assert.equal(pointInRingXZ(5, 5, sq(0, 0, 10)), true);
  assert.equal(pointInRingXZ(15, 5, sq(0, 0, 10)), false);
});

test('[Mission21C] toFallbackRecord: renderHeight / actualHeight 分離（§6）+ fallbackReason', () => {
  const un = toFallbackRecord(1, sq(0, 0, 10), {}, 'sparse-mismatch');
  assert.equal(un.heightUnknown, true);
  assert.equal(un.dz, RENDER_UNKNOWN_HEIGHT_M, 'renderHeight（dz）が RENDER_UNKNOWN_HEIGHT_M でない');
  assert.equal(un.renderHeight, RENDER_UNKNOWN_HEIGHT_M);
  assert.equal(un.actualHeight, null, '実高不明なのに actualHeight が入っている');
  assert.equal(un.fallbackReason, 'sparse-mismatch');

  const kn = toFallbackRecord(2, sq(0, 0, 10), { height: '15' }, 'hole');
  assert.equal(kn.heightUnknown, false);
  assert.equal(kn.dz, 15);
  assert.equal(kn.actualHeight, 15);
  assert.equal(kn.fallbackReason, 'hole');
});

test('[Mission21C] resolveOsmHeight は Mission21B 方針を維持', () => {
  assert.equal(resolveOsmHeight({ 'building:levels': '5' }).heightSource, 'osm-levels');
  assert.equal(resolveOsmHeight({}).heightUnknown, true);
});

test('[Mission21C] 閾値定数の健全性', () => {
  assert.ok(SPARSE_AREA_RATIO >= 2 && SPARSE_AREA_RATIO <= 4);
  assert.ok(SPARSE_MIN_OSM_COUNT >= 3);
  assert.ok(RENDER_UNKNOWN_HEIGHT_M > 0 && RENDER_UNKNOWN_HEIGHT_M <= 10);
});
