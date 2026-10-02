// tools/lib/gsi-building-matching.js
// [Mission 31G-FIX20] PLATEAU building footprint ↔ GSI building outline(BldL) の直接 matching。
//   §7 遵守: 単純 nearest centroid だけでは matching しない（centroid proximity + bbox overlap +
//   area similarity + orientation + shape(IoU) の合成スコア + mutual best match 必須）。
//   §0 遵守: ここでは matching・統計計算のみ。canonical building / GSI geometry は一切変更しない。
//
//   IoU は厳密な polygon clipping（非凸形状にも対応する Weiler–Atherton 等）を実装する代わりに、
//   bbox を細かい grid（既定 0.5m セル）でラスタライズして「両方に属するセル数 / 少なくとも
//   どちらかに属するセル数」で近似する（FIX19 の 5m grid rasterize と同じ考え方。建物1棟あたりの
//   bbox は数十m四方と小さいため、0.5m grid でも計算コストは小さい）。厳密値ではなく近似値である
//   ことを明示する（§0: 捏造しない＝精度を偽らない）。

// ── 基本 polygon 計量 ──
export function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; a += x1 * z2 - x2 * z1; }
  return Math.abs(a) / 2;
}
export function ringCentroid(ring) {
  // 面積加重重心（頂点平均ではなく多角形の重心。自己交差の無い単純多角形を前提）。
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length];
    const cross = x1 * z2 - x2 * z1;
    a += cross; cx += (x1 + x2) * cross; cz += (z1 + z2) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) {
    // 退化（面積ほぼ0）: 頂点平均へフォールバック
    let sx = 0, sz = 0; for (const [x, z] of ring) { sx += x; sz += z; }
    return [sx / ring.length, sz / ring.length];
  }
  return [cx / (6 * a), cz / (6 * a)];
}
export function ringBbox(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
  return { minX, maxX, minZ, maxZ };
}
/** 最小外接矩形の向き（PCA近似・0〜180度・度数）と縦横比。単純な回転キャリパーではなく共分散行列の主軸。
 *  既知の限界: ほぼ正方形（sxx≈szz）の建物は主軸が数学的に不定になり、頂点分布の僅かな差だけで
 *  角度が大きく振れうる（実測: 同一建物の平行移動のみコピーで diff≈0 と確認済みだが、city-wide 平均には
 *  ごく一部にこの種の外れ値が混入し得る。§14 の平均値はこの限界込みで参考値として扱うこと）。 */
export function ringOrientation(ring) {
  const [cx, cz] = ringCentroid(ring);
  let sxx = 0, szz = 0, sxz = 0;
  for (const [x, z] of ring) { const dx = x - cx, dz = z - cz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
  const n = ring.length || 1;
  sxx /= n; szz /= n; sxz /= n;
  // 2x2 対称行列 [[sxx,sxz],[sxz,szz]] の固有ベクトル角度
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  let deg = (theta * 180 / Math.PI) % 180;
  if (deg < 0) deg += 180;
  return deg;
}
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
/** grid rasterize 近似 IoU（§0: 近似値であることを明示）。cellM 既定 0.5m。 */
export function approximateIoU(ringA, ringB, cellM = 0.5) {
  const ba = ringBbox(ringA), bb = ringBbox(ringB);
  const minX = Math.min(ba.minX, bb.minX), maxX = Math.max(ba.maxX, bb.maxX);
  const minZ = Math.min(ba.minZ, bb.minZ), maxZ = Math.max(ba.maxZ, bb.maxZ);
  const w = maxX - minX, h = maxZ - minZ;
  if (w <= 0 || h <= 0 || w > 500 || h > 500) return 0;   // 異常に大きい bbox は誤 match の疑いとして 0 扱い
  const nx = Math.max(1, Math.ceil(w / cellM)), nz = Math.max(1, Math.ceil(h / cellM));
  if (nx * nz > 400000) return 0;   // 安全弁（極端に細長い bbox 等）
  let inA = 0, inB = 0, inBoth = 0;
  for (let ix = 0; ix < nx; ix++) {
    const px = minX + (ix + 0.5) * cellM;
    for (let iz = 0; iz < nz; iz++) {
      const pz = minZ + (iz + 0.5) * cellM;
      const a = pointInRing(px, pz, ringA), b = pointInRing(px, pz, ringB);
      if (a) inA++; if (b) inB++; if (a && b) inBoth++;
    }
  }
  const union = inA + inB - inBoth;
  return union > 0 ? inBoth / union : 0;
}

/** feature（{id, ring:[[x,z],...]}）から matching 用の計量一式を1回だけ計算する。 */
export function precomputeMetrics(feature) {
  const ring = feature.ring;
  const area = ringArea(ring);
  const centroid = ringCentroid(ring);
  const bbox = ringBbox(ring);
  const orientationDeg = ringOrientation(ring);
  return { ...feature, area, centroid, bbox, orientationDeg };
}

// ── 空間 grid index（centroid ベース。半径検索用）──
const IDX_CELL = 20;
export function buildCentroidIndex(features) {
  const grid = new Map();
  for (const f of features) {
    const cx = Math.floor(f.centroid[0] / IDX_CELL), cz = Math.floor(f.centroid[1] / IDX_CELL);
    const k = cx + ',' + cz; let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(f);
  }
  return grid;
}
export function queryCentroidIndex(grid, x, z, radiusM) {
  const out = [];
  const r = Math.ceil(radiusM / IDX_CELL);
  const cx0 = Math.floor(x / IDX_CELL), cz0 = Math.floor(z / IDX_CELL);
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    const arr = grid.get((cx0 + dx) + ',' + (cz0 + dz)); if (!arr) continue;
    for (const f of arr) if (Math.hypot(f.centroid[0] - x, f.centroid[1] - z) <= radiusM) out.push(f);
  }
  return out;
}

