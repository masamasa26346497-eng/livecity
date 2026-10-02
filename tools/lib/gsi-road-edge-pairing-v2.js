// tools/lib/gsi-road-edge-pairing-v2.js
// [Mission 31G-FIX17] GSI 道路縁 reconstruction v2: network graph + intersection masking +
//   segment化 + mutual-best-match + explainable confidence scoring（Strategy B: 高精度 edge pairing）。
//
//   FIX16 v1（gsi-road-edge-pairing.js）の弱点を実測に基づき是正:
//     - 交差点でフラグメント分割された同一縁同士の誤 pairing → node degree による INTERSECTION_ZONE 除外
//     - 長い曲線道路の全体 bearing 比較が破綻 → 長い line を segment 化し局所 bearing で評価
//     - 一方向 nearest のみで誤結合 → mutual best match を HIGH/MEDIUM の必須条件に
//     - 固定 3–30m 幅のみ → 3–45m へ拡張しつつ幅・重なり・並行度・PLATEAU 補助を合成スコア化
//     - black-box score 禁止 → 各 pair に whyHigh/whyMedium/whyRejected を残す
//
//   §0 遵守: source geometry（座標）は一切変更しない。ここで作るのは全て「導出（derived）」データ。
//   §1 遵守: 単一手法に固定しない設計（本ファイルは Strategy B。Strategy A(polygonization) は
//   tools/audit/gsi-road-reconstruction-v2.js 側で軽量評価のみ行い、本ファイルには含めない）。
import { lineLen, midpoint as lineMidpoint } from './gsi-road-edge-pairing.js';

// ── §3 network graph: node（端点）の degree を求める ──
const NODE_SNAP_M = 0.75;   // これ未満の端点は同一 node とみなす（GSI 実測の端点誤差を吸収）
const nodeKeyOf = ([x, z]) => Math.round(x / NODE_SNAP_M) + ',' + Math.round(z / NODE_SNAP_M);

export function buildNetwork(lines) {
  const nodeDegree = new Map();
  const bump = (k) => nodeDegree.set(k, (nodeDegree.get(k) || 0) + 1);
  for (const f of lines) {
    const c = f.geometry.coordinates;
    bump(nodeKeyOf(c[0]));
    bump(nodeKeyOf(c[c.length - 1]));
  }
  return { nodeDegree };
}

// ── §5 intersection zone: degree>=3 の node 周辺 radiusM を交差点扱いにする ──
const INTERSECTION_DEGREE = 3;
const INTERSECTION_RADIUS_M = 10;
const IZ_CELL = 20;
export function buildIntersectionIndex(network) {
  const grid = new Map();
  const pts = [];
  for (const [k, deg] of network.nodeDegree) {
    if (deg < INTERSECTION_DEGREE) continue;
    const [gx, gz] = k.split(',').map(Number);
    const pt = [gx * NODE_SNAP_M, gz * NODE_SNAP_M];
    pts.push(pt);
    const cx = Math.floor(pt[0] / IZ_CELL), cz = Math.floor(pt[1] / IZ_CELL);
    const gk = cx + ',' + cz; let arr = grid.get(gk); if (!arr) { arr = []; grid.set(gk, arr); } arr.push(pt);
  }
  return {
    count: pts.length,
    isNear(pt, radius = INTERSECTION_RADIUS_M) {
      const cx = Math.floor(pt[0] / IZ_CELL), cz = Math.floor(pt[1] / IZ_CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const arr = grid.get((cx + dx) + ',' + (cz + dz)); if (!arr) continue;
        for (const p of arr) if (Math.hypot(p[0] - pt[0], p[1] - pt[1]) <= radius) return true;
      }
      return false;
    },
  };
}

