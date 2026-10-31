// [Mission 58] 面レイヤー（水域 0.5m / 公園 0.9m、どちらも半透明 = 深度を書かない）の「上下」が描画順で決まっていないかを実測する。
// 公園ポリゴンと水域ポリゴンが重なる点（縁から 4m 以上内側）を真上から見て、画素が水色（水が上）か緑寄り（公園が上）かを数える。
// 使い方: node tools/experiments/mission58_layer_order_qa.mjs <label>   ※ 背景 imagery=0 / globe 下地 #e9eef4
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const LABEL = process.argv[2] || 'run';
const OUT_DIR = 'data/reports/mission58-plates';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8159, r));
const URL_ = 'http://localhost:8159/mission37g-osaka-24ward-mvp.html?qa=1&imagery=0&extra=0&fac=0&bw=27120&vcull=0';

const L = 'public/mission37c-layers/osaka-sumiyoshi-9tile/';
const wat = JSON.parse(fs.readFileSync(L + 'waterways.json', 'utf8')).features.filter((f) => f.kind === 'area');
const parks = JSON.parse(fs.readFileSync(L + 'parks.json', 'utf8')).features.filter((f) => f.p && f.p.length >= 3);
const inRing = (x, z, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const dseg = (x, z, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1]; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1))); return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz); };
const edge = (x, z, r) => { let m = 1e9; for (let i = 0, j = r.length - 1; i < r.length; j = i++) m = Math.min(m, dseg(x, z, r[j], r[i])); return m; };
const pts = [];
for (const w of wat) {
  const xs = w.p.map((p) => p[0]), zs = w.p.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  for (let k = 0; k < 100; k++) {
    const x = x0 + (x1 - x0) * (((k * 7) % 10) + 0.5) / 10, z = z0 + (z1 - z0) * (Math.floor(k / 10) + 0.5) / 10;
    if (inRing(x, z, w.p) && edge(x, z, w.p) >= 4 && parks.some((pk) => inRing(x, z, pk.p) && edge(x, z, pk.p) >= 4)) pts.push([x, z]);
  }
}
if (!pts.length) { console.log(JSON.stringify({ overlapPoints: 0 })); srv.close(); process.exit(3); }
// 点群が最も密な位置にカメラを置く
const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;

const b = await launchBrowser({ width: 1400, height: 900 });
const page = b.page;
const out = { mission: '58', label: LABEL, overlapPoints: pts.length, jsErrors: [], googleRequests: 0 };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => { if (/google|googleapis|gstatic/.test(e.request.url)) out.googleRequests++; });
const ev = (js) => page.evaluate(js);
fs.mkdirSync(OUT_DIR, { recursive: true });
try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 80; i++) {
    await sleep(1500);
    if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break;
  }
  await sleep(4000);
  const views = [{ n: 'top', pitch: -90, range: 700 }, { n: 'oblique', pitch: -45, range: 600 }];
  out.views = [];
  for (const v of views) {
    await ev(`window.__mission37dQA.lookAtLocal(${cx}, ${cz}, 0, ${v.range}, ${v.pitch}, 0)`);
    await sleep(5000);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-order-${v.n}.png`), Buffer.from(data, 'base64'));
    const proj = [];
    for (const p of pts) { const q = JSON.parse(await ev(`JSON.stringify(window.__mission37dQA.project(${p[0]},${p[1]},0.7))`)); if (q && q.inCanvas) proj.push([Math.round(q.x), Math.round(q.y)]); }
    const px = await ev(`(async()=>{const i=await new Promise(r=>{const m=new Image();m.onload=()=>r(m);m.src='data:image/png;base64,${data}'});
      const cv=document.createElement('canvas');cv.width=i.width;cv.height=i.height;const x=cv.getContext('2d');x.drawImage(i,0,0);
      return ${JSON.stringify(proj)}.map(p=>{const d=x.getImageData(p[0],p[1],1,1).data;return [d[0],d[1],d[2]]})})()`);
    // 水色 #8dc3e8 (141,195,232) と 公園 #bcd3b4 (188,211,180)。水が上=青成分が大きく赤が小さい / 公園が上=緑寄り(B<G)
    const waterTop = px.filter((c) => c[2] > c[1] + 15 && c[0] < c[1] - 20).length;
    const parkTop = px.filter((c) => c[2] <= c[1] + 5).length;
    out.views.push({ view: v.n, usable: px.length, waterOnTop: waterTop, parkOnTop: parkTop, other: px.length - waterTop - parkTop, sample: px.slice(0, 6) });
  }
} catch (e) { out.fatal = String(e && e.stack || e); }
fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-order-result.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
try { await b.close(); } catch { /* noop */ }
srv.close(); process.exit(0);