const SEARCH_RADIUS_M = 20;   // §7: 候補探索半径（明らかな別建物まで拾わないための上限）
// 角度差は矩形の90度対称を考慮して 0-90度の範囲へ畳み込む
function orientationDiffDeg(a, b) {
  const raw = Math.abs(a - b) % 90;
  return Math.min(raw, 90 - raw);
}

/**
 * 2建物間の合成スコアを計算する（§7の全条件を合成。単純nearest centroidのみでは判定しない）。
 * @returns {{ distance, bboxIoU, areaSimilarity, orientationDiffDeg, iou, score }}
 */
export function scoreBuildingPair(a, b) {
  const distance = Math.hypot(a.centroid[0] - b.centroid[0], a.centroid[1] - b.centroid[1]);
  const bboxIoU = bboxOverlapRatio(a.bbox, b.bbox);
  const areaSimilarity = Math.min(a.area, b.area) / Math.max(a.area, b.area, 1e-6);
  const oDiff = orientationDiffDeg(a.orientationDeg, b.orientationDeg);
  const iou = approximateIoU(a.ring, b.ring);
  // 合成スコア（0-1、重みの合計=1.0）。IoU と面積類似度を重視（形状一致こそが「同一建物」の一番強い証拠）。
  const distScore = Math.max(0, 1 - distance / SEARCH_RADIUS_M);
  const orientScore = Math.max(0, 1 - oDiff / 45);
  const score = 0.35 * iou + 0.25 * areaSimilarity + 0.20 * distScore + 0.20 * orientScore;
  return { distance, bboxIoU, areaSimilarity, orientationDiffDeg: oDiff, iou, score };
}
function bboxOverlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const iz = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
  const inter = ix * iz;
  const areaA = (a.maxX - a.minX) * (a.maxZ - a.minZ), areaB = (b.maxX - b.minX) * (b.maxZ - b.minZ);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

// §8 confidence 閾値（explainable・単一 magic number にしない）
export const CONF_THRESHOLDS = {
  HIGH: { maxDistanceM: 8, minAreaSimilarity: 0.7, minIoU: 0.4, minScore: 0.55 },
  MEDIUM: { maxDistanceM: 15, minAreaSimilarity: 0.5, minIoU: 0.15, minScore: 0.30 },
};

/**
 * PLATEAU（A群）と GSI（B群）を matching する。§7: mutual best match を HIGH の必須条件にする
 * （FIX17 の道路縁 pairing v2 と同じ設計思想）。
 * @param {Array} aFeatures precomputeMetrics 済みの PLATEAU building 配列
 * @param {Array} bFeatures precomputeMetrics 済みの GSI building outline 配列
 * @returns {Array<{ aId, bId, confidence, distance, dx, dz, bearing, iou, areaSimilarity, orientationDiffDeg, score, why }>}
 */
