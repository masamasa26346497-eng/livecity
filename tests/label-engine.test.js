// tests/label-engine.test.js
// [見た目改善 Mission15] tools/lib/label-engine.js の純粋ロジック。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LABEL_TYPES, LABEL_PRIORITY, labelPriority, labelMinBand, LABEL_BANDS, labelBand, labelVisibleAtBand,
  LABEL_DENSITY_CAP, LABEL_GRID, LABEL_STYLES, labelStyleKey, makeLabel,
  polygonCentroidXZ, multiRingCentroidXZ, centerlineAnchor, resolveLabelCollisions,
} from '../tools/lib/label-engine.js';

test('LABEL_TYPES / priority 体系: ward > station > river/place/facility > park', () => {
  assert.deepEqual(LABEL_TYPES, ['ward', 'station', 'river', 'place', 'park', 'public_facility']);
  assert.ok(labelPriority('ward', 'major') > labelPriority('station', 'major'));
  assert.ok(labelPriority('station', 'major') > labelPriority('river', 'major'));
  assert.ok(labelPriority('river', 'major') > labelPriority('park', 'major'));
  assert.ok(labelPriority('station', 'major') > labelPriority('station', 'medium'));
  assert.equal(labelPriority('ward', 'major'), 1000);
});

test('labelMinBand: major=far（park は mid）/ medium=mid / local=near', () => {
  assert.equal(labelMinBand('ward', 'major'), 'far');
  assert.equal(labelMinBand('station', 'major'), 'far');
  assert.equal(labelMinBand('river', 'major'), 'far');
  assert.equal(labelMinBand('park', 'major'), 'mid'); // 大規模公園でも名称は mid から
  assert.equal(labelMinBand('station', 'medium'), 'mid');
  assert.equal(labelMinBand('park', 'local'), 'near');
});

test('labelBand / labelVisibleAtBand: 9000/3500、near は全部・far は far ラベルのみ', () => {
  assert.deepEqual(LABEL_BANDS, { farM: 9000, midM: 3500 });
  assert.equal(labelBand(12000), 'far');
  assert.equal(labelBand(9000), 'mid');
  assert.equal(labelBand(3500), 'near');
  // far カメラ: far ラベルのみ
  assert.equal(labelVisibleAtBand('far', 12000), true);
  assert.equal(labelVisibleAtBand('mid', 12000), false);
  assert.equal(labelVisibleAtBand('near', 12000), false);
  // near カメラ: 全部
  assert.equal(labelVisibleAtBand('far', 1000), true);
  assert.equal(labelVisibleAtBand('near', 1000), true);
});

test('density cap / grid: band 別上限と viewport grid', () => {
  assert.ok(LABEL_DENSITY_CAP.far < LABEL_DENSITY_CAP.mid && LABEL_DENSITY_CAP.mid < LABEL_DENSITY_CAP.near);
  assert.ok(LABEL_DENSITY_CAP.far >= 25 && LABEL_DENSITY_CAP.far <= 40);
  assert.ok(LABEL_DENSITY_CAP.near >= 80 && LABEL_DENSITY_CAP.near <= 140);
  assert.equal(LABEL_GRID.cols * LABEL_GRID.rows, 48);
  assert.ok(LABEL_GRID.perCell >= 3 && LABEL_GRID.perCell <= 5);
});

