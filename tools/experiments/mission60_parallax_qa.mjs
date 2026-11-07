// [Mission 60] 「建物の足元と背景(GSI 淡色地図の建物外形/道路縁)が噛み合わない」見かけが、
//   (a) 屋根の透視視差（高さ×画面中心からの距離/カメラ距離）か、(b) 真の水平位置ずれか、を同一地点・同一向きで切り分ける。
// 方法: 真上(pitch -90)から、通常 fov(60°, range 350m) と 狭 fov(約 2°, range 12000m = ほぼ正射影) の 2 条件で
//   S0=背景のみ / S1=背景+建物 を撮り、差分マスク(建物)の勾配を背景勾配へ最良シフトさせる相互相関を「画面の 4 象限別」に求める。
//   透視視差なら象限ごとに中心から外向きの逆符号のシフトになり、狭 fov で消える。一様な真のずれなら全象限同符号で fov に依らない。
// 背景は GSI 淡色地図（建物外形を描く独立ラスタ。PLATEAU/OSM のローカル変換とは別系統）。
// 外部 GET: GSI は z<16 を 1x1 スタブで応答（外部 GET 0）、z>=16 のみ実 GET（直列・各1.1秒以上・最大 BUDGET 件・429/403 で停止）。
// 使い方: node tools/experiments/mission60_parallax_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT = 'data/reports/mission60';
const BUDGET = 45;
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
await new Promise((r) => srv.listen(8163, r));
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320, D = Math.PI / 180;
const ll = (lat, lon) => [(lon - CLON) * Math.cos(CLAT * D) * MPD, -((lat - CLAT) * MPD)];
const POINTS = [{ n: 'hanwa-hospital', lat: 34.6044, lon: 135.5051 }, { n: 'north-block', lat: 34.6090, lon: 135.5020 }].map((p) => ({ ...p, xz: ll(p.lat, p.lon) }));

const REG = `async (a64,b64)=>{
  const load=s=>new Promise(r=>{const m=new Image();m.onload=()=>r(m);m.src='data:image/png;base64,'+s});
  const [A,B]=await Promise.all([load(a64),load(b64)]);
  const S=2,W=Math.floor(A.width/S),H=Math.floor(A.height/S);
  const px=im=>{const c=document.createElement('canvas');c.width=W;c.height=H;const x=c.getContext('2d');x.drawImage(im,0,0,W,H);return x.getImageData(0,0,W,H).data};
  const da=px(A),db=px(B);
  const ga=new Float32Array(W*H);for(let i=0;i<W*H;i++)ga[i]=0.3*da[i*4]+0.59*da[i*4+1]+0.11*da[i*4+2];
  const mask=new Float32Array(W*H);let nm=0;for(let i=0;i<W*H;i++){const dd=Math.abs(da[i*4]-db[i*4])+Math.abs(da[i*4+1]-db[i*4+1])+Math.abs(da[i*4+2]-db[i*4+2]);if(dd>45){mask[i]=1;nm++}}
  const grad=(g)=>{const o=new Float32Array(W*H);for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=y*W+x;o[i]=Math.abs(g[i+1]-g[i-1])+Math.abs(g[i+W]-g[i-W])}return o};
  const eA=grad(ga),eM=grad(mask);
  const R=20,cx=W/2,cy=H/2;const G=[{},{},{},{},{}];const best=[-1,-1,-1,-1,-1],bs=[[0,0],[0,0],[0,0],[0,0],[0,0]],cnt=[0,0,0,0];
  for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++){const s=[0,0,0,0,0];
    for(let y=R;y<H-R;y++){const ro=y*W;for(let x=R;x<W-R;x++){const m=eM[ro+x];if(m>0){const v=m*eA[(y+dy)*W+x+dx];const q=(y<cy?0:2)+(x<cx?0:1);s[q]+=v;s[4]+=v}}}
    for(let q=0;q<5;q++){G[q][dx+','+dy]=s[q];if(s[q]>best[q]){best[q]=s[q];bs[q]=[dx,dy]}}}
  const sub=(g,q)=>{const [bx,by]=bs[q];const f=(x,y)=>g[x+','+y]||0;const sp=(m,c,p)=>{const d=m-2*c+p;return d?0.5*(m-p)/d:0};return [bx+sp(f(bx-1,by),f(bx,by),f(bx+1,by)),by+sp(f(bx,by-1),f(bx,by),f(bx,by+1))]};
  const names=['NW','NE','SW','SE','all'];const res={};
  for(let q=0;q<5;q++){const s=sub(G[q],q);let mean=0,n=0;for(const k in G[q]){mean+=G[q][k];n++}mean/=n;res[names[q]]={shiftPx:[+(s[0]*S).toFixed(2),+(s[1]*S).toFixed(2)],peakOverMean:+(best[q]/mean).toFixed(2),atEdge:Math.abs(bs[q][0])==R||Math.abs(bs[q][1])==R}}
  return {maskPx:nm,res};
}`;

