// tools/convert/waterways.js
// 河川・水域レイヤー変換（新規レイヤー）。
import { convertCoordsArray } from '../lib/projection.js';

export function convertWaterways(rawElements, projection) {
  const items = [];
  for (const el of rawElements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const tags = el.tags || {};
    let type;
    if (tags.natural === 'water') type = 'water';
    else if (tags.waterway === 'river') type = 'river';
    else if (tags.waterway === 'canal') type = 'canal';
    else continue;

    const coords = el.geometry.map((pt) => [pt.lon, pt.lat]);
    let p = convertCoordsArray(coords, projection);
    if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) {
      p = p.slice(0, -1);
    }
    if (p.length < 2) continue;
    items.push({ type, name: tags.name || '', p });
  }
  return items;
}
