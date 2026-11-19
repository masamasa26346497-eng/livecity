// [Mission 56] 住吉区 9 tile 窓で 建物 + GSI道路縁(線) + OSM道路中心線(線) + OSM水路(線/面) + 公園(面) を 37G viewer で同時表示し、
// 真上/斜めのスクリーンショット・レイヤー ON/OFF・10 地点・建物クリックを記録する。
// 使い方: node tools/experiments/mission56_sumiyoshi_layers_qa.mjs [label]
// headless はソフトウェア描画。FPS は実機値ではない。基盤地図は ?imagery=0（下地のみ）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const LABEL = process.argv[2] || 'run';
const OUT_DIR = 'data/reports/mission56-sumiyoshi';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8156, r));
const URL_ = 'http://localhost:8156/mission37g-osaka-24ward-mvp.html?qa=1&imagery=0&extra=0&fac=0&bw=27120';

const b = await launchBrowser({ width: 1400, height: 900 });
const page = b.page;
const out = { mission: '56', label: LABEL, url: URL_, browser: b.version, jsErrors: [], failed: [], googleRequests: 0, views: [], points: [] };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.responseReceived', (e) => { if (e.response.status >= 400) out.failed.push(e.response.status + ' ' + e.response.url); });
page.on('Network.requestWillBeSent', (e) => { if (/google|googleapis|gstatic/.test(e.request.url)) { out.googleRequests++; (out.googleUrls ||= []).push(e.request.url.slice(0, 120)); } });
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
const LAYERS = ['buildings', 'roads', 'gsiroadedge', 'waterways', 'parks'];
const setOnly = (on) => ev(LAYERS.map((l) => `window.__mission37dQA.setLayer('${l}', ${on.includes(l)});`).join(''));
try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 80; i++) {
    await sleep(1500);
    if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break;
  }
  await sleep(4000);
  out.layersInitial = await ev('JSON.stringify(window.__mission37g.layers)').then(JSON.parse);
  out.gsiRoadEdgeInitial = await ev('JSON.stringify(window.__mission37g.gsiRoadEdge)').then(JSON.parse);
  await sleep(2000);
  out.gsiRoadEdgeAfter = await ev('JSON.stringify(window.__mission37g.gsiRoadEdge)').then(JSON.parse);
  out.primitives = await ev('window.__mission37dQA.primitiveCount ? window.__mission37dQA.primitiveCount() : null').catch(() => null);

  const VIEWS = [
    { name: 'top', x: -2250, z: -750, range: 1800, pitch: -90 },
    { name: 'oblique', x: -2250, z: -650, range: 900, pitch: -45 },
  ];
  for (const v of VIEWS) {
    const rec = { view: v.name };
    out.views.push(rec);
    await ev(`window.__mission37dQA.lookAtLocal(${v.x}, ${v.z}, 0, ${v.range}, ${v.pitch}, 0)`);
    await sleep(5000);
    const sets = {};
    for (const [mode, on] of Object.entries({ all: LAYERS, none: [], bldOnly: ['buildings'], edge: ['gsiroadedge'], centre: ['roads'], water: ['waterways'], parks: ['parks'] })) {
      await setOnly(on);
      await sleep(1500);
      sets[mode] = await shot(`${v.name}-${mode}`);
    }
    rec.diffPx = {};
    for (const k of ['bldOnly', 'edge', 'centre', 'water', 'parks', 'all']) rec.diffPx[k + 'VsNone'] = await diffPx(sets[k], sets.none);
  }
  await setOnly(LAYERS);

  // 10 実在地点（路面・水路・公園・建物が近接する住吉区 9 tile 窓内の局所座標）。各地点で近景(top)を撮り、データ側の最寄り距離も計測する。
  const PTS = [[-2250, -750], [-2000, -600], [-1800, -400], [-2500, -900], [-2800, -1100], [-1500, -300], [-2100, -1200], [-1700, -800], [-2600, -500], [-1300, -100]];
  for (let i = 0; i < PTS.length; i++) {
    const [x, z] = PTS[i];
    await ev(`window.__mission37dQA.lookAtLocal(${x}, ${z}, 0, 350, -90, 0)`);
    await sleep(2500);
    await shot(`pt${i + 1}`);
    out.points.push({ i: i + 1, x, z });
  }
  // 建物クリック: attrs の代表点（実データ）に寄せ、投影 → scene.pick が同じ ID を返す点を実マウスでクリックする
  const attrs = JSON.parse(fs.readFileSync('public/mission37c-layers/osaka-sumiyoshi-9tile/attrs/t_-5_-2.json', 'utf8')).byId;
  const cands = Object.entries(attrs).filter(([, v]) => v[0] >= 25).slice(0, 8);
  out.clicks = [];
  for (const [id, v] of cands) {
    await ev(`window.__mission37dQA.lookAtLocal(${v[2]}, ${v[3]}, ${v[0]}, 260, -55, 0)`);
    await sleep(3500);
    const rec = { id, h: v[0], x: v[2], z: v[3] };
    const pt = await ev(`JSON.stringify(window.__mission37dQA.project(${v[2]}, ${v[3]}, ${v[0]}))`).then(JSON.parse);
    rec.pt = pt;
    if (pt && pt.inCanvas) {
      rec.pickId = await ev(`window.__mission37dQA.pickId(${pt.x}, ${pt.y})`);
      if (rec.pickId === id) {
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        await sleep(2500);
        rec.selected = await ev('window.__mission37g.selectedCanonicalId');
        rec.ok = rec.selected === id;
      }
    }
    out.clicks.push(rec);
    if (rec.ok) { await shot('click-building'); break; }
  }
  out.layersFinal = await ev('JSON.stringify(window.__mission37g.layers)').then(JSON.parse);
  out.stats = await ev('JSON.stringify({gsiRoadEdge:window.__mission37g.gsiRoadEdge,gsiWater:window.__mission37g.gsiWater,buildingState:window.__mission37g.buildingState,tilesetBuildings:window.__mission37g.tilesetBuildings})').then(JSON.parse);
} catch (e) { out.fatal = String(e && e.stack || e); }
fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-result.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ layers: out.layersInitial, gsi: out.gsiRoadEdgeAfter, views: out.views, stats: out.stats, clicks: out.clicks, jsErrors: out.jsErrors, failed: out.failed, google: out.googleRequests, fatal: out.fatal }, null, 1));
try { await b.close(); } catch { /* noop */ }
srv.close(); process.exit(0);
