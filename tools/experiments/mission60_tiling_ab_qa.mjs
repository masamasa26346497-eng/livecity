// [Mission 60] 背景 imagery の tilingScheme A/B。 ?tiling=geo(旧: Cesium 既定の Geographic) と 既定(修正後: WebMercator) を同一カメラで比較。
// 記録: 実際に GSI へ出た tile URL(z/x/y)、その tile が覆う実座標、対象点を含む正しい Mercator tile が要求されたか、背景のみ画像の細密度。
// 外部 GET 予算: 1 回の実行で 1 URL ずつ直列・各 1 秒以上待ち、BUDGET 件を超える GSI 要求は failRequest（429/403 を見たら停止）。
// 使い方: node tools/experiments/mission60_tiling_ab_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT = 'data/reports/mission60';
const STUB = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const BUDGET = 25;         // 1 variant あたり。2 variant で最大 56 (< 60)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8162, r));
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320, D = Math.PI / 180;
const P = { n: 'hanwa-hospital', lat: 34.6044, lon: 135.5051 };
const xz = [(P.lon - CLON) * Math.cos(CLAT * D) * MPD, -((P.lat - CLAT) * MPD)];
const merc = (z) => { const N = 2 ** z; return { x: Math.floor((P.lon + 180) / 360 * N), y: Math.floor((1 - Math.log(Math.tan(P.lat * D) + 1 / Math.cos(P.lat * D)) / Math.PI) / 2 * N) }; };
// 要求された z/x/y を「Mercator 解釈」で覆う中心緯度経度に直す（そのタイル画像が本来描いている場所）
const mercCentre = (z, x, y) => { const N = 2 ** z; return { lon: (x + 0.5) / N * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / N))) / D }; };

fs.mkdirSync(OUT, { recursive: true });
const all = { mission: '60', point: P, budgetPerVariant: BUDGET, variants: {} };
for (const variant of ['geo', 'mercator']) {
  const URL_ = `http://localhost:8162/mission37g-osaka-24ward-mvp.html?qa=1&basemap=gsi-pale&extra=0&fac=0&bw=27120&vcull=0${variant === 'geo' ? '&tiling=geo' : ''}`;
  const b = await launchBrowser({ width: 1400, height: 900 });
  const page = b.page;
  const rec = { requested: [], blocked: 0, status: {}, stop: null, jsErrors: [] };
  let chain = Promise.resolve(), n = 0;
  await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://cyberjapandata.gsi.go.jp/*', requestStage: 'Request' }] });
  page.on('Fetch.requestPaused', (e) => {
    chain = chain.then(async () => {
      const m = /\/xyz\/pale\/(\d+)\/(\d+)\/(\d+)\.png/.exec(e.request.url);
      if (!m) return page.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      const z = +m[1], x = +m[2], y = +m[3];
      rec.requested.push({ z, x, y, mercatorCentre: mercCentre(z, x, y) });
      // z<16 または予算超過は外部へ出さず 1x1 透明 PNG で応答（要求 URL だけ記録＝タイル選択の証拠。外部 GET 0）。z>=16 のみ実 GET（予算内・1.1 秒間隔）。
      if (rec.stop || n >= BUDGET || z < 16) { rec.stubbed = (rec.stubbed || 0) + 1; return page.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: STUB }).catch(() => {}); }
      n++; rec.realGets = n;
      await sleep(1100);
      return page.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
    });
  });
  page.on('Network.responseReceived', (e) => { if (/cyberjapandata/.test(e.response.url)) { rec.status[e.response.status] = (rec.status[e.response.status] || 0) + 1; if (e.response.status === 429 || e.response.status === 403) rec.stop = e.response.status; } });
  page.on('Runtime.exceptionThrown', (e) => { try { rec.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 200)); } catch { /* noop */ } });
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 80; i++) { await sleep(1500); if ((await page.evaluate("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break; }
  await page.evaluate(`window.__mission37dQA.lookAtLocal(${xz[0]},${xz[1]},0,350,-90,0)`);
  for (let i = 0; i < 24; i++) { await sleep(2500); if ((rec.realGets || 0) >= BUDGET) break; }
  await sleep(4000);
  await page.evaluate("(()=>{for(const id of ['roads','waterways','parks','railways','gsiroadedge','gsiwater']){try{window.__mission37dQA.setLayer(id,false)}catch(e){}}window.__mission37dQA.setTilesetShow(false)})()");
  await sleep(3000);
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${variant}-top-bg-only.png`), Buffer.from(data, 'base64'));
  await page.evaluate("window.__mission37dQA.setTilesetShow(true)"); await sleep(2500);
  const s2 = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${variant}-top-bg+bldg.png`), Buffer.from(s2.data, 'base64'));
  // 背景のみ画像の「細密度」= 隣接画素差の平均（0 に近いほど単色/空白）
  rec.bgDetail = await page.evaluate(`(async()=>{const m=await new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src='data:image/png;base64,${data}'});const c=document.createElement('canvas');c.width=m.width;c.height=m.height;const x=c.getContext('2d');x.drawImage(m,0,0);const d=x.getImageData(0,0,m.width,m.height).data;let s=0,k=0;for(let i=0;i<m.width*m.height-1;i+=3){s+=Math.abs(d[i*4]-d[i*4+4])+Math.abs(d[i*4+1]-d[i*4+5]);k++}return +(s/k).toFixed(3)})()`);
  const want = [14, 15, 16, 17].map((z) => ({ z, ...merc(z) }));
  rec.expectedMercatorTiles = want;
  rec.correctTileRequested = want.map((w) => ({ z: w.z, requested: rec.requested.some((q) => q.z === w.z && q.x === w.x && q.y === w.y) }));
  rec.maxZRequested = rec.requested.reduce((m, q) => Math.max(m, q.z), 0);
  // 要求 tile の実位置（Mercator 解釈）から対象点までの距離[km]の最小値
  rec.nearestRequestedKm = +Math.min(...rec.requested.map((q) => Math.hypot((q.mercatorCentre.lon - P.lon) * Math.cos(P.lat * D), q.mercatorCentre.lat - P.lat) * MPD / 1000)).toFixed(2);
  rec.requestedSample = rec.requested.slice(0, 12);
  all.variants[variant] = rec; console.log(variant, JSON.stringify({ n: rec.requested.length, maxZ: rec.maxZRequested, status: rec.status, nearestKm: rec.nearestRequestedKm, correct: rec.correctTileRequested, bgDetail: rec.bgDetail, stop: rec.stop, js: rec.jsErrors.length }));
  try { await b.close(); } catch { /* noop */ }
}
fs.writeFileSync(path.join(OUT, 'tiling-ab.json'), JSON.stringify(all, null, 2));
srv.close(); process.exit(0);