fs.mkdirSync(OUT, { recursive: true });
const out = { mission: '60', budget: BUDGET, jsErrors: [], realGets: 0, stubbed: 0, stop: null, statuses: {}, maxZ: 0, points: [] };
const b = await launchBrowser({ width: 1400, height: 900 });
const page = b.page;
let chain = Promise.resolve();
await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://cyberjapandata.gsi.go.jp/*', requestStage: 'Request' }] });
page.on('Fetch.requestPaused', (e) => {
  chain = chain.then(async () => {
    const m = /\/xyz\/pale\/(\d+)\/(\d+)\/(\d+)\.png/.exec(e.request.url);
    if (!m) return page.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    const z = +m[1]; out.maxZ = Math.max(out.maxZ, z);
    if (out.stop || out.realGets >= BUDGET || z < 16) { out.stubbed++; return page.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: STUB }).catch(() => {}); }
    out.realGets++; await sleep(1100);
    return page.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
  });
});
page.on('Network.responseReceived', (e) => { if (/cyberjapandata/.test(e.response.url)) { out.statuses[e.response.status] = (out.statuses[e.response.status] || 0) + 1; if (e.response.status === 429 || e.response.status === 403) out.stop = e.response.status; } });
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 200)); } catch { /* noop */ } });
const ev = (js) => page.evaluate(js);
const shot = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64')); return data; };
const VEC = ['roads', 'waterways', 'parks', 'railways', 'gsiroadedge', 'gsiwater'];
try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: 'http://localhost:8163/mission37g-osaka-24ward-mvp.html?qa=1&basemap=gsi-pale&extra=0&fac=0&bw=27120&vcull=0&panel=0' });
  for (let i = 0; i < 80; i++) { await sleep(1500); if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break; }
  await ev(`(()=>{for(const id of ${JSON.stringify(VEC)}){try{window.__mission37dQA.setLayer(id,false)}catch(e){}}})()`);
  for (const p of POINTS) {
    const [x, z] = p.xz;
    const rec = { name: p.n, lat: p.lat, lon: p.lon, localXZ: [+x.toFixed(1), +z.toFixed(1)], cams: {} };
    for (const cam of [{ k: 'persp60-r350', fov: 60, range: 350 }, { k: 'ortho-like-fov2-r12000', fov: 2, range: 12000 }]) {
      await ev(`(()=>{const v=window.__mission37dQA.setFov(${cam.fov});window.__mission37dQA.lookAtLocal(${x},${z},0,${cam.range},-90,0)})()`);
      for (let i = 0; i < 10; i++) { await sleep(2500); if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; }
      await sleep(5000);
      await ev('window.__mission37dQA.setTilesetShow(false)'); await sleep(3000);
      const s0 = await shot(`${p.n}-${cam.k}-bg-only`);
      await ev('window.__mission37dQA.setTilesetShow(true)'); await sleep(3000);
      const s1 = await shot(`${p.n}-${cam.k}-bg+bldg`);
      const q0 = JSON.parse(await ev(`JSON.stringify(window.__mission37dQA.project(${x},${z},0))`)), q1 = JSON.parse(await ev(`JSON.stringify(window.__mission37dQA.project(${x + 100},${z},0))`));
      const mpp = q0 && q1 ? 100 / Math.hypot(q1.x - q0.x, q1.y - q0.y) : null;
      const reg = await ev(`(${REG})(${JSON.stringify(s0)},${JSON.stringify(s1)})`);
      const m = (px) => (mpp ? +(px * mpp).toFixed(2) : null);
      rec.cams[cam.k] = { fovDeg: cam.fov, range: cam.range, metersPerPixel: mpp && +mpp.toFixed(3), maskPx: reg.maskPx,
        quadrantShift: Object.fromEntries(Object.entries(reg.res).map(([k, v]) => [k, { px: v.shiftPx, east_m: m(v.shiftPx[0]), south_m: m(v.shiftPx[1]), peakOverMean: v.peakOverMean, atEdge: v.atEdge }])) };
      console.log(p.n, cam.k, JSON.stringify(rec.cams[cam.k]));
    }
    out.points.push(rec);
  }
  await ev('window.__mission37dQA.setFov(60)');
} catch (e) { out.fatal = String(e && e.stack || e); }
fs.writeFileSync(path.join(OUT, 'parallax.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ jsErrors: out.jsErrors, realGets: out.realGets, stubbed: out.stubbed, statuses: out.statuses, maxZ: out.maxZ, stop: out.stop, fatal: out.fatal }));
try { await b.close(); } catch { /* noop */ }
srv.close(); process.exit(0);
