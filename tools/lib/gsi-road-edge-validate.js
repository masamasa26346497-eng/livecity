// tools/lib/gsi-road-edge-validate.js
// [Mission 31G-FIX15 §9] normalized GSI 道路縁 line の geometry validation。
//   invalid coordinates / zero length / duplicate line / self-intersection / extreme outlier を検出する。
//   ★ ここでの「修正」は一切行わない（invalid を除外・フラグするのみ。座標を書き換えない §8）。

const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

export function lineLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  return len;
}

export function hasInvalidCoordinate(coords) {
  return coords.some(([x, z]) => !Number.isFinite(x) || !Number.isFinite(z));
}

// 大阪市を大きく超える範囲（world 原点から ±60km。24区は ±20km 程度に収まるため余裕を持たせた外れ値判定）。
const OUTLIER_RADIUS_M = 60000;
export function isExtremeOutlier(coords) {
  return coords.some(([x, z]) => Math.hypot(x, z) > OUTLIER_RADIUS_M);
}

function segIntersect(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
}
/** 非隣接セグメント同士が交差していれば self-intersecting とみなす（O(n^2)・短い line 前提）。 */
export function isSelfIntersecting(coords) {
  const n = coords.length;
  if (n < 4) return false;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      if (i === 0 && j === n - 2) continue; // 閉路（始点=終点）は許容
      if (segIntersect(coords[i], coords[i + 1], coords[j], coords[j + 1])) return true;
    }
  }
  return false;
}

/** 座標列を丸めて重複検出用キーを作る（0.1m 精度）。 */
export function lineKey(coords) {
  return coords.map(([x, z]) => round(x) + ',' + round(z)).join('|');
}

/**
 * normalized line feature の配列を検証し、統計と invalid/duplicate の id 一覧を返す。
 * geometry は一切変更しない（読み取り専用）。
 */
export function validateLines(features) {
  const stats = { total: features.length, invalidCoordinates: 0, zeroLength: 0, selfIntersecting: 0, extremeOutlier: 0, duplicates: 0 };
  const seen = new Map();
  const invalidIds = [], duplicateIds = [];
  for (const f of features) {
    const coords = f.geometry && f.geometry.coordinates;
    if (!coords || coords.length < 2) { stats.invalidCoordinates++; invalidIds.push(f.id); continue; }
    if (hasInvalidCoordinate(coords)) { stats.invalidCoordinates++; invalidIds.push(f.id); continue; }
    if (isExtremeOutlier(coords)) { stats.extremeOutlier++; invalidIds.push(f.id); continue; }
    if (lineLength(coords) < 0.01) { stats.zeroLength++; invalidIds.push(f.id); continue; }
    if (isSelfIntersecting(coords)) stats.selfIntersecting++;   // フラグのみ・除外しない（統計目的）
    const k = lineKey(coords);
    if (seen.has(k)) { stats.duplicates++; duplicateIds.push(f.id); } else seen.set(k, f.id);
  }
  return { stats, invalidIds, duplicateIds };
}
