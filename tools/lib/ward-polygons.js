// tools/lib/ward-polygons.js
// N03行政区境界（tools/ingest/n03-administrative-boundaries.js の出力、flat な rings[] 配列）から、
// point-in-polygon 判定用の {outer, holes} 構造へ再構成する（P1-3）。
//
// 【背景】convertGeometryToRings() は MultiPolygon を [poly0.outer, poly0.hole..., poly1.outer, ...]
// のように flat 化するため、「どのリングがどのポリゴンの穴か」という構造が失われている。
// ここでは巻き順に依存せず、包含関係（ネスト深さ）で outer / hole を復元する:
//   - あるリングを内包する「より大きいリング」の数が 偶数(0,2,..) → outer（新しいポリゴン）
//   - 奇数(1,3,..) → hole（それを内包する最小の outer に属する）
// 飛び地（disjoint な outer 複数）・穴・穴の中の島 をすべて扱える。

import { pointInRing } from './point-in-polygon.js';
import { representativePoint } from './building-representative-point.js';

// 【座標軸の整合チェック用リファレンス】
// Live City本体HTMLの TOWN_POLYGONS（住吉区・東住吉区・平野区、znorth-neg-v1）から実測した
// 各区の全町丁目頂点centroid（x, z）。znorth-neg-v1 は「北 = z が負」。
// N03取り込み（tools/lib/projection.js の geoToLocal）は「北 = z が正」で変換するため、
// N03側の z 符号が反転している。build-ward-polygons.js はここと突き合わせて z 軸を自動補正する。
const REFERENCE_KNOWN_WARD_CENTROIDS_ZNN = {
  sumiyoshi: [-1849, -283],
  higashisumiyoshi: [616, -1610],
  hirano: [3298, -1120],
};

function ringSignedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  // 閉じていない場合の最終辺
  const n = ring.length;
  a += ring[n - 1][0] * ring[0][1] - ring[0][0] * ring[n - 1][1];
  return a / 2;
}

function ringBbox(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

function unionBbox(boxes) {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const x of boxes) {
    if (x.minX < b.minX) b.minX = x.minX;
    if (x.maxX > b.maxX) b.maxX = x.maxX;
    if (x.minZ < b.minZ) b.minZ = x.minZ;
    if (x.maxZ > b.maxZ) b.maxZ = x.maxZ;
  }
  return b;
}

// リング内部の点（包含テスト用）。頂点平均が内部なら採用、そうでなければスキャンラインで求める。
function ringInteriorPoint(ring) {
  const rp = representativePoint(ring);
  if (rp.valid && pointInRing(rp.x, rp.z, ring)) return [rp.x, rp.z];
  // フォールバック: 最初の3頂点の重心
  const [a, b, c] = ring;
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
}

/**
 * flat な rings[] を {outer, holes}[] の配列（＝1区分のポリゴン群）へ再構成する。
 * @param {number[][][]} rings
 * @returns {{polygons:Array<{outer:number[][],holes:number[][][]}>, ringCount:number}}
 */
export function reconstructPolygons(rings) {
  const valid = (rings || []).filter((r) => Array.isArray(r) && r.length >= 3);
  const meta = valid.map((ring) => ({
    ring,
    area: Math.abs(ringSignedArea(ring)),
    bbox: ringBbox(ring),
    interior: ringInteriorPoint(ring),
  }));
  meta.sort((a, b) => b.area - a.area); // 大きい順

  const polygons = [];
  for (let i = 0; i < meta.length; i++) {
    let depth = 0;
    let smallestContainer = null;
    let smallestContainerArea = Infinity;
    for (let k = 0; k < i; k++) {
      const outerCand = meta[k];
      const [px, pz] = meta[i].interior;
      if (px < outerCand.bbox.minX || px > outerCand.bbox.maxX || pz < outerCand.bbox.minZ || pz > outerCand.bbox.maxZ) continue;
      if (pointInRing(px, pz, outerCand.ring)) {
        depth++;
        if (outerCand.area < smallestContainerArea) {
          smallestContainerArea = outerCand.area;
          smallestContainer = outerCand;
        }
      }
    }
    if (depth % 2 === 0) {
      const poly = { outer: closeRing(meta[i].ring), holes: [] };
      meta[i]._poly = poly;
      polygons.push(poly);
    } else {
      // hole: 内包する最小の outer polygon に付ける
      if (smallestContainer && smallestContainer._poly) {
        smallestContainer._poly.holes.push(closeRing(meta[i].ring));
      } else {
        // どの outer にも紐づけられない hole（データ不整合）→ outer として扱い、捨てない
        const poly = { outer: closeRing(meta[i].ring), holes: [] };
        meta[i]._poly = poly;
        polygons.push(poly);
      }
    }
  }
  return { polygons, ringCount: valid.length };
}

function closeRing(ring) {
  const n = ring.length;
  if (n >= 3 && (ring[0][0] !== ring[n - 1][0] || ring[0][1] !== ring[n - 1][1])) {
    return [...ring, ring[0]];
  }
  return ring;
}

function wardOuterCentroid(polygons) {
  let sx = 0, sz = 0, n = 0;
  for (const poly of polygons) for (const [x, z] of poly.outer) { sx += x; sz += z; n++; }
  return n ? [sx / n, sz / n] : [0, 0];
}

