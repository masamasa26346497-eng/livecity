// tools/experiments/mission39a_perf_stability_qa.mjs
// [39A 実機性能に向けた安定化 QA] 実 Chrome(headless) で 起動 / ズーム往復 / 360° 回転 / 建物クリック(+写真) を
//   fac=0（区別施設ロード無効）と fac=1（既定）、デスクトップ幅とスマホ幅で同条件計測する。
//   JS 例外 0 / Google 通信 0 / 404 を確認。headless はソフトウェア描画のため FPS・時間は実機値ではない（相対比較のみ）。
// 使い方: node tools/experiments/mission39a_perf_stability_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT_DIR = 'data/reports/mission39a-perf';
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
await new Promise((r) => srv.listen(8142, r));

// 阪和病院（写真あり）: 建物属性の代表点から位置を求める
const TARGET_ID = 'bldg_ec74351a-f344-4b61-b2e6-04b660b05aa0';
const attrDir = 'public/mission37c-layers/osaka-sumiyoshi-9tile/attrs/';
const attrs = {};
for (const f of fs.readdirSync(attrDir)) Object.assign(attrs, JSON.parse(fs.readFileSync(attrDir + f, 'utf8')).byId);
const [TH, , TX, TZ] = attrs[TARGET_ID];

const pct = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1); };
const stat = (a) => ({ n: a.length, mean: a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null, p50: pct(a, 0.5), p95: pct(a, 0.95), max: a.length ? +Math.max(...a).toFixed(1) : null });

