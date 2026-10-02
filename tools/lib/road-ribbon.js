// tools/lib/road-ribbon.js
// [見た目改善 Mission03] 道路の centerline + 幅から「帯(ribbon)」ジオメトリを作る（THREE非依存・純粋関数）。
//   道路を「線」ではなく「薄いグレーの面」として見せる。ribbon生成の miter/clamp 安全設計は
//   RiverLayerV2（tools/lib/river-ribbon.js）と共通のものを再利用する。
// canonical。public/osaka_3d_buildings.ward-ux-v1.html の CityTileLayer に同じ計算を inline する。

import { buildRiverRibbon } from './river-ribbon.js';
import { validateRiverRibbon } from './river-ribbon-validator.js';

// [指示書3節] highway 種別ごとの既定幅(m)。実道路のおおよその全幅（路肩含む）に寄せた代表値。
export const DEFAULT_ROAD_WIDTH_M = Object.freeze({
  motorway: 17, motorway_link: 9,
  trunk: 14, trunk_link: 8,
  primary: 12, primary_link: 7,
  secondary: 9.5, secondary_link: 6,
  tertiary: 7.5, tertiary_link: 5.5,
  residential: 5.5, living_street: 4.5,
  unclassified: 4.5, service: 3.5,
});
export const ROAD_WIDTH_LIMITS = Object.freeze({ min: 2.5, max: 28 });
export const LANE_WIDTH_M = 3.25; // [指示書3節] laneWidth目安 3.0〜3.5m の中央

export function classifyRoadWidth(highway) {
  return DEFAULT_ROAD_WIDTH_M[highway] || DEFAULT_ROAD_WIDTH_M.residential;
}

export function clampRoadWidth(w) {
  if (!Number.isFinite(w) || w <= 0) return null;
  return Math.max(ROAD_WIDTH_LIMITS.min, Math.min(ROAD_WIDTH_LIMITS.max, w));
}

/**
 * [指示書3節] 道路幅を決定する。優先順位: 1. width タグ 2. lanes×laneWidth 3. highway class default。
 * @param {{highway?:string, width?:number|string, lanes?:number|string}} feature
 * @param {{laneWidth?:number}} [opts]
 * @returns {{width:number, method:'width-tag'|'lanes'|'class-default'}}
 */
export function computeRoadWidth(feature, opts = {}) {
  const f = feature || {};
  const wt = typeof f.width === 'string' ? parseFloat(f.width) : f.width;
  if (Number.isFinite(wt) && wt > 0) return { width: clampRoadWidth(wt), method: 'width-tag' };
  const ln = typeof f.lanes === 'string' ? parseFloat(f.lanes) : f.lanes;
  if (Number.isFinite(ln) && ln >= 1) {
    const lw = opts.laneWidth || LANE_WIDTH_M;
    return { width: clampRoadWidth(ln * lw), method: 'lanes' };
  }
  return { width: clampRoadWidth(classifyRoadWidth(f.highway || '')), method: 'class-default' };
}

/**
 * 道路 centerline + 幅から ribbon（left/right offset polyline + 三角形統計）を生成する。
 * miter clamp/densify は river-ribbon.js と共通（buildRiverRibbon をそのまま利用）。
 * @param {number[][]} centerline  [[x,z],...]
 * @param {number} width
 * @param {{maxSeg?:number, maxMiterRatio?:number}} [opts]
 */
export function buildRoadRibbon(centerline, width, opts = {}) {
  // maxSeg は道路の方が細かい曲率を持つため river(60m) より短め。
  return buildRiverRibbon(centerline, width, {
    maxSeg: opts.maxSeg ?? 40,
    maxMiterRatio: opts.maxMiterRatio ?? 2.75, // [指示書4節] 2.5〜3.0
  });
}

/**
 * 道路 ribbon の検証。river-ribbon-validator の汎用チェックを道路の幅上限で使う。
 * @param {object} ribbon  buildRoadRibbon の戻り値 + { id?, name?, highway?, width }
 */
export function validateRoadRibbon(ribbon) {
  // 道路はランプ・鋭角コーナーが多く局所self-crossingは避けられない（巨大三角形は
  // maxTriangleEdgeチェックで別途ERROR判定される）ため WARN 扱い。
  return validateRiverRibbon(ribbon, { widthLimits: ROAD_WIDTH_LIMITS, selfCrossingSeverity: 'warn' });
}