// ── §4 segment 化: 頂点数が多い/長い line を局所 bearing が安定する chunk へ分割 ──
const SEG_MAX_VERTICES = 8;
const SEG_TARGET_LEN_M = 30;
export function segmentize(lines) {
  const segs = [];
  for (const f of lines) {
    const c = f.geometry.coordinates;
    if (c.length <= SEG_MAX_VERTICES && lineLen(c) <= SEG_TARGET_LEN_M * 2.2) {
      segs.push(makeSegment(f.id, 0, c, f));
      continue;
    }
    // 頂点を累積距離で target 長ごとに chunk 化（座標は元の頂点をそのまま使う＝改変しない）
    let chunkStart = 0, acc = 0, idx = 0;
    for (let i = 1; i < c.length; i++) {
      acc += Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]);
      const isLast = i === c.length - 1;
      if (acc >= SEG_TARGET_LEN_M || isLast) {
        const chunk = c.slice(chunkStart, i + 1);
        if (chunk.length >= 2) segs.push(makeSegment(f.id, idx++, chunk, f));
        chunkStart = i; acc = 0;
      }
    }
  }
  return segs;
}
function makeSegment(parentId, idx, coords, parentFeature) {
  const len = lineLen(coords);
  const mid = lineMidpoint(coords);
  const a = coords[0], b = coords[coords.length - 1];
  const dx = b[0] - a[0], dz = b[1] - a[1]; const bl = Math.hypot(dx, dz) || 1;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of coords) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
  return {
    id: parentId + '#' + idx, parentId, coords, length: len, midpoint: mid,
    bearing: [dx / bl, dz / bl], bbox: { minX, maxX, minZ, maxZ },
    attrs: parentFeature.attrs, sourceCrs: parentFeature.sourceCrs,
  };
}

// ── grid index（segment bbox ベース）──
const CELL = 60;
const ckey = (cx, cz) => cx + ',' + cz;
export function buildGrid(segs) {
  const grid = new Map();
  for (const s of segs) {
    const x0 = Math.floor(s.bbox.minX / CELL), x1 = Math.floor(s.bbox.maxX / CELL);
    const z0 = Math.floor(s.bbox.minZ / CELL), z1 = Math.floor(s.bbox.maxZ / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = ckey(cx, cz); let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(s);
    }
  }
  return grid;
}
export function queryGrid(grid, bbox, padCells = 1) {
  const x0 = Math.floor(bbox.minX / CELL) - padCells, x1 = Math.floor(bbox.maxX / CELL) + padCells;
  const z0 = Math.floor(bbox.minZ / CELL) - padCells, z1 = Math.floor(bbox.maxZ / CELL) + padCells;
  const seen = new Set(), out = [];
  for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
    const arr = grid.get(ckey(cx, cz)); if (!arr) continue;
    for (const s of arr) { if (seen.has(s)) continue; seen.add(s); out.push(s); }
  }
  return out;
}

function dist(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1]); }

// ── §12 longitudinal overlap ratio: 2 segment を共通軸へ投影した重なり長 / 短い方の長さ ──
function overlapRatio(segA, segB) {
  const dir = segA.bearing;
  const proj = (p) => p[0] * dir[0] + p[1] * dir[1];
  const a0 = proj(segA.coords[0]), a1 = proj(segA.coords[segA.coords.length - 1]);
  const b0 = proj(segB.coords[0]), b1 = proj(segB.coords[segB.coords.length - 1]);
  const aMin = Math.min(a0, a1), aMax = Math.max(a0, a1);
  const bMin = Math.min(b0, b1), bMax = Math.max(b0, b1);
  const overlap = Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
  const shorter = Math.min(aMax - aMin, bMax - bMin) || 1;
  return Math.min(1, overlap / shorter);
}

// ── §13 crossing rejection: pair の連結線が第三の candidate segment とほぼ直交して交差しないか ──
function segIntersect(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 0.05 && t < 0.95 && u > 0.05 && u < 0.95;
}
function crossesOther(pA, pB, candidates, exclude) {
  for (const s of candidates) {
    if (s === exclude[0] || s === exclude[1]) continue;
    const c = s.coords;
    for (let i = 1; i < c.length; i++) if (segIntersect(pA, pB, c[i - 1], c[i])) return true;
  }
  return false;
}

const MIN_SEP_M = 3.0, MAX_SEP_M = 45.0;
const MIN_PARALLEL = 0.75;
const MIN_OVERLAP = 0.35;

/**
 * §6-13/§24 candidate pair のスコアを計算する（mutual best match は呼び出し側 pairSegmentsV2 で判定）。
 * @returns {null|{sep, parallel, overlap, score, reasons:string[]}}
 */
