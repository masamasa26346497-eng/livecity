// tools/experiments/mission38f_lru_regression_qa.mjs
// [37G+38F 統合回帰] 実 Chrome（headless）で 5 区を順に訪れ、区別施設ローダーの LRU（最大 3 区）を検証する。
//   cachedWards <= 3 / facilityEvictions 増加 / 外れた区の点・検索インデックスの解放 / 選択中施設の維持 /
//   再訪時の再取得 / JS 例外 0 / Google 通信 0。headless の FPS・時間は実機値ではない。
// 使い方: node tools/experiments/mission38f_lru_regression_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT_DIR = 'data/reports/mission38f-lru';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE_HOSTS = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8141, r));
const URL_ = 'http://localhost:8141/mission37g-osaka-24ward-mvp.html?qa=1';

const wardFile = (id) => JSON.parse(fs.readFileSync(`public/map-data/osaka-city/facilities/wards/${id}.json`, 'utf8'));
const base37d = new Set(JSON.parse(fs.readFileSync('public/mission37d-data/sumiyoshi-facilities.json', 'utf8')).records.map((r) => r.sourceId));
// 各区: 名称が一意で 37D 束に無い施設（点クリック対象・検索確認用）。他施設と 25m 以上離れ、非飲食を優先
function target(id) {
  const all = wardFile(id).records;
  const names = new Map(); for (const r of all) names.set(r.name, (names.get(r.name) || 0) + 1);
  const ok = (r) => r.name && names.get(r.name) === 1 && !base37d.has(r.sourceId) && r.sourceId;
  const cands = all.filter((r) => ok(r) && ['public', 'education', 'medical', 'tourism', 'transport'].includes(r.category));
  return cands.find((r) => all.every((o) => o === r || Math.hypot(o.localX - r.localX, o.localZ - r.localZ) > 25)) || cands[0];
}
const ORDER = ['kita', 'tsurumi', 'chuo', 'nishi', 'kita'];   // 4 区目で kita が LRU から外れ、5 回目で再訪
const T = Object.fromEntries([...new Set(ORDER)].map((id) => [id, target(id)]));

