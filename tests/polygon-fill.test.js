// tests/polygon-fill.test.js
// P1-6E: 水域/公園の面フィル triangulation の入力正規化・結果検証（tools/lib/polygon-fill.js）。
//   HTML の CityTileLayer.areaMesh へ inline した pf* ヘルパと同一ロジック。
//   実機で「巨大な水色polygon/帯が画面を横断する」問題の再発防止。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import {
  cleanRingXZ, ensureWindingXZ, signedAreaXZ, pointInRingXZ, prepareFill,
  triangulateFillXZ, validateFillXZ, buildFillPositions,
} from '../tools/lib/polygon-fill.js';

const OFFENDERS = JSON.parse(fs.readFileSync(
  path.join(PROJECT_ROOT, 'tools', 'lib', '__fixtures__', 'water-fill', 'offenders.json'), 'utf-8'));

// 密に分割した凹リバーバンク（コの字）を作る
function densify(pts, seg) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(d / seg));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]);
  }
  return out;
}

test('cleanRingXZ: 終点重複・連続重複・非有限点を除去', () => {
  const r = cleanRingXZ([[0, 0], [0, 0], [10, 0], [10, 0.005], [10, 10], [NaN, 1], [0, 10], [0, 0]]);
  assert.deepEqual(r, [[0, 0], [10, 0], [10, 10], [0, 10]]);
});

test('ensureWindingXZ / signedAreaXZ: outer=ccw, hole=cw に揃う', () => {
  const cw = [[0, 0], [0, 10], [10, 10], [10, 0]];
  assert.ok(signedAreaXZ(cw) < 0);
  assert.ok(signedAreaXZ(ensureWindingXZ(cw, 'ccw')) > 0);
  assert.ok(signedAreaXZ(ensureWindingXZ(cw, 'cw')) < 0);
});

test('prepareFill: outer 外の hole は捨てる / 内側の hole は保持し CW に', () => {
  const outer = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const insideHole = [[40, 40], [60, 40], [60, 60], [40, 60]];
  const outsideHole = [[400, 400], [420, 400], [420, 420], [400, 420]];
  const { outer: o, holes, droppedHoles } = prepareFill(outer, [insideHole, outsideHole]);
  assert.ok(signedAreaXZ(o) > 0);
  assert.equal(holes.length, 1);
  assert.equal(droppedHoles, 1);
  assert.ok(signedAreaXZ(holes[0]) < 0);
});

test('凹リバーバンク（コの字）: 正しく分割され area 比 ≈ 1・拒否されない', () => {
  const outer = densify([[0, 0], [300, 0], [300, 300], [200, 300], [200, 100], [100, 100], [100, 300], [0, 300]], 25);
  const r = buildFillPositions({ id: 'concave', kind: 'area', p: outer }, 0.05);
  assert.equal(r.rejected, false, r.reason);
  assert.ok(Math.abs(r.debug.areaRatio - 1) < 0.02);
  assert.ok(r.positions.length > 0);
});

test('細長い河川（長い直線区間で疎なノード）: 分割は成立し拒否されない', () => {
  // 3km × 40m の帯。片岸だけノードが疎（巨大セグメントはあるが自己交差なし）。
  const outer = [
    [0, 0], [3000, 0],
    [3000, 40], [2000, 40], [1000, 40], [0, 40],
  ];
  const r = buildFillPositions({ id: 'thin', kind: 'area', p: outer }, 0.05);
  assert.equal(r.rejected, false, r.reason);
  assert.ok(Math.abs(r.debug.areaRatio - 1) < 0.02);
});

test('multipolygon + hole: hole 内側に三角形重心が入らない', () => {
  const outer = [[0, 0], [200, 0], [200, 200], [0, 200]];
  const hole = [[80, 80], [120, 80], [120, 120], [80, 120]];
  const { outer: o, holes } = prepareFill(outer, [hole]);
  const { points, faces } = triangulateFillXZ(o, holes);
  const v = validateFillXZ(o, holes, faces, points);
  assert.equal(v.ok, true, v.reason);
  // 手動でも重心 in hole を確認
  for (const fc of faces) {
    const a = points[fc[0]], b = points[fc[1]], c = points[fc[2]];
    const cen = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    assert.equal(pointInRingXZ(cen, hole), false, 'hole 内に三角形重心');
  }
});

test('自己交差（bowtie）は拒否される（巨大面の兆候）', () => {
  const r = buildFillPositions({ id: 'bowtie', kind: 'area', p: [[0, 0], [100, 100], [100, 0], [0, 100]] }, 0);
  assert.equal(r.rejected, true);
  assert.match(r.reason, /area-ratio|centroid-outside|dominant/);
});

test('line フィーチャは絶対に面フィルへ流れない', () => {
  const r = buildFillPositions({ id: 'L', kind: 'line', p: [[0, 0], [10, 0], [20, 5], [30, 20]] }, 0);
  assert.equal(r.rejected, true);
  assert.equal(r.reason, 'not-area');
  assert.equal(r.positions.length, 0);
});

test('退化入力（3頂点未満・全同一点）は拒否', () => {
  assert.equal(buildFillPositions({ id: 'a', kind: 'area', p: [[0, 0], [1, 1]] }, 0).rejected, true);
  assert.equal(buildFillPositions({ id: 'b', kind: 'area', p: [[5, 5], [5, 5], [5, 5], [5, 5]] }, 0).rejected, true);
});

test('regression: 実機の大河川フィーチャ（大和川/神崎川/道頓堀川 等）は拒否されない・area比≈1', () => {
  const areas = OFFENDERS.filter((f) => f.kind === 'area');
  assert.ok(areas.length >= 5);
  for (const f of areas) {
    const r = buildFillPositions(f, 0.05, { tileId: 't' });
    assert.equal(r.rejected, false, `${f.id} (${f.name || ''}) が誤って拒否された: ${r.reason}`);
    assert.ok(Math.abs(r.debug.areaRatio - 1) < 0.05, `${f.id} areaRatio=${r.debug.areaRatio}`);
    assert.ok(r.debug.triangleCount >= 2);
  }
});

test('regression: 実機の水域 line フィーチャは面フィルへ行かない', () => {
  const line = OFFENDERS.find((f) => f.kind === 'line');
  assert.ok(line);
  assert.equal(buildFillPositions(line, 0.05).reason, 'not-area');
});
