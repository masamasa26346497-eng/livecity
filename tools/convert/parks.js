// tools/convert/parks.js
// 公園・緑地レイヤー変換: Overpassの生データ -> ParkLayerが読み込む {tag, name, p} 形式。
import { convertCoordsArray } from '../lib/projection.js';

export function convertParks(rawElements, projection) {
  const parks = [];
  for (const el of rawElements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const tags = el.tags || {};
    let tag;
    if (tags.leisure === 'park') tag = 'leisure_park';
    else if (tags.landuse) tag = `landuse_${tags.landuse}`;
    else continue;

    const coords = el.geometry.map((pt) => [pt.lon, pt.lat]);
    let p = convertCoordsArray(coords, projection);
    // GeoJSON/Overpassの閉じたwayは先頭=末尾点が重複していることが多いため除去する
    if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) {
      p = p.slice(0, -1);
    }
    if (p.length < 3) continue;
    parks.push({ tag, name: tags.name || '', p });
  }
  return parks;
}
