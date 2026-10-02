// tests/road-ribbon.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRoadWidth, clampRoadWidth, computeRoadWidth, buildRoadRibbon, validateRoadRibbon,
  DEFAULT_ROAD_WIDTH_M, ROAD_WIDTH_LIMITS, LANE_WIDTH_M,
} from '../tools/lib/road-ribbon.js';

test('classifyRoadWidth: highway別の既定幅（motorway > trunk > primary > secondary > tertiary > residential）', () => {
  assert.ok(classifyRoadWidth('motorway') > classifyRoadWidth('trunk'));
  assert.ok(classifyRoadWidth('trunk') > classifyRoadWidth('primary'));
  assert.ok(classifyRoadWidth('primary') > classifyRoadWidth('secondary'));
  assert.ok(classifyRoadWidth('secondary') > classifyRoadWidth('tertiary'));
  assert.ok(classifyRoadWidth('tertiary') > classifyRoadWidth('residential'));
  // 指示書3節のレンジ内
  assert.ok(classifyRoadWidth('motorway') >= 14 && classifyRoadWidth('motorway') <= 20);
  assert.ok(classifyRoadWidth('residential') >= 4 && classifyRoadWidth('residential') <= 7);
  // 不明タグは residential 相当へフォールバック
  assert.equal(classifyRoadWidth('mystery'), DEFAULT_ROAD_WIDTH_M.residential);
});

test('clampRoadWidth: 上限/下限でclamp、不正値はnull', () => {
  assert.equal(clampRoadWidth(1), ROAD_WIDTH_LIMITS.min);
  assert.equal(clampRoadWidth(999), ROAD_WIDTH_LIMITS.max);
  assert.equal(clampRoadWidth(10), 10);
  assert.equal(clampRoadWidth(0), null);
  assert.equal(clampRoadWidth(-3), null);
  assert.equal(clampRoadWidth(NaN), null);
});

test('computeRoadWidth: 優先順位 1.widthタグ 2.lanes×laneWidth 3.class default', () => {
  assert.deepEqual(computeRoadWidth({ highway: 'residential', width: '12' }), { width: 12, method: 'width-tag' });
  assert.deepEqual(computeRoadWidth({ highway: 'residential', lanes: 4 }), { width: clampRoadWidth(4 * LANE_WIDTH_M), method: 'lanes' });
  assert.deepEqual(computeRoadWidth({ highway: 'primary' }), { width: classifyRoadWidth('primary'), method: 'class-default' });
  // width が lanes より優先
  assert.equal(computeRoadWidth({ highway: 'residential', width: 20, lanes: 2 }).method, 'width-tag');
});

test('buildRoadRibbon: 直線centerlineは一定幅のribbon、bboxがcenterline周辺', () => {
  const r = buildRoadRibbon([[0, 0], [200, 0], [400, 0]], 12, {});
  assert.equal(r.ok, true);
  for (let i = 0; i < r.left.length; i++) {
    const w = Math.hypot(r.left[i][0] - r.right[i][0], r.left[i][1] - r.right[i][1]);
    assert.ok(Math.abs(w - 12) < 1e-6, `i=${i} width=${w}`);
  }
  assert.ok(r.bbox.minX >= -20 && r.bbox.maxX <= 420);
});

test('buildRoadRibbon: 急カーブ（90度ターン）で巨大三角形を作らない（miter clamp）', () => {
  const r = buildRoadRibbon([[0, 0], [300, 0], [300, 300]], 14, { maxSeg: 40, maxMiterRatio: 2.75 });
  assert.equal(r.ok, true);
  assert.ok(r.maxTriangleEdge < 200, `maxTriangleEdge=${r.maxTriangleEdge}`);
  assert.ok(r.maxTriangleArea < 30000, `maxTriangleArea=${r.maxTriangleArea}`);
});

test('buildRoadRibbon: 長い直線でもdensifyで三角形が細分され、巨大三角形にならない', () => {
  const r = buildRoadRibbon([[0, 0], [4000, 0]], 12, { maxSeg: 40 });
  // densifyPolylineXZ は1辺あたり最大64分割のため 4000m → 64区間（約62.5m/区間）
  assert.ok(r.triangleCount >= 100, `triangleCount=${r.triangleCount}`);
  assert.ok(r.maxTriangleEdge < 70, `maxTriangleEdge=${r.maxTriangleEdge}`);
  assert.ok(r.maxTriangleArea < 1000, `maxTriangleArea=${r.maxTriangleArea}`);
});

test('validateRoadRibbon: 正常な道路ribbonはERROR 0', () => {
  const r = buildRoadRibbon([[0, 0], [200, 30], [400, 0], [600, -20]], 12, {});
  const v = validateRoadRibbon({ id: 'r1', highway: 'primary', width: 12, ...r });
  assert.deepEqual(v.errors, []);
});

test('validateRoadRibbon: 道路の幅上限(28m)超はERROR、負の幅もERROR', () => {
  const r = buildRoadRibbon([[0, 0], [200, 0]], 12, {});
  assert.ok(validateRoadRibbon({ id: 'x', width: 40, ...r }).errors.some((e) => e.includes('上限超過')));
  assert.ok(validateRoadRibbon({ id: 'x', width: -1, ...r }).errors.some((e) => e.includes('width が不正')));
});
