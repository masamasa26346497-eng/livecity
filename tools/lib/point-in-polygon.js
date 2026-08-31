// tools/lib/point-in-polygon.js
// 点(x,z)が行政区ポリゴンのどれに属するかを判定する共通ライブラリ（P1-3）。
//
// 【設計方針】
//  - アルゴリズムは既存 tools/build-ward-poc-data.cjs / tools/split-building-tiles.js と同一の
//    even-odd レイキャスト（pointInRing）。新しい判定式は発明しない。
//  - polygon / multipolygon / hole / 飛び地 を扱う。
//  - 座標は znorth-neg-v1 のローカルメートル [x, z]。
//  - building.ward のような属性は一切参照しない。N03公式境界に対する point-in-polygon が
//    authoritative（AUTODEV/ P1-3指令）。
//
// 【境界上の点の扱い】
//  even-odd レイキャストは境界上の点について実装依存の結果を返す（頂点・辺に厳密に乗った点）。
//  行政区分類では次の方針を明示する:
//   - まず素の点で判定する。
//   - ちょうど1区にヒット → その区。
//   - 複数区に同時ヒット（またはヒット0だが近傍で揺れる） → 4近傍に微小オフセット(EPS)した点で
//     多数決を取り、決着すればその区、しなければ 'ambiguous' / null。
//  これにより「区境界の縫い目に厳密に乗った代表点」でも安定して1区へ寄せられる。

const BOUNDARY_EPS = 0.05; // メートル。区境界の縫い目に乗った点をずらして判定するための微小量。

/**
 * 点(x,z)が1リング内にあるか（even-odd レイキャスト）。
 * @param {number} x
 * @param {number} z
 * @param {number[][]} ring [[x,z],...]
 */
export function pointInRing(x, z, ring) {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], zi = ring[i][1];
    const xj = ring[j][0], zj = ring[j][1];
    const intersect = ((zi > z) !== (zj > z)) &&
      (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * 点(x,z)が「outer 内 かつ どの hole にも入っていない」か。
 * @param {number} x
 * @param {number} z
 * @param {{outer:number[][], holes?:number[][][]}} polygon
 */
export function pointInPolygonWithHoles(x, z, polygon) {
  if (!polygon || !Array.isArray(polygon.outer)) return false;
  if (!pointInRing(x, z, polygon.outer)) return false;
  for (const hole of polygon.holes || []) {
    if (pointInRing(x, z, hole)) return false;
  }
  return true;
}

function bboxContains(bbox, x, z) {
  return bbox && x >= bbox.minX && x <= bbox.maxX && z >= bbox.minZ && z <= bbox.maxZ;
}

/**
 * 点(x,z)が1区（複数polygon＝飛び地対応）に属するか。bbox即時棄却つき。
 * @param {number} x
 * @param {number} z
 * @param {{bbox?:object, polygons:Array<{outer:number[][],holes?:number[][][]}>}} ward
 */
export function pointInWard(x, z, ward) {
  if (!ward || !Array.isArray(ward.polygons)) return false;
  if (ward.bbox && !bboxContains(ward.bbox, x, z)) return false;
  for (const poly of ward.polygons) {
    if (pointInPolygonWithHoles(x, z, poly)) return true;
  }
  return false;
}

/**
 * 点(x,z)がどの区に属するかを1回だけ判定する（境界揺らし無し）。
 * @returns {{wardId:string|null, hitCount:number, hits:string[]}}
 */
function classifyOnce(x, z, wards) {
  const hits = [];
  for (const w of wards) {
    if (pointInWard(x, z, w)) hits.push(w.wardId);
  }
  return { wardId: hits.length === 1 ? hits[0] : null, hitCount: hits.length, hits };
}

/**
 * 点(x,z)を24区へ分類する。
 * @param {number} x
 * @param {number} z
 * @param {Array<{wardId:string, bbox?:object, polygons:Array}>} wards
 * @param {{boundaryEps?:number}} [options]
 * @returns {{
 *   wardId: string|null,          // 確定した区。未確定/区外は null
 *   status: 'inside'|'outside'|'ambiguous'|'boundary-resolved',
 *   hitCount: number,             // 素の点でのヒット区数
 *   resolvedBy?: 'direct'|'boundary-vote'
 * }}
 */
export function classifyPointToWard(x, z, wards, options = {}) {
  const eps = options.boundaryEps ?? BOUNDARY_EPS;
  const direct = classifyOnce(x, z, wards);

  if (direct.hitCount === 1) {
    return { wardId: direct.wardId, status: 'inside', hitCount: 1, resolvedBy: 'direct' };
  }

  // ヒット0またはヒット複数（境界の縫い目 / 隙間）。4近傍で多数決を取る。
  const neighbours = [
    [x + eps, z], [x - eps, z], [x, z + eps], [x, z - eps],
  ];
  const votes = new Map();
  for (const [nx, nz] of neighbours) {
    const r = classifyOnce(nx, nz, wards);
    if (r.hitCount === 1) votes.set(r.wardId, (votes.get(r.wardId) || 0) + 1);
  }
  let best = null;
  let bestVotes = 0;
  let tie = false;
  for (const [wardId, v] of votes) {
    if (v > bestVotes) { best = wardId; bestVotes = v; tie = false; }
    else if (v === bestVotes) { tie = true; }
  }

  if (best && !tie && bestVotes >= 2) {
    return { wardId: best, status: 'boundary-resolved', hitCount: direct.hitCount, resolvedBy: 'boundary-vote' };
  }
  if (direct.hitCount === 0 && votes.size === 0) {
    return { wardId: null, status: 'outside', hitCount: 0 };
  }
  return { wardId: null, status: 'ambiguous', hitCount: direct.hitCount };
}

export { BOUNDARY_EPS };
