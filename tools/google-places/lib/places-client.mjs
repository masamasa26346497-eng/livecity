// tools/google-places/lib/places-client.mjs
// [Mission 36H §6/§7] Google Places API (New) への薄いクライアント。
//
//   §7 遵守: API キーが無ければネットワークへは一切出ず、`enabled:false` を返すだけ
//     （例外を投げない・黙って壊れない）。field mask は field-mask.mjs の最小集合を必ず使う。
//     1件あたりの写真枚数は maxPhotosPerPlace で必ず切る（既定 4、3〜5に丸める）。
//   §6 遵守: 実際にネットへ出る箇所は requestGuard.schedule() を必ず通す
//     （重複排除・レート上限・セッション上限）。
//
//   fetchImpl を注入できるようにしてあるのは、テストで実ネットワークを使わずに
//   （＝このサンドボックスでも）動作を検証するため。実行時は node の組み込み fetch を渡す。
import { SEARCH_FIELD_MASK, DETAILS_FIELD_MASK, IDENTITY_FIELD_MASK, buildFieldMaskHeader, clampPhotoCount }
  from './field-mask.mjs';
import { createRequestGuard } from './rate-guard.mjs';

const API_BASE = 'https://places.googleapis.com/v1';

export function createPlacesClient(opts = {}) {
  const apiKey = opts.apiKey || null;
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const requestGuard = opts.requestGuard || createRequestGuard(opts.rateGuard || {});
  const maxPhotosPerPlace = clampPhotoCount(opts.maxPhotosPerPlace);
  const debugCounters = { searchCalls: 0, detailsCalls: 0, photoMediaCalls: 0, disabledCalls: 0 };

  const isEnabled = () => !!apiKey;

  function headers(fieldMask) {
    return {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': buildFieldMaskHeader(fieldMask),
    };
  }

  /**
   * §9 保守的マッチングの入力用。テキスト検索のみ（写真は取らない＝コストを抑える）。
   * @param {{textQuery:string, lat?:number, lon?:number, radiusMeters?:number}} params
   */
  async function searchText(params) {
    if (!isEnabled()) { debugCounters.disabledCalls++; return { ok: false, reason: 'no-api-key', places: [] }; }
    if (!fetchImpl) { return { ok: false, reason: 'no-fetch-implementation', places: [] }; }
    const key = 'searchText:' + params.textQuery + ':' + (params.lat ?? '') + ',' + (params.lon ?? '');
    return requestGuard.schedule(key, async () => {
      // languageCode/regionCode: 日本語名で検索しているので日本語の displayName を優先して返してもらう
      // （未指定だと英語/ローマ字表記が返り名前照合が失敗しやすい）。課金には影響しない。
      const body = { textQuery: params.textQuery, maxResultCount: 10, languageCode: 'ja', regionCode: 'JP' };
      if (params.lat != null && params.lon != null) {
        body.locationBias = { circle: { center: { latitude: params.lat, longitude: params.lon },
          radius: params.radiusMeters ?? 300 } };
      }
      debugCounters.searchCalls++;
      const res = await fetchImpl(API_BASE + '/places:searchText', {
        method: 'POST', headers: headers(SEARCH_FIELD_MASK), body: JSON.stringify(body),
      });
      if (!res.ok) return { ok: false, reason: 'http-' + res.status, places: [] };
      const json = await res.json();
      const places = (json.places || []).map((p) => ({
        placeId: p.id, displayName: p.displayName && p.displayName.text,
        formattedAddress: p.formattedAddress || null,
        lat: p.location && p.location.latitude, lon: p.location && p.location.longitude,
        primaryType: p.primaryType || null, types: Array.isArray(p.types) ? p.types : [],
      }));
      return { ok: true, places };
    });
  }

  /**
   * §5/§7 確定した placeId の写真メタデータを取る。写真の実データではなく
   * 「media参照名」だけを受け取り、表示時に getPhotoMedia() で解決する（永続化しない）。
   */
  async function getPlaceDetails(placeId) {
    if (!isEnabled()) { debugCounters.disabledCalls++; return { ok: false, reason: 'no-api-key', place: null }; }
    if (!fetchImpl) { return { ok: false, reason: 'no-fetch-implementation', place: null }; }
    return requestGuard.schedule('details:' + placeId, async () => {
      debugCounters.detailsCalls++;
      const res = await fetchImpl(API_BASE + '/places/' + encodeURIComponent(placeId), {
        headers: headers(DETAILS_FIELD_MASK),
      });
      if (!res.ok) return { ok: false, reason: 'http-' + res.status, place: null };
      const p = await res.json();
      const photos = (p.photos || []).slice(0, maxPhotosPerPlace).map((ph) => ({
        photoName: ph.name, widthPx: ph.widthPx, heightPx: ph.heightPx,
        authorAttributions: (ph.authorAttributions || []).map((a) => ({
          displayName: a.displayName, uri: a.uri || null, photoUri: null, // §5: 著者アイコン画像URLは保持しない
        })),
      }));
      return {
        ok: true,
        place: {
          placeId: p.id, displayName: p.displayName && p.displayName.text,
          formattedAddress: p.formattedAddress || null,
          lat: p.location && p.location.latitude, lon: p.location && p.location.longitude,
          primaryType: p.primaryType || null, googleMapsUri: p.googleMapsUri || null,
          photos,
        },
      };
    });
  }

  /**
   * 曖昧さ解消（第二段階）専用。写真を含まない識別用フィールドだけを取る。
   * ja の displayName を要求する（Text Search と同じ言語で比較するため）。
   */
  async function getPlaceIdentity(placeId) {
    if (!isEnabled()) { debugCounters.disabledCalls++; return { ok: false, reason: 'no-api-key', place: null }; }
    if (!fetchImpl) { return { ok: false, reason: 'no-fetch-implementation', place: null }; }
    return requestGuard.schedule('identity:' + placeId, async () => {
      debugCounters.detailsCalls++;
      const res = await fetchImpl(API_BASE + '/places/' + encodeURIComponent(placeId)
        + '?languageCode=ja&regionCode=JP', { headers: headers(IDENTITY_FIELD_MASK) });
      if (!res.ok) return { ok: false, reason: 'http-' + res.status, place: null };
      const p = await res.json();
      return {
        ok: true,
        place: {
          placeId: p.id || placeId, displayName: p.displayName && p.displayName.text,
          formattedAddress: p.formattedAddress || null,
          lat: p.location && p.location.latitude, lon: p.location && p.location.longitude,
          primaryType: p.primaryType || null, types: Array.isArray(p.types) ? p.types : [],
        },
      };
    });
  }

  /**
   * §5 写真そのものは表示のたびに解決する（＝これの戻り値・URLを恒久データとして保存しない）。
   * @param {string} photoName  'places/{id}/photos/{ref}' 形式
   */
  async function getPhotoMediaUrl(photoName, { maxWidthPx = 800 } = {}) {
    if (!isEnabled()) { debugCounters.disabledCalls++; return { ok: false, reason: 'no-api-key', url: null }; }
    return requestGuard.schedule('media:' + photoName + ':' + maxWidthPx, async () => {
      debugCounters.photoMediaCalls++;
      const url = API_BASE + '/' + photoName + '/media?maxWidthPx=' + maxWidthPx
        + '&skipHttpRedirect=true&key=' + encodeURIComponent(apiKey);
      if (!fetchImpl) return { ok: false, reason: 'no-fetch-implementation', url: null };
      const res = await fetchImpl(url);
      if (!res.ok) return { ok: false, reason: 'http-' + res.status, url: null };
      const json = await res.json();
      return { ok: true, url: json.photoUri || null };
    });
  }

  return {
    isEnabled, searchText, getPlaceDetails, getPlaceIdentity, getPhotoMediaUrl,
    getDebugCounters: () => ({ ...debugCounters, ...requestGuard.getStats() }),
    maxPhotosPerPlace,
  };
}
