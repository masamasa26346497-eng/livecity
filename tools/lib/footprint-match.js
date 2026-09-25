// tools/lib/footprint-match.js
// [Mission 35T] footprint どうしの重なりを厳密に測り、照合の信頼度を決める純関数群。
//
//   35S は「重心が近い + 面積比が範囲内 + 内包点が 1 つある」で採用していた。
//   これでは隣の棟や、複合建物の一部を掴んでも通ってしまう。
//   35T では **IoU（共通部分 / 和集合）** を主判定にし、満たさないものは
//   現行 canonicalId であっても採用しない（nearest fallback は持たない）。

/** 多角形の符号付き面積（|値| が面積）。 */
export function ringArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a) / 2;
}

export function ringBbox(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, maxX, minZ, maxZ };
}

export function ringCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % n];
    const cr = x1 * z2 - x2 * z1;
    a += cr; cx += (x1 + x2) * cr; cz += (z1 + z2) * cr;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (const p of ring) { sx += p[0]; sz += p[1]; }
    return [sx / ring.length, sz / ring.length];
  }
  return [cx / (6 * a), cz / (6 * a)];
}

export function pointInRing(x, z, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-12) + xi)) inside = !inside;
  }
  return inside;
}

export function bboxOverlap(a, b) {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxZ < b.minZ || b.maxZ < a.minZ);
}

/** 2 つの bbox の重なり面積。 */
export function bboxIntersectionArea(a, b) {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  return (w > 0 && h > 0) ? w * h : 0;
}

/**
 * 共通部分・和集合の面積を **格子サンプル** で測る。
 *
 * 厳密なポリゴンクリッピングは自己交差・穴で壊れやすく、ここで要るのは
 * 「どれくらい同じ形か」を安定して比べられる数値なので、両方の bbox を覆う
 * 格子を張って内外を数える。格子は両者の小さい方の辺長から自動で細かくする。
 *
 * @returns {{intersectionM2:number, unionM2:number, iou:number,
 *            aCoveredRatio:number, bCoveredRatio:number, cellM:number, samples:number}}
 */
export function overlapMetrics(ringA, ringB, opts = {}) {
  const ba = ringBbox(ringA), bb = ringBbox(ringB);
  const zero = { intersectionM2: 0, unionM2: 0, iou: 0, aCoveredRatio: 0, bCoveredRatio: 0, cellM: 0, samples: 0 };
  if (!Number.isFinite(ba.minX) || !Number.isFinite(bb.minX)) return zero;
  const minX = Math.min(ba.minX, bb.minX), maxX = Math.max(ba.maxX, bb.maxX);
  const minZ = Math.min(ba.minZ, bb.minZ), maxZ = Math.max(ba.maxZ, bb.maxZ);
  const w = maxX - minX, h = maxZ - minZ;
  if (!(w > 0) || !(h > 0)) return zero;
  // 小さい方の建物が 100 セル程度で表現される粗さにする（上限 400x400 セル）
  const smallSide = Math.max(1, Math.min(ba.maxX - ba.minX, ba.maxZ - ba.minZ,
    bb.maxX - bb.minX, bb.maxZ - bb.minZ));
  let cell = opts.cellM || Math.max(0.25, smallSide / 12);
  let nx = Math.ceil(w / cell), nz = Math.ceil(h / cell);
  while (nx * nz > 160000) { cell *= 1.5; nx = Math.ceil(w / cell); nz = Math.ceil(h / cell); }
  let inA = 0, inB = 0, both = 0;
  for (let i = 0; i < nx; i++) {
    const x = minX + cell * (i + 0.5);
    for (let j = 0; j < nz; j++) {
      const z = minZ + cell * (j + 0.5);
      const a = pointInRing(x, z, ringA);
      const b = pointInRing(x, z, ringB);
      if (a) inA++;
      if (b) inB++;
      if (a && b) both++;
    }
  }
  const cellArea = cell * cell;
  const interM2 = both * cellArea;
  const unionM2 = (inA + inB - both) * cellArea;
  return {
    intersectionM2: +interM2.toFixed(2),
    unionM2: +unionM2.toFixed(2),
    iou: unionM2 > 0 ? +(interM2 / unionM2).toFixed(4) : 0,
    aCoveredRatio: inA > 0 ? +(both / inA).toFixed(4) : 0,
    bCoveredRatio: inB > 0 ? +(both / inB).toFixed(4) : 0,
    cellM: +cell.toFixed(3),
    samples: nx * nz,
  };
}

