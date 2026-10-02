// tools/lib/footprint-ward-overlap.js
// P1-5 #5: 建物フットプリントと Ward polygon の「重なり面積」による救済分類。
//
// 優先順位（P1-5指令）:
//   1. point-in-polygon（代表点が1区に入る）        … tools/lib/point-in-polygon.js
//   2. footprint と Ward polygon の面積重複（本ファイル）… 代表点がどの区にも入らない建物のみ対象
//   3. それでも不明なら unclassified
//
// 面積重複はフットプリント bbox のグリッドサンプリングで近似する（建物は数十m規模で
// 行政界のすぐ外にあるものが対象のため、グリッド近似で十分な精度が出る）。
// nearestWardId / nearestWardDistance は診断情報としてのみ使い、救済判定には使わない。

import { pointInRing, pointInWard } from './point-in-polygon.js';

function bboxOf(fp) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of fp) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * フットプリントと各区の重なり率を、フットプリント面積を1としたときの比で返す。
 * @param {number[][]} fp  建物フットプリント [[x,z],...]
 * @param {Array} wards    ward-classification-polygons.json の wards[]（bbox / polygons を持つ）
 * @param {{grid?:number, minCoverage?:number}} [opts] grid=一辺のサンプル数, minCoverage=救済に必要な最小重なり率
 * @returns {{
 *   wardId: string|null,      // 救済分類先（minCoverage 未満なら null）
 *   coverage: number,         // 上記区の重なり率（0..1）
 *   inFootprintSamples: number,
 *   perWard: Record<string, number>,  // 区ごとの重なり率
 *   method: 'footprint-overlap'|'none'
 * }}
 */
export function rescueByFootprintOverlap(fp, wards, opts = {}) {
  const grid = opts.grid ?? 12;
  const minCoverage = opts.minCoverage ?? 0.5;
  if (!Array.isArray(fp) || fp.length < 3) return { wardId: null, coverage: 0, inFootprintSamples: 0, perWard: {}, method: 'none' };

  const bb = bboxOf(fp);
  const perWardHits = {};
  let inFp = 0;
  for (let i = 0; i < grid; i++) {
    const x = bb.minX + ((bb.maxX - bb.minX) * (i + 0.5)) / grid;
    for (let j = 0; j < grid; j++) {
      const z = bb.minZ + ((bb.maxZ - bb.minZ) * (j + 0.5)) / grid;
      if (!pointInRing(x, z, fp)) continue;
      inFp++;
      // この点が入る区（1区のみ想定。複数入る＝Ward polygon重複はP1-3 validatorで排除済み）
      for (const w of wards) {
        if (pointInWard(x, z, w)) { perWardHits[w.wardId] = (perWardHits[w.wardId] || 0) + 1; break; }
      }
    }
  }
  const perWard = {};
  let best = null, bestCov = 0;
  for (const [wardId, hits] of Object.entries(perWardHits)) {
    const cov = inFp ? hits / inFp : 0;
    perWard[wardId] = Math.round(cov * 1000) / 1000;
    if (cov > bestCov) { bestCov = cov; best = wardId; }
  }
  return {
    wardId: bestCov >= minCoverage ? best : null,
    coverage: Math.round(bestCov * 1000) / 1000,
    inFootprintSamples: inFp,
    perWard,
    method: bestCov >= minCoverage ? 'footprint-overlap' : 'none',
  };
}
