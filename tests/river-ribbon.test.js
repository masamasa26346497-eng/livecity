// tests/river-ribbon.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanPolylineXZ, densifyPolylineXZ, offsetCenterline, triangulateRibbon, buildRiverRibbon,
} from '../tools/lib/river-ribbon.js';

test('cleanPolylineXZ: 連続重複点・非有限点を除去', () => {
  const out = cleanPolylineXZ([[0, 0], [0, 0.001], [10, 0], [10, 0], [NaN, 1], [20, 0]]);
  assert.deepEqual(out, [[0, 0], [10, 0], [20, 0]]);
});

test('densifyPolylineXZ: 長辺に中間点を挿入するが端点位置は不変', () => {
  const out = densifyPolylineXZ([[0, 0], [300, 0]], 100);
  assert.equal(out[0][0], 0);
  assert.equal(out[out.length - 1][0], 300);
  assert.ok(out.length >= 4, `densify後の点数=${out.length}`);
  for (let i = 0; i < out.length - 1; i++) {
    const d = Math.hypot(out[i + 1][0] - out[i][0], out[i + 1][1] - out[i][1]);
    assert.ok(d <= 100 + 1e-6, `segment長=${d}`);
  }
});

test('offsetCenterline: 直線centerlineの直角offsetは一定幅', () => {
  const line = [[0, 0], [100, 0], [200, 0], [300, 0]];
  const { left, right } = offsetCenterline(line, 40);
  for (let i = 0; i < line.length; i++) {
    const w = Math.hypot(left[i][0] - right[i][0], left[i][1] - right[i][1]);
    assert.ok(Math.abs(w - 40) < 1e-6, `i=${i} width=${w}`);
  }
});

test('offsetCenterline: 直角ターンでもmiter長がclampされ暴走しない（maxMiterRatio内）', () => {
  // 90度ターン
  const line = [[0, 0], [100, 0], [100, 100]];
  const { left, right } = offsetCenterline(line, 20, { maxMiterRatio: 2.5 });
  const half = 10;
  // 角の頂点(i=1)でのoffset長が half*maxMiterRatio を超えない
  const cornerLeftLen = Math.hypot(left[1][0] - line[1][0], left[1][1] - line[1][1]);
  const cornerRightLen = Math.hypot(right[1][0] - line[1][0], right[1][1] - line[1][1]);
  assert.ok(cornerLeftLen <= half * 2.5 + 1e-6, `left corner len=${cornerLeftLen}`);
  assert.ok(cornerRightLen <= half * 2.5 + 1e-6, `right corner len=${cornerRightLen}`);
});

test('offsetCenterline: 180度折返し（U字）でもNaN/Infinityにならない', () => {
  const line = [[0, 0], [100, 0], [0, 0.0001]]; // ほぼ真後ろへ折返す鋭角
  const { left, right } = offsetCenterline(line, 20, { maxMiterRatio: 3 });
  for (const arr of [left, right]) {
    for (const p of arr) {
      assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]), `非有限値: ${p}`);
    }
  }
});

test('triangulateRibbon: quad数 = (n-1)*2 三角形、面積が有限', () => {
  const line = [[0, 0], [100, 0], [200, 0]];
  const { left, right } = offsetCenterline(line, 30);
  const { triangleCount, maxTriangleArea } = triangulateRibbon(left, right);
  assert.equal(triangleCount, (line.length - 1) * 2);
  assert.ok(Number.isFinite(maxTriangleArea) && maxTriangleArea > 0);
});

test('buildRiverRibbon: 巨大三角形が出ない（densifyにより長い直線でも三角形面積が抑えられる）', () => {
  // 5km の直線河川、幅50m。densifyしないと1本の巨大三角形(面積≈125,000m²)になりうる。
  const centerline = [[0, 0], [5000, 0]];
  const result = buildRiverRibbon(centerline, 50, { maxSeg: 60 });
  assert.equal(result.ok, true);
  // densify後は 60m 区間ごとの三角形になるはずなので、面積は 60*50/2=1500 程度に収まる
  assert.ok(result.maxTriangleArea < 2000, `maxTriangleArea=${result.maxTriangleArea}`);
  assert.ok(result.triangleCount > 100, `triangleCount=${result.triangleCount}`);
});

test('buildRiverRibbon: 点が2未満・幅が不正なら ok:false', () => {
  assert.equal(buildRiverRibbon([[0, 0]], 30).ok, false);
  assert.equal(buildRiverRibbon([[0, 0], [10, 0]], 0).ok, false);
  assert.equal(buildRiverRibbon([[0, 0], [10, 0]], -5).ok, false);
});

test('buildRiverRibbon: maxTriangleEdge / centerlineLength / rawMaxSegment を報告する', () => {
  const centerline = [[0, 0], [1000, 0], [2000, 0]];
  const result = buildRiverRibbon(centerline, 50, { maxSeg: 60 });
  assert.ok(Number.isFinite(result.maxTriangleEdge) && result.maxTriangleEdge > 0, `maxTriangleEdge=${result.maxTriangleEdge}`);
  assert.ok(Math.abs(result.centerlineLength - 2000) < 1e-6, `centerlineLength=${result.centerlineLength}`);
  assert.ok(Math.abs(result.rawMaxSegment - 1000) < 1e-6, `rawMaxSegment=${result.rawMaxSegment}`);
});

test('buildRiverRibbon: rawMaxSegmentはdensify前の元データジャンプを検出する（数km級の横飛び検出用）', () => {
  const centerline = [[0, 0], [5000, 0]]; // 5kmジャンプ（source継ぎ目相当）
  const result = buildRiverRibbon(centerline, 50, { maxSeg: 9999 }); // densifyさせない
  assert.ok(Math.abs(result.rawMaxSegment - 5000) < 1e-6, `rawMaxSegment=${result.rawMaxSegment}`);
});

test('buildRiverRibbon: bboxがcenterline周辺（幅の半分程度の余裕内）に収まる', () => {
  const centerline = [[0, 0], [1000, 0], [1000, 1000]];
  const result = buildRiverRibbon(centerline, 40, { maxMiterRatio: 2.5 });
  assert.ok(result.bbox.minX >= -100 && result.bbox.maxX <= 1100, `bbox=${JSON.stringify(result.bbox)}`);
  assert.ok(result.bbox.minZ >= -100 && result.bbox.maxZ <= 1100, `bbox=${JSON.stringify(result.bbox)}`);
});
