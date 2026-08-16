// tools/lib/projection.js
// LiveCityの既存HTML内 geoToThree() と完全に同一の座標変換式。
// この式を変更すると、既存の建物データ(BLDGS)と新規取得データの座標系がズレるため、
// 既存エリアの再計算時は areaConfig.projection の値をそのまま使うこと。

/**
 * 緯度経度をLiveCityのローカル座標系(x, z)へ変換する。
 * @param {number} lat 緯度
 * @param {number} lon 経度
 * @param {{centerLat:number, centerLon:number, metersPerDegree:number}} projection area設定のprojectionブロック
 * @returns {{x:number, z:number}}
 */
export function geoToLocal(lat, lon, projection) {
  const { centerLat, centerLon, metersPerDegree } = projection;
  const x = (lon - centerLon) * Math.cos((centerLat * Math.PI) / 180) * metersPerDegree;
  const z = (lat - centerLat) * metersPerDegree;
  return { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 };
}

/**
 * GeoJSON座標配列([lon, lat]の配列)をローカル座標の点列([x, z]の配列)へ変換する。
 */
export function convertCoordsArray(coords, projection) {
  return coords.map(([lon, lat]) => {
    const { x, z } = geoToLocal(lat, lon, projection);
    return [x, z];
  });
}

/**
 * ローカル座標(x,z)を逆変換して緯度経度へ戻す（検証・デバッグ用）。
 */
export function localToGeo(x, z, projection) {
  const { centerLat, centerLon, metersPerDegree } = projection;
  const lat = z / metersPerDegree + centerLat;
  const lon = x / (Math.cos((centerLat * Math.PI) / 180) * metersPerDegree) + centerLon;
  return { lat, lon };
}
