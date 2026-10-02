// tools/lib/geometry-anomaly.js
// リング（点列）の幾何異常を検出する共通ユーティリティ。
//   - 巨大セグメント（地物を横断する1本の異常に長い辺）: 未連結multipolygon・座標破損の兆候
//   - 自己交差: O(n^2) のセグメント交差スキャン
//   - 未閉合 / 退化（重複点のみ）
//
// tools/lib/boundary-ingestion-validator.js（行政区境界）と tools/validate/water-geometry.js
// （河川・水域）の両方から使う。座標系は呼び出し側で統一済みであること（メートル系推奨。
// 巨大セグメントの絶対長しきい値はメートル前提）。

// 「1セグメントが異常に長い」= 同一リング内の中央値セグメント長のこの倍数を超え、かつ絶対長も超える。
// 行政界・水域外周は通常セグメント長が比較的均一なため、中央値の20倍を超える辺は連結漏れを強く示唆する。
export const DEFAULT_OVERSIZED_SEG_MEDIAN_MULT = 20;
export const DEFAULT_OVERSIZED_SEG_ABS = 800;
export const DEFAULT_OVERSIZED_SEG_MIN_POINTS = 3;
// 自己交差スキャンは O(n^2)。想定外に巨大なリングでCIが固まらないよう上限を設ける。
export const DEFAULT_SELF_INTERSECTION_MAX_POINTS = 6000;

function isFinitePair(pt) {
  return Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]);
}

function ringBbox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, diag: Math.hypot(maxX - minX, maxY - minY) };
}

function segmentsIntersect(p1, p2, p3, p4) {
  const d = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = d(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1]);
  const d2 = d(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1]);
  const d3 = d(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  const d4 = d(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1]);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * 1リング（[[x,y],...]。座標系は呼び出し側で統一済み）を評価する。
 * @param {number[][]} rawPoints
 * @param {object} [opts]
 * @returns {{points:number, uniquePoints:number, closed:boolean, maxSegment:number,
 *   medianSegment:number, bboxDiag:number, oversizedSegments:number, selfIntersections:number,
 *   selfIntersectionScanned:boolean, nonFinite:number}}
 */
export function analyzeRing(rawPoints, opts = {}) {
  const oversizedAbs = opts.oversizedAbs ?? DEFAULT_OVERSIZED_SEG_ABS;
  const oversizedMult = opts.oversizedMedianMult ?? DEFAULT_OVERSIZED_SEG_MEDIAN_MULT;
  const oversizedMinPoints = opts.oversizedMinPoints ?? DEFAULT_OVERSIZED_SEG_MIN_POINTS;
  // oversizedBboxRatio: セグメント長がリング自身のbbox対角線のこの比率を超えたら（かつ絶対長も超えたら）
  // 巨大セグメントとみなす。未指定なら無効（行政区境界は中央値倍率のみで判定する）。
  const oversizedBboxRatio = opts.oversizedBboxRatio ?? null;
  const selfIntMax = opts.selfIntersectionMaxPoints ?? DEFAULT_SELF_INTERSECTION_MAX_POINTS;

  const points = Array.isArray(rawPoints) ? rawPoints : [];
  let nonFinite = 0;
  for (const pt of points) if (!isFinitePair(pt)) nonFinite++;
  const finitePoints = points.filter(isFinitePair);
  const n = finitePoints.length;

  const closed = n >= 2 &&
    finitePoints[0][0] === finitePoints[n - 1][0] &&
    finitePoints[0][1] === finitePoints[n - 1][1];

  const uniqueKeys = new Set(finitePoints.map((p) => `${p[0]}_${p[1]}`));
  const bb = n ? ringBbox(finitePoints) : { diag: 0 };

  const segLengths = [];
  for (let i = 0; i < n - 1; i++) {
    segLengths.push(Math.hypot(finitePoints[i + 1][0] - finitePoints[i][0], finitePoints[i + 1][1] - finitePoints[i][1]));
  }
  // 明示的に閉じていないリング（面データは終点=始点を省略して保持されることが多い）は、
  // 三角形分割時に終点→始点の辺が生成される。この暗黙の閉合辺も評価対象に含める。
  // これが巨大だと「川面を横断する巨大三角形」になる（未連結memberを閉ポリゴン扱いした典型）。
  if (n >= 3 && !closed) {
    segLengths.push(Math.hypot(finitePoints[0][0] - finitePoints[n - 1][0], finitePoints[0][1] - finitePoints[n - 1][1]));
  }
  const maxSegment = segLengths.length ? Math.max(...segLengths) : 0;
  const sorted = [...segLengths].sort((a, b) => a - b);
  const medianSegment = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  let oversizedSegments = 0;
  if (n >= oversizedMinPoints && medianSegment > 0) {
    for (const seg of segLengths) {
      if (seg <= oversizedAbs) continue;
      const byMedian = seg > medianSegment * oversizedMult;
      const byBbox = oversizedBboxRatio !== null && bb.diag > 0 && seg > bb.diag * oversizedBboxRatio;
      if (byMedian || byBbox) oversizedSegments++;
    }
  }

  let selfIntersections = 0;
  let selfIntersectionScanned = false;
  if (n >= 4 && n <= selfIntMax) {
    selfIntersectionScanned = true;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n - 1; j++) {
        if (i === 0 && j === n - 2) continue; // 閉リングの最初と最後は共有頂点
        if (segmentsIntersect(finitePoints[i], finitePoints[i + 1], finitePoints[j], finitePoints[j + 1])) {
          selfIntersections++;
        }
      }
    }
  }

  return {
    points: points.length,
    uniquePoints: uniqueKeys.size,
    closed,
    maxSegment,
    medianSegment,
    bboxDiag: bb.diag,
    oversizedSegments,
    selfIntersections,
    selfIntersectionScanned,
    nonFinite,
  };
}
