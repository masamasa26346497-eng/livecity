// [Mission 47] 道路線幅のズーム依存(46C)を、実 Chrome で before(?rw=0 固定幅) / after(既定) 比較する E2E。
// 俯瞰/斜め × 近景/中景/遠景 × 道路 ON/OFF のスクリーンショット、道路ピクセル占有、JS 例外、区切替を記録。
// headless はソフトウェア描画・基盤地図なし(?imagery=0)。FPS は実機値ではない。座標補正は一切行わない。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT_DIR = 'data/reports/mission47-road-width';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8147, r));
fs.mkdirSync(OUT_DIR, { recursive: true });
const VIEWS = [
  { name: 'top-near', x: -2000, z: -600, range: 700, pitch: -90 },
  { name: 'oblique-near', x: -2000, z: -600, range: 700, pitch: -45 },
  { name: 'top-mid', x: -2250, z: -750, range: 1500, pitch: -90 },
  { name: 'oblique-mid', x: -2250, z: -750, range: 1500, pitch: -45 },
  { name: 'top-far', x: -2250, z: -750, range: 3500, pitch: -90 },
  { name: 'oblique-far', x: -2250, z: -750, range: 3500, pitch: -45 },
];
const out = { mission: '47', runs: {} };

async function run(label, query) {
  const url = 'http://localhost:8147/mission37g-osaka-24ward-mvp.html?qa=1&imagery=0&fac=0&bw=27120' + query;
  const b = await launchBrowser({ width: 1400, height: 900 });
  const page = b.page;
  const rec = { url, browser: b.version, jsErrors: [], failed: [], views: [] };
  page.on('Runtime.exceptionThrown', (e) => { try { rec.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
  page.on('Network.responseReceived', (e) => { if (e.response.status >= 400) rec.failed.push(e.response.status + ' ' + e.response.url); });
  const ev = (js) => page.evaluate(js);
  const shot = async (name) => {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, label + '-' + name + '.png'), Buffer.from(data, 'base64'));
    return data;
  };
  const diffPx = (a, c) => ev(`(async()=>{const L=(s)=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src='data:image/png;base64,'+s});
    const [a,b]=await Promise.all([L('${a}'),L('${c}')]);const cv=document.createElement('canvas');cv.width=a.width;cv.height=a.height;const x=cv.getContext('2d');
    x.drawImage(a,0,0);const da=x.getImageData(0,0,cv.width,cv.height).data;x.clearRect(0,0,cv.width,cv.height);x.drawImage(b,0,0);const db=x.getImageData(0,0,cv.width,cv.height).data;
    let n=0;for(let i=0;i<da.length;i+=4){if(Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2])>24)n++}return n})()`);
  try {
    await page.send('Network.enable');
    await page.send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) {
      await sleep(1500);
      if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break;
    }
    await sleep(3000);
    rec.layers = await ev('JSON.stringify(window.__mission37g.layers)').then(JSON.parse);
    for (const v of VIEWS) {
      await ev('window.__mission37dQA.lookAtLocal(' + [v.x, v.z, 0, v.range, v.pitch, 0].join(',') + ')');
      await sleep(3500);
      const road46c = await ev('JSON.stringify(window.__mission37g.road46c||null)').then(JSON.parse);
      await ev("window.__mission37dQA.setLayer('roads', true)"); await sleep(1200);
      const on = await shot(v.name + '-roads-on');
      await ev("window.__mission37dQA.setLayer('roads', false)"); await sleep(1200);
      const off = await shot(v.name + '-roads-off');
      await ev("window.__mission37dQA.setLayer('roads', true)");
      rec.views.push({ view: v.name, range: v.range, pitch: v.pitch, road46c, roadPixels: await diffPx(on, off) });
    }
    // 区切替(道路 ON のまま 住吉→北→住吉)でも例外が出ないこと
    rec.wardSwitch = [];
    for (const code of ['27127', '27120']) {
      await ev("window.__mission37dQA.setBuildingWard('" + code + "')").catch((e) => rec.jsErrors.push('switch ' + e));
      await sleep(4000);
      rec.wardSwitch.push({ code, tilesets: await ev('JSON.stringify(window.__mission37dQA.tilesetCount())').then(JSON.parse) });
    }
  } catch (e) { rec.fatal = String((e && e.stack) || e); }
  try { await b.close(); } catch { /* noop */ }
  out.runs[label] = rec;
}
await run('before-rw0', '&rw=0');
await run('after', '');
out.summary = out.runs.after.views.map((v, i) => ({ view: v.view, roadPixelsBefore: out.runs['before-rw0'].views[i]?.roadPixels, roadPixelsAfter: v.roadPixels }));
fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify(out, null, 2));
const errs = {}; const fails = {}; const fatal = {};
for (const [k, r] of Object.entries(out.runs)) { errs[k] = r.jsErrors; fails[k] = r.failed; fatal[k] = r.fatal; }
console.log(JSON.stringify({ summary: out.summary, jsErrors: errs, failed: fails, fatal }, null, 1));
srv.close(); process.exit(0);
