// [Mission 50] 大川・中之島の GSI 水域面レイヤー（gsiwater）の実 Chrome 検証。
// 真上・同位置で OFF/ON を撮り、(a) GSI 水域面の内部点（データ側で選んだ点）の画面投影位置の画素が水色か、
// (b) 水域面の外側（GSI 建物 BldA 内の点でない陸側の点）が水色にならないか、(c) 深度読み戻しで投影した点の局所座標が元座標と一致するか、を数える。
// 画素差だけでは位置の根拠にならないため、点ごとの一致率で評価する。headless はソフトウェア描画・基盤地図なし（?imagery=0）。
// 使い方: node tools/experiments/mission50_okawa_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT_DIR = 'data/reports/mission50';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8150, r));

const data = JSON.parse(fs.readFileSync('public/mission50-data/gsi-okawa-nakanoshima.json', 'utf8'));
const VIEW = { x: -2400, z: -9960, range: 900, pitch: -90 };
const inRing = (x, z, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const inW = (x, z) => data.water.some((w) => inRing(x, z, w.outer) && !w.holes.some((h) => inRing(x, z, h)));
// 視野内（中心から 350m 以内）で水域の内部点 / 陸側の点を格子で選ぶ（水域境界から 6m 以上離れた点だけ＝境界の揺れを除く）
const farFromEdge = (x, z) => [[6, 0], [-6, 0], [0, 6], [0, -6]].every(([dx, dz]) => inW(x + dx, z + dz) === inW(x, z));
const water = [], land = [];
for (let x = VIEW.x - 350; x <= VIEW.x + 350; x += 20) for (let z = VIEW.z - 350; z <= VIEW.z + 350; z += 20) {
  if (!farFromEdge(x, z)) continue; (inW(x, z) ? water : land).push([x, z]);
}
const out = { mission: '50', view: VIEW, samples: { water: water.length, land: land.length }, jsErrors: [], failed: [], googleRequests: [] };
fs.mkdirSync(OUT_DIR, { recursive: true });
const url = 'http://localhost:8150/mission37g-osaka-24ward-mvp.html?qa=1&imagery=0&extra=1&fac=0&bw=27127';
const b = await launchBrowser({ width: 1400, height: 900 });
const page = b.page;
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.responseReceived', (e) => {
  if (e.response.status >= 400) out.failed.push(e.response.status + ' ' + e.response.url);
  if (/google/i.test(e.response.url)) out.googleRequests.push(e.response.url);
});
const ev = (js) => page.evaluate(js);
const shot = async (name) => {
  const { data: d } = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'okawa-' + name + '.png'), Buffer.from(d, 'base64'));
  return d;
};
// 点ごとの画面座標と、その位置の画素色（スクリーンショット PNG を canvas に描いて読む。dpr=1 前提で検査）
const measure = async (png, pts) => ev('(async()=>{const pts=' + JSON.stringify(pts) + ';const I=await new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src="data:image/png;base64,' + png + '"});' +
  'const cv=document.createElement("canvas");cv.width=I.width;cv.height=I.height;const x=cv.getContext("2d");x.drawImage(I,0,0);' +
  'const dpr=window.devicePixelRatio||1;const res=[];for(const [lx,lz] of pts){const p=window.__mission37dQA.project(lx,lz,0.5);if(!p||!p.inCanvas){res.push(null);continue}' +
  'const d=x.getImageData(Math.round(p.x*dpr),Math.round(p.y*dpr),1,1).data;res.push({sx:p.x,sy:p.y,rgb:[d[0],d[1],d[2]]})}return JSON.stringify({dpr,w:I.width,res})})()').then(JSON.parse);
// 水色 #8dc3e8 (141,195,232) に近い画素（青成分が赤より 50 以上大きい）。基盤地図なし・下地は淡灰なので区別できる
const isWater = (rgb) => rgb[2] - rgb[0] > 50 && rgb[2] > 180;
// 中央の作業領域（左パネル・右パネルを避ける）の点だけ使う
const usable = (r) => r && r.sx > 380 && r.sx < 1050 && r.sy > 80 && r.sy < 820;
try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break;
  }
  await sleep(4000);
  out.gsiWaterState = await ev('JSON.stringify(window.__mission37g.gsiWater)').then(JSON.parse);
  await ev('window.__mission37dQA.lookAtLocal(' + VIEW.x + ',' + VIEW.z + ',0,' + VIEW.range + ',' + VIEW.pitch + ',0)');
  await sleep(5000);
  const res = {};
  for (const state of ['off', 'on']) {
    await ev("window.__mission37dQA.setLayer('gsiwater', " + (state === 'on') + ')');
    await sleep(2500);
    const png = await shot(state);
    const w = await measure(png, water), l = await measure(png, land);
    const wu = w.res.filter(usable), lu = l.res.filter(usable);
    res[state] = {
      waterSamplesUsed: wu.length, waterSamplesRenderedAsWater: wu.filter((r) => isWater(r.rgb)).length,
      landSamplesUsed: lu.length, landSamplesRenderedAsWater: lu.filter((r) => isWater(r.rgb)).length,
    };
    res[state].waterHitPct = wu.length ? Math.round(1000 * res[state].waterSamplesRenderedAsWater / wu.length) / 10 : null;
    res[state].landFalseWaterPct = lu.length ? Math.round(1000 * res[state].landSamplesRenderedAsWater / lu.length) / 10 : null;
  }
  out.result = res;
  // 深度読み戻し: 画面に投影した点を pickLocal で局所座標に戻し、元座標との差（基盤地図の有無に依らず座標系の往復一致を見る）
  await ev("window.__mission37dQA.setLayer('gsiwater', true)"); await sleep(1500);
  const rt = [];
  for (const [lx, lz] of water.slice(0, 40)) {
    const p = await ev('JSON.stringify(window.__mission37dQA.project(' + lx + ',' + lz + ',0.5))').then(JSON.parse);
    if (!p || !p.inCanvas) continue;
    const q = await ev('JSON.stringify(window.__mission37dQA.pickLocal(' + p.x + ',' + p.y + '))').then(JSON.parse);
    if (q) rt.push(Math.hypot(q.x - lx, q.z - lz));
  }
  rt.sort((a, c) => a - c);
  out.roundTrip = { n: rt.length, medianM: rt.length ? Math.round(rt[rt.length >> 1] * 100) / 100 : null, maxM: rt.length ? Math.round(rt[rt.length - 1] * 100) / 100 : null };
} catch (e) { out.fatal = String((e && e.stack) || e); }
try { await b.close(); } catch { /* noop */ }
fs.writeFileSync(path.join(OUT_DIR, 'okawa-qa.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
srv.close(); process.exit(0);
