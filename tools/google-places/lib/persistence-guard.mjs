// tools/google-places/lib/persistence-guard.mjs
// [Mission 36H §5] 永続化してよいのは canonicalId/facilityId ↔ googlePlaceId の
//   「対応関係」と検証メタデータだけ。Google の写真バイナリ・長期URL・resource name を
//   「永続」として保存してはいけない（表示のたびに新しく解決する）。
//
//   ここは純粋関数のみ。ネットワークI/Oもファイル書き込みも持たない。
//   書き込みツール（match-pilot-places.mjs）は、書く直前に必ず assertDurableRecordSafe を通す。

/** durable mapping の 1 レコードに入れてよいキー。 */
export const ALLOWED_DURABLE_FIELDS = Object.freeze([
  'facilityId',      // 既存 facilities.json の id（施設側の恒久キー）
  'googlePlaceId',   // Google Places の Place ID（写真そのものではない）
  'name',
  'relevanceClass',
  'matchConfidence', // 'VERIFIED' | 'AMBIGUOUS' | 'UNRESOLVED'
  'matchReason',
  'distanceMeters',
  'verifiedAt',      // ISO タイムスタンプ
  'verifiedBy',       // 'automated-pilot-match' 等
]);

/** 絶対に永続化してはいけないキー（バイナリ・長期URL・resource name を「確定」として保存する形）。 */
const FORBIDDEN_KEY_PATTERNS = Object.freeze([
  /photo/i,          // photos / photoName / photoUri / photoReference 等 → 表示のたびに再取得する
  /imageData/i,
  /base64/i,
  /binary/i,
  /thumbnailUrl/i,
  /mediaUrl/i,
  /resourceName/i,
]);

/**
 * @param {object} record  書き込もうとしている 1 レコード
 * @returns {{ok:boolean, violations:string[]}}
 */
export function checkDurableRecordSafety(record) {
  const violations = [];
  if (!record || typeof record !== 'object') {
    return { ok: false, violations: ['record が object ではない'] };
  }
  for (const key of Object.keys(record)) {
    if (!ALLOWED_DURABLE_FIELDS.includes(key)) {
      violations.push('許可されていないキー: ' + key);
      continue;
    }
    if (FORBIDDEN_KEY_PATTERNS.some((re) => re.test(key))) {
      violations.push('禁止パターンに一致するキー: ' + key);
    }
  }
  // 値そのものが写真URL/データURIっぽい場合も弾く（キー名を誤魔化されても検出する）。
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && /^data:image\//i.test(value)) {
      violations.push('値が data URI（画像バイナリ）: ' + key);
    }
    if (typeof value === 'string' && /googleusercontent\.com|places\.googleapis\.com\/v1\/.+\/media/i.test(value)) {
      violations.push('値が Google の写真配信URL（長期URLとして保存しようとしている）: ' + key);
    }
  }
  if (record.googlePlaceId != null && !/^[A-Za-z0-9_-]+$/.test(String(record.googlePlaceId))) {
    violations.push('googlePlaceId の形式が不正');
  }
  return { ok: violations.length === 0, violations };
}

/** 安全でなければ例外を投げる（書き込みツールはこれを通してから fs.writeFileSync する）。 */
export function assertDurableRecordSafe(record) {
  const { ok, violations } = checkDurableRecordSafety(record);
  if (!ok) {
    throw new Error('durable mapping に永続化してはいけないデータが含まれる: ' + violations.join('; '));
  }
  return record;
}
