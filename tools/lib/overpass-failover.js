// tools/lib/overpass-failover.js
// P1-6: 複数 Overpass エンドポイントを failover しながらクエリを実行するクライアント。
//
// tools/lib/overpass.js（全リトライ後にようやく次エンドポイントへ）とは方針が異なり、
// サーバー障害系（429/500/502/503/504/timeout/network）では **同一エンドポイントで粘らず即座に
// 別エンドポイントへ切り替える**。エンドポイントごとに health（連続失敗数・cooldown）を持つ。
//
// ネットワーク I/O は fetchImpl 経由で注入可能（テストで偽 fetch を渡せる）。

const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const SERVER_ERROR_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * @param {object} [opts]
 * @param {string[]} [opts.endpoints]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.httpTimeoutMs=90000]
 * @param {number} [opts.minRequestIntervalMs=1200]  グローバルなリクエスト間隔（公開Overpass負荷配慮）
 * @param {number} [opts.minEndpointIntervalMs=2500] 同一エンドポイントへの最短間隔
 * @param {number} [opts.maxRounds=4]                全エンドポイントを1周する試行を何周するか
 * @param {number} [opts.baseBackoffMs=2000]         周回ごとの指数バックオフ基準
 * @param {number} [opts.cooldownFailThreshold=3]    連続失敗がこの数に達したら cooldown
 * @param {[number,number]} [opts.cooldownRangeMs=[60000,180000]]
 * @param {(evt:object)=>void} [opts.onEvent]        ログ用イベント（type: fetch|retry|failover|cooldown|ok|giveup）
 * @param {()=>number} [opts.now]                    テスト用時刻ソース
 * @param {(ms:number)=>Promise<void>} [opts.sleepImpl]
 */
