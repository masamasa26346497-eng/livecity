// tools/lib/projection.js
// LiveCity のローカル座標変換を集約する。
//
// IMPORTANT:
// - geoToLocal()/localToGeo() は既存データ生成パイプライン互換の legacy 規約
//   （north = +Z）として保持する。既存利用箇所を一括で反転させないこと。
// - 現行 LiveCity runtime / canonical 表示は znorth-neg-v1（north = -Z）。
//   新しく runtime 座標が必要な処理は geoToRuntimeLocal() を使う。

export const RUNTIME_COORDINATE_CONVENTION = 'znorth-neg-v1';

function round2(value) {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * 既存パイプライン互換: 緯度経度を legacy ローカル座標系 (north = +Z) へ変換する。
 * @param {number} lat 緯度
 * @param {number} lon 経度
 * @param {{centerLat:number, centerLon:number, metersPerDegree:number}} projection area設定のprojectionブロック
 * @returns {{x:number, z:number}}
 */
export function geoToLocal(lat, lon, projection) {
  const { centerLat, centerLon, metersPerDegree } = projection;
  const x = (lon - centerLon) * Math.cos((centerLat * Math.PI) / 180) * metersPerDegree;
  const z = (lat - centerLat) * metersPerDegree;
  return { x: round2(x), z: round2(z) };
}

/**
 * 現行 LiveCity runtime 規約 znorth-neg-v1 (north = -Z) へ変換する。
 * consumer 側で localZ の符号を個別反転せず、この関数を座標系の唯一の境界として使う。
 */
export function geoToRuntimeLocal(lat, lon, projection) {
  const { centerLat, centerLon, metersPerDegree } = projection;
  const x = (lon - centerLon) * Math.cos((centerLat * Math.PI) / 180) * metersPerDegree;
  const z = -(lat - centerLat) * metersPerDegree;
  return { x: round2(x), z: round2(z) };
}

/**
 * GeoJSON座標配列([lon, lat]の配列)を legacy ローカル座標の点列([x, z]の配列)へ変換する。
 * 既存利用箇所の互換性維持のため geoToLocal() を使う。
 */
export function convertCoordsArray(coords, projection) {
  return coords.map(([lon, lat]) => {
    const { x, z } = geoToLocal(lat, lon, projection);
    return [x, z];
  });
}

/** legacy north=+Z の逆変換。 */
export function localToGeo(x, z, projection) {
  const { centerLat, centerLon, metersPerDegree } = projection;
  const lat = z / metersPerDegree + centerLat;
  const lon = x / (Math.cos((centerLat * Math.PI) / 180) * metersPerDegree) + centerLon;
  return { lat, lon };
}

/** znorth-neg-v1 (north=-Z) の逆変換。 */
export function runtimeLocalToGeo(x, z, projection) {
  const { centerLat, centerLon, metersPerDegree } = projection;
  const lat = centerLat - z / metersPerDegree;
  const lon = x / (Math.cos((centerLat * Math.PI) / 180) * metersPerDegree) + centerLon;
  return { lat, lon };
}
