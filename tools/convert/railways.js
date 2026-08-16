// tools/convert/railways.js
// 鉄道レイヤー変換（新規レイヤー。既存コードへの依存なし、RoadLayerと似た形式で設計）。
import { convertCoordsArray, geoToLocal } from '../lib/projection.js';

export function convertRailways(rawElements, projection) {
  const lines = [];
  const stations = [];
  for (const el of rawElements) {
    if (el.type === 'way' && el.geometry && el.tags && el.tags.railway) {
      const coords = el.geometry.map((pt) => [pt.lon, pt.lat]);
      const p = convertCoordsArray(coords, projection);
      if (p.length >= 2) lines.push({ railway: el.tags.railway, p });
    } else if (el.tags && el.tags.railway === 'station') {
      const name = el.tags['name:ja'] || el.tags.name || '';
      let lat, lon;
      if (el.type === 'node') { lat = el.lat; lon = el.lon; }
      else if (el.geometry && el.geometry.length) {
        lat = el.geometry.reduce((s, p) => s + p.lat, 0) / el.geometry.length;
        lon = el.geometry.reduce((s, p) => s + p.lon, 0) / el.geometry.length;
      } else continue;
      const { x, z } = geoToLocal(lat, lon, projection);
      stations.push({ name, p: [x, z] });
    }
  }
  return { lines, stations };
}