export function createOverpassClient(opts = {}) {
  const endpoints = (opts.endpoints && opts.endpoints.length ? opts.endpoints : DEFAULT_ENDPOINTS).slice();
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  // HTTP(AbortController) timeout は Overpass-QL の [timeout:N] より必ず長くする。
  // qlTimeoutSec を渡すと httpTimeoutMs = (qlTimeoutSec + margin) * 1000 を採用する。
  const qlTimeoutSec = opts.qlTimeoutSec ?? 90;
  const httpTimeoutMs = opts.httpTimeoutMs ?? (qlTimeoutSec + 30) * 1000;
  const errorBodyChars = opts.errorBodyChars ?? 1000; // 4xx/5xx 時に読む response body の文字数
  const minRequestIntervalMs = opts.minRequestIntervalMs ?? 1200;
  const minEndpointIntervalMs = opts.minEndpointIntervalMs ?? 2500;
  const maxRounds = opts.maxRounds ?? 4;
  const baseBackoffMs = opts.baseBackoffMs ?? 2000;
  const cooldownFailThreshold = opts.cooldownFailThreshold ?? 3;
  const cooldownRange = opts.cooldownRangeMs || [60000, 180000];
  const onEvent = opts.onEvent || (() => {});
  const now = opts.now || (() => Date.now());
  const doSleep = opts.sleepImpl || sleep;

  const health = new Map(); // url -> { consecutiveFailures, cooldownUntil, lastAttemptAt, totalFailures, totalOk }
  for (const u of endpoints) health.set(u, { consecutiveFailures: 0, cooldownUntil: 0, lastAttemptAt: 0, totalFailures: 0, totalOk: 0 });
  let lastGlobalRequestAt = 0;

  function orderedEndpoints() {
    const t = now();
    return [...endpoints].sort((a, b) => {
      const ha = health.get(a), hb = health.get(b);
      const aCool = ha.cooldownUntil > t ? 1 : 0;
      const bCool = hb.cooldownUntil > t ? 1 : 0;
      if (aCool !== bCool) return aCool - bCool;                 // cooldown 中は後回し
      if (ha.consecutiveFailures !== hb.consecutiveFailures) return ha.consecutiveFailures - hb.consecutiveFailures;
      return ha.lastAttemptAt - hb.lastAttemptAt;               // 最近使っていない方を優先
    });
  }

  function markFailure(url, reason) {
    const h = health.get(url);
    h.consecutiveFailures++;
    h.totalFailures++;
    if (h.consecutiveFailures >= cooldownFailThreshold) {
      const [lo, hi] = cooldownRange;
      const dur = Math.round(lo + Math.random() * (hi - lo));
      h.cooldownUntil = now() + dur;
      onEvent({ type: 'cooldown', endpoint: url, ms: dur, consecutiveFailures: h.consecutiveFailures, reason });
    }
  }
  function markSuccess(url) {
    const h = health.get(url);
    h.consecutiveFailures = 0;
    h.cooldownUntil = 0;
    h.totalOk++;
  }

  function parseRetryAfter(headers) {
    try {
      const v = headers && (headers.get ? headers.get('retry-after') : headers['retry-after']);
      if (!v) return null;
      const secs = Number(v);
      if (Number.isFinite(secs)) return Math.min(secs * 1000, 120000);
      const when = Date.parse(v);
      if (Number.isFinite(when)) return Math.min(Math.max(0, when - now()), 120000);
    } catch (e) { /* noop */ }
    return null;
  }

  async function attempt(url, query, label) {
    // グローバル & エンドポイント間隔
    const gWait = minRequestIntervalMs - (now() - lastGlobalRequestAt);
    if (gWait > 0) await doSleep(gWait);
    const h = health.get(url);
    const eWait = minEndpointIntervalMs - (now() - h.lastAttemptAt);
    if (eWait > 0) await doSleep(eWait);

    lastGlobalRequestAt = now();
    h.lastAttemptAt = now();
    const httpStart = now();
    onEvent({ type: 'fetch', tile: label, endpoint: url, httpTimeoutMs, qlTimeoutSec });

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timedOut = false;
    const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, httpTimeoutMs) : null;
    // Overpass は raw QL POST も data= も受けるが、広く互換な application/x-www-form-urlencoded + data= を使う。
    const body = 'data=' + encodeURIComponent(query);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'LiveCity-Osaka-DataPipeline/1.0 (+https://github.com/; OSM tiling for Osaka 24 wards)',
          'Accept': 'application/json',
        },
        body,
        signal: controller ? controller.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      const httpMs = now() - httpStart;
      const text = await safeText(res); // body は1回しか読めないため text で受けてから判定する
      if (res.ok) {
        try {
          const data = JSON.parse(text);
          markSuccess(url);
          return { ok: true, data };
        } catch (pe) {
          markFailure(url, 'JSON parse 失敗');
          onEvent({ type: 'errorBody', tile: label, endpoint: url, status: res.status, httpMs, body: text.slice(0, errorBodyChars) });
          return { ok: false, retryable: true, reason: `応答が JSON でない（${pe.message}）` };
        }
      }
      onEvent({ type: 'errorBody', tile: label, endpoint: url, status: res.status, httpMs, body: text.slice(0, errorBodyChars) });
      if (SERVER_ERROR_STATUS.has(res.status)) {
        const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers) : null;
        markFailure(url, `HTTP ${res.status}`);
        return { ok: false, retryable: true, status: res.status, retryAfterMs, reason: `HTTP ${res.status}` };
      }
      // 4xx（400 等）はクエリ側の問題。failover しても直らないので即エラー。
      markFailure(url, `HTTP ${res.status}`);
      return { ok: false, retryable: false, status: res.status, reason: `HTTP ${res.status}（クエリを確認）` };
    } catch (e) {
      if (timer) clearTimeout(timer);
      const httpMs = now() - httpStart;
      const reason = timedOut
        ? `HTTP timeout(${httpTimeoutMs}ms > QL timeout ${qlTimeoutSec}s)`
        : `network: ${e && e.message}`;
      markFailure(url, reason);
      onEvent({ type: 'errorBody', tile: label, endpoint: url, status: timedOut ? 'timeout' : 'network', httpMs, body: (e && (e.stack || e.message)) || '' });
      return { ok: false, retryable: true, reason };
    }
  }

  async function safeText(res) {
    try { return await res.text(); } catch (e) { return ''; }
  }

  /**
   * @param {string} query Overpass QL
   * @param {string} [label] ログ用のタイル名等
   * @returns {Promise<object>} Overpass JSON
   */
  async function run(query, label = '') {
    if (!fetchImpl) throw new Error('fetch 実装がありません（Node 18+ または fetchImpl を注入してください）');
    let lastReason = 'unknown';
    let prevEndpoint = null;
    for (let round = 0; round < maxRounds; round++) {
      const order = orderedEndpoints();
      for (const url of order) {
        if (prevEndpoint && prevEndpoint !== url) onEvent({ type: 'failover', tile: label, from: prevEndpoint, to: url, reason: lastReason });
        else if (round > 0 || prevEndpoint === url) onEvent({ type: 'retry', tile: label, endpoint: url, round: round + 1, reason: lastReason });
        prevEndpoint = url;

        const r = await attempt(url, query, label);
        if (r.ok) { onEvent({ type: 'ok', tile: label, endpoint: url }); return r.data; }
        lastReason = r.reason;
        if (!r.retryable) throw new Error(`Overpass 取得失敗（${label}）: ${r.reason}`);
        // 429 の Retry-After は尊重するが、まず「別エンドポイントを試す」ことを優先。
        if (r.retryAfterMs && order.length === 1) await doSleep(r.retryAfterMs);
      }
      // 1周して全滅 → 指数バックオフしてもう1周
      const backoff = baseBackoffMs * Math.pow(2, round);
      onEvent({ type: 'retry', tile: label, endpoint: '(all)', round: round + 2, reason: `全endpoint失敗。${backoff}ms 待機` });
      await doSleep(backoff);
    }
    throw new Error(`Overpass 取得失敗（${label}）: 全 ${endpoints.length} endpoint × ${maxRounds} 周で成功せず。最後の理由: ${lastReason}`);
  }

  function healthSnapshot() {
    const out = {};
    for (const [u, h] of health) out[u] = { consecutiveFailures: h.consecutiveFailures, cooldownRemainingMs: Math.max(0, h.cooldownUntil - now()), totalOk: h.totalOk, totalFailures: h.totalFailures };
    return out;
  }

  return { run, healthSnapshot, endpoints: endpoints.slice() };
}

export { DEFAULT_ENDPOINTS };
