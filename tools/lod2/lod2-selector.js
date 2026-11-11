// tools/lod2/lod2-selector.js  (Mission 152, 独立モジュール)
//
// 元PLATEAUの建物ID(gml:id)でLOD1/LOD2を1対1照合し、「各建物をどちらで描くか」を決める純関数群。
// 既存の建物変換・地名ラベル・駅UIには一切触れない。ネットワーク不要・実GML/fixture両対応。
//
// 原則:
//   - LOD2の実幾何(Roof/Wall/Ground)が検証を通った建物だけ LOD2 を描き、その建物の LOD1 は描かない。
//   - それ以外(LOD2欠損/幾何不正/容量超過)は LOD1 にフォールバック。AI推定屋根は作らない。
//   - lod1Draw と lod2Draw は常に互いに素(重なり・z-fighting防止)。
import {
  splitBuildings, analyzeBuilding, extractSurfacePosLists, summarizeBuildingGeometry,
} from '../lib/citygml.js';

export const FALLBACK = Object.freeze({
  NO_LOD2: 'no-lod2-geometry',
  NO_ENVELOPE: 'lod2-missing-roof-or-wall',
  INVALID_GEOMETRY: 'lod2-invalid-geometry',
  OVER_TRIANGLE_BUDGET: 'lod2-over-triangle-budget',
  OVER_BYTE_BUDGET: 'lod2-over-byte-budget',
  NOT_IN_LOD1: 'lod2-id-not-in-lod1',
});

function ringOf(poly) {
  const a = poly[0], b = poly[poly.length - 1];
  return poly.length > 1 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] ? poly.slice(0, -1) : poly;
}

/** 1棟分のLOD2診断(屋根高さ/底面/有効性/テクスチャ有無)。 */
export function diagnoseLod2Building(bldgXml) {
  const a = analyzeBuilding(bldgXml);
  const roofs = extractSurfacePosLists(bldgXml, 'Roof');
  const walls = extractSurfacePosLists(bldgXml, 'Wall');
  const grounds = extractSurfacePosLists(bldgXml, 'Ground');
  const hasLod2 = a.hasLod2Solid || a.hasLod2MultiSurface;
  let valid = true;
  const problems = [];
  let roofTop = -Infinity, roofLow = Infinity, base = Infinity;
  for (const poly of [...roofs, ...walls, ...grounds]) {
    const ring = ringOf(poly);
    if (ring.length < 3 || ring.some((p) => p.some((v) => !Number.isFinite(v)))) {
      valid = false; problems.push('degenerate-ring');
    }
  }
  for (const poly of roofs) for (const p of poly) { roofTop = Math.max(roofTop, p[2]); roofLow = Math.min(roofLow, p[2]); }
  for (const poly of grounds.length ? grounds : walls) for (const p of poly) base = Math.min(base, p[2]);
  const hasEnvelope = roofs.length > 0 && walls.length > 0;
  if (hasEnvelope && Number.isFinite(roofTop) && Number.isFinite(base) && roofTop <= base) {
    valid = false; problems.push('roof-not-above-base');
  }
  const geo = summarizeBuildingGeometry(bldgXml);
  return {
    id: a.id,
    hasLod2,
    hasEnvelope,
    valid,
    problems: [...new Set(problems)],
    roofTopM: Number.isFinite(roofTop) ? roofTop : null,
    baseM: Number.isFinite(base) ? base : null,
    heightM: Number.isFinite(roofTop) && Number.isFinite(base) ? +(roofTop - base).toFixed(3) : null,
    roofRelief: Number.isFinite(roofTop) ? +(roofTop - roofLow).toFixed(3) : null, // >0: 屋根に勾配/形状あり
    triangles: geo.triangleCountApprox,
    surfaceCount: geo.surfaceCount,
    hasTexture: /<(?:\w+:)?(?:ParameterizedTexture|imageURI)\b/.test(bldgXml) || /appearanceMember/.test(bldgXml),
  };
}

/** CityGML(複数可)からLOD2インデックス Map<id, diag> を作る。LOD2を持たない建物は含めない。 */
export function buildLod2Index(gmlXmls) {
  const index = new Map();
  let total = 0;
  for (const xml of gmlXmls) {
    for (const b of splitBuildings(xml)) {
      total++;
      const d = diagnoseLod2Building(b);
      if (d.id && d.hasLod2) index.set(d.id, d);
    }
  }
  return { index, totalBuildings: total };
}

/**
 * 描画元の決定。
 * @param {Iterable<string>} lod1Ids  既存LOD1(24区574,213棟など)の建物ID
 * @param {Map<string,object>} lod2Index buildLod2Index().index
 * @param {{maxTrianglesPerBuilding?:number, maxTotalTriangles?:number}} [opts] 容量超過はLOD1へ
 */
export function planBuildingSources(lod1Ids, lod2Index, opts = {}) {
  const maxPer = opts.maxTrianglesPerBuilding ?? 5000;
  const maxTotal = opts.maxTotalTriangles ?? Infinity;
  const lod1Set = new Set(lod1Ids);
  const lod2Draw = new Set();
  const lod1Draw = new Set(lod1Set);
  const fallbacks = new Map(); // id -> reason (LOD1に残した理由。LOD2を持つ建物のみ)
  let tri = 0;
  for (const [id, d] of lod2Index) {
    let reason = null;
    if (!lod1Set.has(id)) reason = FALLBACK.NOT_IN_LOD1;
    else if (!d.hasEnvelope) reason = FALLBACK.NO_ENVELOPE;
    else if (!d.valid) reason = FALLBACK.INVALID_GEOMETRY;
    else if (d.triangles > maxPer) reason = FALLBACK.OVER_TRIANGLE_BUDGET;
    else if (tri + d.triangles > maxTotal) reason = FALLBACK.OVER_BYTE_BUDGET;
    if (reason) { fallbacks.set(id, reason); continue; }
    lod2Draw.add(id); lod1Draw.delete(id); tri += d.triangles;
  }
  return {
    lod1Draw, lod2Draw, fallbacks,
    stats: {
      lod1Total: lod1Set.size, lod2Candidates: lod2Index.size, lod2Used: lod2Draw.size,
      lod2Ratio: lod1Set.size ? +(lod2Draw.size / lod1Set.size).toFixed(6) : 0,
      lod2Triangles: tri,
      withTexture: [...lod2Draw].filter((i) => lod2Index.get(i).hasTexture).length,
    },
  };
}

/** 排他性検査(重なり防止): 共通IDが1件でもあれば失敗。 */
export function assertDisjoint(plan) {
  const dup = [...plan.lod2Draw].filter((id) => plan.lod1Draw.has(id));
  if (dup.length) throw new Error(`LOD1/LOD2 overlap: ${dup.length} ids (e.g. ${dup[0]})`);
  return true;
}

/**
 * カメラ距離による表現選択。遠景=LOD1(低負荷)、近景=LOD2。ヒステリシスで境界のちらつき・再ロードを防ぐ。
 * @param {number} distanceM カメラ〜建物距離
 * @param {'lod1'|'lod2'} [current] 現在の表現
 */
export function pickRepresentation(distanceM, current = 'lod1', { nearM = 400, farM = 520 } = {}) {
  if (current === 'lod2') return distanceM > farM ? 'lod1' : 'lod2';
  return distanceM < nearM ? 'lod2' : 'lod1';
}
