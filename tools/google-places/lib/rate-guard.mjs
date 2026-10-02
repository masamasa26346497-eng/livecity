// tools/google-places/lib/rate-guard.mjs
// [Mission 36H §6/§7] オンデマンド呼び出しの安全装置。
//   - 同じキーへの同時リクエストは 1 回にまとめる（de-duplication）
//   - 一定時間あたりのリクエスト数に上限を設ける（rate guard）
//   - セッション全体の総リクエスト数にも上限を設ける（コスト上限）
//
//   時計は引数で注入できるようにして、実時間を待たずにテストできるようにする。
//   ネットワークI/Oは持たない（呼び出す関数を受け取って実行するだけ）。

export class RateLimitExceededError extends Error {}

/**
 * @param {object} [opts]
 * @param {number} [opts.maxRequestsPerWindow=10]  ウィンドウ内の最大リクエスト数
 * @param {number} [opts.windowMs=60000]           ウィンドウの長さ（ms）
 * @param {number} [opts.maxRequestsPerSession=200] セッション全体の総上限（コスト保護）
 * @param {() => number} [opts.now]                 現在時刻（テスト用に注入可能）
 */
export function createRequestGuard(opts = {}) {
  const maxRequestsPerWindow = opts.maxRequestsPerWindow ?? 10;
  const windowMs = opts.windowMs ?? 60_000;
  const maxRequestsPerSession = opts.maxRequestsPerSession ?? 200;
  const now = opts.now || (() => Date.now());

  const inFlight = new Map();   // key -> Promise（重複排除）
  let windowStart = now();
  let windowCount = 0;
  let sessionCount = 0;
  const stats = { deduped: 0, rateLimited: 0, sessionLimited: 0, executed: 0 };

  function rollWindowIfNeeded() {
    const t = now();
    if (t - windowStart >= windowMs) { windowStart = t; windowCount = 0; }
  }

  /**
   * @param {string} key   同一とみなすリクエストのキー（例: 検索クエリの正規化文字列）
   * @param {() => Promise<any>} fn  実際にネットワークへ出る処理
   */
  async function schedule(key, fn) {
    if (inFlight.has(key)) {
      stats.deduped++;
      return inFlight.get(key);
    }
    rollWindowIfNeeded();
    if (sessionCount >= maxRequestsPerSession) {
      stats.sessionLimited++;
      throw new RateLimitExceededError('セッション内リクエスト上限に達した（' + maxRequestsPerSession + '）');
    }
    if (windowCount >= maxRequestsPerWindow) {
      stats.rateLimited++;
      throw new RateLimitExceededError('レート上限に達した（' + maxRequestsPerWindow + '/' + windowMs + 'ms）');
    }
    windowCount++;
    sessionCount++;
    stats.executed++;
    const p = Promise.resolve().then(fn).finally(() => { inFlight.delete(key); });
    inFlight.set(key, p);
    return p;
  }

  return {
    schedule,
    getStats: () => ({ ...stats, inFlight: inFlight.size, windowCount, sessionCount }),
  };
}
