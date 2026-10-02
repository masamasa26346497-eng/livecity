// tests/building-coverage.test.js
// [Mission21B] tools/lib/building-coverage.js / osm-building-fallback.js の純粋ロジック。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  indexWards, wardAt, auditBuildingCoverage, clusterGapCells, rasterizePolylineLength,
} from '../tools/lib/building-coverage.js';
import {
  resolveOsmHeight, ringArea, ringBbox, ringCentroid,
  buildPlateauPresenceGrid, isInPlateauHole, toFallbackRecord,
  LEVEL_HEIGHT_M, UNKNOWN_HEIGHT_M, MAX_FALLBACK_HEIGHT_M,
} from '../tools/lib/osm-building-fallback.js';

const WARDS = [
  { wardId: 'a', polygons: [{ outer: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] }] },
];

test('[Mission21B] wardAt: 区内/区外', () => {
  const iw = indexWards(WARDS);
  assert.equal(wardAt(500, 500, iw), 'a');
  assert.equal(wardAt(1500, 500, iw), null);
});

test('[Mission21B] auditBuildingCoverage: 道路あり建物なしを gap にする / 建物 cell は除外', () => {
  const roads = [{ p: [[100, 100], [900, 100]] }, { p: [[100, 500], [900, 500]] }];
  const buildings = [{ x: 150, z: 100, fp: [[145, 95], [155, 95], [155, 105], [145, 105]], fpArea: 100 }];
  const a = auditBuildingCoverage({ wards: WARDS, cellM: 100, buildings, roads, rails: [], parkRings: [], rivers: [], waterCells: new Set() });
  assert.ok(a.totalLandCells >= 90);
  assert.ok(a.cellsWithBuildings >= 1);
  assert.ok(a.suspectedGapCells >= 1, '道路のみ cell が gap にならない');
  // 建物のある cell は gap でない
  assert.ok(!a.gapCells.some((g) => g.x >= 100 && g.x < 200 && g.z >= 50 && g.z < 150));
});

test('[Mission21B] auditBuildingCoverage: park/water/rail cell は gap から除外', () => {
  const roads = [{ p: [[100, 300], [900, 300]] }];
  const parkRings = [[[50, 250], [950, 250], [950, 350], [50, 350]]];
  const a = auditBuildingCoverage({ wards: WARDS, cellM: 100, buildings: [], roads, rails: [], parkRings, rivers: [], waterCells: new Set() });
  // z=300 の道路 cell は park に覆われているので gap でない
  assert.ok(!a.gapCells.some((g) => g.z >= 250 && g.z < 350), '公園 cell が gap に残っている');
});

test('[Mission21B] clusterGapCells: 連結クラスタ化', () => {
  const gapCells = [];
  for (let cx = 0; cx < 5; cx++) for (let cz = 0; cz < 5; cz++) gapCells.push({ cx, cz, x: cx * 100, z: cz * 100, ward: 'a', roadLen: 50 });
  const cl = clusterGapCells(gapCells, 100, { minCells: 4 });
  assert.equal(cl.length, 1);
  assert.equal(cl[0].cells, 25);
  assert.ok(cl[0].areaKm2 > 0);
});

