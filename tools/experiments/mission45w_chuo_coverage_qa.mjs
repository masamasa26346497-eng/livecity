// [Mission 45W] 実公開の 37C 束（住吉区 9tile）で、中央区を見たときに道路・河川が「描画されない」ことと、住吉区では描画されることを
// ピクセル差で区別し、画面の coverage 表示が実態に合うかを確認する。データ・位置は一切変更しない。
//   node tools/experiments/mission45w_chuo_coverage_qa.mjs [out.json]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT = process.argv[2] || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8145, r));
const b = await launchBrowser({ width: 1400, height: 900 });
const page = b.page, ev = (js) => page.evaluate(js);
const out = { mission: '45W', views: [], jsErrors: [] };
page.on('Runtime.exceptionThrown', (e) => { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); });
const shot = async () => (await page.send('Page.captureScreenshot', { format: 'png' })).data;
const diffPx = (a, c) => ev(`(async()=>{const L=(s)=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src='data:image/png;base64,'+s});
  const [a,b]=await Promise.all([L('${a}'),L('${c}')]);const cv=document.createElement('canvas');cv.width=a.width;cv.height=a.height;const x=cv.getContext('2d');
  x.drawImage(a,0,0);const da=x.getImageData(0,0,cv.width,cv.height).data;x.clearRect(0,0,cv.width,cv.height);x.drawImage(b,0,0);const db=x.getImageData(0,0,cv.width,cv.height).data;
  let n=0;for(let i=0;i<da.length;i+=4){if(Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2])>24)n++}return n})()`);
try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: 'http://localhost:8145/mission37g-osaka-24ward-mvp.html?qa=1&imagery=0&extra=0&fac=0' });
  for (let i = 0; i < 60; i++) { await sleep(1500); if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break; }
  await sleep(3000);
  out.layerCounts = await ev('JSON.stringify({roads:window.__mission37g.layers.roads.count,water:window.__mission37g.layers.waterways.count})').then(JSON.parse);
  const VIEWS = [
    { name: 'sumiyoshi', x: -2250, z: -750, range: 2600, pitch: -90 },
    { name: 'chuo', x: -800, z: -8300, range: 2600, pitch: -90 },
  ];
  for (const v of VIEWS) {
    await ev(`window.__mission37dQA.lookAtLocal(${v.x}, ${v.z}, 0, ${v.range}, ${v.pitch}, 0)`);
    await sleep(4500);
    await ev("window.__mission37dQA.setLayer('roads', true); window.__mission37dQA.setLayer('waterways', true);"); await sleep(1500);
    const on = await shot();
    await ev("window.__mission37dQA.setLayer('roads', false); window.__mission37dQA.setLayer('waterways', false);"); await sleep(1500);
    const off = await shot();
    await ev("window.__mission37dQA.setLayer('roads', true); window.__mission37dQA.setLayer('waterways', true);");
    const cov = await ev('JSON.stringify(window.__mission37g.vecCoverage)').then(JSON.parse);
    out.views.push({ view: v.name, roadsWaterOnVsOffPx: await diffPx(on, off), coverage: cov, noteText: await ev("document.getElementById('lc-vec-coverage').textContent") });
    if (OUT) fs.writeFileSync(OUT.replace(/\.json$/, '') + '-' + v.name + '.png', Buffer.from(on, 'base64'));
  }
} catch (e) { out.fatal = String(e && e.stack || e); }
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
try { await b.close(); } catch { /* noop */ }
srv.close(); process.exit(0);
