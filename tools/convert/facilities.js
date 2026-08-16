// tools/convert/facilities.js
// 施設ラベル変換: Overpassの生データ -> LabelLayerが読み込む {name, category, priority, p} 形式。
import { geoToLocal } from '../lib/projection.js';

const CATEGORY_PRIORITY = {
  station: 1,
  government: 2,
  hospital: 3,
  university: 4,
  school: 5,
  library: 5,
};

function categorize(tags) {
  if (tags.railway === 'station') return 'station';
  if (tags.amenity === 'townhall' || tags.office === 'government') return 'government';
  if (tags.amenity === 'hospital') return 'hospital';
  if (tags.amenity === 'college' || tags.amenity === 'university') return 'university';
  if (tags.amenity === 'school') return 'school';
  if (tags.amenity === 'library') return 'library';
  return null;
}

function elementCenter(el) {
  // nodeはlat/lonを直接持つ。wayはgeometry配列の重心を使う(out geomで取得した座標群の平均)。
  if (el.type === 'node') return { lat: el.lat, lon: el.lon };
  if (el.geometry && el.geometry.length) {
    const lat = el.geometry.reduce((s, p) => s + p.lat, 0) / el.geometry.length;
    const lon = el.geometry.reduce((s, p) => s + p.lon, 0) / el.geometry.length;
    return { lat, lon };
  }
  return null;
}

export function convertFacilities(rawElements, projection) {
  const items = [];
  for (const el of rawElements) {
    const tags = el.tags || {};
    const category = categorize(tags);
    if (!category) continue;
    const name = tags['name:ja'] || tags.name; // 日本語名を優先、なければ通常のnameを使用
    if (!name) continue;
    const center = elementCenter(el);
    if (!center) continue;
    const { x, z } = geoToLocal(center.lat, center.lon, projection);
    items.push({ name, category, priority: CATEGORY_PRIORITY[category], p: [x, z] });
  }
  return deduplicateByNameAndDistance(items);
}

/**
 * 名前が部分文字列関係にあり、かつ距離が近い(同一施設がOSM上で2つのノードとして
 * 登録されているケース)を検出し、より長い(正式名称らしい)名前を残す。
 */
function deduplicateByNameAndDistance(items, distThreshold = 100) {
  const toRemove = new Set();
  for (let i = 0; i < items.length; i++) {
    if (toRemove.has(i)) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (toRemove.has(j)) continue;
      if (items[i].category !== items[j].category) continue;
      const a = items[i].name, b = items[j].name;
      if (!(a.includes(b) || b.includes(a))) continue;
      const dx = items[i].p[0] - items[j].p[0], dz = items[i].p[1] - items[j].p[1];
      if (Math.hypot(dx, dz) >= distThreshold) continue;
      if (a.length >= b.length) toRemove.add(j);
      else toRemove.add(i);
    }
  }
  return items.filter((_, idx) => !toRemove.has(idx));
}
