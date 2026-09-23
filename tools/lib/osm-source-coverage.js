// tools/lib/osm-source-coverage.js
// [Mission31] OSM PBF ソースが大阪市 N03 24区域を完全に包含しているかを判定する純粋ロジック。
//   架空道路を生成しないための「import 前ゲート」。座標は WGS84 lat/lon。
// ══════════════════════════════════════════════════════════════════════════════════

// znorth-neg-v1（tools/lib/projection.js と同一原点。ここでは XZ→lat/lon の逆変換だけ使う）。
const CLAT = 34.604208, CLON = 135.52502, MPD = 111320;
const COSLAT = Math.cos(CLAT * Math.PI / 180);

/** znorth-neg-v1 の [x,z] → { lat, lon }。 */
export function xzToLatLon(x, z) {
  return { lat: CLAT - z / MPD, lon: CLON + x / (COSLAT * MPD) };
}

/**
 * N03 ward polygon（znorth-neg-v1 の [x,z]）群から WGS84 外接矩形を算出する。
 * @param {Array<{polygons:Array<{outer:number[][]}>}>} wards
 * @returns {{south:number, north:number, west:number, east:number}}
 */
export function n03Bbox(wards) {
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const w of (wards || [])) for (const pg of (w.polygons || [])) for (const pt of (pg.outer || [])) {
    if (pt[0] < mnx) mnx = pt[0]; if (pt[0] > mxx) mxx = pt[0];
    if (pt[1] < mnz) mnz = pt[1]; if (pt[1] > mxz) mxz = pt[1];
  }
  // z が最も負 = 北。x 最小 = 西。
  const nw = xzToLatLon(mnx, mnz), se = xzToLatLon(mxx, mxz);
  return {
    south: +Math.min(nw.lat, se.lat).toFixed(6),
    north: +Math.max(nw.lat, se.lat).toFixed(6),
    west: +Math.min(nw.lon, se.lon).toFixed(6),
    east: +Math.max(nw.lon, se.lon).toFixed(6),
  };
}

/**
 * bbox に km マージンを付ける（局所平面近似。緯度1度≈111.32km、経度は cos 補正）。
 * @param {{south,north,west,east}} bbox
 * @param {number} marginKm
 */
export function expandBboxKm(bbox, marginKm = 3) {
  const dLat = marginKm / 111.32;
  const dLon = marginKm / (111.32 * COSLAT);
  return {
    south: +(bbox.south - dLat).toFixed(6),
    north: +(bbox.north + dLat).toFixed(6),
    west: +(bbox.west - dLon).toFixed(6),
    east: +(bbox.east + dLon).toFixed(6),
  };
}

/**
 * 与えられた PBF の実カバレッジ bbox が required bbox を4辺すべてで包含しているか。
 * @param {{south,north,west,east}} coverage  PBF の road-way node bbox（またはノード全体 bbox）
 * @param {{south,north,west,east}} required   N03 + margin
 * @param {number} tolDeg  端の許容（0.001度 ≈ 110m）
 * @returns {{ok:boolean, sides:{north:boolean,south:boolean,east:boolean,west:boolean}, shortfall:object}}
 */
export function coverageContains(coverage, required, tolDeg = 0.001) {
  const sides = {
    north: coverage.north >= required.north - tolDeg,
    south: coverage.south <= required.south + tolDeg,
    east: coverage.east >= required.east - tolDeg,
    west: coverage.west <= required.west + tolDeg,
  };
  const shortfall = {
    northDeg: +(required.north - coverage.north).toFixed(6),
    southDeg: +(coverage.south - required.south).toFixed(6),
    eastDeg: +(required.east - coverage.east).toFixed(6),
    westDeg: +(coverage.west - required.west).toFixed(6),
    // 概算 km（北南は緯度差、東西は経度差×cos）
    northKm: +((required.north - coverage.north) * 111.32).toFixed(2),
    eastKm: +((required.east - coverage.east) * 111.32 * COSLAT).toFixed(2),
  };
  return { ok: sides.north && sides.south && sides.east && sides.west, sides, shortfall };
}

/**
 * ノード緯度ヒストグラム（0.01度刻み）から「不自然な cliff（急落）」を検出する。
 * road データが bbox で切られていると、ある緯度から先で急減する。
 * @param {Record<string, number>} latHist  { '34.73': 20634, '34.74': 352, ... }
 * @returns {{cliffLat:number|null, ratio:number|null}}  cliffLat = 急落が始まる緯度
 */
export function detectLatCliff(latHist) {
  const bins = Object.keys(latHist).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < bins.length; i++) {
    const prev = latHist[bins[i - 1].toFixed(2)] ?? latHist[String(bins[i - 1])] ?? 0;
    const cur = latHist[bins[i].toFixed(2)] ?? latHist[String(bins[i])] ?? 0;
    if (prev >= 2000 && cur > 0 && prev / cur >= 20) return { cliffLat: +bins[i].toFixed(2), ratio: +(prev / cur).toFixed(1) };
    if (prev >= 2000 && cur === 0) return { cliffLat: +bins[i].toFixed(2), ratio: Infinity };
  }
  return { cliffLat: null, ratio: null };
}
