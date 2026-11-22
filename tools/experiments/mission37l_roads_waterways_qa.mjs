// [Mission 37L] 住吉 9 tile 範囲の道路・河川が実際に描画されているかを、レイヤー ON/OFF のピクセル差で判定する。
// 使い方: node tools/experiments/mission37l_roads_waterways_qa.mjs [label]   （label は出力名の接頭辞。例 before / after）
// headless はソフトウェア描画・基盤地図なし（?imagery=0）。FPS は実機値ではない。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const LABEL = process.argv[2] || 'run';
const OUT_DIR = 'data/reports/mission37l-roads';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8141, r));
const URL_ = 'http://localhost:8141/mission37g-osaka-24ward-mvp.html?qa=1&imagery=0&extra=0&fac=0';

const b = await launchBrowser({ width: 1400, height: 900 });
const page = b.page;
const out = { mission: '37L', label: LABEL, url: URL_, browser: b.version, jsErrors: [], failed: [], views: [] };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.responseReceived', (e) => { if (e.response.status >= 400) out.failed.push(e.response.status + ' ' + e.response.url); });
const ev = (js) => page.evaluate(js);
fs.mkdirSync(OUT_DIR, { recursive: true });
const shot = async (name) => {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-${name}.png`), Buffer.from(data, 'base64'));
  return data;
};
async function diffPx(a, c) {
  return ev(`(async()=>{const L=(s)=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src='data:image/png;base64,'+s});
    const [a,b]=await Promise.all([L('${a}'),L('${c}')]);const cv=document.createElement('canvas');cv.width=a.width;cv.height=a.height;const x=cv.getContext('2d');
    x.drawImage(a,0,0);const da=x.getImageData(0,0,cv.width,cv.height).data;x.clearRect(0,0,cv.width,cv.height);x.drawImage(b,0,0);const db=x.getImageData(0,0,cv.width,cv.height).data;
    let n=0;for(let i=0;i<da.length;i+=4){if(Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2])>24)n++}return n})()`);
}
try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break;
  }
  await sleep(3000);
  out.layers = await ev('JSON.stringify(window.__mission37g.layers)').then(JSON.parse);
  const VIEWS = [
    { name: 'mid', x: -2250, z: -750, range: 2600, pitch: -90 },
    { name: 'near', x: -2000, z: -600, range: 700, pitch: -60 },
  ];
  for (const v of VIEWS) {
    const rec = { view: v.name };
    out.views.push(rec);
    await ev(`window.__mission37dQA.lookAtLocal(${v.x}, ${v.z}, 0, ${v.range}, ${v.pitch}, 0)`);
    await sleep(3500);
    const sets = {};
    for (const mode of ['both', 'none', 'roads', 'water']) {
      const roads = mode === 'both' || mode === 'roads', water = mode === 'both' || mode === 'water';
      await ev(`window.__mission37dQA.setLayer('roads', ${roads}); window.__mission37dQA.setLayer('waterways', ${water});`);
      await sleep(1500);
      sets[mode] = await shot(`${v.name}-${mode}`);
    }
    rec.diffPx = {
      bothVsNone: await diffPx(sets.both, sets.none),
      roadsVsNone: await diffPx(sets.roads, sets.none),
      waterVsNone: await diffPx(sets.water, sets.none),
    };
  }
} catch (e) { out.fatal = String(e && e.stack || e); }
fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-result.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ layers: out.layers, views: out.views, jsErrors: out.jsErrors, failed: out.failed, fatal: out.fatal }, null, 1));
try { await b.close(); } catch { /* noop */ }
srv.close(); process.exit(0);
