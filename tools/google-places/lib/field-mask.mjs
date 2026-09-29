// tools/google-places/lib/field-mask.mjs
// [Mission 36H §7] Google Places API (New) はリクエストしたフィールドの分だけ課金される
//   （FieldMask で絞るほど安い）。ここに「必要最小限」のフィールド一覧を固定して、
//   呼び出し側がうっかり reviews / openingHours / priceLevel など高額・不要なフィールドを
//   足さないようにする。
//
//   1件あたりの写真枚数の上限（3〜5枚）もここで固定する。

/** Text Search（候補探索）で使う最小フィールド。写真そのものはここでは取らない。 */
export const SEARCH_FIELD_MASK = Object.freeze([
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.primaryType',
  'places.types',
]);

/** Place Details（確定後、写真メタデータを取る）で使う最小フィールド。 */
export const DETAILS_FIELD_MASK = Object.freeze([
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'primaryType',
  'photos.name',
  'photos.widthPx',
  'photos.heightPx',
  'photos.authorAttributions',
  'googleMapsUri',
]);

/**
 * 曖昧さ解消（第二段階）用の Place Details。識別に必要な項目のみ。photos は含めない
 * （写真メタデータ・media参照名を取らない＝コストと永続化リスクの両方を避ける）。
 */
export const IDENTITY_FIELD_MASK = Object.freeze([
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'primaryType',
  'types',
]);

/** 1施設あたりに保持・表示する写真の上限（§7: 3〜5枚）。 */
export const MIN_PHOTOS_PER_PLACE = 3;
export const MAX_PHOTOS_PER_PLACE = 5;
export const DEFAULT_PHOTOS_PER_PLACE = 4;

export function clampPhotoCount(n) {
  const v = Number.isFinite(n) ? Math.floor(n) : DEFAULT_PHOTOS_PER_PLACE;
  return Math.min(MAX_PHOTOS_PER_PLACE, Math.max(MIN_PHOTOS_PER_PLACE, v));
}

export function buildFieldMaskHeader(fields) {
  if (!Array.isArray(fields) || !fields.length) {
    throw new Error('field mask が空: 明示的にフィールドを列挙すること（ワイルドカード禁止）');
  }
  for (const f of fields) {
    if (f === '*' || /\*/.test(f)) {
      throw new Error('field mask にワイルドカードは使わない（コスト最小化のため）: ' + f);
    }
  }
  return fields.join(',');
}