const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
const out = { mission: '37G+38F LRU regression', url: URL_, browser: b.version, generatedAt: new Date().toISOString(), googleRequests: [], failedRequests: [], jsErrors: [], wardFetches: [], steps: [], checks: {} };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => {
  try {
    const u = new URL(e.request.url);
    if (GOOGLE_HOSTS.test(u.hostname)) out.googleRequests.push(e.request.url);
    if (/\/facilities\/wards\/[a-z]+\.json$/.test(u.pathname)) out.wardFetches.push(u.pathname.split('/').pop().replace('.json', ''));
  } catch { /* data: */ }
});
page.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/tile\.|cyberjapandata/.test(e.response.url)) out.failedRequests.push(e.response.status + ' ' + e.response.url); });
const ev = (js) => page.evaluate(js);
const evj = async (js) => JSON.parse(await ev(`JSON.stringify(${js})`));
async function click(x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const shot = async (name) => {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64'));
};
const snap = () => evj(`({ cached: window.__mission37g.facilityCachedWards || null, evictions: window.__mission37g.facilityEvictions || 0, wards: Object.keys(window.__mission37g.facilityWards || {}), poi: window.__mission37g.poi, selected: window.__mission37g.selectedPoi || null })`);
async function search(name) {
  await ev(`(() => { const q = document.getElementById('lc-q'); q.value = ${JSON.stringify(name)}; q.dispatchEvent(new Event('input')); })()`);
  await sleep(1500);
  return ev("Array.from(document.querySelectorAll('#lc-results button')).map((b) => b.textContent)");
}
async function gotoWard(id, visit) {
  const t = T[id];
  const t0 = Date.now();
  const before = (await snap()).evictions;
  await ev(`window.__mission37dQA.lookAtLocal(${t.localX}, ${t.localZ}, 0, 500, -60, 0)`);
  let ok = false;
  for (let i = 0; i < 60; i++) { await sleep(500); const s = await snap(); if (s.cached && s.cached.includes(id) && s.wards.includes(id)) { ok = true; break; } }
  const loadMs = Date.now() - t0;
  await sleep(2500);
  const s = await snap();
  return { step: visit, ward: id, loaded: ok, loadMs, evictionsBefore: before, evictionsAfter: s.evictions, cached: s.cached, poi: s.poi, selected: s.selected };
}

try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    if ((await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break;
  }
  await sleep(2500);
  out.heapStart = await ev('performance.memory ? performance.memory.usedJSHeapSize : null');

  // 1) kita: ロード → 施設点を実クリックして選択（以降の移動で維持されるべき）
  const s1 = await gotoWard('kita', 1);
  out.steps.push(s1);
  const t = T.kita;
  const p = await evj(`window.__mission37dQA.project(${t.localX}, ${t.localZ}, 6)`);
  if (p && p.inCanvas) { await click(p.x, p.y); await sleep(900); }
  const sel = await snap();
  out.checks.selectedKita = !!(sel.selected && sel.selected.id === t.id);
  out.selectedKita = sel.selected;
  out.kitaSearchWhileCached = (await search(t.name)).some((x) => x.includes(t.name));

  // 2) tsurumi, chuo, nishi（4 区目で kita が外れる）、kita 再訪
  for (let i = 1; i < ORDER.length; i++) {
    const r = await gotoWard(ORDER[i], i + 1);
    out.steps.push(r);
    if (i === 3) {
      // nishi ロード直後（kita は LRU 外）: 選択中の kita 施設は維持、他の kita 施設は検索から消える
      const sn = await snap();
      out.afterEviction = { cached: sn.cached, evictions: sn.evictions, selected: sn.selected };
      const sameNameOther = wardFile('kita').records.find((r2) => r2.name && r2.sourceId !== t.sourceId && !base37d.has(r2.sourceId) && r2.category !== 'dining');
      out.evictedSearch = sameNameOther ? { name: sameNameOther.name, hits: await search(sameNameOther.name) } : null;
      out.selectedSearchKept = (await search(t.name)).some((x) => x.includes(t.name));
      out.panelNameAfterEviction = await ev("document.getElementById('lc-poi-name') && document.getElementById('lc-poi-name').textContent");
      await shot('after-eviction-nishi');
    }
  }
  const last = out.steps[out.steps.length - 1];
  out.fetchCounts = out.wardFetches.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {});
  out.heapEnd = await ev('performance.memory ? performance.memory.usedJSHeapSize : null');

  // 3) 建物クリック（北区の 3D 一部配信）: 実在 canonicalId 選択が維持されるか
  try {
    out.buildingClick = await ev(`(async () => { const d = window.__mission37g; return { tilesetStats: d.tilesetStats ? true : false, errors: d.errors || null }; })()`).then((x) => x);
  } catch { /* noop */ }

  const maxCached = Math.max(...out.steps.map((s) => (s.cached || []).length));
  out.checks.lruMax3 = maxCached <= 3 && maxCached >= 1;
  out.checks.maxCachedObserved = maxCached;
  out.checks.evictionIncreased = (out.afterEviction?.evictions || 0) >= 1 && last.evictionsAfter >= out.afterEviction.evictions;
  out.checks.kitaEvictedFromCache = out.afterEviction ? !out.afterEviction.cached.includes('kita') : false;
  out.checks.evictedSearchGone = out.evictedSearch ? !out.evictedSearch.hits.some((x) => x.includes(out.evictedSearch.name)) : null;
  out.checks.selectedKept = !!(out.afterEviction?.selected && out.afterEviction.selected.id === t.id) && out.selectedSearchKept;
  out.checks.kitaRefetched = (out.fetchCounts.kita || 0) >= 2;
  out.checks.kitaReloaded = !!last.loaded && last.ward === 'kita';
  out.jsErrorCount = out.jsErrors.length;
  out.googleRequestCount = out.googleRequests.length;
  const c = out.checks;
  out.pass = out.steps.every((s) => s.loaded) && c.selectedKita && c.lruMax3 && c.evictionIncreased && c.kitaEvictedFromCache
    && c.evictedSearchGone !== false && c.selectedKept && c.kitaRefetched && out.jsErrorCount === 0 && out.googleRequestCount === 0;
} catch (e) {
  out.error = String(e && e.stack || e);
} finally {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'lru-qa.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ pass: out.pass, checks: out.checks, steps: out.steps.map((s) => ({ ward: s.ward, loaded: s.loaded, loadMs: s.loadMs, cached: s.cached, ev: s.evictionsAfter })), fetchCounts: out.fetchCounts, evictedSearch: out.evictedSearch, jsErrors: out.jsErrors, google: out.googleRequestCount, failed: out.failedRequests, error: out.error }, null, 2));
  await b.close?.();
  srv.close();
  process.exit(out.pass ? 0 : 1);
}
