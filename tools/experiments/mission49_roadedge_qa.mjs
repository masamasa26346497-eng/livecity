// [Mission 49] GSI 道路縁（参考レイヤー）の実 Chrome 検証。真上の同位置で OFF/ON を撮り、画素差と stats を残す。
// 使い方: node tools/experiments/mission49_roadedge_qa.mjs
// headless はソフトウェア描画・基盤地図なし（?imagery=0）。FPS は実機値ではない。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT_DIR = 'data/reports/mission49';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8149, r));

const CASES = [
  { name: 'kita', bw: '27127', view: { x: -2860, z: -11600, range: 900, pitch: -90 } },
  { name: 'sumiyoshi', bw: '27120', view: { x: -2250, z: -750, range: 900, pitch: -90 } },
];
const out = { mission: '49', cases: [], jsErrors: [], failed: [], googleRequests: [] };
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const c of CASES) {
  const url = `http://localhost:8149/mission37g-osaka-24ward-mvp.html?qa=1&imagery=0&extra=1&fac=0&bw=${c.bw}`;
  const b = await launchBrowser({ width: 1400, height: 900 });
  const page = b.page;
  page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(c.name + ': ' + String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
  page.on('Network.responseReceived', (e) => {
    if (e.response.status >= 400) out.failed.push(c.name + ' ' + e.response.status + ' ' + e.response.url);
    if (/google/i.test(e.response.url)) out.googleRequests.push(e.response.url);
  });
  const ev = (js) => page.evaluate(js);
  const shot = async (name) => {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, `roadedge-${c.name}-${name}.png`), Buffer.from(data, 'base64'));
    return data;
  };
  const diffPx = (a, d) => ev(`(async()=>{const L=(s)=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src='data:image/png;base64,'+s});
    const [a,b]=await Promise.all([L('${a}'),L('${d}')]);const cv=document.createElement('canvas');cv.width=a.width;cv.height=a.height;const x=cv.getContext('2d');
    x.drawImage(a,0,0);const da=x.getImageData(0,0,cv.width,cv.height).data;x.clearRect(0,0,cv.width,cv.height);x.drawImage(b,0,0);const db=x.getImageData(0,0,cv.width,cv.height).data;
    let n=0;for(let i=0;i<da.length;i+=4){if(Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2])>24)n++}return n})()`);
  const rec = { case: c.name, url, bw: c.bw };
  try {
    await page.send('Network.enable');
    await page.send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) {
      await sleep(1500);
      if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break;
    }
    await sleep(4000);
    rec.initial = await ev('JSON.stringify({gsi: window.__mission37g.gsiRoadEdge})').then(JSON.parse);
    rec.layersBefore = await ev("JSON.stringify(window.__mission37g.layers && window.__mission37g.layers.gsiroadedge)").then(JSON.parse);
    await ev(`window.__mission37dQA.lookAtLocal(${c.view.x}, ${c.view.z}, 0, ${c.view.range}, ${c.view.pitch}, 0)`);
    await sleep(5000);
    await ev("window.__mission37dQA.setLayer('gsiroadedge', false)");
    await sleep(1500);
    const off = await shot('off');
    await ev("window.__mission37dQA.setLayer('gsiroadedge', true)");
    for (let i = 0; i < 30; i++) { await sleep(1000); if ((await ev("window.__mission37g.gsiRoadEdge.state")) === 'ready') break; }
    await sleep(2500);
    const on = await shot('on');
    rec.diffPx = await diffPx(off, on);
    rec.gsiRoadEdge = await ev('JSON.stringify(window.__mission37g.gsiRoadEdge)').then(JSON.parse);
    rec.layersAfter = await ev("JSON.stringify(window.__mission37g.layers && window.__mission37g.layers.gsiroadedge)").then(JSON.parse);
    await ev("window.__mission37dQA.setLayer('gsiroadedge', false)");
    await sleep(1500);
    const off2 = await shot('off-again');
    rec.diffOffAgainVsOff = await diffPx(off, off2);
  } catch (e) { rec.fatal = String((e && e.stack) || e); }
  out.cases.push(rec);
  try { await b.close(); } catch { /* noop */ }
}
fs.writeFileSync(path.join(OUT_DIR, 'roadedge-qa.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
srv.close(); process.exit(0);
