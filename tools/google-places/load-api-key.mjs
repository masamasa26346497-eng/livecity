// tools/google-places/load-api-key.mjs
// [Mission 36H §7] APIキーはコードに埋め込まない。環境変数から読む。
//   e-Stat クライアント（tools/lib/estat/api-client.js）と違い、こちらは未設定でも
//   例外を投げない（＝Google Places は「無くても壊れない」任意のフォールバック層のため）。
export function loadGooglePlacesApiKeyFromEnv(env = process.env) {
  const key = env.GOOGLE_PLACES_API_KEY;
  return key && String(key).trim() ? String(key).trim() : null;
}
