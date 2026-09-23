// tools/lib/osm-fallback-v2-classify.js
// [Mission 32O] OSM fallback を Corrected PLATEAU V2 基準で選び直すための純粋ロジック（THREE / fs 非依存）。
//
//   旧 fallback（Mission 21B/29）は、回転していた V1 PLATEAU を基準に
//   「PLATEAU が無い場所」を選び、centroid-in-polygon / bbox IoU だけで重複を判定していた。
//   ここでは V2 PLATEAU との**面積ベースの重なり**を 1 棟ずつ測り、4 分類する（§4/§5/§9）。
//
//   計測値（OSM 1 棟あたり）:
//     osmArea            OSM footprint の面積（厳密）
//     intersectionArea   OSM ∩（重なる PLATEAU の和集合）の面積（サンプリング）
//     coveredFraction    intersectionArea / osmArea
//     plateauPartners    OSM と実際に重なる PLATEAU 棟数（one-to-many の検出）
//     maxIoU             PLATEAU 1 棟ごとの IoU の最大値
//     maxPlateauInside   PLATEAU 1 棟のうち OSM の内側にある割合の最大値（OSM が PLATEAU を包む逆方向）
//     centroidInPlateau  OSM の重心がいずれかの PLATEAU の内側か
//     maxBboxIoU         旧ルールと同じ bbox IoU の最大値
//     nearestDistanceM   重ならない場合の PLATEAU までの最短距離（重なれば 0。探索半径外は null）
//   **単純な nearest だけでは判定しない**（§9）。距離は参考値で、分類には使わない。
import { ringArea, ringBbox, ringCentroid, pointInRingXZ } from './osm-building-fallback.js';

export const FALLBACK_V2_CLASS = Object.freeze({
  CLEAR_DUPLICATE: 'CLEAR_DUPLICATE',
  LIKELY_DUPLICATE: 'LIKELY_DUPLICATE',
  AMBIGUOUS: 'AMBIGUOUS',
  VALID_FALLBACK: 'VALID_FALLBACK',
});

// 閾値（根拠は data/reports/osm-fallback-v2-rebuild.json の thresholdRationale）
export const TH = Object.freeze({
  clearCovered: 0.5,       // OSM の半分以上が PLATEAU と重なる → 同一建物
  clearIoU: 0.5,           // PLATEAU 1 棟と IoU 0.5 以上 → 同一建物
  likelyCovered: 0.2,      // 2 割以上重なる → 同一建物の可能性が高い
  likelyBboxIoU: 0.3,      // 旧ルール（validator 側の値）
  likelyPlateauInside: 0.5, // PLATEAU 1 棟の半分以上が OSM の内側、かつ
  likelyPlateauShare: 0.3,  //   その PLATEAU が OSM 面積の 3 割以上 → OSM は PLATEAU を包む輪郭
  // LIKELY でも「重ならない部分が独立した建物ほど大きい」ものは落とさない（§7: 別建物を誤って落とさない）
  keepUncoveredM2: 60,
  keepCoveredBelow: 0.35,
  ambiguousCovered: 0.02,  // 2% 以上の重なりは AMBIGUOUS（残すが別計上）
});

function bboxIoU(a, b) {
  const ox = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const oz = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
  const inter = ox * oz;
  const u = (a.maxX - a.minX) * (a.maxZ - a.minZ) + (b.maxX - b.minX) * (b.maxZ - b.minZ) - inter;
  return u > 0 ? inter / u : 0;
}
const bboxOverlap = (a, b) => a.maxX >= b.minX && a.minX <= b.maxX && a.maxZ >= b.minZ && a.minZ <= b.maxZ;

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L = dx * dx + dz * dz;
  let t = L > 0 ? ((px - ax) * dx + (pz - az) * dz) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