test('LABEL_STYLES: 全 styleKey が定義、派手色・黒ベタでない', () => {
  for (const t of ['ward', 'place', 'station_major', 'station_medium', 'station_local', 'river', 'park', 'public_facility']) {
    assert.ok(LABEL_STYLES[t], `${t} style が無い`);
    assert.ok(!/#000000|black/i.test(LABEL_STYLES[t].text), `${t} が黒ベタ`);
  }
  assert.equal(labelStyleKey('station', 'major'), 'station_major');
  assert.equal(labelStyleKey('ward', 'major'), 'ward');
});

test('makeLabel: 欠損を補完（priority / minBand / styleKey）', () => {
  const l = makeLabel({ id: 'x', type: 'river', name: '淀川', x: 1, z: 2, importance: 'major' });
  assert.equal(l.priority, labelPriority('river', 'major'));
  assert.equal(l.minBand, 'far');
  assert.equal(l.styleKey, 'river');
  assert.equal(l.pinned, false);
  // 不正 type → place
  assert.equal(makeLabel({ id: 'y', type: 'bogus', name: 'a', x: 0, z: 0 }).type, 'place');
});

test('polygonCentroidXZ / multiRingCentroidXZ: 面積加重セントロイド', () => {
  const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const c = polygonCentroidXZ(sq);
  assert.ok(Math.abs(c.x - 50) < 1e-6 && Math.abs(c.z - 50) < 1e-6);
  assert.equal(c.area, 10000);
  // 大きいリングが重心を引っ張る
  const m = multiRingCentroidXZ([sq, [[1000, 1000], [1010, 1000], [1010, 1010], [1000, 1010]]]);
  assert.ok(m.x < 100, '小リングに引っ張られすぎ');
});

test('centerlineAnchor: 弧長 t の点', () => {
  const cl = [[0, 0], [100, 0], [100, 100]]; // 総長 200
  const mid = centerlineAnchor(cl, 0.5); // 弧長 100 → (100,0)
  assert.ok(Math.abs(mid.x - 100) < 1e-6 && Math.abs(mid.z - 0) < 1e-6);
  assert.deepEqual(centerlineAnchor(cl, 0), { x: 0, z: 0 });
});

test('resolveLabelCollisions: priority 高い順に配置、重なりは低優先を hide、cap で打ち切り', () => {
  const mk = (id, prio, sx, sy, pinned) => ({ id, priority: prio, minBand: 'near', sx, sy, hw: 0.1, hh: 0.05, distToCenter: 0, pinned });
  const cands = [
    mk('a', 900, 0, 0),        // 高優先、中央
    mk('b', 500, 0.05, 0.02),  // a と重なる、低優先 → hide
    mk('c', 700, 0.5, 0.5),    // 離れている → 表示
    mk('p', 100, 0, 0, true),  // pinned（重なっても表示）
  ];
  const { visibleIds, stats } = resolveLabelCollisions(cands, { distance: 1000 });
  assert.ok(visibleIds.has('a'));
  assert.ok(!visibleIds.has('b'), 'b が collision で消えていない');
  assert.ok(visibleIds.has('c'));
  assert.ok(visibleIds.has('p'), 'pinned が消えた');
  assert.ok(stats.hiddenByCollision >= 1);
});

test('resolveLabelCollisions: LOD で far ラベルのみ、viewport 外は除外', () => {
  const cands = [
    { id: 'far1', priority: 900, minBand: 'far', sx: 0, sy: 0, hw: 0.05, hh: 0.03, distToCenter: 0 },
    { id: 'near1', priority: 800, minBand: 'near', sx: 0.3, sy: 0.3, hw: 0.05, hh: 0.03, distToCenter: 0 },
    { id: 'off', priority: 950, minBand: 'far', sx: 5, sy: 0, hw: 0.05, hh: 0.03, distToCenter: 0 },
  ];
  const { visibleIds, stats } = resolveLabelCollisions(cands, { distance: 15000 });
  assert.ok(visibleIds.has('far1'));
  assert.ok(!visibleIds.has('near1'), 'near ラベルが far で出た');
  assert.ok(!visibleIds.has('off'), 'viewport 外が出た');
  assert.equal(stats.hiddenByLOD, 1);
  assert.equal(stats.hiddenByViewport, 1);
});

test('resolveLabelCollisions: density cap で打ち切り', () => {
  const cands = [];
  for (let i = 0; i < 200; i++) cands.push({ id: 'l' + i, priority: 500 + i, minBand: 'far', sx: (i % 20) * 0.09 - 0.9, sy: Math.floor(i / 20) * 0.15 - 0.7, hw: 0.001, hh: 0.001, distToCenter: 0 });
  const { visibleIds, stats } = resolveLabelCollisions(cands, { distance: 15000, densityCap: { far: 20 } });
  assert.ok(visibleIds.size <= 20, `cap 超過: ${visibleIds.size}`);
  assert.ok(stats.hiddenByDensityCap > 0 || stats.hiddenByGrid > 0);
});