export function scorePair(segA, segB, opts) {
  const parallel = Math.abs(segA.bearing[0] * segB.bearing[0] + segA.bearing[1] * segB.bearing[1]);
  if (parallel < MIN_PARALLEL) return null;
  const sep = dist(segA.midpoint, segB.midpoint);
  if (sep < MIN_SEP_M || sep > MAX_SEP_M) return null;
  const ov = overlapRatio(segA, segB);
  if (ov < MIN_OVERLAP) return null;

  const reasons = [];
  const widthScore = sep >= 4 && sep <= 35 ? 1.0 : 0.65;   // §7: 中庸な幅は高評価・極端値はやや減点
  const parallelScore = parallel;
  const overlapScore = ov;
  let plateauSupport = 0;
  if (opts && opts.plateauSupportFn) { plateauSupport = opts.plateauSupportFn(segA.midpoint, segB.midpoint) ? 1 : 0.4; }
  else plateauSupport = 0.6;   // 判定材料が無ければ中立

  const score = 0.32 * parallelScore + 0.28 * overlapScore + 0.20 * widthScore + 0.20 * plateauSupport;
  if (parallelScore >= 0.92) reasons.push('parallel>=0.92');
  if (overlapScore >= 0.6) reasons.push('overlap>=0.6');
  if (plateauSupport === 1) reasons.push('plateau-corridor-match');
  return { sep: +sep.toFixed(2), parallel: +parallel.toFixed(3), overlap: +ov.toFixed(3), score: +score.toFixed(3), plateauSupport, reasons };
}

/**
 * §8/§24 segments を pairing する。mutual best match を HIGH/MEDIUM の必須条件とする。
 * @param {Array} segs 候補 segment（呼び出し側で type='真幅道路' 等に絞り込み済みを想定）
 * @param {{ plateauSupportFn?: Function, intersectionIndex?: Object }} opts
 */
export function pairSegmentsV2(segs, opts = {}) {
  const grid = buildGrid(segs);
  const bestOf = new Map();   // segId -> { other, result }
  for (const s of segs) {
    const cand = queryGrid(grid, s.bbox, 1).filter((g) => g !== s && g.parentId !== s.parentId);
    let best = null, bestScore = -1;
    for (const g of cand) {
      const r = scorePair(s, g, opts);
      if (!r) continue;
      if (r.score > bestScore) { bestScore = r.score; best = { other: g, result: r }; }
    }
    if (best) bestOf.set(s.id, best);
  }

  // 3 バケツで会計を必ず一致させる: pairs.length*2 + rejected.length + unpaired.length === segs.length
  //   pairs   = HIGH/MEDIUM/LOW で pair 成立
  //   rejected= best match 候補はあったが §13 crossing violation で reject（segment 自体は無効ではない）
  //   unpaired= best match 候補すら見つからなかった（孤立 segment）
  const pairs = [];
  const rejected = [];
  const usedIds = new Set();
  const rejectedIds = new Set();
  const idToSeg = new Map(segs.map((s) => [s.id, s]));
  for (const s of segs) {
    if (usedIds.has(s.id) || rejectedIds.has(s.id)) continue;
    const b = bestOf.get(s.id);
    if (!b) continue;
    const other = b.other;
    if (usedIds.has(other.id) || rejectedIds.has(other.id)) continue;
    const backRef = bestOf.get(other.id);
    const mutual = !!(backRef && backRef.other.id === s.id);

    const isectA = opts.intersectionIndex ? opts.intersectionIndex.isNear(s.midpoint) : false;
    const isectB = opts.intersectionIndex ? opts.intersectionIndex.isNear(other.midpoint) : false;
    const nearIntersection = isectA || isectB;
    // §13 crossing rejection: 連結線が第三の segment を直交気味に横切らないか（周辺 candidate のみ確認）
    const nearby = queryGrid(grid, { minX: Math.min(s.midpoint[0], other.midpoint[0]) - 5, maxX: Math.max(s.midpoint[0], other.midpoint[0]) + 5, minZ: Math.min(s.midpoint[1], other.midpoint[1]) - 5, maxZ: Math.max(s.midpoint[1], other.midpoint[1]) + 5 }, 1);
    const crossViolation = crossesOther(s.midpoint, other.midpoint, nearby, [s, other]);

    const r = b.result;
    let confidence, why;
    if (crossViolation) { confidence = 'reject'; why = 'crossing-violation: 連結線が第三 segment と交差'; }
    else if (!mutual) { confidence = 'low'; why = 'not-mutual-best-match（片方向 nearest のみ）'; }
    else if (nearIntersection) { confidence = 'medium'; why = 'mutual-best-match だが交差点近傍(<' + INTERSECTION_RADIUS_M + 'm)のため confidence 抑制'; }
    else if (r.score >= 0.78 && r.parallel >= 0.88 && r.overlap >= 0.55) { confidence = 'high'; why = 'mutual-best-match + parallel>=0.88 + overlap>=0.55 + score>=0.78: ' + r.reasons.join(','); }
    else if (r.score >= 0.55) { confidence = 'medium'; why = 'mutual-best-match だが score<0.78: score=' + r.score; }
    else { confidence = 'low'; why = 'mutual-best-match だが score<0.55: score=' + r.score; }

    if (confidence === 'reject') { rejectedIds.add(s.id); rejected.push({ a: s, b: other, sepM: r.sep, why }); continue; }
    usedIds.add(s.id); usedIds.add(other.id);
    pairs.push({ a: s, b: other, sepM: r.sep, parallel: r.parallel, overlapRatio: r.overlap, score: r.score,
      mutual, nearIntersection, confidence, why, plateauSupport: r.plateauSupport });
  }
  const unpaired = segs.filter((s) => !usedIds.has(s.id) && !rejectedIds.has(s.id));
  return { pairs, rejected, unpaired, idToSeg };
}