/** 2 リング間の最短距離（頂点↔辺の両方向。交差しない前提の近似。重なりは呼び出し側で 0 にする）。 */
export function ringDistance(r1, r2) {
  let d = Infinity;
  for (const [a, b] of [[r1, r2], [r2, r1]]) {
    for (const p of a) {
      for (let i = 0, j = b.length - 1; i < b.length; j = i++) {
        const v = segDist(p[0], p[1], b[j][0], b[j][1], b[i][0], b[i][1]);
        if (v < d) d = v;
      }
    }
  }
  return d;
}

/** PLATEAU footprint の grid index（{id, ring, bb, area}）。 */
export function buildPlateauIndex(plateau, cellM = 40) {
  const grid = new Map();
  for (const p of plateau) {
    const bb = p.bb || ringBbox(p.ring);
    const rec = { id: p.id, ring: p.ring, bb, area: p.area != null ? p.area : ringArea(p.ring) };
    for (let cx = Math.floor(bb.minX / cellM); cx <= Math.floor(bb.maxX / cellM); cx++)
      for (let cz = Math.floor(bb.minZ / cellM); cz <= Math.floor(bb.maxZ / cellM); cz++) {
        const k = cx + ',' + cz;
        let a = grid.get(k); if (!a) grid.set(k, (a = []));
        a.push(rec);
      }
  }
  return { grid, cellM };
}
function query(index, bb, pad = 0) {
  const out = new Set();
  const cm = index.cellM;
  for (let cx = Math.floor((bb.minX - pad) / cm); cx <= Math.floor((bb.maxX + pad) / cm); cx++)
    for (let cz = Math.floor((bb.minZ - pad) / cm); cz <= Math.floor((bb.maxZ + pad) / cm); cz++)
      for (const r of index.grid.get(cx + ',' + cz) || []) out.add(r);
  return out;
}

/** サンプリング間隔（1 棟あたり概ね 2,000 点）。 */
export function sampleStep(area) { return Math.max(0.25, Math.sqrt(area / 2000)); }

/**
 * OSM footprint 1 棟の、V2 PLATEAU に対する重なり計測（§4）。
 * @param {number[][]} ring  OSM 外周（閉じ点なし）
 * @param {{grid,cellM}} index  buildPlateauIndex の戻り値
 * @param {{searchM?:number}} [opts]
 */
export function measureOverlap(ring, index, { searchM = 50 } = {}) {
  const osmArea = ringArea(ring);
  const bb = ringBbox(ring);
  const c = ringCentroid(ring);
  const near = query(index, bb, searchM);
  const cands = [];
  let centroidInPlateau = false, maxBboxIoU = 0;
  for (const r of near) {
    if (bboxOverlap(bb, r.bb)) {
      cands.push({ r, hits: 0 });
      const bi = bboxIoU(bb, r.bb); if (bi > maxBboxIoU) maxBboxIoU = bi;
      if (!centroidInPlateau && c[0] >= r.bb.minX && c[0] <= r.bb.maxX && c[1] >= r.bb.minZ && c[1] <= r.bb.maxZ && pointInRingXZ(c[0], c[1], r.ring)) centroidInPlateau = true;
    }
  }
  const step = sampleStep(osmArea);
  let inside = 0, covered = 0;
  if (cands.length) {
    for (let x = bb.minX + step / 2; x < bb.maxX; x += step) {
      for (let z = bb.minZ + step / 2; z < bb.maxZ; z += step) {
        if (!pointInRingXZ(x, z, ring)) continue;
        inside++;
        let any = false;
        for (const cd of cands) {
          const b = cd.r.bb;
          if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
          if (pointInRingXZ(x, z, cd.r.ring)) { cd.hits++; any = true; }
        }
        if (any) covered++;
      }
    }
  }
  // 極小・細長で 1 点も落ちない場合は頂点平均で 1 点だけ見る
  if (cands.length && inside === 0) {
    inside = 1;
    let any = false;
    for (const cd of cands) if (pointInRingXZ(c[0], c[1], cd.r.ring)) { cd.hits++; any = true; }
    if (any) covered = 1;
  }
  const coveredFraction = inside ? covered / inside : 0;
  const cellArea = inside ? osmArea / inside : 0; // サンプル 1 点あたりの面積（osmArea に合わせて正規化）
  let maxIoU = 0, maxPlateauInside = 0, maxPlateauInsideShare = 0, partners = 0;
  const partnerIds = [];
  for (const cd of cands) {
    if (!cd.hits) continue;
    partners++; partnerIds.push(cd.r.id);
    const inter = cd.hits * cellArea;
    const iou = inter / (osmArea + cd.r.area - inter);
    if (iou > maxIoU) maxIoU = iou;
    const insideFrac = Math.min(1, inter / cd.r.area);
    if (insideFrac > maxPlateauInside || (insideFrac === maxPlateauInside && cd.r.area / osmArea > maxPlateauInsideShare)) {
      maxPlateauInside = insideFrac; maxPlateauInsideShare = cd.r.area / osmArea;
    }
  }
  let nearestDistanceM = null;
  if (covered > 0) nearestDistanceM = 0;
  else {
    let d = Infinity;
    for (const r of near) {
      // bbox 間距離で枝刈り
      const gx = Math.max(0, r.bb.minX - bb.maxX, bb.minX - r.bb.maxX), gz = Math.max(0, r.bb.minZ - bb.maxZ, bb.minZ - r.bb.maxZ);
      if (Math.hypot(gx, gz) >= d || Math.hypot(gx, gz) > searchM) continue;
      const v = ringDistance(ring, r.ring); if (v < d) d = v;
    }
    nearestDistanceM = Number.isFinite(d) && d <= searchM ? d : null;
  }
  return {
    osmArea, intersectionArea: covered * cellArea, coveredFraction,
    plateauPartners: partners, partnerIds: partnerIds.slice(0, 8),
    maxIoU, maxPlateauInside, maxPlateauInsideShare,
    centroidInPlateau, maxBboxIoU, nearestDistanceM,
    samples: inside, stepM: step,
  };
}

