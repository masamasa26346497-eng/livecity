// tools/lib/polyline-ward-clip.js
// P1-7B: 折れ線（道路・鉄道・河川中心線）を「大阪市24区ポリゴンの内側 or 境界近傍」の
//   連続区間（run）だけへ分割する。市外の部分は削除し、市境をまたぐ道路・鉄道は
//   大阪市側の断片だけが自然に残るようにする（bbox の keep/drop ではなく実クリップ）。
//
// 面（水域・公園）は既存の feature-ward-overlap.js の overlap 判定（bufferM 500m・
// fraction ベース）を維持する。ここは line 専用。

import { pointNearWards } from './feature-ward-overlap.js';

/**
 * @param {number[][]} points znorth-neg-v1 [x,z] の折れ線（2点以上）
 * @param {object[]} wardIndex buildWardIndex() の結果
 * @param {number} [bufferM=150] 区境界からの許容距離(m)。小さいほど境界で正確に切れる。
 * @returns {number[][][]} 「内側」連続区間（run）の配列。各 run は2点以上。全て市外なら []。
 */
export function clipPolylineToWards(points, wardIndex, bufferM = 150) {
  if (!Array.isArray(points) || points.length < 2 || !Array.isArray(wardIndex) || !wardIndex.length) return [];
  const inside = points.map((p) => (
    Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
      ? !!pointNearWards(p[0], p[1], wardIndex, bufferM)
      : false
  ));
  const runs = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    if (inside[i]) {
      cur.push(points[i]);
    } else if (cur.length >= 2) {
      runs.push(cur);
      cur = [];
    } else {
      cur = [];
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/**
 * 元 feature 全体が変更なしで1本の run に収まるか（= クリップ不要）。
 * @param {number[][]} points
 * @param {number[][][]} runs clipPolylineToWards() の結果
 */
export function isUnclipped(points, runs) {
  return runs.length === 1 && runs[0].length === points.length;
}
