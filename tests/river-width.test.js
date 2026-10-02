// tests/river-width.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  raySegmentHit, nearestRingHitDistance, measureCenterlineWidth, resolveRiverWidth,
  clampWidth, RIVER_WIDTH_LIMITS, bboxOfPoints, bboxOverlaps,
} from '../tools/lib/river-width.js';

test('raySegmentHit: 単純な交差', () => {
  // origin(0,0) から +x 方向、segment (5,-5)-(5,5) と x=5 で交差
  const t = raySegmentHit(0, 0, 1, 0, 5, -5, 5, 5);
  assert.ok(Math.abs(t - 5) < 1e-9);
});

test('raySegmentHit: 平行・非交差は null', () => {
  assert.equal(raySegmentHit(0, 0, 1, 0, 5, 1, 10, 1), null); // 平行
  assert.equal(raySegmentHit(0, 0, 1, 0, -5, -5, -5, 5), null); // 後方
});

test('nearestRingHitDistance: 矩形リングの中心から真横までの距離', () => {
  const ring = [[-10, -5], [10, -5], [10, 5], [-10, 5]]; // 幅20 x 高10
  const d = nearestRingHitDistance([0, 0], [1, 0], ring);
  assert.ok(Math.abs(d - 10) < 1e-6);
});

test('measureCenterlineWidth: 一定幅の矩形riverbankを直線centerlineで実測 → 中央値が幅と一致', () => {
  // 幅40mの矩形riverbank(x: -1000..1000, z: -20..20)、centerlineはz=0上の直線
  const bank = { p: [[-1000, -20], [1000, -20], [1000, 20], [-1000, 20]] };
  const centerline = [[-800, 0], [-400, 0], [0, 0], [400, 0], [800, 0]];
  const res = measureCenterlineWidth(centerline, [bank], { sampleCount: 7 });
  assert.equal(res.method, 'measured');
  assert.ok(Math.abs(res.width - 40) < 1, `width=${res.width}`);
});

test('measureCenterlineWidth: riverbankが無ければ insufficient', () => {
  const res = measureCenterlineWidth([[0, 0], [10, 0]], []);
  assert.equal(res.method, 'insufficient');
  assert.equal(res.width, null);
});

test('clampWidth: 上限/下限でclampする', () => {
  assert.equal(clampWidth(1), RIVER_WIDTH_LIMITS.min);
  assert.equal(clampWidth(99999), RIVER_WIDTH_LIMITS.max);
  assert.equal(clampWidth(50), 50);
  assert.equal(clampWidth(NaN), null);
});

test('bboxOverlaps: bufferM を考慮した矩形重なり判定', () => {
  const a = bboxOfPoints([[0, 0], [10, 10]]);
  const b = bboxOfPoints([[20, 0], [30, 10]]);
  assert.equal(bboxOverlaps(a, b, 5), false);
  assert.equal(bboxOverlaps(a, b, 15), true);
});

test('resolveRiverWidth: widthタグがあれば最優先', () => {
  const res = resolveRiverWidth({ p: [[0, 0], [10, 0]], name: 'test' }, [], { widthTag: 55 });
  assert.equal(res.method, 'tag');
  assert.equal(res.width, 55);
});

test('resolveRiverWidth: riverbank一致で実測、無ければdefaultへfallback', () => {
  const bank = { p: [[-1000, -15], [1000, -15], [1000, 15], [-1000, 15]], name: '実測川', waterClass: 'river' };
  const line = { p: [[-800, 0], [-400, 0], [0, 0], [400, 0], [800, 0]], name: '実測川', waterClass: 'river' };
  const measured = resolveRiverWidth(line, [bank]);
  assert.equal(measured.method, 'measured');
  assert.ok(Math.abs(measured.width - 30) < 1);

  const noMatch = resolveRiverWidth({ p: [[0, 0], [10, 0]], name: '無名川', waterClass: 'canal' }, [bank]);
  assert.equal(noMatch.method, 'default');
  assert.ok(noMatch.width > 0);
});

test('measureCenterlineWidth: 合流部で無関係な広いpolygonが近くにあっても左右を混ぜない（実データ寝屋川で発生したwidth=500暴走の回帰）', () => {
  // 本流(幅30m)のすぐ隣に、centerlineを内包しない広いpolygon(幅300m)がbuffer内に存在するケース。
  // 旧実装は「左右で最も近いhitを別polygonからでも採用」していたため、右側だけ隣の広いpolygonの
  // 遠い辺を拾って width が異常に大きくなっていた。
  const mainBank = { p: [[-1000, -15], [1000, -15], [1000, 15], [-1000, 15]], name: '本流' }; // 幅30
  const wideNeighbor = { p: [[-1000, 20], [1000, 20], [1000, 320], [-1000, 320]], name: '本流' }; // 幅300・本流のさらに外側に隣接
  const centerline = [[-800, 0], [-400, 0], [0, 0], [400, 0], [800, 0]];
  const res = measureCenterlineWidth(centerline, [mainBank, wideNeighbor], { sampleCount: 9 });
  assert.equal(res.method, 'measured');
  assert.ok(Math.abs(res.width - 30) < 2, `width=${res.width}（本流の30m前後であるべき。隣接polygonを誤って合算していないか）`);
});

test('resolveRiverWidth: 主要河川名はriverbank無しでも既定の大きめ幅を使う', () => {
  const res = resolveRiverWidth({ p: [[0, 0], [10, 0]], name: '淀川', waterClass: 'river' }, []);
  assert.equal(res.method, 'default');
  assert.ok(res.width >= 200, `淀川default width=${res.width}`);
});
