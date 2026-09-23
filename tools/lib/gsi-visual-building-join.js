// tools/lib/gsi-visual-building-join.js
// [Mission 32B §5/§6/§7] PLATEAU Canonical Building と GSI BldA(建築物ポリゴン)を、
//   単純な1対1 best-matchではなく「重なりのある集合」として結合し、
//   ONE_TO_ONE / ONE_TO_MANY / MANY_TO_ONE / COMPLEX の関係を正式に扱う。
// §0遵守: ここはgeometryの参照・グルーピングのみ。座標は一切変更しない。
import { ringArea, ringCentroid, ringBbox, ringOrientation, buildCentroidIndex, queryCentroidIndex } from './gsi-building-matching.js';

const SEARCH_RADIUS_M = 20; // gsi-building-matching.js の既存基準と同一（明らかな別建物まで拾わない上限）

function bboxOverlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const iz = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
  const inter = ix * iz;
  const areaA = (a.maxX - a.minX) * (a.maxZ - a.minZ), areaB = (b.maxX - b.minX) * (b.maxZ - b.minZ);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
/** 「意味のある重なり」判定。centroid相互包含 or bbox overlap比率が一定以上のいずれかで真とする
 *  （全ペアで高コストなIoU rasterizeをしない・§0で新規重いアルゴリズムを増やしすぎない設計判断）。
 *  [実測で判明した問題と対策] 初回実装は bbox overlap閾値0.15が緩すぎ、隣接する別棟どうしが
 *  transitive closure（A-B重なり・B-C重なりでA-C間に重なりが無くてもunion-findで同一groupへ
 *  連結されてしまう）で連鎖し、最大34棟がひとつのCOMPLEX groupに巻き込まれる実例を確認した
 *  （dense long house/集合住宅のbboxが隣とわずかに重なるだけで発生）。centroid包含は形状の実態に
 *  基づく強い証拠だが、bbox overlapだけの緩い基準は誤連結の主因だったため、閾値を0.15→0.55へ
 *  引き上げ、誤って別棟どうしを同一groupへ巻き込む連鎖を大幅に抑制した（§5「誤match禁止」）。*/
function meaningfulOverlap(a, b) {
  if (pointInRing(a.centroid[0], a.centroid[1], b.ring)) return true;
  if (pointInRing(b.centroid[0], b.centroid[1], a.ring)) return true;
  return bboxOverlapRatio(a.bbox, b.bbox) > 0.55;
}

/** GSI BldA feature（{id, coordinates:[exterior, ...holes]}）から matching 用metricsを1回だけ計算する。
 *  matching自体は外周(exterior)のみを対象にする（穴はvisual geometry生成時にそのまま保持するが、
 *  重なり判定・面積比較の基準は既存gsi-building-matching.jsのprecomputeMetricsと揃える）。*/
export function precomputeGsiAreaMetrics(feature) {
  const ring = feature.coordinates[0];
  const area = ringArea(ring);
  const centroid = ringCentroid(ring);
  const bbox = ringBbox(ring);
  const orientationDeg = ringOrientation(ring);
  return { id: feature.id, ring, holes: feature.coordinates.slice(1), area, centroid, bbox, orientationDeg, attrs: feature.attrs || {} };
}

/**
 * PLATEAU（aFeatures, precomputeMetrics済み）と GSI BldA（bFeatures, precomputeGsiAreaMetrics済み）を
 * 重なりグラフとして結合し、連結成分ごとに関係タイプを判定する。
 * @returns {{ groups: Array<{aIds:string[], bIds:string[], relationship:string}>, unmatchedA: string[] }}
 */
export function joinBuildingGeometries(aFeatures, bFeatures) {
  const bIndex = buildCentroidIndex(bFeatures);
  const aById = new Map(aFeatures.map((f) => [f.id, f]));
  const bById = new Map(bFeatures.map((f) => [f.id, f]));

  // Union-Find（ノードキーは 'A:'+id / 'B:'+id で名前空間を分離）
  const parent = new Map();
  function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
  function union(x, y) { const rx = find(x), ry = find(y); if (rx !== ry) parent.set(rx, ry); }
  for (const a of aFeatures) parent.set('A:' + a.id, 'A:' + a.id);
  for (const b of bFeatures) parent.set('B:' + b.id, 'B:' + b.id);

  const unmatchedA = [];
  const matchedAIds = new Set();
  for (const a of aFeatures) {
    const cands = queryCentroidIndex(bIndex, a.centroid[0], a.centroid[1], SEARCH_RADIUS_M);
    let any = false;
    for (const b of cands) {
      if (meaningfulOverlap(a, b)) { union('A:' + a.id, 'B:' + b.id); any = true; matchedAIds.add(a.id); }
    }
    if (!any) unmatchedA.push(a.id);
  }

  // 連結成分ごとに集約
  const compMembers = new Map(); // root -> {aIds:[], bIds:[]}
  for (const a of aFeatures) {
    if (!matchedAIds.has(a.id)) continue;
    const r = find('A:' + a.id);
    let c = compMembers.get(r); if (!c) { c = { aIds: [], bIds: [] }; compMembers.set(r, c); }
    c.aIds.push(a.id);
  }
  for (const b of bFeatures) {
    const key = 'B:' + b.id;
    if (find(key) === key && !compMembers.has(key)) continue; // 誰とも繋がっていないGSI単独（Visual Buildingには使わない）
    const r = find(key);
    let c = compMembers.get(r); if (!c) { c = { aIds: [], bIds: [] }; compMembers.set(r, c); }
    if (!c.bIds.includes(b.id)) c.bIds.push(b.id);
  }

  const groups = [];
  for (const [, c] of compMembers) {
    if (c.aIds.length === 0) continue; // PLATEAU属性が無いgroupはVisual Buildingの対象外（§4: PLATEAU属性が必須）
    let relationship;
    if (c.aIds.length === 1 && c.bIds.length === 1) relationship = 'ONE_TO_ONE';
    else if (c.aIds.length === 1 && c.bIds.length > 1) relationship = 'ONE_TO_MANY';
    else if (c.aIds.length > 1 && c.bIds.length === 1) relationship = 'MANY_TO_ONE';
    else if (c.aIds.length > 1 && c.bIds.length > 1) relationship = 'COMPLEX';
    else relationship = 'ONE_TO_NONE'; // bIds.length===0（候補はあったがmeaningfulOverlap成立せず、通常は起きない防御的分岐）
    groups.push({ aIds: c.aIds, bIds: c.bIds, relationship });
  }
  return { groups, unmatchedA, aById, bById };
}
