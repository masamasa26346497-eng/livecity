// tools/experiments/mission145_places_qa.mjs
// [Mission 145] 実 Chrome（headless, ローカルサーバー）の軽量スモーク: 駅レイヤー（24 区）を、住吉区 + 都心 2 区で
//   (1) 駅マーカーを実クリック → 右パネルに駅名 / 運営会社（未取得 or 根拠つき）/ 出典 (2) 駅名検索でヒット
//   (3) 町丁目 24 区レイヤーの状態（towns-24.json が無ければ「未接続」と正直に出る） (4) Google 通信 0 / JS 例外 0
// クリック座標は QA フック（localhost かつ ?qa=1）の投影 API で求めた画面点。headless の FPS は実機値ではない。
// 使い方: node tools/experiments/mission145_places_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT_DIR = 'data/reports/mission145-places';
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
await new Promise((r) => srv.listen(8145, r));
const URL_ = 'http://localhost:8145/mission37g-osaka-24ward-mvp.html?qa=1&nobuiltin=1';

const st = JSON.parse(fs.readFileSync('public/mission145-data/stations-24.json', 'utf8')).stations;
// 他の駅から 60m 以上離れた駅を選ぶ（誤クリック回避）
const target = (wardId, prefer) => {
  const c = st.filter((s) => s.wardId === wardId);
  return c.find((s) => s.name === prefer) || c.find((s) => st.every((o) => o === s || Math.hypot(o.x - s.x, o.z - s.z) > 60)) || c[0];
};
const CASES = [
  { ward: '住吉区', t: target('sumiyoshi', '住吉大社') },
  { ward: '北区', t: target('kita') },
  { ward: '中央区', t: target('chuo') },
];

const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
const out = { mission: '145', url: URL_, browser: b.version, generatedAt: new Date().toISOString(), googleRequests: [], failedRequests: [], jsErrors: [], cases: [] };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => { try { const h = new URL(e.request.url).hostname; if (GOOGLE_HOSTS.test(h)) out.googleRequests.push(e.request.url); } catch { /* data: */ } });
page.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/tile\.|cyberjapandata/.test(e.response.url)) out.failedRequests.push(e.response.status + ' ' + e.response.url); });
const ev = (js) => page.evaluate(js);
async function click(x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const shot = async (name) => {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64'));
  return `${OUT_DIR}/${name}.jpg`;
};
try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    if ((await ev("!!(window.__mission37dQA && window.__mission37g && window.__mission37g.stations145 && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break;
  }
  await sleep(1500);
  out.stats = await ev('JSON.stringify({ stations145: window.__mission37g.stations145, towns145: window.__mission37g.towns145 || null })').then(JSON.parse);
  for (const c of CASES) {
    const rec = { ward: c.ward, target: { id: c.t.id, name: c.t.name } };
    out.cases.push(rec);
    await ev(`window.__mission37dQA.lookAtLocal(${c.t.x}, ${c.t.z}, 0, 450, -60, 0)`);
    await sleep(3500);
    const p = await ev(`JSON.stringify(window.__mission37dQA.project(${c.t.x}, ${c.t.z}, 8))`).then(JSON.parse);
    rec.projected = p;
    if (p && p.inCanvas) {
      rec.pickAtPoint = await ev(`window.__mission37dQA.pickPoiId(${p.x}, ${p.y})`);
      await click(p.x, p.y);
      await sleep(900);
      rec.selectedPoi = await ev('JSON.stringify(window.__mission37g.selectedPoi || null)').then(JSON.parse);
      rec.panel = await ev("JSON.stringify({ name: document.getElementById('lc-poi-name').textContent, sub: document.getElementById('lp-sub').textContent, ops: document.getElementById('lp-ops').textContent, opsVisible: document.getElementById('lp-ops-row').style.display !== 'none', src: document.getElementById('lp-src').textContent })").then(JSON.parse);
      rec.realClick = !!(rec.selectedPoi && rec.selectedPoi.id === c.t.id);
      rec.opsHonest = rec.panel.opsVisible && /(未取得|不明|根拠)/.test(rec.panel.ops);
      rec.screenshot = await shot('station-' + c.t.wardId);
    }
    // 駅名検索
    await ev(`(() => { const q = document.getElementById('lc-q'); q.value = ${JSON.stringify(c.t.name)}; q.dispatchEvent(new Event('input')); })()`);
    await sleep(1500);
    const hits = await ev("Array.from(document.querySelectorAll('#lc-results button')).map((b) => b.textContent)");
    rec.searchFound = hits.some((s) => s.includes('駅') && s.includes(c.t.name));
  }
  out.layerStates = await ev('JSON.stringify(Object.fromEntries(["stations","towns24","facilities","labels"].map((id) => [id, window.__mission37g.layers[id] || null])))').then(JSON.parse);
  out.jsErrorCount = out.jsErrors.length;
  out.googleRequestCount = out.googleRequests.length;
  out.pass = out.cases.every((c) => c.realClick && c.opsHonest && c.searchFound) && out.jsErrorCount === 0 && out.googleRequestCount === 0;
} catch (e) {
  out.error = String(e && e.stack || e);
} finally {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'places-qa.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await b.close?.();
  srv.close();
  process.exit(out.pass ? 0 : 1);
}
