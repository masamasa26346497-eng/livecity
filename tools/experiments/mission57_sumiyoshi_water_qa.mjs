// [Mission 57] 住吉区 9 tile 窓の GSI 水域面（WA）を 37G viewer に追加した before/after（同一カメラ・真上/斜め）。
// 水域ポリゴン内部の点（縁から 6m 以上）を画面に投影し、画素色が水色かを数える。gsiwater OFF=before / ON=after。
// 使い方: node tools/experiments/mission57_sumiyoshi_water_qa.mjs [label]   headless=ソフトウェア描画、FPS は実機値ではない。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const LABEL = process.argv[2] || 'run';
const OUT_DIR = 'data/reports/mission57-water';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8157, r));
const URL_ = 'http://localhost:8157/mission37g-osaka-24ward-mvp.html?qa=1&imagery=0&extra=0&fac=0&bw=27120';

// 水域ポリゴン（データ）から内部点を選ぶ: 外周の bbox 中心を含み、縁から 6m 以上離れた点
const data = JSON.parse(fs.readFileSync('public/mission57-data/gsi-sumiyoshi-9tile.json', 'utf8'));
const area = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(s / 2); };
const inRing = (x, z, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const distSeg = (x, z, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1]; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1))); return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz); };
const edgeDist = (x, z, ring) => { let m = 1e9; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) m = Math.min(m, distSeg(x, z, ring[j], ring[i])); return m; };
const polys = data.water.filter((w) => w.outer.length >= 3).sort((a, b) => area(b.outer) - area(a.outer));
// 既存 OSM 水域面（waterways.json area）に既に覆われる点は除外 = 「今回の追加で初めて水面になる」点だけを測る
const osmAreas = JSON.parse(fs.readFileSync('public/mission37c-layers/osaka-sumiyoshi-9tile/waterways.json', 'utf8')).features.filter((f) => f.kind === 'area').map((f) => f.p);
const inOsm = (x, z) => osmAreas.some((r) => inRing(x, z, r) || edgeDist(x, z, r) < 6);
const insidePts = [];
for (const w of polys) {
  const xs = w.outer.map((p) => p[0]), zs = w.outer.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  for (let k = 0; k < 400 && insidePts.length < 200; k++) {
    const x = x0 + (x1 - x0) * (((k * 37) % 20) + 0.5) / 20, z = z0 + (z1 - z0) * (Math.floor(k / 20) % 20 + 0.5) / 20;
    if (!inOsm(x, z) && inRing(x, z, w.outer) && !w.holes.some((h) => inRing(x, z, h)) && edgeDist(x, z, w.outer) >= 6 && w.holes.every((h) => edgeDist(x, z, h) >= 6)) insidePts.push([x, z]);
  }
}
if (!insidePts.length) { console.error('no GSI-only interior points'); process.exit(3); }
const [cx, cz] = insidePts[0];

const b = await launchBrowser({ width: 1400, height: 900 });
const page = b.page;
const out = { mission: '57', label: LABEL, url: URL_, browser: b.version, jsErrors: [], failed: [], googleRequests: 0, views: [], insidePtsCandidates: insidePts.length, center: [cx, cz] };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.responseReceived', (e) => { if (e.response.status >= 400) out.failed.push(e.response.status + ' ' + e.response.url); });
page.on('Network.requestWillBeSent', (e) => { if (/google|googleapis|gstatic/.test(e.request.url)) out.googleRequests++; });
const ev = (js) => page.evaluate(js);
fs.mkdirSync(OUT_DIR, { recursive: true });
const shot = async (name) => {
  const { data: d } = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-${name}.png`), Buffer.from(d, 'base64'));
  return d;
};
const isWaterColor = (r, g, bl) => bl > r + 25 && bl >= g && g > r; // #8dc3e8 系
async function pixelAt(png, pts) {
  return ev(`(async()=>{const i=await new Promise(r=>{const m=new Image();m.onload=()=>r(m);m.src='data:image/png;base64,${png}'});
    const cv=document.createElement('canvas');cv.width=i.width;cv.height=i.height;const x=cv.getContext('2d');x.drawImage(i,0,0);
    return ${JSON.stringify(pts)}.map(p=>{const d=x.getImageData(Math.round(p[0]),Math.round(p[1]),1,1).data;return [d[0],d[1],d[2]]})})()`);
}
try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 80; i++) {
    await sleep(1500);
    if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break;
  }
  await sleep(4000);
  out.waterState = await ev('JSON.stringify(window.__mission37g.gsiWater)').then(JSON.parse);
  const VIEWS = [
    { name: 'top', range: 900, pitch: -90 },
    { name: 'oblique', range: 700, pitch: -45 },
  ];
  for (const v of VIEWS) {
    const rec = { view: v.name };
    out.views.push(rec);
    await ev(`window.__mission37dQA.lookAtLocal(${cx}, ${cz}, 0, ${v.range}, ${v.pitch}, 0)`);
    await sleep(5000);
    const proj = [];
    for (const p of insidePts) {
      const pt = await ev(`JSON.stringify(window.__mission37dQA.project(${p[0]}, ${p[1]}, 0.5))`).then(JSON.parse);
      if (pt && pt.inCanvas) proj.push([pt.x, pt.y, p[0], p[1]]);
      if (proj.length >= 120) break;
    }
    rec.usable = proj.length;
    for (const on of [false, true]) {
      await ev(`window.__mission37dQA.setLayer('gsiwater', ${on})`);
      await sleep(2500);
      const png = await shot(`${v.name}-${on ? 'after' : 'before'}`);
      const px = await pixelAt(png, proj.map((p) => [p[0], p[1]]));
      rec[on ? 'after' : 'before'] = { waterColoured: px.filter((c) => isWaterColor(c[0], c[1], c[2])).length };
    }
  }
  await ev("window.__mission37dQA.setLayer('gsiwater', true)");
  out.layers = await ev('JSON.stringify(window.__mission37g.layers)').then(JSON.parse);
  out.stats = await ev('JSON.stringify({gsiWater:window.__mission37g.gsiWater,buildingState:window.__mission37g.buildingState})').then(JSON.parse);
} catch (e) { out.fatal = String(e && e.stack || e); }
fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-result.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ water: out.waterState, views: out.views, jsErrors: out.jsErrors, failed: out.failed, google: out.googleRequests, fatal: out.fatal }, null, 1));
try { await b.close(); } catch { /* noop */ }
srv.close(); process.exit(0);
