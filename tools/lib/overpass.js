// tools/lib/overpass.js
// Overpass APIへのクエリ実行。リトライ・レート制限対応・エンドポイント切替に対応する。
// 注意: このモジュールは実際にネットワークへ接続する。Claude Codeの隔離環境では実行できず、
// ネットワーク接続可能なローカル環境またはCI環境でのみ動作する。

// 接続先はハードコードせず、環境変数または引数で切り替えられるようにする。
// 複数のミラーを順に試すことで、単一障害点を避ける。
const DEFAULT_ENDPOINTS = [
  process.env.OVERPASS_ENDPOINT,
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
].filter(Boolean);

const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 2000; // 429やエラー時の初回待機時間（以降は指数的に増やす）
const REQUEST_INTERVAL_MS = 1500; // 連続リクエスト間の最低待機時間（APIへの過度な負荷を避ける）
const HTTP_TIMEOUT_MS = 90000; // Overpass-QL自体の[timeout:N]はサーバ側の処理時間上限であり、
                                 // クライアント側のHTTP接続自体がハングするケースに備えて別途設定する
const USER_AGENT = 'LiveCity-Osaka-DataPipeline/1.0 (https://github.com/; contact via project repository)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 単一のOverpass QLクエリを実行し、JSON結果を返す。
 * @param {string} query Overpass QL（[out:json];... の完全な文字列）
 * @param {{endpoints?: string[], onRetry?: (attempt:number, reason:string)=>void}} options
 */
export async function runOverpassQuery(query, options = {}) {
  const endpoints = options.endpoints && options.endpoints.length ? options.endpoints : DEFAULT_ENDPOINTS;
  if (!endpoints.length) {
    throw new Error('Overpass APIエンドポイントが設定されていません。OVERPASS_ENDPOINT環境変数を設定してください。');
  }

  let lastError = null;
  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
          body: query,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.status === 429 || res.status === 504) {
          // レート制限・タイムアウト: 指数バックオフして再試行
          const waitMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
          if (options.onRetry) options.onRetry(attempt + 1, `HTTP ${res.status}`);
          await sleep(waitMs);
          continue;
        }
        if (!res.ok) {
          throw new Error(`Overpass APIエラー: HTTP ${res.status} (${endpoint})`);
        }
        const data = await res.json();
        await sleep(REQUEST_INTERVAL_MS); // 次のリクエストまで間隔を空ける（API負荷軽減）
        return data;
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err.name === 'AbortError' ? new Error(`HTTPタイムアウト(${HTTP_TIMEOUT_MS}ms超過)`) : err;
        if (attempt < MAX_RETRIES) {
          const waitMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
          if (options.onRetry) options.onRetry(attempt + 1, lastError.message);
          await sleep(waitMs);
        }
      }
    }
    // このエンドポイントで全リトライ失敗 -> 次のエンドポイントを試す
  }
  throw new Error(`全エンドポイントで取得失敗: ${lastError ? lastError.message : '不明なエラー'}`);
}

/**
 * bbox(south,west,north,east)とOSMフィルタ式から、Overpass QLクエリ文字列を組み立てる。
 * osmFilter例: 'way["highway"~"^(motorway|trunk)$"]'
 * 複数フィルタはセミコロン区切りで連結できる（config側でそのように定義する）。
 */
export function buildOverpassQuery(bbox, osmFilter, timeoutSec = 60) {
  const { south, west, north, east } = bbox;
  const bboxStr = `${south},${west},${north},${east}`;
  // フィルタ文字列内の各 "way[...]" や "node[...]" に bbox を付与する
  const statements = osmFilter
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${s}(${bboxStr});`)
    .join('\n  ');
  return `[out:json][timeout:${timeoutSec}];\n(\n  ${statements}\n);\nout geom;`;
}
