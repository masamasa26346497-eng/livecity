// Issue #52: 読み取り専用・ドメイン限定の取得器（権限が付与された後の外部取得で使う）。
// このファイル自体はネットワークを使わない: fetch 実装は引数で注入でき、試験は偽の fetch で行う。
// 制限（コード側で担保。ワークフロー権限の代わりにはならないが、権限を許可しても取得先が広がらないようにする）:
//   - https の GET のみ / 許可ホストは完全一致 / 許可パスと許可 action（読み取り系）のみ / 認証情報付きURLは不可
//   - リダイレクトは自動で追わず、各リダイレクト先を同じ検証にかけて最大 3 回まで
//   - 要求間隔 minIntervalMs（ミリ秒）、リトライは最大 3 回（429/5xx のみ、指数バックオフ）、タイムアウト
//   - User-Agent は汎用のクライアント名のみ（個人情報・連絡先メールを入れない）。連絡先が必要な場合は環境変数 PHOTO_FETCH_UA_CONTACT で指定
//   - 結果はキャッシュ（URL のハッシュ）へ保存し、再開可能な小分け処理に使う
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ALLOWED = {
  'www.wikidata.org': { paths: [/^\/w\/api\.php$/, /^\/wiki\/Special:EntityData\/Q\d+\.json$/], actions: ['wbgetentities'] },
  'commons.wikimedia.org': { paths: [/^\/w\/api\.php$/], actions: ['query'] }
};
export const MAX_REDIRECTS = 3;
export const MAX_RETRIES = 3;

export function validateUrl(u) {
  let x; try { x = new URL(u); } catch (e) { return { ok: false, reason: 'invalid-url' }; }
  if (x.protocol !== 'https:') return { ok: false, reason: 'not-https' };
  if (x.username || x.password) return { ok: false, reason: 'credentials-in-url' };
  if (x.port && x.port !== '443') return { ok: false, reason: 'port-not-allowed' };
  const rule = ALLOWED[x.hostname];
  if (!rule) return { ok: false, reason: 'host-not-allowed' };
  if (!rule.paths.some((re) => re.test(x.pathname))) return { ok: false, reason: 'path-not-allowed' };
  if (x.pathname === '/w/api.php') {
    const action = x.searchParams.get('action');
    if (!rule.actions.includes(action)) return { ok: false, reason: 'action-not-allowed' };
  }
  return { ok: true, url: x.href };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cacheKey = (url) => crypto.createHash('sha256').update(url).digest('hex').slice(0, 40) + '.json';

// opts: { fetchImpl, cacheDir, minIntervalMs=1000, timeoutMs=20000, offline=false, userAgent, sleepImpl, backoffMs=2000 }
export function createFetcher(opts) {
  const o = Object.assign({ minIntervalMs: 1000, timeoutMs: 20000, offline: false, backoffMs: 2000 }, opts);
  const doSleep = o.sleepImpl || sleep;
  const contact = process.env.PHOTO_FETCH_UA_CONTACT;
  const ua = o.userAgent || ('LiveCity-photo-index/1.0 (read-only; open data pipeline)' + (contact ? ' ' + contact : ''));
  let last = 0;
  const stats = { requests: 0, cacheHits: 0, retries: 0, redirects: 0 };

  async function getJson(url) {
    const v = validateUrl(url);
    if (!v.ok) throw new Error('blocked-url:' + v.reason);
    const file = o.cacheDir ? path.join(o.cacheDir, cacheKey(v.url)) : null;
    if (file && fs.existsSync(file)) { stats.cacheHits++; return JSON.parse(fs.readFileSync(file, 'utf8')); }
    if (o.offline) throw new Error('offline-cache-miss');
    let cur = v.url, hops = 0;
    for (let attempt = 0; ; ) {
      const wait = o.minIntervalMs - (Date.now() - last);
      if (wait > 0) await doSleep(wait);
      last = Date.now(); stats.requests++;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), o.timeoutMs);
      let res;
      try { res = await o.fetchImpl(cur, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': ua, Accept: 'application/json' }, signal: ctl.signal }); }
      catch (e) { res = { status: 599, headers: { get: () => null }, json: async () => { throw e; } }; }
      finally { clearTimeout(t); }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (++hops > MAX_REDIRECTS) throw new Error('too-many-redirects');
        let next; try { next = new URL(loc, cur).href; } catch (e) { throw new Error('blocked-redirect:invalid-url'); }
        const rv = validateUrl(next);
        if (!rv.ok) throw new Error('blocked-redirect:' + rv.reason); // リダイレクト先も許可ホスト/パスのみ
        stats.redirects++; cur = rv.url; continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (++attempt > MAX_RETRIES) throw new Error('retry-limit:' + res.status);
        stats.retries++; await doSleep(o.backoffMs * 2 ** (attempt - 1)); continue;
      }
      if (res.status !== 200) throw new Error('http-' + res.status);
      const json = await res.json();
      if (file) { fs.mkdirSync(o.cacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(json)); }
      return json;
    }
  }
  return { getJson, stats };
}
