// tools/lib/major-building-lod.js
// [Mission27] 中景（MID band）用・主要建物LODの純粋ロジック（THREE / DOM 非依存）。
//   遠景 CityBuildingLOD（密度mesh）と近景 BuildingTileLayer（詳細）の中間に、
//   「主要建物・高層建物だけを簡易ブロックで表示する」中間LODを入れる。
//   canonical。public/osaka_3d_buildings.ward-ux-v1.html の CityBuildingLOD が同じ判定を inline する。

// §2 主要建物の選定基準（実データ分布監査で調整。data/reports/major-building-lod.json 参照）。
export const MAJOR_MIN_HEIGHT_M = 30;      // ≈10階建て。高層・中高層
export const MAJOR_MIN_FP_AREA_M2 = 3000;  // 駅ビル・大型商業・大規模公共施設

// §1 距離バンド。道路・河川・鉄道・公園と同じ FAR 境界（9000m）。NEAR は既存 HIDE_NEAR_M=4000 と整合。
export const MID_MAX_M = 9000;
export const HIDE_NEAR_M = 4000;

/** footprint（[x,z] 配列）の面積 m²。 */
export function fpAreaXZ(fp) {
  if (!Array.isArray(fp) || fp.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < fp.length; i++) {
    const p = fp[i], q = fp[(i + 1) % fp.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/**
 * 建物が「主要建物」か。height>=30m OR footprintArea>=3000m² OR landmark。
 * @param {{id?:string, dz?:number, h?:number, fp?:number[][]}} b
 * @param {{landmarkIds?:Set<string>}} [opts]
 */
export function isMajorBuilding(b, opts = {}) {
  if (!b) return false;
  const h = (typeof b.dz === 'number') ? b.dz : (typeof b.h === 'number' ? b.h : 0);
  if (h >= MAJOR_MIN_HEIGHT_M) return true;
  if (fpAreaXZ(b.fp) >= MAJOR_MIN_FP_AREA_M2) return true;
  if (opts.landmarkIds && b.id != null && opts.landmarkIds.has(b.id)) return true;
  return false;
}

/** camera 距離 → 'far' | 'mid' | 'near'。 */
export function bandForDistance(r) {
  const d = Number.isFinite(r) ? r : Infinity;
  if (d > MID_MAX_M) return 'far';
  if (d > HIDE_NEAR_M) return 'mid';
  return 'near';
}

/**
 * camera 距離 → { minor, major } の表示可否。
 *   far  : minor=true  major=true   （＝従来の密度mesh。全建物）
 *   mid  : minor=false major=true   （主要建物だけ＝都市の輪郭）
 *   near : minor=false major=false  （BuildingTileLayer 実体へ handoff）
 */
export function bucketVisibility(r) {
  const band = bandForDistance(r);
  return { band, minor: band === 'far', major: band === 'far' || band === 'mid' };
}

/**
 * §2 主要建物選定の実データ監査。
 * @param {object} o
 * @param {Array<{id?:string, dz?:number, h?:number, fp?:number[][], repX?:number, repZ?:number}>} o.buildings
 * @param {Set<string>} [o.landmarkIds]
 * @param {Array<{wardId:string, polygons:Array<{outer:number[][], holes?:number[][][]}>}>} [o.wards]  区別集計用
 * @returns {object}
 */
export function auditMajorBuildingLod(o) {
  const buildings = o.buildings || [];
  const landmarkIds = o.landmarkIds || new Set();
  const wards = o.wards || [];

  const heightHist = {}, areaHist = {};
  let total = 0, byHeight = 0, byArea = 0, byLandmark = 0, selected = 0, heightUnknown = 0;
  const selectedIdsByWard = {};

  const wIndex = wards.map((w) => ({ wardId: w.wardId, polys: (w.polygons || []).map((pg) => ({ outer: pg.outer || [], holes: pg.holes || [] })) }));
  const pnpoly = (x, z, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
  };
  const wardAt = (x, z) => {
    if (!wIndex.length || !Number.isFinite(x)) return null;
    for (const w of wIndex) for (const pg of w.polys) {
      if (!pnpoly(x, z, pg.outer)) continue;
      let hole = false;
      for (const h of pg.holes) if (pnpoly(x, z, h)) { hole = true; break; }
      if (!hole) return w.wardId;
    }
    return null;
  };

  for (const b of buildings) {
    if (!b || !Array.isArray(b.fp) || b.fp.length < 3) continue;
    total++;
    const h = (typeof b.dz === 'number') ? b.dz : (typeof b.h === 'number' ? b.h : 0);
    const ar = fpAreaXZ(b.fp);
    if (b.heightUnknown) heightUnknown++;
    const hb = Math.min(100, Math.floor(h / 10) * 10);
    heightHist[hb] = (heightHist[hb] || 0) + 1;
    const ab = Math.min(10000, Math.floor(ar / 1000) * 1000);
    areaHist[ab] = (areaHist[ab] || 0) + 1;

    const bh = h >= MAJOR_MIN_HEIGHT_M;
    const ba = ar >= MAJOR_MIN_FP_AREA_M2;
    const bl = b.id != null && landmarkIds.has(b.id);
    if (bh) byHeight++;
    if (ba) byArea++;
    if (bl) byLandmark++;
    if (bh || ba || bl) {
      selected++;
      if (wIndex.length) {
        const x = (typeof b.repX === 'number') ? b.repX : b.fp[0][0];
        const z = (typeof b.repZ === 'number') ? b.repZ : b.fp[0][1];
        const wd = wardAt(x, z);
        if (wd) selectedIdsByWard[wd] = (selectedIdsByWard[wd] || 0) + 1;
      }
    }
  }

  return {
    thresholds: { minHeightM: MAJOR_MIN_HEIGHT_M, minFpAreaM2: MAJOR_MIN_FP_AREA_M2, midMaxM: MID_MAX_M, hideNearM: HIDE_NEAR_M },
    totalBuildings: total,
    heightUnknown,
    selectedMajor: selected,
    selectedFraction: total ? +(selected / total).toFixed(4) : 0,
    byCriterion: { height: byHeight, area: byArea, landmark: byLandmark },
    heightHistogram: heightHist,
    areaHistogram: areaHist,
    byWard: selectedIdsByWard,
  };
}
