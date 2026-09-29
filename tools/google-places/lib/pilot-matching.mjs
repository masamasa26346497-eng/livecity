// tools/google-places/lib/pilot-matching.mjs
// [Mission 36H §9] Google Places の検索結果を、こちらの検証済み施設（facilities.json由来、
//   expectLat/expectLon 付き）に対して「保守的に」対応付ける。
//
//   36A の classifyFootprintMatch と同じ考え方: 「近いから」「名前が似ているから」だけで
//   決めない。座標も名前も一致し、曖昧な候補が無いときだけ VERIFIED にする。
//   複数の候補が閾値内にある／名前が矛盾する場合は AMBIGUOUS / UNRESOLVED のまま残す
//   （誤って別の建物の写真を借りてこない）。
//
//   純粋関数のみ（ネットワークI/Oを持たない。単体テストで検証できるようにする）。

import { crossLanguageNameAgree, typesCompatible, coreName, hasTypeInfo } from './cross-language-name.mjs';

const EARTH_RADIUS_M = 6371000;

/** 2点間の距離（メートル）。 */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** 表記ゆれの正規化（全角半角・空白・中黒等）。footprint-photo-matching.mjs と同じ方針。 */
export function normalizeName(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　・･（）()「」【】]/g, '')
    .toLowerCase();
}

export function namesAgree(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na));
}

export const DEFAULT_MAX_DISTANCE_METERS = 120;

const OSAKA_RE = /osaka|大阪/i;

/**
 * [Mission 36H 第二段階] 近傍候補が複数あるときの曖昧さ解消。距離の近さでは決めない。
 * 1候補が「名前（核名の完全一致 or 語彙対応）」「タイプ互換」「所在地が大阪（存在を要求）」
 * 「座標（詳細座標があれば閾値内）」の全てを満たし、他の候補が同じ証拠を満たさず、
 * 名前が合うのに判定不能（タイプ/所在地情報なし）な競合も居ないときだけ採用する。
 * 同点・証拠不足は ok:false（AMBIGUOUS のまま）。
 */
export function disambiguateNearby(candidate, nearby, maxDistanceMeters = DEFAULT_MAX_DISTANCE_METERS) {
  const want = coreName(candidate.name);
  const evaluated = nearby.map((p) => {
    const names = [p.displayName, ...(p.altNames || [])].filter(Boolean);
    let nameKind = null;
    if (want.length >= 3 && names.some((n) => coreName(n) === want)) nameKind = 'exact';
    else if (names.some((n) => crossLanguageNameAgree(candidate.name, n).ok)) nameKind = 'cross';
    const typeOk = typesCompatible(candidate.osmSubcategory, p);
    const addressOk = !!p.formattedAddress && OSAKA_RE.test(p.formattedAddress);
    const coordOk = p.detailDistanceMeters == null || p.detailDistanceMeters <= maxDistanceMeters;
    const supported = !!nameKind && typeOk && addressOk && coordOk;
    // タイプ/所在地が「不一致と確定」していない競合は、証拠不足として採用を止める。
    const disqualified = (hasTypeInfo(p) && !typeOk) || (!!p.formattedAddress && !addressOk);
    return { p, nameKind, supported, blocks: !!nameKind && !supported && !disqualified };
  });
  const supported = evaluated.filter((e) => e.supported);
  if (supported.length === 1 && !evaluated.some((e) => e.blocks)) {
    const e = supported[0];
    return { ok: true, place: e.p, reason: '第二段階: 名前(' + e.nameKind + ')・タイプ(' + (e.p.primaryType || 'types')
      + ')互換・所在地(大阪)・座標が揃う候補が唯一 [disambiguated]' };
  }
  return { ok: false, supportedCount: supported.length };
}

/** Place Details（識別用）の結果を検索結果へ重ねる。photos 等は受け取らない。 */
function applyIdentity(p, d, candidate) {
  if (!d) return p;
  const detailDistance = (Number.isFinite(d.lat) && Number.isFinite(d.lon))
    ? haversineMeters(candidate.expectLat, candidate.expectLon, d.lat, d.lon) : null;
  return {
    ...p,
    altNames: d.displayName && d.displayName !== p.displayName ? [d.displayName] : [],
    formattedAddress: p.formattedAddress || d.formattedAddress || null,
    primaryType: p.primaryType || d.primaryType || null,
    types: [...new Set([...(p.types || []), ...(d.types || [])])],
    detailDistanceMeters: detailDistance,
  };
}

/**
 * @param {{facilityId:string, name:string, expectLat:number, expectLon:number}} candidate
 *   こちら側の検証済み施設（施設データの実座標）。
 * @param {Array<{placeId:string, displayName:string, lat:number, lon:number}>} places
 *   Google Places のText Search結果（同じクエリで返った候補の配列。0件・1件・複数件）。
 * @param {{maxDistanceMeters?:number, detailsByPlaceId?:Record<string,object>}} [opts]
 *   detailsByPlaceId: 第二段階用の識別情報（呼び出し側が曖昧な候補にだけ取得して渡す）。
 * @returns {{matchConfidence:'VERIFIED'|'AMBIGUOUS'|'UNRESOLVED', googlePlaceId:string|null,
 *   distanceMeters:number|null, reason:string, candidateCount:number}}
 */
