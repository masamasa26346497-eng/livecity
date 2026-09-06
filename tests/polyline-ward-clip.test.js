// tests/polyline-ward-clip.test.js
// P1-7B: 折れ線の区ポリゴンクリップ（tools/lib/polyline-ward-clip.js）。
//   「市外道路・鉄道が大量表示される」問題（bbox の keep/drop では市境を跨ぐ長い道路が
//   丸ごと残ってしまう）の根本対処。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipPolylineToWards, isUnclipped } from '../tools/lib/polyline-ward-clip.js';
import { buildWardIndex } from '../tools/lib/feature-ward-overlap.js';

// 1辺200mの正方形ward polygon（原点中心）
const SQUARE = [[-100, -100], [100, -100], [100, 100], [-100, 100]];
const wardIndex = buildWardIndex({ wards: [{ wardId: 'test', wardName: 'テスト区', polygons: [{ outer: SQUARE, holes: [] }] }] });

test('完全に区内: 1本の run のまま（クリップ不要）', () => {
  const line = [[-50, -50], [0, 0], [50, 50]];
  const runs = clipPolylineToWards(line, wardIndex, 10);
  assert.equal(runs.length, 1);
  assert.equal(isUnclipped(line, runs), true);
});

test('完全に区外: run は0本（描画しない）', () => {
  const line = [[500, 500], [600, 600], [700, 500]];
  const runs = clipPolylineToWards(line, wardIndex, 10);
  assert.equal(runs.length, 0);
});

test('市境をまたぐ道路: 大阪市側の断片だけが run として残る', () => {
  // 区内(-50,0)→区外(500,0) へ伸びる道路。境界(x=100)を大きく超えて市外へ伸びる。
  const line = [[-50, 0], [0, 0], [50, 0], [90, 0], [200, 0], [500, 0]];
  const runs = clipPolylineToWards(line, wardIndex, 5);
  assert.equal(runs.length, 1, '大阪市側の断片が1本残るはず');
  const run = runs[0];
  assert.deepEqual(run[0], [-50, 0]);
  // 市外の点(200,0)/(500,0)は含まれない
  assert.ok(!run.some((p) => p[0] >= 150), `市外の点が残っている: ${JSON.stringify(run)}`);
  // 元の全長より短い（実際にクリップされた）
  assert.ok(run.length < line.length);
  assert.equal(isUnclipped(line, runs), false);
});

test('市内→市外→市内: 2本の run に分かれる（間の市外区間は削除）', () => {
  const line = [[-90, 0], [-50, 0], [500, 0], [600, 0], [50, -90], [80, -90]];
  const runs = clipPolylineToWards(line, wardIndex, 5);
  assert.equal(runs.length, 2, JSON.stringify(runs));
  assert.ok(runs[0].every((p) => p[0] < 150));
  assert.ok(runs[1].every((p) => p[0] < 150 && p[1] < 150));
});

test('bufferM: 境界すぐ外側の点は buffer 内なら run に含まれる', () => {
  const line = [[50, 0], [100, 0], [105, 0], [110, 0]]; // 境界(x=100)から5m/10m外側
  const withBuffer = clipPolylineToWards(line, wardIndex, 8);
  assert.ok(withBuffer[0].some((p) => p[0] === 105));
  assert.ok(!withBuffer[0].some((p) => p[0] === 110));
});

test('不正入力は空配列', () => {
  assert.deepEqual(clipPolylineToWards(null, wardIndex), []);
  assert.deepEqual(clipPolylineToWards([[0, 0]], wardIndex), []); // 1点のみ
  assert.deepEqual(clipPolylineToWards([[0, 0], [1, 1]], []), []); // wardIndex 空
});

test('isUnclipped: 1本かつ全点一致のときだけ true', () => {
  const line = [[0, 0], [10, 0], [20, 0]];
  assert.equal(isUnclipped(line, [line]), true);
  assert.equal(isUnclipped(line, [[[0, 0], [10, 0]]]), false); // 一部が欠けている
  assert.equal(isUnclipped(line, [[[0, 0], [10, 0]], [[20, 0], [30, 0]]]), false);
});
