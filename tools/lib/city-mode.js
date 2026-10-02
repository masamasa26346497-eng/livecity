// tools/lib/city-mode.js
// P1-7: City Mode（大阪市24区全域表示）の純粋ロジック（THREE 非依存）。
//   canonical。public/osaka_3d_buildings.ward-ux-v1.html の CityTileLayer / CityModeManager に
//   同じ計算を inline する。

// [Mission16] City Mode（大阪市全域）の初期カメラ preset。値を1箇所へ集約。
//   public/osaka_3d_buildings.ward-ux-v1.html に同じ値を inline する。
export const CITY_CAMERA_PRESET = {
  elevationDeg: 42,    // 地平線からの仰角。真上(90)禁止・水平(0)禁止。屋根と側面の両方が読める斜め上視点。
  azimuthDeg: 0,       // 北を画面上へ（既存の「北向き」方針を維持）。
  fov: 50,            // 都市模型写真的な落ち着いた perspective（Ward の 60 より控えめ）。
  marginFactor: 1.10, // bbox fit 後の余白（大阪市が画面の ~80〜88% を占める）。
  targetYOffset: 50,  // controls.target を地表より少し上へ。
  headroomM: 800,     // 縦 fit 時の建物高さ・空の余白。
  minRadius: 6000,
  maxRadius: 24000,
};

/**
 * 大阪市全域の camera 位置を、ハードコードではなく地表範囲（znorth-neg-v1 ローカル座標の bbox）から算出する。
 *   opts.aspect を渡すと [Mission16] aspect-aware fit（FOV / aspect / elevation から必要距離を算出、
 *   横 fit と縦 fit の大きい方 + margin）。渡さなければ旧方式（diag * radiusFactor）。
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} extent
 * @param {{radiusFactor?:number, minR?:number, maxR?:number, aspect?:number, fovDeg?:number,
 *          elevationDeg?:number, marginFactor?:number, headroomM?:number}} [opts]
 */
export function cityCameraTarget(extent, opts = {}) {
  const width = extent.maxX - extent.minX;
  const height = extent.maxZ - extent.minZ;
  const diag = Math.hypot(width, height);
  const x = (extent.minX + extent.maxX) / 2;
  const z = (extent.minZ + extent.maxZ) / 2;
  const P = CITY_CAMERA_PRESET;

  if (opts.aspect == null) {
    // [P1-7B] 旧方式（aspect 非考慮）: ward の 0.62 より詰めた 0.5。
    const radiusFactor = opts.radiusFactor ?? 0.5;
    const minR = opts.minR ?? 0;
    const maxR = opts.maxR ?? Infinity;
    const radius = Math.max(minR, Math.min(maxR, diag * radiusFactor));
    return { x, z, width, height, diag, radius, fitMode: 'diag' };
  }

  // [Mission16] aspect-aware fit
  const fovDeg = opts.fovDeg ?? P.fov;
  const elevationDeg = opts.elevationDeg ?? P.elevationDeg;
  const margin = opts.marginFactor ?? P.marginFactor;
  const headroom = opts.headroomM ?? P.headroomM;
  const minR = opts.minR ?? P.minRadius;
  const maxR = opts.maxR ?? P.maxRadius;
  const halfV = (fovDeg * Math.PI / 180) / 2;
  const halfH = Math.atan(Math.tan(halfV) * opts.aspect);
  const elevRad = elevationDeg * Math.PI / 180;
  const fitDistanceX = (width / 2) / Math.tan(halfH);                     // 東西（azimuth=0 で foreshorten なし）
  const projZ = (height / 2) * Math.sin(elevRad) + headroom;             // 南北 depth を仰角で foreshorten + 建物高さ
  const fitDistanceY = projZ / Math.tan(halfV);
  const fitDistance = Math.max(fitDistanceX, fitDistanceY) * margin;
  const radius = Math.max(minR, Math.min(maxR, fitDistance));
  return {
    x, z, width, height, diag, radius, fitMode: 'aspect',
    fitDistanceX, fitDistanceY, fitDistance, fovDeg, elevationDeg, aspect: opts.aspect, margin,
  };
}

// ── 道路 LOD ──
// [見た目改善 Mission02] 道路の距離LODは tools/lib/road-lod.js（MAJOR/MID/LOCAL の3段階分類 +
//   FAR/MID/NEAR band）へ切り出した。旧 P1-7B の major/secondary/local（2段階+常時secondary）は
//   ここでは廃止。city-mode.js からも参照できるよう re-export しておく。
export { ROAD_LOD_CLASSES, classifyRoadLod, ROAD_LOD_BANDS, roadLodBand, roadClassVisible, countByRoadLodClass } from './road-lod.js';

// ── 公園 LOD ──
// [見た目改善 Mission12] 旧 big/small（2ha 閾値・小規模は <=4000m）は廃止。面積 3 段階
//   （LARGE/MEDIUM/SMALL）+ 道路と同じ FAR/MID/NEAR band へ切り出した（tools/lib/park-lod.js）。
export {
  PARK_AREA_LARGE_M2, PARK_AREA_MEDIUM_M2, classifyParkArea, PARK_LOD_BANDS, parkLodBand,
  parkClassVisible, PARK_TIER_OPACITY, parkTierOpacity, ringAreaXZ, polygonAreaWithHoles, countByParkClass,
} from './park-lod.js';

// ── 鉄道 LOD ──
// [見た目改善 Mission13] 旧「rail は距離によらず常に表示」は廃止。MAJOR/URBAN/LOCAL の3クラス +
//   道路・公園と同じ FAR/MID/NEAR band へ切り出した（tools/lib/rail-lod.js）。
export {
  RAIL_MAJOR_MIN_LEN_M, classifyRail, railIncluded, RAIL_EXCLUDED_TAGS, RAIL_LOD_BANDS, railLodBand,
  railClassVisible, RAIL_TIER_OPACITY, railTierOpacity, RAIL_COLORS,
  polylineLengthXZ, maxSegmentLengthXZ, countByRailClass,
} from './rail-lod.js';
export const STATION_MAX_M = 5000;
export function stationVisible(distance) {
  const d = Number.isFinite(distance) ? distance : 0;
  return d <= STATION_MAX_M;
}

/**
 * タイル一覧を N 件ずつのバッチへ分割する（中心→外の順で並んでいる前提。呼び出し側が
 * setTimeout 等でバッチ間隔を空けて呼び、156 tile を同期一括ロードしないために使う）。
 * @param {any[]} list
 * @param {number} [batchSize=10]
 * @returns {any[][]}
 */
export function batchProgressive(list, batchSize = 10) {
  const out = [];
  const n = Math.max(1, batchSize | 0);
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** tile 座標配列を、中心タイルからの距離が近い順に並べる（破壊しない）。 */
export function sortTilesByCenterDistance(tiles, centerTx, centerTz) {
  return [...tiles].sort((a, b) => (
    Math.hypot(a.tx - centerTx, a.tz - centerTz) - Math.hypot(b.tx - centerTx, b.tz - centerTz)
  ));
}