/**
 * 計測値 → 分類（§5-§9）。戻り値 {cls, rule}。
 *   CLEAR / LIKELY は fallback から除外、AMBIGUOUS / VALID は残す（AMBIGUOUS は別計上）。
 */
export function classifyOverlap(m) {
  const C = FALLBACK_V2_CLASS;
  if (m.coveredFraction >= TH.clearCovered) return { cls: C.CLEAR_DUPLICATE, rule: 'covered>=' + TH.clearCovered };
  if (m.maxIoU >= TH.clearIoU) return { cls: C.CLEAR_DUPLICATE, rule: 'iou>=' + TH.clearIoU };
  const envelops = m.maxPlateauInside >= TH.likelyPlateauInside && m.maxPlateauInsideShare >= TH.likelyPlateauShare;
  const likely = m.coveredFraction >= TH.likelyCovered || m.centroidInPlateau || envelops || m.maxBboxIoU >= TH.likelyBboxIoU;
  if (likely) {
    const uncovered = m.osmArea - m.intersectionArea;
    // 重ならない部分が十分大きく、重なりも小さい → 別建物が一部重なっているだけの可能性。落とさない。
    if (uncovered >= TH.keepUncoveredM2 && m.coveredFraction < TH.keepCoveredBelow && !envelops) {
      return { cls: C.AMBIGUOUS, rule: 'likely-but-large-uncovered' };
    }
    const why = m.coveredFraction >= TH.likelyCovered ? 'covered>=' + TH.likelyCovered
      : m.centroidInPlateau ? 'centroid-in-plateau' : envelops ? 'osm-envelops-plateau' : 'bbox-iou>=' + TH.likelyBboxIoU;
    return { cls: C.LIKELY_DUPLICATE, rule: why };
  }
  if (m.coveredFraction >= TH.ambiguousCovered) return { cls: C.AMBIGUOUS, rule: 'covered>=' + TH.ambiguousCovered };
  return { cls: C.VALID_FALLBACK, rule: 'no-overlap' };
}

export const isRetainedClass = (cls) => cls === FALLBACK_V2_CLASS.VALID_FALLBACK || cls === FALLBACK_V2_CLASS.AMBIGUOUS;