export function classifyPilotMatch(candidate, places, opts = {}) {
  const maxDistanceMeters = opts.maxDistanceMeters ?? DEFAULT_MAX_DISTANCE_METERS;
  const base = { matchConfidence: 'UNRESOLVED', googlePlaceId: null, distanceMeters: null,
    reason: '', candidateCount: Array.isArray(places) ? places.length : 0 };

  if (!places || !places.length) {
    return { ...base, reason: 'Google Places 側に候補が無い' };
  }

  // 距離が閾値内にある候補だけを見る（近いというだけでは信頼しない。名前も見る）。
  const withDistance = places.map((p) => ({
    ...p, distanceMeters: haversineMeters(candidate.expectLat, candidate.expectLon, p.lat, p.lon),
  })).filter((p) => Number.isFinite(p.distanceMeters));

  const details = opts.detailsByPlaceId || {};
  const nearby = withDistance.filter((p) => p.distanceMeters <= maxDistanceMeters)
    .map((p) => applyIdentity(p, details[p.placeId], candidate));
  if (!nearby.length) {
    const closest = withDistance.slice().sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
    return { ...base, distanceMeters: closest ? Math.round(closest.distanceMeters) : null,
      reason: '閾値(' + maxDistanceMeters + 'm)内に候補が無い（最も近い候補: '
        + (closest ? Math.round(closest.distanceMeters) + 'm' : 'なし') + '）' };
  }

  const nameAgreeing = nearby.filter((p) => namesAgree(candidate.name, p.displayName));

  // 第二段階: 近傍が複数で名前一致が一意でないときだけ。既存の一意VERIFIEDは変えない。
  let needsDetailsFor;
  if (nearby.length >= 2 && nameAgreeing.length !== 1) {
    const s2 = disambiguateNearby(candidate, nearby, maxDistanceMeters);
    if (s2.ok) {
      return { matchConfidence: 'VERIFIED', googlePlaceId: s2.place.placeId,
        distanceMeters: Math.round(s2.place.distanceMeters), reason: s2.reason, candidateCount: places.length };
    }
    if (!Object.keys(details).length) needsDetailsFor = nearby.map((p) => p.placeId);
  }
  const withNeeds = (r) => (needsDetailsFor ? { ...r, needsDetailsFor } : r);

  if (nameAgreeing.length === 1) {
    return {
      matchConfidence: 'VERIFIED', googlePlaceId: nameAgreeing[0].placeId,
      distanceMeters: Math.round(nameAgreeing[0].distanceMeters),
      reason: '座標(' + Math.round(nameAgreeing[0].distanceMeters) + 'm以内)と名前が一致',
      candidateCount: places.length,
    };
  }

  if (nameAgreeing.length > 1) {
    return withNeeds({ ...base, matchConfidence: 'AMBIGUOUS',
      reason: '座標が近く名前も一致する候補が複数ある（一意に決められない。同名の別施設の可能性）' });
  }

  // 言語違い（日本語名 ↔ 英語/ローマ字 displayName）の救済。距離だけでは採らず、
  // 近傍候補がちょうど1件・タイプ互換・語彙対応（地名+施設種別）・所在地が大阪、の全てを要求する。
  if (nearby.length === 1) {
    const p = nearby[0];
    const cross = crossLanguageNameAgree(candidate.name, p.displayName);
    const addressOk = !p.formattedAddress || /osaka|大阪/i.test(p.formattedAddress);
    if (cross.ok && addressOk && typesCompatible(candidate.osmSubcategory, p)) {
      return {
        matchConfidence: 'VERIFIED', googlePlaceId: p.placeId,
        distanceMeters: Math.round(p.distanceMeters),
        reason: '座標(' + Math.round(p.distanceMeters) + 'm以内)・タイプ(' + (p.primaryType || 'types') + ')互換・'
          + cross.reason + ' [cross-language]',
        candidateCount: places.length,
      };
    }
  }

  // 座標は近いが名前が一致しない → 別施設の可能性があるので保留（借りてこない）。
  if (nearby.length === 1) {
    return { ...base, matchConfidence: 'AMBIGUOUS', distanceMeters: Math.round(nearby[0].distanceMeters),
      reason: '座標は近い(' + Math.round(nearby[0].distanceMeters) + 'm)が名前が一致しない: "'
        + nearby[0].displayName + '"' };
  }
  return withNeeds({ ...base, matchConfidence: 'AMBIGUOUS',
    reason: '座標が近い候補が複数あるが、どれも名前が一致しない（曖昧）' });
}
