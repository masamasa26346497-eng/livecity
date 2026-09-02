// tools/lib/city-tile-grid.js
// P1-6: 大阪市24区の都市レイヤー（道路・河川・公園・鉄道）共通タイルグリッド。
//
// 【方針】
//  - config/areas/osaka-city.json の bbox と projection（znorth-neg-v1・原点固定）を唯一の基準とする。
//  - 大阪市全域で同一の tile grid を使う。区ごとに別座標系を作らない。
//  - tile id は "tile_<tx>_<tz>.json"（建物 dataset と同一形式）。道路/河川/公園/鉄道で共有。
//  - znorth-neg-v1（北 = z 負）で扱う。tools/lib/projection.js の geoToLocal は北=z正で変換するため、
//    呼び出し側（build-city-layer-tiles.js）が変換後に z を反転する（toZNorthNegPoint）。
//    本ファイルの grid 計算は最初から znorth-neg-v1 前提の x/z で行う。
//  - bbox 境界で地物が欠落しないよう、feature は「bbox が重なる全タイル」へ割り当てる
//    （クリップしない。load 時に feature id で dedup）。取得は bufferMeters ぶん広めに行う。

const DEG2RAD = Math.PI / 180;

/**
 * 緯度経度 → znorth-neg-v1 ローカル座標（HTML geoToThree と同一式）。
 */
export function geoToZNorthNeg(lat, lon, projection) {
  const { centerLat, centerLon, metersPerDegree } = projection;
  const x = (lon - centerLon) * Math.cos(centerLat * DEG2RAD) * metersPerDegree;
  const z = -((lat - centerLat) * metersPerDegree); // 北を -z へ
  return { x, z };
}

/**
 * znorth-neg-v1 ローカル座標 → 緯度経度（Overpass の bbox 文字列生成用）。
 */
export function zNorthNegToGeo(x, z, projection) {
  const { centerLat, centerLon, metersPerDegree } = projection;
  const lat = centerLat - z / metersPerDegree;
  const lon = centerLon + x / (Math.cos(centerLat * DEG2RAD) * metersPerDegree);
  return { lat, lon };
}

/**
 * @param {{bbox:{south,west,north,east}, projection:object, tileSizeMeters?:number, bufferMeters?:number}} opts
 */
export function createCityTileGrid(opts) {
  const { bbox, projection } = opts;
  const tileSize = opts.tileSizeMeters || 2000;
  const buffer = opts.bufferMeters ?? 150;
  if (!bbox || !projection) throw new Error('createCityTileGrid: bbox / projection が必要です');

  // bbox の4隅を znorth-neg-v1 へ。z は北で負になるので min/max を取り直す。
  const c1 = geoToZNorthNeg(bbox.south, bbox.west, projection);
  const c2 = geoToZNorthNeg(bbox.north, bbox.east, projection);
  const minX = Math.min(c1.x, c2.x), maxX = Math.max(c1.x, c2.x);
  const minZ = Math.min(c1.z, c2.z), maxZ = Math.max(c1.z, c2.z);

  // tile 原点は grid が (0,0) 起点になるよう floor して丸める（建物 tiling と同じ「floor(x/ts)」規則）。
  const originTx = Math.floor(minX / tileSize);
  const originTz = Math.floor(minZ / tileSize);
  const lastTx = Math.floor((maxX - 1e-6) / tileSize);
  const lastTz = Math.floor((maxZ - 1e-6) / tileSize);
  const cols = lastTx - originTx + 1;
  const rows = lastTz - originTz + 1;

  const grid = {
    tileSize,
    buffer,
    bboxLocal: { minX, maxX, minZ, maxZ },
    originTx, originTz, lastTx, lastTz, cols, rows,
    tileCount: cols * rows,
    coordinateConvention: 'znorth-neg-v1',

    tileIdOf(x, z) { return `${Math.floor(x / tileSize)}_${Math.floor(z / tileSize)}`; },

    tileBounds(tx, tz) {
      return { minX: tx * tileSize, maxX: (tx + 1) * tileSize, minZ: tz * tileSize, maxZ: (tz + 1) * tileSize };
    },

    inRange(tx, tz) {
      return tx >= originTx && tx <= lastTx && tz >= originTz && tz <= lastTz;
    },

    allTiles() {
      const out = [];
      for (let tz = originTz; tz <= lastTz; tz++) {
        for (let tx = originTx; tx <= lastTx; tx++) out.push({ tx, tz });
      }
      return out;
    },

    // feature の znorth-neg-v1 bbox が重なる全タイル id。bbox 境界での地物欠落を防ぐ。
    tilesForBounds(fb) {
      const t0x = Math.max(originTx, Math.floor(fb.minX / tileSize));
      const t1x = Math.min(lastTx, Math.floor((fb.maxX - 1e-9) / tileSize));
      const t0z = Math.max(originTz, Math.floor(fb.minZ / tileSize));
      const t1z = Math.min(lastTz, Math.floor((fb.maxZ - 1e-9) / tileSize));
      const out = [];
      for (let tz = t0z; tz <= t1z; tz++) {
        for (let tx = t0x; tx <= t1x; tx++) out.push(`${tx}_${tz}`);
      }
      return out;
    },

    // Overpass 取得用: あるタイルの緯度経度 bbox（buffer ぶん外側へ拡張）。"south,west,north,east"。
    latLonBboxForTile(tx, tz) {
      const b = { minX: tx * tileSize - buffer, maxX: (tx + 1) * tileSize + buffer, minZ: tz * tileSize - buffer, maxZ: (tz + 1) * tileSize + buffer };
      // znorth-neg-v1: z が小さい方が北。4隅を緯度経度へ戻して min/max。
      const p1 = zNorthNegToGeo(b.minX, b.minZ, projection);
      const p2 = zNorthNegToGeo(b.maxX, b.maxZ, projection);
      const south = Math.min(p1.lat, p2.lat), north = Math.max(p1.lat, p2.lat);
      const west = Math.min(p1.lon, p2.lon), east = Math.max(p1.lon, p2.lon);
      return { south, west, north, east, str: `${south.toFixed(7)},${west.toFixed(7)},${north.toFixed(7)},${east.toFixed(7)}` };
    },

    // 大阪市全域の緯度経度 bbox（buffer込み。一括取得の非推奨確認・カバレッジ検証用）。
    fullLatLonBbox() {
      const p1 = zNorthNegToGeo(minX - buffer, minZ - buffer, projection);
      const p2 = zNorthNegToGeo(maxX + buffer, maxZ + buffer, projection);
      return {
        south: Math.min(p1.lat, p2.lat), north: Math.max(p1.lat, p2.lat),
        west: Math.min(p1.lon, p2.lon), east: Math.max(p1.lon, p2.lon),
      };
    },
  };
  return grid;
}

/**
 * 点列/リング配列の znorth-neg-v1 bbox。
 */
export function boundsOfPoints(points) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    const x = p[0], z = p[1];
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** [x,z] の z を反転（geoToLocal(北=z正) → znorth-neg-v1(北=z負)）。 */
export function toZNorthNegPoints(points) {
  return points.map(([x, z]) => [x, -z]);
}
