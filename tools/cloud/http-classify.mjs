// Mission 213: HTTP 応答の分類(純関数)。非2xxを「LOD0 / 実LOD1/2 / 任意アセット」に分け、404 を実建物の取得失敗と誤判定しない。
//   計測対象: Network.responseReceived の HTTP status(3xx/4xx/5xx = 非2xx)。対象外: loadingFailed(netFailed 別集計), 取消, キャッシュ提供。
//   examples は種別ごと上限 EX_MAX 件で打切り(truncated=true)。件数(nNon2xx)は打切りなし。
export const EX_MAX = 10;
export function classifyUrl(u) {
  if (/_city-lod0\//.test(u)) return /tileset\.json/.test(u) ? 'lod0Tileset' : /\.glb(\?|$)/.test(u) ? 'lod0Glb' : 'lod0Other';
  if (/\.glb(\?|$)/.test(u)) return 'realGlb';
  if (/tileset\.json/.test(u)) return 'realTileset';
  if (/\/ext-3dtiles\/.*\/layers\/|\/ext-3dtiles\/index\.json/.test(u)) return 'realLayerOrIndex';
  return 'optionalAsset'; // towns/stations/favicon/他区 source.json 等。404 でも建物取得失敗ではない
}
export function recordHttp(stat, url, status, base = /^http:\/\/127\.0\.0\.1:\d+/) {
  const cls = classifyUrl(url), s = (stat[cls] ||= { n2xx: 0, nNon2xx: 0, examples: [], truncated: false });
  if (status >= 200 && status < 300) { s.n2xx++; return cls; }
  s.nNon2xx++; const e = url.replace(base, '').slice(0, 120);
  if (s.examples.length < EX_MAX) { if (!s.examples.some((x) => x.url === e)) s.examples.push({ url: e, status }); } else s.truncated = true;
  return cls;
}
// 実建物の取得失敗とみなすのは realGlb/realTileset の非2xxのみ。
export function realFailures(stat) { return (stat.realGlb?.nNon2xx || 0) + (stat.realTileset?.nNon2xx || 0); }