async function scenario(label, query, viewport) {
  const b = await launchBrowser({ width: viewport.width, height: viewport.height });
  const page = b.page;
  const r = { label, query, viewport, browser: b.version, googleRequests: [], failed404: [], jsErrors: [], checks: {} };
  page.on('Runtime.exceptionThrown', (e) => { try { r.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
  page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE_HOSTS.test(new URL(e.request.url).hostname)) r.googleRequests.push(e.request.url); } catch { /* data: */ } });
  page.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/tile\.|cyberjapandata|favicon/.test(e.response.url)) r.failed404.push(e.response.status + ' ' + e.response.url); });
  const ev = (js) => page.evaluate(js);
  const evj = async (js) => JSON.parse(await ev(`JSON.stringify(${js})`));
  const heap = async () => { try { return +((await ev('performance.memory ? performance.memory.usedJSHeapSize : 0')) / 1048576).toFixed(1); } catch { return null; } };
  try {
    await page.send('Network.enable');
    if (viewport.mobile) await page.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 2, mobile: true });
    const t0 = Date.now();
    await page.send('Page.navigate', { url: `http://localhost:8142/mission37g-osaka-24ward-mvp.html?qa=1${query}` });
    let ready = false;
    for (let i = 0; i < 120; i++) { await sleep(500); try { if (await ev("!!window.__mission37g && typeof window.__mission37g.status === 'string' && window.__mission37g.status !== 'error' && window.__mission37g.status.indexOf('loading') !== 0 || (window.__mission37g && window.__mission37g.status === 'loading tiles…')")) { ready = true; break; } } catch { /* loading */ } }
    r.startup = { ready, readyMs: Date.now() - t0, heapMB: await heap() };
    // 計測用フレームサンプラー（rAF 間隔）
    await ev('window.__fr = { t: [], on: false }; (function loop(ts){ if (window.__fr.on) window.__fr.t.push(ts); requestAnimationFrame(loop); })(0); true');
    const frames = async (fn) => {
      await ev('window.__fr.t = []; window.__fr.on = true');
      await fn();
      await ev('window.__fr.on = false');
      const t = await evj('window.__fr.t');
      const d = []; for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
      return { ...stat(d), longFramesOver100ms: d.filter((x) => x > 100).length };
    };
    const look = (range, pitch, heading) => ev(`window.__mission37dQA.lookAtLocal(${TX}, ${TZ}, ${TH * 0.5}, ${range}, ${pitch}, ${heading})`);
    await look(700, -50, 0);
    for (let i = 0; i < 40; i++) { if (await ev('window.__mission37dQA.tilesReady()')) break; await sleep(500); }
    await sleep(2500);   // 区別施設ロードの完了待ち（fac=1 のとき）
    r.firstDisplayMs = await ev('window.__mission37g.firstDisplayMs || null');
    r.status = await ev('window.__mission37g.status');
    r.afterSettle = { heapMB: await heap(), poi: await evj('window.__mission37g.poi'), cachedWards: await evj('window.__mission37g.facilityCachedWards || null') };
    // ズーム往復
    r.zoom = await frames(async () => { for (const rg of [400, 250, 150, 400, 900, 2500, 900, 400]) { await look(rg, -50, 0); await sleep(350); } });
    // 360° 回転（30° 刻み）
    r.rotate360 = await frames(async () => { for (let h = 0; h <= 360; h += 30) { await look(500, -45, h); await sleep(250); } });
    r.afterMotion = { heapMB: await heap(), jsErrors: r.jsErrors.length };
    // 建物クリック（実マウス）: 投影した画面点のうち pick が目的 ID を返す点だけクリックし、選択 / 写真表示までの遅延を測る
    await look(300, -60, 0); await sleep(2500);
    let pt = null;
    for (const f of [0.5, 1, 0.1]) {
      const base = await evj(`window.__mission37dQA.project(${TX}, ${TZ}, ${TH * f})`);
      if (!base || !base.inCanvas) continue;
      for (const [dx, dy] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [12, 6], [-12, 6], [12, -6], [-12, -6]]) {
        if ((await ev(`window.__mission37dQA.pickId(${base.x + dx}, ${base.y + dy})`)) === TARGET_ID) { pt = { x: base.x + dx, y: base.y + dy }; break; }
      }
      if (pt) break;
    }
    r.click = { found: !!pt };
    if (pt) {
      const tc = Date.now();
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      let selMs = null, photoMs = null;
      for (let i = 0; i < 400; i++) {
        const s = await evj("({ sel: (window.__mission37d && window.__mission37d.selectedCanonicalId) || null, img: (function () { var im = document.querySelector('#lc-photo-slot img'); return !!(im && im.complete && im.naturalWidth > 0); })() })");
        if (selMs === null && s.sel === TARGET_ID) selMs = Date.now() - tc;
        if (photoMs === null && s.img) { photoMs = Date.now() - tc; break; }
        await sleep(50);
      }
      r.click = { found: true, selectedMs: selMs, photoShownMs: photoMs, selected: selMs !== null, photoDisplayed: photoMs !== null };
    }
    r.finalHeapMB = await heap();
    r.checks = {
      ready, googleZero: r.googleRequests.length === 0, jsErrorsZero: r.jsErrors.length === 0, no404: r.failed404.length === 0,
      clickSelected: !!(r.click && r.click.selected), photoShown: !!(r.click && r.click.photoDisplayed),
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    fs.writeFileSync(path.join(OUT_DIR, label + '.jpg'), Buffer.from(data, 'base64'));
  } catch (e) { r.error = String((e && e.message) || e); }
  try { await b.close(); } catch { /* noop */ }
  return r;
}

const SCEN = [
  ['desktop-fac0', '&fac=0', { width: 1500, height: 940 }],
  ['desktop-fac1', '', { width: 1500, height: 940 }],
  ['mobile-fac0', '&fac=0', { width: 390, height: 780, mobile: true }],
  ['mobile-fac1', '', { width: 390, height: 780, mobile: true }],
];
const out = { mission: '39A perf/stability', generatedAt: new Date().toISOString(), note: 'headless ソフトウェア描画。絶対値は実機値ではなく、fac=0/1 の相対比較のみ有効', results: [] };
for (const [l, q, v] of SCEN) { console.log('run', l); out.results.push(await scenario(l, q, v)); }
srv.close();
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'perf-qa.json'), JSON.stringify(out, null, 2));
for (const r of out.results) console.log(r.label, JSON.stringify({ startup: r.startup, zoom: r.zoom, rotate: r.rotate360, click: r.click, heap: r.finalHeapMB, checks: r.checks, err: r.error }));
process.exit(out.results.some((r) => r.error || Object.values(r.checks).some((v) => v !== true)) ? 1 : 0);
