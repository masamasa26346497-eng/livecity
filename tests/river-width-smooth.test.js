// tests/river-width-smooth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderRiverSegments, rejectWidthOutliers } from '../tools/lib/river-width-smooth.js';
import { buildVertexWidths, buildRiverRibbonTapered, offsetCenterline } from '../tools/lib/river-ribbon.js';

test('orderRiverSegments: 端点一致でセグメントを流路順に並べる', () => {
  const segs = [
    { id: 'b', centerline: [[100, 0], [200, 0]], width: 20 },
    { id: 'a', centerline: [[0, 0], [100, 0]], width: 20 },
    { id: 'c', centerline: [[200, 0], [300, 0]], width: 20 },
  ];
  const { chains } = orderRiverSegments(segs, 5);
  assert.equal(chains.length, 1);
  const ids = chains[0].map((c) => segs[c.segIndex].id);
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

test('orderRiverSegments: 逆向きに繋がるセグメントは flip=true になる', () => {
  const segs = [
    { id: 'a', centerline: [[0, 0], [100, 0]], width: 20 },
    { id: 'b', centerline: [[200, 0], [100, 0]], width: 20 }, // 逆向き（末尾が a の末尾に一致）
  ];
  const { chains } = orderRiverSegments(segs, 5);
  assert.equal(chains.length, 1);
  const bEntry = chains[0].find((c) => segs[c.segIndex].id === 'b');
  assert.equal(bEntry.flip, true);
});

test('orderRiverSegments: 孤立セグメントは singletons へ', () => {
  const segs = [
    { id: 'lone', centerline: [[0, 0], [50, 0]], width: 10 },
    { id: 'x', centerline: [[1000, 0], [1100, 0]], width: 10 },
    { id: 'y', centerline: [[1100, 0], [1200, 0]], width: 10 },
  ];
  const { chains, singletons } = orderRiverSegments(segs, 5);
  assert.deepEqual(singletons.map((i) => segs[i].id), ['lone']);
  assert.equal(chains.length, 1);
});

test('rejectWidthOutliers: 単発スパイク（両隣一致で自分だけ跳ねる）を近傍中央値へ寄せる', () => {
  // 神崎川の 123 → 43 → 91 パターン相当（43が下振れスパイク）
  const w = [220, 123, 43, 91, 95];
  const out = rejectWidthOutliers(w);
  assert.ok(out[2] > 60 && out[2] < 120, `spike補正後=${out[2]}`);
});

test('rejectWidthOutliers: 河口へ向かう緩やかな単調拡幅は保つ（指示書6節）', () => {
  // 大和川の上流→河口: 各ステップが spikeRatio(1.8) 未満なので保持されるべき
  const w = [90, 100, 110, 138, 170];
  const out = rejectWidthOutliers(w);
  assert.deepEqual(out.map((x) => Math.round(x)), [90, 100, 110, 138, 170]);
});

test('buildVertexWidths: profile 両端の幅を弧長で線形補間し、rate clampで急変を均す', () => {
  const dense = [[0, 0], [50, 0], [100, 0], [150, 0], [200, 0]];
  // profile: t=0で20m, t=1で200m を、maxDeltaPer100m=40 で clamp（200m区間で最大80m差まで）
  const widths = buildVertexWidths(dense, [{ t: 0, w: 20 }, { t: 1, w: 200 }], { maxDeltaPer100m: 40 });
  assert.equal(widths.length, 5);
  assert.ok(widths[0] >= 20 - 1e-6, `start=${widths[0]}`);
  // 隣接頂点間（50m）の幅差が 40/100*50 = 20m を超えない
  for (let i = 1; i < widths.length; i++) {
    assert.ok(Math.abs(widths[i] - widths[i - 1]) <= 20 + 1e-6, `i=${i} delta=${Math.abs(widths[i] - widths[i - 1])}`);
  }
});

test('buildVertexWidths: 単一点profileは一定幅', () => {
  const dense = [[0, 0], [100, 0], [200, 0]];
  const widths = buildVertexWidths(dense, [{ t: 0.5, w: 42 }], {});
  assert.deepEqual(widths, [42, 42, 42]);
});

test('offsetCenterline: width配列を渡すと頂点ごとに異なる半幅でoffsetする', () => {
  const cl = [[0, 0], [100, 0], [200, 0]];
  const { left, right } = offsetCenterline(cl, [10, 40, 80]);
  assert.ok(Math.abs(Math.hypot(left[0][0] - right[0][0], left[0][1] - right[0][1]) - 10) < 1e-6);
  assert.ok(Math.abs(Math.hypot(left[2][0] - right[2][0], left[2][1] - right[2][1]) - 80) < 1e-6);
});

test('buildRiverRibbonTapered: 幅が滑らかに変化し、巨大三角形・NaNなし', () => {
  const cl = [[0, 0], [500, 30], [1000, 0], [1500, -20], [2000, 0]];
  const r = buildRiverRibbonTapered(cl, [{ t: 0, w: 60 }, { t: 1, w: 200 }], { maxSeg: 40, maxDeltaPer100m: 40 });
  assert.equal(r.ok, true);
  assert.equal(r.widths.length, r.centerline.length);
  assert.ok(r.maxTriangleArea < 30000 && r.maxTriangleEdge < 2000);
  assert.ok(r.maxWidthDeltaPer100m <= 40 + 1e-6, `maxWidthDeltaPer100m=${r.maxWidthDeltaPer100m}`);
  for (const w of r.widths) assert.ok(Number.isFinite(w) && w > 0);
});