/** 点から線分までの距離。 */
function pointSegDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** 点からリング境界までの最短距離。 */
export function pointToRingDist(x, z, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = pointSegDist(x, z, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * 境界どうしの離れ具合（Hausdorff 距離の近似）。
 * 頂点だけを見る片側最大距離の大きい方を返す。
 */
export function hausdorffApprox(ringA, ringB) {
  let ab = 0, ba = 0;
  for (const p of ringA) { const d = pointToRingDist(p[0], p[1], ringB); if (d > ab) ab = d; }
  for (const p of ringB) { const d = pointToRingDist(p[0], p[1], ringA); if (d > ba) ba = d; }
  return { aToB: +ab.toFixed(2), bToA: +ba.toFixed(2), max: +Math.max(ab, ba).toFixed(2) };
}

/** §3 判定のしきい値。ここを緩めるときは必ず実測の根拠を添えること。 */
export const MATCH_RULES = {
  HIGH: { iou: 0.75, centroidM: 10, areaRatio: [0.80, 1.25] },
  MEDIUM: { iou: 0.60, centroidM: 15, areaRatio: [0.70, 1.40] },
  /** §4 best と second が近すぎるときは AMBIGUOUS。 */
  AMBIGUOUS: { iouGap: 0.10, centroidGapM: 3 },
  /** 候補を集める半径（§2）。 */
  CANDIDATE_RADIUS_M: 100,
};

/**
 * 1 候補ぶんの指標をまとめる。
 * @param {{ring:number[][], area:number, centroid:number[]}} src   OSM 側
 * @param {{ring:number[][], id:string, heightM:number|null}} cand  canonical 側
 */
export function evaluateCandidate(src, cand) {
  const ring = cand.ring;
  const area = ringArea(ring);
  const c = ringCentroid(ring);
  const centroidDistanceM = Math.hypot(c[0] - src.centroid[0], c[1] - src.centroid[1]);
  const areaRatio = src.area > 0 ? area / src.area : 0;
  const o = overlapMetrics(src.ring, ring);
  const hd = hausdorffApprox(src.ring, ring);
  const bbA = ringBbox(src.ring), bbB = ringBbox(ring);
  return {
    canonicalId: cand.id,
    centroid: [+c[0].toFixed(2), +c[1].toFixed(2)],
    centroidDistanceM: +centroidDistanceM.toFixed(2),
    sourceAreaM2: +src.area.toFixed(1),
    candidateAreaM2: +area.toFixed(1),
    areaRatio: +areaRatio.toFixed(3),
    intersectionM2: o.intersectionM2,
    unionM2: o.unionM2,
    iou: o.iou,
    sourceCoveredRatio: o.aCoveredRatio,
    candidateCoveredRatio: o.bCoveredRatio,
    bboxOverlap: bboxOverlap(bbA, bbB),
    bboxIntersectionM2: +bboxIntersectionArea(bbA, bbB).toFixed(1),
    hausdorffM: hd.max,
    heightM: cand.heightM != null ? cand.heightM : null,
    usageCategory: cand.usageCategory || null,
    sourceType: cand.source || null,
    vertexCount: ring.length,
  };
}

const inRange = (v, [lo, hi]) => v >= lo && v <= hi;

/**
 * §3/§4 best / second から最終判定を出す。
 * しきい値を満たさないときに現行 canonicalId へ寄せることはしない（nearest fallback 禁止）。
 */
export function decideMatch(best, second, opts = {}) {
  const rules = opts.rules || MATCH_RULES;
  if (!best) {
    return { matchConfidence: 'UNMATCHED', lod1SuppressionAllowed: false,
      reason: '候補が 1 つも無い', ambiguousReason: null };
  }
  const meetsHigh = best.iou >= rules.HIGH.iou
    && best.centroidDistanceM <= rules.HIGH.centroidM
    && inRange(best.areaRatio, rules.HIGH.areaRatio);
  const meetsMedium = best.iou >= rules.MEDIUM.iou
    && best.centroidDistanceM <= rules.MEDIUM.centroidM
    && inRange(best.areaRatio, rules.MEDIUM.areaRatio);

  // §4 second と僅差なら、どちらとも断定できない
  let ambiguousReason = null;
  if (second) {
    const iouGap = best.iou - second.iou;
    const cGap = second.centroidDistanceM - best.centroidDistanceM;
    if (iouGap < rules.AMBIGUOUS.iouGap && cGap < rules.AMBIGUOUS.centroidGapM) {
      ambiguousReason = `best と second が僅差（IoU 差 ${iouGap.toFixed(3)} / 重心差 ${cGap.toFixed(2)}m）`;
    }
  }
  // source が複数の候補にまたがっている（どれも source を覆いきれていない）
  if (!ambiguousReason && second
    && best.sourceCoveredRatio < 0.75 && second.sourceCoveredRatio >= 0.15) {
    ambiguousReason = `source polygon が複数の建物にまたがっている疑い`
      + `（best ${best.sourceCoveredRatio} / second ${second.sourceCoveredRatio}）`;
  }

  if (ambiguousReason) {
    return { matchConfidence: 'AMBIGUOUS', lod1SuppressionAllowed: false,
      reason: 'best を断定できない', ambiguousReason };
  }
  if (meetsHigh) {
    return { matchConfidence: 'HIGH', lod1SuppressionAllowed: true,
      reason: `IoU ${best.iou} / 重心 ${best.centroidDistanceM}m / 面積比 ${best.areaRatio}`,
      ambiguousReason: null };
  }
  if (meetsMedium) {
    return { matchConfidence: 'MEDIUM', lod1SuppressionAllowed: false,
      reason: `HIGH に届かない（IoU ${best.iou} / 重心 ${best.centroidDistanceM}m / 面積比 ${best.areaRatio}）`,
      ambiguousReason: null };
  }
  return { matchConfidence: 'UNMATCHED', lod1SuppressionAllowed: false,
    reason: `基準未達（IoU ${best.iou} / 重心 ${best.centroidDistanceM}m / 面積比 ${best.areaRatio}）`,
    ambiguousReason: null };
}

/** 候補の並び順。IoU を主、重心距離を従にする（nearest 単独では選ばない）。 */
export function rankCandidates(list) {
  return [...list].sort((a, b) => (b.iou - a.iou) || (a.centroidDistanceM - b.centroidDistanceM));
}
