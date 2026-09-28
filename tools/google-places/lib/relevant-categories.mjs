// tools/google-places/lib/relevant-categories.mjs
// [Mission 36H §3] Google Places写真の対象は「ユーザーに関係する建物・施設」のみで、
//   全建物ではない。対象クラスをここで明示し、既存の施設カテゴリ
//   （data/processed/{areaId}/facilities/facilities.json の category/subcategory）から
//   関連度クラスへ変換できるようにする。
//
//   このモジュールは純粋なデータ・純粋関数のみ（ネットワークI/Oを持たない）。

/** ユーザーに関係する施設クラス（指示にある一覧に対応）。 */
export const RELEVANCE_CLASSES = Object.freeze([
  'hotel',
  'restaurant',
  'retail-commercial',
  'office',
  'hospital',
  'school',
  'public-facility',
  'station',
  'tourism-cultural',
  'temple-shrine',
  'residential-tower',
]);

/**
 * 既存の facilities.json の category/subcategory から relevanceClass へのマッピング。
 * 一致しないものは null（＝ Google Places 写真の対象外。全施設を対象にしない）。
 */
const SUBCATEGORY_TO_CLASS = Object.freeze({
  hotel: 'hotel',
  restaurant: 'restaurant',
  fast_food: 'restaurant',
  cafe: 'restaurant',
  supermarket: 'retail-commercial',
  convenience: 'retail-commercial',
  department_store: 'retail-commercial',
  shopping_mall: 'retail-commercial',
  drugstore: 'retail-commercial',
  pharmacy: 'retail-commercial',
  bank: 'office',
  hospital: 'hospital',
  clinic: 'hospital',
  dentist: 'hospital',
  school: 'school',
  kindergarten: 'school',
  college: 'school',
  university: 'school',
  post_office: 'public-facility',
  community_centre: 'public-facility',
  library: 'public-facility',
  government: 'public-facility',
  police: 'public-facility',
  fire_station: 'public-facility',
  station: 'station',
  platform: 'station',
  historic_memorial: 'tourism-cultural',
  attraction: 'tourism-cultural',
  museum: 'tourism-cultural',
  shrine: 'temple-shrine',
  temple: 'temple-shrine',
  place_of_worship: 'temple-shrine',
});

/**
 * @param {{category?:string|null, subcategory?:string|null, name?:string|null}} facility
 * @returns {string|null} relevanceClass。対象外なら null。
 */
export function classifyRelevance(facility) {
  const sub = facility && facility.subcategory;
  if (sub && SUBCATEGORY_TO_CLASS[sub]) return SUBCATEGORY_TO_CLASS[sub];
  // 神社・寺は名前からも拾う（OSMのsubcategoryが historic_memorial 止まりのことがあるため）。
  const name = String((facility && facility.name) || '');
  if (/神社|大社|寺院?(?!$)|お寺/.test(name)) return 'temple-shrine';
  return null;
}

export function isRelevantFacility(facility) {
  return classifyRelevance(facility) !== null;
}
