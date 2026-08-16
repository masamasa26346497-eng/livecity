// tools/lib/landuse.js
// 土地利用(landuse)レイヤーの共通定義。
// - Overpassクエリ群(parking / landuse / natural_and_water の3群)
// - OSMタグ → LiveCityのカテゴリ/サブタイプ分類
// - 駐車場の詳細分類(parking=surface/multi-storey/underground/rooftop/unspecified)
//
// download と convert の両方、およびテストから参照するため、
// ネットワークやファイルI/Oに依存しない純粋なロジックのみをここに置く。

// ── Overpassクエリ群 ──
// 一度に巨大なクエリを投げるとタイムアウトしやすいため、3群に分けて順に取得する。
// 面(way/relation)のみを対象とする。amenity=parking の「点」は面レイヤーには使わないが、
// 取得件数・除外件数を統計に残すため node も取得しておく(convert側で面レイヤーからは除外する)。
export const LANDUSE_QUERY_GROUPS = {
  // 第1優先: 駐車場
  parking: [
    'way["amenity"="parking"]',
    'relation["amenity"="parking"]',
    'node["amenity"="parking"]', // 面には使わない。統計(除外件数)にのみ計上する。
  ],
  // 第2・第3優先: 公園・緑地・墓地・工業・商業・その他の土地利用
  landuse: [
    'way["leisure"="park"]',
    'relation["leisure"="park"]',
    'way["landuse"="recreation_ground"]',
    'relation["landuse"="recreation_ground"]',
    'way["landuse"="grass"]',
    'relation["landuse"="grass"]',
    'way["landuse"="cemetery"]',
    'relation["landuse"="cemetery"]',
    'way["landuse"="industrial"]',
    'relation["landuse"="industrial"]',
    'way["landuse"="commercial"]',
    'relation["landuse"="commercial"]',
    'way["landuse"="retail"]',
    'relation["landuse"="retail"]',
    'way["landuse"="construction"]',
    'relation["landuse"="construction"]',
    'way["landuse"="railway"]',
    'relation["landuse"="railway"]',
  ],
  // 第4優先: 自然・水域
  natural_and_water: [
    'way["natural"="wood"]',
    'relation["natural"="wood"]',
    'way["natural"="scrub"]',
    'relation["natural"="scrub"]',
    'way["natural"="grassland"]',
    'relation["natural"="grassland"]',
    'way["natural"="water"]',
    'relation["natural"="water"]',
    'way["waterway"="riverbank"]',
    'relation["waterway"="riverbank"]',
  ],
};

// ── 駐車場の詳細分類 ──
// OSMの parking=* の値から、描画側が扱いやすい5種へ正規化する。
// 地表の駐車場(parking_surface)だけが「地表ポリゴンとして描く」対象であり、
// 立体/地下/屋上は面としては描かない判断ができるよう、種別を明示的に残す。
export const PARKING_SUBTYPES = [
  'parking_surface',
  'parking_multi_storey',
  'parking_underground',
  'parking_rooftop',
  'parking_unspecified',
];

export function classifyParking(tags = {}) {
  const p = String(tags.parking || '').toLowerCase();
  switch (p) {
    case 'surface':
      return 'parking_surface';
    case 'multi-storey':
    case 'multi_storey':
    case 'garage':
    case 'garages':
      return 'parking_multi_storey';
    case 'underground':
    case 'underground_garage':
      return 'parking_underground';
    case 'rooftop':
      return 'parking_rooftop';
    default:
      return 'parking_unspecified';
  }
}

// ── カテゴリ分類 ──
// category: 描画レイヤーの振り分けに使う大分類
// subtype : 表示色・扱いの細分（駐車場は上記の5種、それ以外はOSMの値をそのまま使う）
//
// 優先順位はご指示の第1〜第4優先に対応する。1つの要素が複数のタグを持つ場合は
// 優先度の高いものを採用する(例: leisure=park かつ landuse=grass なら park)。
export function classifyLanduse(tags = {}) {
  // 第1優先: 駐車場
  if (tags.amenity === 'parking') {
    return { category: 'parking', subtype: classifyParking(tags), priority: 1 };
  }

  // 第2優先: 公園・レクリエーション・芝生
  if (tags.leisure === 'park') {
    return { category: 'park', subtype: 'leisure_park', priority: 2 };
  }
  if (tags.landuse === 'recreation_ground') {
    return { category: 'park', subtype: 'landuse_recreation_ground', priority: 2 };
  }
  if (tags.landuse === 'grass') {
    return { category: 'grass', subtype: 'landuse_grass', priority: 2 };
  }

  // 第3優先: 墓地・工業・商業・小売・工事中・鉄道用地
  if (tags.landuse === 'cemetery') {
    return { category: 'cemetery', subtype: 'landuse_cemetery', priority: 3 };
  }
  if (tags.landuse === 'industrial') {
    return { category: 'industrial', subtype: 'landuse_industrial', priority: 3 };
  }
  if (tags.landuse === 'commercial') {
    return { category: 'commercial', subtype: 'landuse_commercial', priority: 3 };
  }
  if (tags.landuse === 'retail') {
    return { category: 'commercial', subtype: 'landuse_retail', priority: 3 };
  }
  if (tags.landuse === 'construction') {
    return { category: 'construction', subtype: 'landuse_construction', priority: 3 };
  }
  if (tags.landuse === 'railway') {
    return { category: 'railway', subtype: 'landuse_railway', priority: 3 };
  }

  // 第4優先: 自然・水域
  if (tags.natural === 'wood') {
    return { category: 'wood', subtype: 'natural_wood', priority: 4 };
  }
  if (tags.natural === 'scrub') {
    return { category: 'wood', subtype: 'natural_scrub', priority: 4 };
  }
  if (tags.natural === 'grassland') {
    return { category: 'grass', subtype: 'natural_grassland', priority: 4 };
  }
  if (tags.natural === 'water') {
    return { category: 'water', subtype: 'natural_water', priority: 4 };
  }
  if (tags.waterway === 'riverbank') {
    return { category: 'water', subtype: 'waterway_riverbank', priority: 4 };
  }

  return null; // 対象外
}

// 既存の ParkLayer(parks.json)と重複するカテゴリかどうか。
// parks.json は leisure=park / landuse=recreation_ground / landuse=grass を収録している。
// landuse.json 側にも保持したうえでこのフラグを立て、描画時に重複除外できるようにする。
export function isDuplicateWithExistingParkLayer(subtype) {
  return (
    subtype === 'leisure_park' ||
    subtype === 'landuse_recreation_ground' ||
    subtype === 'landuse_grass'
  );
}
