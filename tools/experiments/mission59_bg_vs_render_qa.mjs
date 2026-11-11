// [Mission 59] 実背景（GSI 淡色地図 z17 相当）と 3D Tiles 建物の「画面上の」位置関係を画像から独立に測る。
// pickPosition / 自己投影は使わない。方法:
//   S0 = 背景のみ（建物・道路・水域・公園などのベクタ全 OFF）, S1 = 背景+建物。
//   建物マスク = |S1-S0| の差分。背景側の輪郭 = S0 の勾配。両者の勾配をシフトさせて相互相関→最良シフト[px]→[m]。
//   これは「GSI 淡色地図に描かれた建物形状 vs PLATEAU 建物」の見かけのずれ（独立ソース同士）。
// 併せて同一カメラで 道路/水域/公園 ON/OFF の画像（真上/斜め）を保存。
// 使い方: node tools/experiments/mission59_bg_vs_render_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT = 'data/reports/mission59';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8161, r));
const URL_ = 'http://localhost:8161/mission37g-osaka-24ward-mvp.html?qa=1&basemap=gsi-pale&extra=0&fac=0&bw=27120&vcull=0';

const CLAT = 34.604208, CLON = 135.525020, MPD = 111320;
const ll = (lat, lon) => [(lon - CLON) * Math.cos(CLAT * Math.PI / 180) * MPD, -((lat - CLAT) * MPD)];
const POINTS = [
  { n: 'hanwa-hospital', lat: 34.6044, lon: 135.5051 },
  { n: 'sumiyoshi-taisha', lat: 34.6114, lon: 135.4930 },
  { n: 'sumiyoshi-park-ne', lat: 34.6050, lon: 135.4990 },
  { n: 'hosoigawa', lat: 34.5984, lon: 135.5139 },
  { n: 'north-block', lat: 34.6090, lon: 135.5020 },
  { n: 'south-block', lat: 34.5990, lon: 135.4950 },
].map((p) => ({ ...p, xz: ll(p.lat, p.lon) }));

const b = await launchBrowser({ width: 1400, height: 900 });
const page = b.page;
const out = { mission: '59', jsErrors: [], badResponses: [], points: [] };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.responseReceived', (e) => { if (e.response.status >= 400) out.badResponses.push(e.response.status + ' ' + e.response.url.slice(0, 120)); });
const ev = (js) => page.evaluate(js);
fs.mkdirSync(OUT, { recursive: true });
const shot = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64')); return data; };
const VEC = ['roads', 'waterways', 'parks', 'railways', 'gsiroadedge', 'gsiwater'];
const setVec = (on) => ev(`(()=>{for(const id of ${JSON.stringify(VEC)}){try{window.__mission37dQA.setLayer(id,${on})}catch(e){}}})()`);

// ページ内で 2 枚の PNG(base64) の相互相関を計算
const REG = `async (a64,b64)=>{
  const load=s=>new Promise(r=>{const m=new Image();m.onload=()=>r(m);m.src='data:image/png;base64,'+s});
  const [A,B]=await Promise.all([load(a64),load(b64)]);
  const S=2,W=Math.floor(A.width/S),H=Math.floor(A.height/S);
  const px=im=>{const c=document.createElement('canvas');c.width=W;c.height=H;const x=c.getContext('2d');x.drawImage(im,0,0,W,H);return x.getImageData(0,0,W,H).data};
  const da=px(A),db=px(B);
  const gray=d=>{const g=new Float32Array(W*H);for(let i=0;i<W*H;i++)g[i]=0.3*d[i*4]+0.59*d[i*4+1]+0.11*d[i*4+2];return g};
  const ga=gray(da),gb=gray(db);
  const mask=new Float32Array(W*H);let nm=0;for(let i=0;i<W*H;i++){const dd=Math.abs(da[i*4]-db[i*4])+Math.abs(da[i*4+1]-db[i*4+1])+Math.abs(da[i*4+2]-db[i*4+2]);if(dd>45){mask[i]=1;nm++}}
  const grad=(g)=>{const o=new Float32Array(W*H);for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=y*W+x;o[i]=Math.abs(g[i+1]-g[i-1])+Math.abs(g[i+W]-g[i-W])}return o};
  const eA=grad(ga),eM=grad(mask);
  const R=24;let best=-1,bx=0,by=0,zero=0;const grid={};
  for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++){let s=0;
    for(let y=R;y<H-R;y++){const ro=y*W;for(let x=R;x<W-R;x++){const m=eM[ro+x];if(m>0)s+=m*eA[(y+dy)*W+x+dx]}}
    grid[dx+','+dy]=s;if(dx==0&&dy==0)zero=s;if(s>best){best=s;bx=dx;by=dy}}
  // サブピクセル（放物線）
  const g=(x,y)=>grid[x+','+y]||0;const sub=(m,c,p)=>{const d=m-2*c+p;return d? 0.5*(m-p)/d:0};
  const sx=bx+sub(g(bx-1,by),g(bx,by),g(bx+1,by)), sy=by+sub(g(bx,by-1),g(bx,by),g(bx,by+1));
  // 平均スコア(ランダムシフトの平均)と比べたピークの鋭さ
  let mean=0,n=0;for(const k in grid){mean+=grid[k];n++}mean/=n;
  return {W,H,scale:S,maskPx:nm,bestShiftPx:[sx*S,sy*S],bestAtEdge:(Math.abs(bx)==R||Math.abs(by)==R),peakOverMean:best/mean,zeroOverBest:zero/best};
}`;