test('[Mission21B/29] resolveOsmHeight: height → levels → class-default → generic（§10/§11 confidence 付き）', () => {
  const h = resolveOsmHeight({ height: '12', building: 'yes' });
  assert.equal(h.dz, 12); assert.equal(h.heightSource, 'osm-height'); assert.equal(h.heightUnknown, false);
  assert.ok(h.confidence >= 0.9, 'osm-height の confidence が低い');
  const lv = resolveOsmHeight({ 'building:levels': '3', building: 'apartments' });
  assert.equal(lv.dz, 3 * LEVEL_HEIGHT_M);
  assert.equal(lv.heightSource, 'osm-levels');
  assert.ok(lv.confidence >= 0.7 && lv.confidence < 0.9);
  // [Mission29 §10] building タグに応じた class default
  const house = resolveOsmHeight({ building: 'house' });
  assert.equal(house.heightSource, 'class-default');
  assert.ok(house.dz >= 7 && house.dz <= 9, 'house の class default が 7〜9m でない: ' + house.dz);
  assert.equal(house.heightUnknown, true, 'class-default も実測ではないので heightUnknown は true');
  assert.ok(house.confidence >= 0.5 && house.confidence < 0.7);
  const office = resolveOsmHeight({ building: 'office' });
  assert.ok(office.dz >= 10 && office.dz <= 18, 'office の class default');
  // generic building=yes は controlled default
  const un = resolveOsmHeight({ building: 'yes' });
  assert.equal(un.dz, UNKNOWN_HEIGHT_M);
  assert.equal(un.heightSource, 'generic-default');
  assert.equal(un.heightUnknown, true);
  assert.ok(un.confidence < 0.5, 'generic default の confidence が高すぎる');
  // 異常 height は clamp
  assert.equal(resolveOsmHeight({ height: '400', building: 'yes' }).dz, MAX_FALLBACK_HEIGHT_M);
});

test('[Mission21B] ring helpers', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(ringArea(sq), 100);
  assert.deepEqual(ringBbox(sq), { minX: 0, maxX: 10, minZ: 0, maxZ: 10 });
  const c = ringCentroid(sq);
  assert.ok(Math.abs(c[0] - 5) < 1e-6 && Math.abs(c[1] - 5) < 1e-6);
});

test('[Mission21B] isInPlateauHole: 8近傍まで PLATEAU-free のときだけ true（granularity mismatch を弾く）', () => {
  const grid = buildPlateauPresenceGrid([[[0, 0], [40, 0], [40, 40], [0, 40]]], 50); // cell (0,0) 占有
  assert.equal(isInPlateauHole(25, 25, grid, 50), false, '占有 cell が hole 扱い');
  assert.equal(isInPlateauHole(75, 75, grid, 50), false, '占有 cell の隣が hole 扱い（8近傍）');
  assert.equal(isInPlateauHole(500, 500, grid, 50), true, '遠く離れた空き cell が hole でない');
});

test('[Mission21B/29] toFallbackRecord: source metadata / id prefix / heightUnknown / usage / confidence', () => {
  const rec = toFallbackRecord(12345, [[0, 0], [10, 0], [10, 10], [0, 10]], { building: 'yes' });
  assert.equal(rec.id, 'osm_12345');
  assert.equal(rec.source, 'osm-fallback');
  assert.equal(rec.osmId, 'way/12345');
  assert.equal(rec.heightUnknown, true);
  assert.equal(rec.heightSource, 'generic-default');
  assert.equal(typeof rec.confidence, 'number');
  assert.ok(rec.confidence > 0 && rec.confidence <= 1);
  assert.ok(rec.dz > 0 && rec.repX != null);
  const rec2 = toFallbackRecord(1, [[0, 0], [10, 0], [10, 10], [0, 10]], { 'building:levels': '4', building: 'apartments' });
  assert.equal(rec2.heightUnknown, false);
  assert.equal(rec2.dz, 4 * LEVEL_HEIGHT_M);
  assert.equal(rec2.usage, 'apartments'); // [Mission29 §2] building タグ値を保持
  assert.equal(rec2.actualHeight, 4 * LEVEL_HEIGHT_M);
  // [Mission29 §2] roof/construction は toFallbackRecord には来ない（build 側で弾く）が、来ても usage で判別可能
  const cd = toFallbackRecord(2, [[0, 0], [10, 0], [10, 10], [0, 10]], { building: 'warehouse' });
  assert.equal(cd.heightSource, 'class-default');
  assert.equal(cd.usage, 'warehouse');
});

test('[Mission21B] rasterizePolylineLength: cell へ長さ集計', () => {
  const g = rasterizePolylineLength([{ p: [[0, 50], [300, 50]] }], 100, { x: 0, z: 0 });
  let total = 0; for (const v of g.values()) total += v;
  // 粗いサンプリングのため厳密一致でなく「およそ道路長」であることを見る
  assert.ok(total >= 250 && total <= 420, 'total=' + total);
  assert.ok(g.size >= 3, '3 cell 以上に分散していない');
});