export function matchBuildings(aFeatures, bFeatures) {
  const gridB = buildCentroidIndex(bFeatures);
  const gridA = buildCentroidIndex(aFeatures);

  // 各 A について B 側候補の best を求める（score 最大）
  const bestFromA = new Map();   // aId -> {b, result}
  for (const a of aFeatures) {
    const cands = queryCentroidIndex(gridB, a.centroid[0], a.centroid[1], SEARCH_RADIUS_M);
    let best = null, bestResult = null;
    for (const b of cands) {
      const r = scoreBuildingPair(a, b);
      if (!best || r.score > bestResult.score) { best = b; bestResult = r; }
    }
    if (best) bestFromA.set(a.id, { b: best, result: bestResult });
  }
  // 各 B について A 側候補の best を求める（mutual 判定用）
  const bestFromB = new Map();
  for (const b of bFeatures) {
    const cands = queryCentroidIndex(gridA, b.centroid[0], b.centroid[1], SEARCH_RADIUS_M);
    let best = null, bestResult = null;
    for (const a of cands) {
      const r = scoreBuildingPair(a, b);
      if (!best || r.score > bestResult.score) { best = a; bestResult = r; }
    }
    if (best) bestFromB.set(b.id, { a: best, result: bestResult });
  }

  const out = [];
  for (const a of aFeatures) {
    const fa = bestFromA.get(a.id);
    if (!fa) { out.push(unmatchedRecord(a)); continue; }
    const { b, result } = fa;
    const mutual = bestFromB.get(b.id) && bestFromB.get(b.id).a.id === a.id;
    const dx = b.centroid[0] - a.centroid[0], dz = b.centroid[1] - a.centroid[1];
    const bearing = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;   // 0=北 znorth-neg-v1
    let confidence = 'UNMATCHED';
    const T = CONF_THRESHOLDS;
    const passHigh = mutual && result.distance <= T.HIGH.maxDistanceM && result.areaSimilarity >= T.HIGH.minAreaSimilarity
      && result.iou >= T.HIGH.minIoU && result.score >= T.HIGH.minScore;
    const passMedium = result.distance <= T.MEDIUM.maxDistanceM && result.areaSimilarity >= T.MEDIUM.minAreaSimilarity
      && result.iou >= T.MEDIUM.minIoU && result.score >= T.MEDIUM.minScore;
    if (passHigh) confidence = 'MATCH_HIGH';
    else if (passMedium) confidence = 'MATCH_MEDIUM';
    else if (result.score > 0) confidence = 'MATCH_LOW';
    // why: 実際に不足している条件を列挙する（HIGH 閾値を基準に、どれが未達だったかを正直に記録）。
    const missing = [];
    if (!mutual) missing.push('mutual best matchでない');
    if (result.distance > T.HIGH.maxDistanceM) missing.push('距離>' + T.HIGH.maxDistanceM + 'm');
    if (result.areaSimilarity < T.HIGH.minAreaSimilarity) missing.push('面積類似度<' + T.HIGH.minAreaSimilarity);
    if (result.iou < T.HIGH.minIoU) missing.push('IoU<' + T.HIGH.minIoU);
    if (result.score < T.HIGH.minScore) missing.push('score<' + T.HIGH.minScore);
    const why = confidence === 'MATCH_HIGH' ? 'mutual best match かつ距離/面積/IoU/スコア全て HIGH 閾値内'
      : confidence === 'MATCH_MEDIUM' ? 'MEDIUM 閾値は満たすが HIGH 閾値は未達（' + missing.join('、') + '）'
      : confidence === 'MATCH_LOW' ? '候補はあるが MEDIUM 閾値未達（' + missing.join('、') + '）'
      : '候補無し（検索半径 ' + SEARCH_RADIUS_M + 'm 以内に GSI outline 無し）';
    out.push({
      aId: a.id, bId: b.id, confidence, mutual,
      distance: +result.distance.toFixed(3), dx: +dx.toFixed(3), dz: +dz.toFixed(3), bearing: +bearing.toFixed(1),
      iou: +result.iou.toFixed(3), bboxIoU: +result.bboxIoU.toFixed(3), areaSimilarity: +result.areaSimilarity.toFixed(3),
      orientationDiffDeg: +result.orientationDiffDeg.toFixed(2), score: +result.score.toFixed(3),
      aCentroid: a.centroid, bCentroid: b.centroid, why,
    });
  }
  return out;
}
function unmatchedRecord(a) {
  return { aId: a.id, bId: null, confidence: 'UNMATCHED', mutual: false, distance: null, dx: null, dz: null, bearing: null,
    iou: 0, bboxIoU: 0, areaSimilarity: 0, orientationDiffDeg: null, score: 0, aCentroid: a.centroid, bCentroid: null,
    why: '検索半径 ' + SEARCH_RADIUS_M + 'm 以内に GSI outline 候補が無い' };
}

