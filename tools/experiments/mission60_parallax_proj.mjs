// [Mission 60] 透視視差の定量: 同一の地上点 (x,z) について、足元(h=0)と屋根(h=H)の画面投影の差[px, m]を Cesium の実カメラで測る。
// 通常 fov(60°, range 350m, 真上) と ほぼ正射影(fov 2°, range 12000m) を比較。外部 GET 0（GSI は全てスタブ）。
// 使い方: node tools/experiments/mission60_parallax_proj.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT = 'data/reports/mission60';
const STUB = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8164, r));
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320, D = Math.PI / 180;
const ctr = [(135.5051 - CLON) * Math.cos(CLAT * D) * MPD, -((34.6044 - CLAT) * MPD)];
const b = await launchBrowser({ width: 1400, height: 900 });
const page = b.page;
await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://cyberjapandata.gsi.go.jp/*', requestStage: 'Request' }] });
page.on('Fetch.requestPaused', (e) => page.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: STUB }).catch(() => {}));
const ev = (js) => page.evaluate(js);
const out = { mission: '60', centre: ctr.map((v) => +v.toFixed(1)), cases: [] };
await page.send('Network.enable');
await page.send('Page.navigate', { url: 'http://localhost:8164/mission37g-osaka-24ward-mvp.html?qa=1&basemap=gsi-pale&extra=0&fac=0&bw=27120&vcull=0&panel=0' });
for (let i = 0; i < 80; i++) { await sleep(1500); if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break; }
for (const cam of [{ k: 'persp60-r350', fov: 60, range: 350 }, { k: 'ortho-like-fov2-r12000', fov: 2, range: 12000 }]) {
  await ev(`window.__mission37dQA.setFov(${cam.fov});window.__mission37dQA.lookAtLocal(${ctr[0]},${ctr[1]},0,${cam.range},-90,0)`);
  await sleep(1500);
  for (const [dx, dz] of [[0, 0], [60, 0], [120, 0], [0, 100], [-120, -80]]) for (const H of [10, 34.4]) {
    const x = ctr[0] + dx, z = ctr[1] + dz;
    const f = JSON.parse(await ev(`JSON.stringify(window.__mission37dQA.project(${x},${z},0))`)), r = JSON.parse(await ev(`JSON.stringify(window.__mission37dQA.project(${x},${z},${H}))`));
    const q = JSON.parse(await ev(`JSON.stringify(window.__mission37dQA.project(${x + 100},${z},0))`));
    const mpp = 100 / Math.hypot(q.x - f.x, q.y - f.y);
    out.cases.push({ cam: cam.k, offsetFromCentreM: Math.round(Math.hypot(dx, dz)), roofHeightM: H, roofVsFootPx: +Math.hypot(r.x - f.x, r.y - f.y).toFixed(2), roofVsFootM: +(Math.hypot(r.x - f.x, r.y - f.y) * mpp).toFixed(2) });
  }
}
fs.writeFileSync(path.join(OUT, 'parallax-proj.json'), JSON.stringify(out, null, 2));
for (const c of out.cases) console.log(c.cam, 'off', c.offsetFromCentreM, 'H', c.roofHeightM, '->', c.roofVsFootPx + 'px', c.roofVsFootM + 'm');
try { await b.close(); } catch { /* noop */ }
srv.close(); process.exit(0);
