// tools/experiments/mission37g_ward_map_qa.mjs
// [Mission 37G] 実 Chrome（headless）で 24 区ページを開き、次を記録する。
//   全域の初期画面 / 区一覧 24 件 / 区への移動（北区・中央区・住吉区・平野区）/ 全域に戻る / 検索からの移動 /
//   404 / JS 例外 / Google への通信 0 / FPS。スクリーンショットを data/reports/mission37g-wards/ に保存。
// 使い方: node tools/experiments/mission37g_ward_map_qa.mjs   （public/ を node の静的サーバーで配信。ネットワーク不要の範囲のみ）
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT_DIR = 'data/reports/mission37g-wards';
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
await new Promise((r) => srv.listen(8138, r));
const URL_ = process.env.MISSION37G_URL || 'http://localhost:8138/mission37g-osaka-24ward-mvp.html';

const b = await launchBrowser({ width: 1440, height: 900 });
const page = b.page;
const out = { mission: '37G', url: URL_, browser: b.version, generatedAt: new Date().toISOString(),
  googleRequests: [], failedRequests: [], jsErrors: [], consoleErrors: [], steps: {} };
const cdnHosts = new Set();
page.on('Runtime.exceptionThrown', (e) => { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); });
page.on('Network.requestWillBeSent', (e) => {
  try { const h = new URL(e.request.url).hostname; cdnHosts.add(h); if (GOOGLE_HOSTS.test(h)) out.googleRequests.push(e.request.url); } catch { /* data: */ }
});
page.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/tile\.|cyberjapandata/.test(e.response.url)) out.failedRequests.push(e.response.status + ' ' + e.response.url); });
page.on('Network.loadingFailed', (e) => { out.failedRequests.push('failed ' + (e.errorText || '') + ' ' + (e.requestId || '')); });

const ev = (s) => page.evaluate(s);
const shot = async (name) => {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64'));
  return `${OUT_DIR}/${name}.jpg`;
};
const cam = async () => JSON.parse(await ev('JSON.stringify(window.__mission37g.camera)'));
const fps = async () => { await sleep(2500); return await ev('window.__mission37g.fps'); };

try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const st = await ev("window.__mission37g ? window.__mission37g.status + '|' + (window.__mission37g.cityBounds ? 'b' : '-') : ''").catch(() => '');
    if (/^(ready|ready-with-errors)\|b/.test(st)) break;
  }
  await sleep(3000);
  out.steps.initial = { camera: await cam(), fps: await fps(), validation: await ev('JSON.stringify(window.__mission37g.wardValidation)').then(JSON.parse),
    coverage: await ev('JSON.stringify(window.__mission37g.coverage)').then(JSON.parse), status: await ev('window.__mission37g.status'),
    wardButtons: await ev("document.querySelectorAll('.lc-wardbtn').length") };
  out.steps.initial.screenshot = await shot('01-citywide');
  const home = out.steps.initial.camera;

  out.steps.wards = {};
  for (const name of ['北区', '中央区', '住吉区', '平野区']) {
    await ev(`(() => { const b = [...document.querySelectorAll('.lc-wardbtn')].find((x) => x.textContent.startsWith(${JSON.stringify(name)})); b.click(); return 1; })()`);
    await sleep(4500);
    const c = await cam();
    const w = JSON.parse(await ev('JSON.stringify(window.__mission37g.selectedWard)'));
    const card = await ev("document.getElementById('wc-3d').textContent");
    out.steps.wards[name] = { camera: c, selected: w, card3d: card, fps: await fps() };
    out.steps.wards[name].screenshot = await shot('ward-' + name);
  }

  // 検索 → 移動
  await ev(`(() => { const i = document.getElementById('lc-q'); i.value = '鶴見'; i.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(1500);
  out.steps.search = { results: await ev("[...document.querySelectorAll('#lc-results button')].map((b) => b.textContent).join(' | ')") };
  await ev("document.querySelector('#lc-results button').click()");
  await sleep(4500);
  out.steps.search.selected = await ev('JSON.stringify(window.__mission37g.selectedWard)').then(JSON.parse);
  out.steps.search.screenshot = await shot('search-tsurumi');

  // 全域に戻る
  await ev("document.getElementById('btn-home').click()");
  await sleep(2500);
  const back = await cam();
  out.steps.backToCity = { camera: back, selectedWard: await ev('JSON.stringify(window.__mission37g.selectedWard)').then(JSON.parse),
    heightDiffM: Math.abs(back.heightM - home.heightM) };
  out.steps.backToCity.screenshot = await shot('99-back-to-citywide');
} finally {
  try { await b.close(); } catch { /* noop */ }
  srv.close();
}
out.summary = {
  googleRequestCount: out.googleRequests.length, jsErrors: out.jsErrors.length, failedRequests: out.failedRequests.length,
  wardsListed: out.steps.initial?.wardButtons, validationOk: out.steps.initial?.validation?.ok,
  initialHeightM: out.steps.initial?.camera?.heightM, fpsCity: out.steps.initial?.fps,
  hosts: [...cdnHosts].sort(),
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'ward-map-qa.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log(JSON.stringify({ wards: Object.fromEntries(Object.entries(out.steps.wards || {}).map(([k, v]) => [k, { h: v.camera.heightM, sel: v.selected?.wardName, fps: v.fps }])),
  search: out.steps.search?.results, searchSel: out.steps.search?.selected?.wardName, back: out.steps.backToCity?.heightDiffM }, null, 1));
if (out.jsErrors.length) console.log('jsErrors', out.jsErrors.slice(0, 5));
if (out.failedRequests.length) console.log('failed', out.failedRequests.slice(0, 10));