try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 80; i++) { await sleep(1500); if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break; }
  await sleep(4000);
  out.renderInfo = JSON.parse(await ev('JSON.stringify(window.__mission37dQA.renderInfo())'));
  for (const p of POINTS) {
    const [x, z] = p.xz; const rec = { name: p.n, lat: p.lat, lon: p.lon, localXZ: [+x.toFixed(1), +z.toFixed(1)] };
    const look = async (range, pitch) => { await ev(`window.__mission37dQA.lookAtLocal(${x},${z},0,${range},${pitch},0)`); await sleep(5500); };
    // m/px（真上 range=350）: 100m 離れた 2 点の画面距離
    await look(350, -90);
    await setVec(false); await ev('window.__mission37dQA.setTilesetShow(false)'); await sleep(2500);
    const s0 = await shot(`${p.n}-top-bg-only`);
    await ev('window.__mission37dQA.setTilesetShow(true)'); await sleep(2500);
    const s1 = await shot(`${p.n}-top-bg+bldg`);
    const q0 = JSON.parse(await ev(`JSON.stringify(window.__mission37dQA.project(${x},${z},0))`)), q1 = JSON.parse(await ev(`JSON.stringify(window.__mission37dQA.project(${x + 100},${z},0))`));
    const mpp = q0 && q1 ? 100 / Math.hypot(q1.x - q0.x, q1.y - q0.y) : null;
    rec.metersPerPixel = mpp && +mpp.toFixed(3);
    rec.registration = await ev(`(${REG})(${JSON.stringify(s0)},${JSON.stringify(s1)})`);
    const sp = rec.registration.bestShiftPx;
    rec.shiftMeters = mpp ? { dxEast: +(sp[0] * mpp).toFixed(2), dySouth: +(sp[1] * mpp).toFixed(2), horiz: +(Math.hypot(sp[0], sp[1]) * mpp).toFixed(2) } : null;
    // 同一カメラの ON/OFF 画像（真上/斜め）
    await setVec(true); await sleep(2500); await shot(`${p.n}-top-all-on`);
    await ev(`window.__mission37dQA.setLayer('roads',false);window.__mission37dQA.setLayer('waterways',false);window.__mission37dQA.setLayer('parks',false)`); await sleep(2000); await shot(`${p.n}-top-gsi-vec-only`);
    await setVec(true); await look(450, -40); await sleep(1500); await shot(`${p.n}-oblique-all-on`);
    await setVec(false); await sleep(2000); await shot(`${p.n}-oblique-bg+bldg`);
    await ev('window.__mission37dQA.setGlobe(false)'); await sleep(1500); await shot(`${p.n}-oblique-globe-off`); await ev('window.__mission37dQA.setGlobe(true)');
    out.points.push(rec); console.log(JSON.stringify(rec));
  }
} catch (e) { out.fatal = String(e && e.stack || e); }
fs.writeFileSync(path.join(OUT, 'bg-vs-render.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ jsErrors: out.jsErrors, badResponses: out.badResponses.slice(0, 10), fatal: out.fatal }, null, 1));
try { await b.close(); } catch { /* noop */ }
srv.close(); process.exit(0);