// ── §9 side consistency（軽量版）: 同一 parentId（元 line）が複数 pair に登場する場合、
//   相手との左右関係（外積の符号）が一貫しているかを確認する。QA 指標として集計するのみ（reject しない）。
export function sideConsistencyStats(pairs) {
  const bySource = new Map();   // parentId -> [side signs]
  for (const p of pairs) {
    const cross = p.a.bearing[0] * (p.b.midpoint[1] - p.a.midpoint[1]) - p.a.bearing[1] * (p.b.midpoint[0] - p.a.midpoint[0]);
    const sign = cross >= 0 ? 1 : -1;
    for (const parentId of [p.a.parentId, p.b.parentId]) {
      let arr = bySource.get(parentId); if (!arr) { arr = []; bySource.set(parentId, arr); }
      arr.push(sign);
    }
  }
  let consistent = 0, inconsistent = 0, singleOccurrence = 0;
  for (const arr of bySource.values()) {
    if (arr.length <= 1) { singleOccurrence++; continue; }
    const allSame = arr.every((s) => s === arr[0]);
    if (allSame) consistent++; else inconsistent++;
  }
  return { consistent, inconsistent, singleOccurrence, totalMultiOccurrence: consistent + inconsistent };
}

// ── §10 width continuity（軽量版）: 同名 corridor 内の隣接 pair 幅が近傍 pair 群の中央値から
//   大きく外れていないかを事後チェックする（交差点前後の実幅変化は許容するため「近傍」を空間的に取る）。
export function widthContinuityFlags(pairs, radiusM = 60) {
  const grid = buildGrid(pairs.map((p) => ({ ...p, midpoint: lineMidpoint([p.a.midpoint, p.b.midpoint]), bbox: { minX: Math.min(p.a.midpoint[0], p.b.midpoint[0]) - 1, maxX: Math.max(p.a.midpoint[0], p.b.midpoint[0]) + 1, minZ: Math.min(p.a.midpoint[1], p.b.midpoint[1]) - 1, maxZ: Math.max(p.a.midpoint[1], p.b.midpoint[1]) + 1 } })));
  let flagged = 0;
  for (const p of pairs) {
    const mid = lineMidpoint([p.a.midpoint, p.b.midpoint]);
    const nearby = queryGrid(grid, { minX: mid[0] - radiusM, maxX: mid[0] + radiusM, minZ: mid[1] - radiusM, maxZ: mid[1] + radiusM }, 1)
      .filter((n) => dist(n.midpoint, mid) <= radiusM && n.sepM !== p.sepM);
    if (nearby.length < 3) continue;
    const widths = nearby.map((n) => n.sepM).sort((a, b) => a - b);
    const med = widths[Math.floor(widths.length / 2)];
    if (med > 0 && (p.sepM > med * 2.5 || p.sepM < med / 2.5)) { p.widthContinuityOutlier = true; flagged++; }
  }
  return { flagged, totalChecked: pairs.length };
}

// ── prototype surface 化（HIGH confidence pair のみ・呼び出し側で制限する §13/§0）──
//   centerline ladder 方式（v1 と同じ思想。segment の座標をそのまま使う・改変しない）。
export function polygonFromPairSegments(segA, segB) {
  function nearestOnLine(p, line) {
    let best = line[0], bestD = Infinity;
    for (const q of line) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < bestD) { bestD = d; best = q; } }
    return best;
  }
  const ca = segA.coords, cb = segB.coords;
  const quads = [];
  for (let i = 1; i < ca.length; i++) {
    const p0 = ca[i - 1], p1 = ca[i];
    const q0 = nearestOnLine(p0, cb), q1 = nearestOnLine(p1, cb);
    quads.push([p0, p1, q1, q0]);
  }
  return quads;
}

export { MIN_SEP_M, MAX_SEP_M, INTERSECTION_RADIUS_M, INTERSECTION_DEGREE };