/**
 * 取り込み済み rings（geoToLocal 由来 = 北がz正）が、Live City本体の znorth-neg-v1（北がz負）と
 * z 軸の向きが一致しているかを、住吉区・東住吉区・平野区の実測centroidと突き合わせて判定する。
 * @returns {{needsNegate:boolean, matches:number, mismatches:number, detail:string[]}}
 */
export function detectZAxisOrientation(wards) {
  let matches = 0, mismatches = 0;
  const detail = [];
  for (const [wardId, ref] of Object.entries(REFERENCE_KNOWN_WARD_CENTROIDS_ZNN)) {
    const w = wards.find((x) => x.wardId === wardId);
    if (!w) continue;
    const [, cz] = wardOuterCentroid(w.polygons);
    const refZ = ref[1];
    // 参照の |z| が十分大きい区（東住吉区・平野区）で符号を比較する。住吉区は原点近くで曖昧。
    if (Math.abs(refZ) < 500) { detail.push(`${wardId}: 参照z=${refZ} は原点近くで判定に使わない`); continue; }
    const same = Math.sign(cz) === Math.sign(refZ);
    if (same) matches++; else mismatches++;
    detail.push(`${wardId}: N03 z=${cz.toFixed(0)} / 参照(znorth-neg-v1) z=${refZ} → ${same ? '一致' : '反転'}`);
  }
  return { needsNegate: mismatches > matches, matches, mismatches, detail };
}

function negateZ(wards) {
  for (const w of wards) {
    for (const poly of w.polygons) {
      poly.outer = poly.outer.map(([x, z]) => [x, -z]);
      poly.holes = poly.holes.map((h) => h.map(([x, z]) => [x, -z]));
    }
    w.bbox = { minX: w.bbox.minX, maxX: w.bbox.maxX, minZ: -w.bbox.maxZ, maxZ: -w.bbox.minZ };
  }
}

/**
 * N03取り込みペイロード（{records:[{wardId,wardCode,wardName,geometry:{rings}}]}）から
 * Ward polygon データセットを構築する。
 * @param {{records:object[], metadata?:object}} payload
 * @param {{registry?:object, zAxis?:'auto'|'as-is'|'negate'}} [options]
 *   zAxis: 取り込み rings の z 軸の扱い。
 *     'auto'   (既定) … 住吉区・東住吉区・平野区の実測centroidと突き合わせ、znorth-neg-v1 と
 *                        z 符号が反転していれば自動で negate する。
 *     'as-is'  … 何もしない（rings をそのまま使う）。
 *     'negate' … 無条件に z を反転する。
 * @returns {{
 *   coordinateConvention:string, zAxisApplied:string, zAxisDetection:object,
 *   wards:Array<{wardId,wardCode,wardName,polygonCount,holeCount,exclaveCount,bbox,polygons}>,
 *   metadata:object
 * }}
 */
export function buildWardPolygons(payload, options = {}) {
  if (!payload || !Array.isArray(payload.records)) {
    throw new Error('buildWardPolygons: payload.records が配列ではありません。');
  }
  const conventions = new Set();
  const wards = [];
  for (const rec of payload.records) {
    const geom = rec.geometry || {};
    if (!Array.isArray(geom.rings)) {
      throw new Error(`buildWardPolygons: ${rec.wardId} の geometry.rings がありません（未変換の生WGS84は非対応。--area osaka-city で変換済みの取り込み出力を使ってください）。`);
    }
    if (geom.coordinateConvention) conventions.add(geom.coordinateConvention);
    const { polygons } = reconstructPolygons(geom.rings);
    const bbox = unionBbox(polygons.map((p) => ringBbox(p.outer)));
    const holeCount = polygons.reduce((s, p) => s + p.holes.length, 0);
    wards.push({
      wardId: rec.wardId,
      wardCode: rec.wardCode,
      wardName: rec.wardName,
      polygonCount: polygons.length,
      exclaveCount: Math.max(0, polygons.length - 1),
      holeCount,
      bbox,
      polygons,
    });
  }
  if (conventions.size > 1) {
    throw new Error(`buildWardPolygons: coordinateConvention が混在しています: ${[...conventions].join(', ')}`);
  }

  const zAxis = options.zAxis || 'auto';
  const detection = detectZAxisOrientation(wards);
  let zAxisApplied = 'as-is';
  if (zAxis === 'negate' || (zAxis === 'auto' && detection.needsNegate)) {
    negateZ(wards);
    zAxisApplied = 'negate';
  }

  return {
    coordinateConvention: 'znorth-neg-v1',
    zAxisApplied,
    zAxisDetection: detection,
    wards,
    metadata: {
      generatedFrom: 'data/processed/osaka-city/boundaries/administrative-boundaries.json',
      sourceCoordinateConvention: conventions.size ? [...conventions][0] : null,
      zAxisApplied,
      zAxisNote: zAxisApplied === 'negate'
        ? 'N03取り込み(geoToLocal)は北=z正で出力するが、Live City本体は znorth-neg-v1(北=z負)。住吉区・東住吉区・平野区の実測centroidで z 反転を検出し、z を negate して znorth-neg-v1 に揃えた。上流(tools/lib/n03-boundaries.js / projection.js)の恒久修正は別途要判断。'
        : 'z 軸補正なし（取り込み rings をそのまま使用）。',
      sourceMetadata: payload.metadata || null,
      wardCount: wards.length,
      note: '行政区分類の authoritative source。building.ward 属性は使用しない。point-in-polygon は tools/lib/point-in-polygon.js。',
    },
  };
}

export { ringBbox, ringSignedArea };