// ── §10 統計 ──
export function percentileOf(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}
export function summarizeTranslation(matches) {
  const dxs = matches.map((m) => m.dx).filter((v) => v != null).sort((a, b) => a - b);
  const dzs = matches.map((m) => m.dz).filter((v) => v != null).sort((a, b) => a - b);
  const dists = matches.map((m) => m.distance).filter((v) => v != null).sort((a, b) => a - b);
  const mean = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const std = (arr) => { if (!arr.length) return null; const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); };
  return {
    n: dists.length,
    medianDx: percentileOf(dxs, 0.5), medianDz: percentileOf(dzs, 0.5), medianDistance: percentileOf(dists, 0.5),
    meanDx: mean(dxs), meanDz: mean(dzs),
    stdDx: std(dxs), stdDz: std(dzs),
    p50: percentileOf(dists, 0.5), p90: percentileOf(dists, 0.9), p95: percentileOf(dists, 0.95), p99: percentileOf(dists, 0.99),
    max: dists.length ? dists[dists.length - 1] : null,
  };
}

// ── §12 空間回帰: dx/dz を x(経度相当)/z(緯度相当)/distanceFromOrigin に単回帰し、傾き・相関係数を返す ──
function linreg(xs, ys) {
  const n = xs.length; if (n < 3) return { slope: 0, intercept: 0, r: 0 };
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const slope = sxx > 1e-9 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const r = (sxx > 1e-9 && syy > 1e-9) ? sxy / Math.sqrt(sxx * syy) : 0;
  return { slope, intercept, r };
}
export function spatialRegression(matches) {
  const rows = matches.filter((m) => m.dx != null && m.aCentroid);
  const xs = rows.map((m) => m.aCentroid[0]), zs = rows.map((m) => m.aCentroid[1]);
  const dxs = rows.map((m) => m.dx), dzs = rows.map((m) => m.dz);
  const dists = rows.map((m) => Math.hypot(m.aCentroid[0], m.aCentroid[1]));
  return {
    n: rows.length,
    dxVsX: linreg(xs, dxs), dxVsZ: linreg(zs, dxs), dxVsDist: linreg(dists, dxs),
    dzVsX: linreg(xs, dzs), dzVsZ: linreg(zs, dzs), dzVsDist: linreg(dists, dzs),
  };
}

/**
 * §12 分類。回帰結果と統計から6分類のいずれかを選ぶ（explainable・単一 magic number に頼りすぎない）。
 */
export function classifyShift(summary, regression) {
  if (!summary || summary.n === 0) return { classification: 'NO_SYSTEMATIC_SHIFT', reason: 'HIGH match が0件（判定不能）' };
  const NOISE_FLOOR_M = 0.5;   // これ未満の median は「ずれ無し」とみなす床値
  const STRONG_R = 0.4;        // これ以上の相関を「位置依存性あり」とみなす
  const absDx = Math.abs(summary.medianDx || 0), absDz = Math.abs(summary.medianDz || 0);
  const rMax = regression ? Math.max(
    Math.abs(regression.dxVsX.r), Math.abs(regression.dxVsZ.r), Math.abs(regression.dxVsDist.r),
    Math.abs(regression.dzVsX.r), Math.abs(regression.dzVsZ.r), Math.abs(regression.dzVsDist.r),
  ) : 0;
  // 位置依存の系統誤差（ROTATION/SCALE）は median が0近く（回転中心が sample 内にある等）でも
  // 発生しうるため、median の大小より先に回帰の相関を確認する（判定順序を誤ると見逃す・実測で確認済み）。
  if (rMax >= STRONG_R) {
    const distR = regression ? Math.max(Math.abs(regression.dxVsDist.r), Math.abs(regression.dzVsDist.r)) : 0;
    const posR = regression ? Math.max(Math.abs(regression.dxVsX.r), Math.abs(regression.dxVsZ.r), Math.abs(regression.dzVsX.r), Math.abs(regression.dzVsZ.r)) : 0;
    if (distR >= STRONG_R && distR >= posR) return { classification: 'SCALE', reason: 'dx/dzが原点からの距離と強く相関(|r|>=' + STRONG_R + ')' };
    return { classification: 'ROTATION', reason: 'dx/dzが位置(x/z)と強く相関(|r|>=' + STRONG_R + ')' };
  }
  if (absDx < NOISE_FLOOR_M && absDz < NOISE_FLOOR_M) return { classification: 'NO_SYSTEMATIC_SHIFT', reason: 'median dx/dz とも ' + NOISE_FLOOR_M + 'm 未満・位置との相関も弱い' };
  return { classification: 'CONSTANT_TRANSLATION', reason: 'median dx/dzが有意だが位置との相関は弱い(|r|<' + STRONG_R + ')＝一定方向への平行移動候補' };
}
