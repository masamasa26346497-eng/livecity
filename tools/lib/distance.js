// tools/lib/distance.js
// Haversine式による2点間の直線距離(メートル)計算。
// 【重要】この距離は地球楕円体上の大圏距離であり、徒歩経路や道路距離ではない。
// 呼び出し側は必ずdistanceMode:"straight-line"を明示し、画面上にも
// 「直線距離。実際の徒歩経路・所要時間とは異なります」と表示すること。
const EARTH_RADIUS_M = 6371000;

/**
 * 2点間のHaversine距離(メートル)を計算する。
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} 距離(メートル)
 */
export function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}
