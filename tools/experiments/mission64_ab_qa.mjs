// [Mission 64] 同一カメラ A/B（実 Chrome）。阪和病院と住吉大社の池（水域×公園の重なり点）だけを比較する。
// 外部通信は全て本スクリプトが仲介する: 上限 MAX_GETS 件 / MAX_BYTES、各 GET の間隔 1 秒以上、429/403 で即停止、
// 取得済みは temp/mission64-net/ に保存して再利用（再実行は 0 GET）。GSI タイルは z<16 を 1x1 スタブで応答（GET 0 件）。
// 使い方: node tools/experiments/mission64_ab_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT = process.argv.includes('--nobg') ? 'data/reports/mission64/nobg' : 'data/reports/mission64';
const CACHE = 'temp/mission64-net';
const MAX_GETS = process.argv.includes('--nobg') ? 0 : 30,   // --nobg は取得済みキャッシュのみ（新規 GET 0 件）
 MAX_BYTES = 30 * 1024 * 1024;
const STUB = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.css': 'text/css' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8164, r));

const CLAT = 34.604208, CLON = 135.525020, MPD = 111320, D = Math.PI / 180;
const ll = (lat, lon) => [(lon - CLON) * Math.cos(CLAT * D) * MPD, -((lat - CLAT) * MPD)];

// 住吉大社の池 = Mission58 と同じ「水域面×公園面の重なり点」の重心
const L = 'public/mission37c-layers/osaka-sumiyoshi-9tile/';
const wat = JSON.parse(fs.readFileSync(L + 'waterways.json', 'utf8')).features.filter((f) => f.kind === 'area');
const parks = JSON.parse(fs.readFileSync(L + 'parks.json', 'utf8')).features.filter((f) => f.p && f.p.length >= 3);
const inRing = (x, z, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const pts = [];
for (const w of wat) {
  const xs = w.p.map((p) => p[0]), zs = w.p.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  for (let k = 0; k < 100; k++) {
    const x = x0 + (x1 - x0) * (((k * 7) % 10) + 0.5) / 10, z = z0 + (z1 - z0) * (Math.floor(k / 10) + 0.5) / 10;
    if (inRing(x, z, w.p) && parks.some((pk) => inRing(x, z, pk.p))) pts.push([x, z]);
  }
}
const pond = pts.length ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] : null;
const SPOTS = [{ n: 'hanwa-hospital', xz: ll(34.6044, 135.5051) }, ...(pond ? [{ n: 'sumiyoshi-pond', xz: pond }] : [])];

const net = { gets: 0, bytes: 0, cached: 0, stubbed: 0, blocked: 0, stop: null, statuses: {}, maxGsiZ: 0, gsiTiles: [], urls: [] };
let lastGet = 0, chain = Promise.resolve();
async function realGet(url) {
  const wait = 1000 - (Date.now() - lastGet); if (wait > 0) await sleep(wait);
  lastGet = Date.now();
  const r = await fetch(url, { headers: { 'User-Agent': 'livecity-qa/mission64 (read-only; max 30 GET)' } });
  net.statuses[r.status] = (net.statuses[r.status] || 0) + 1;
  if (r.status === 429 || r.status === 403) net.stop = r.status;
  const buf = Buffer.from(await r.arrayBuffer());
  net.gets++; net.bytes += buf.length; net.urls.push({ url: url.replace(/^https:\/\//, ''), status: r.status, bytes: buf.length });
  return { status: r.status, type: r.headers.get('content-type') || 'application/octet-stream', buf };
}
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(CACHE, { recursive: true });

const b = await launchBrowser({ width: 1400, height: 900 });
const page = b.page;
const out = { mission: '64', jsErrors: [], spots: [], net };
await page.send('Fetch.enable', { patterns: [{ urlPattern: 'http*://*', requestStage: 'Request' }] });
page.on('Fetch.requestPaused', (e) => {
  const url = e.request.url;
  if (/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) return page.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
  chain = chain.then(async () => {
    const fulfill = (status, type, body) => page.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: body.toString('base64') }).catch(() => {});
    const fail = () => { net.blocked++; return page.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); };
    if (e.request.method !== 'GET') return fail();
    const g = /cyberjapandata\.gsi\.go\.jp\/xyz\/pale\/(\d+)\/(\d+)\/(\d+)\.png/.exec(url);
    if (g) { const z = +g[1]; net.maxGsiZ = Math.max(net.maxGsiZ, z); if (z < 16 || process.argv.includes('--nobg')) { net.stubbed++; return fulfill(200, 'image/png', STUB); } net.gsiTiles.push(`${g[1]}/${g[2]}/${g[3]}`); }
    if (!/^https:\/\/(cdn\.jsdelivr\.net|cyberjapandata\.gsi\.go\.jp)\//.test(url)) return fail();   // 許可ホスト以外は通信しない
    const key = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex'));
    if (fs.existsSync(key + '.bin')) { net.cached++; const m = JSON.parse(fs.readFileSync(key + '.json', 'utf8')); return fulfill(m.status, m.type, fs.readFileSync(key + '.bin')); }
    if (net.stop || net.gets >= MAX_GETS || net.bytes >= MAX_BYTES) { net.overBudget = true; return fail(); }
    try {
      const r = await realGet(url);
      if (r.status === 200) { fs.writeFileSync(key + '.bin', r.buf); fs.writeFileSync(key + '.json', JSON.stringify({ status: r.status, type: r.type })); }
      return fulfill(r.status, r.type, r.buf);
    } catch (err) { net.fetchError = String(err); return fail(); }
  });
});
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 200)); } catch { /* noop */ } });
const ev = (js) => page.evaluate(js);
const Q = 'window.__mission37dQA';
const shotBuf = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64')); return data; };

// 2 枚の PNG の差分: 変化画素数・外接矩形・最大差（画素）
const DIFF = `async (a64,b64)=>{const ld=s=>new Promise(r=>{const m=new Image();m.onload=()=>r(m);m.src='data:image/png;base64,'+s});
  const [A,B]=await Promise.all([ld(a64),ld(b64)]);const W=A.width,H=A.height;const px=m=>{const c=document.createElement('canvas');c.width=W;c.height=H;const x=c.getContext('2d');x.drawImage(m,0,0);return x.getImageData(0,0,W,H).data};
  const a=px(A),b=px(B);let n=0,x0=W,y0=H,x1=-1,y1=-1;for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>30){n++;if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y}}
  return {changedPx:n,bbox:n?[x0,y0,x1,y1]:null,size:[W,H]}}`;

const settle = async () => {   // 建物 tile + 背景 imagery(globe.tilesLoaded) の両方が完了するまで待つ
  for (let i = 0; i < 24; i++) { await sleep(2000); const ok = await ev(`${Q}.tilesReady() && ${Q}.snapshot().globe.tilesLoaded`).catch(() => false); if (ok) break; }
  await sleep(2500);
};
const LAYERS = ['roads', 'waterways', 'parks', 'railways', 'gsiroadedge', 'gsiwater'];
const setLayers = (on) => ev(`(()=>{for(const id of ${JSON.stringify(LAYERS)}){try{${Q}.setLayer(id,${JSON.stringify(on[id] !== false && on[id] !== undefined ? true : !!on[id])})}catch(e){}}})()`);

try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: 'http://localhost:8164/mission37g-osaka-24ward-mvp.html?qa=1&basemap=gsi-pale&extra=0&fac=0&bw=27120&vcull=0&panel=0' });
  for (let i = 0; i < 80; i++) { await sleep(1500); if ((await ev(`!!(${Q} && document.getElementById('lc-loading').classList.contains('done'))`).catch(() => false)) === true) break; }
  for (const sp of SPOTS) {
    const [x, z] = sp.xz;
    const rec = { name: sp.n, localXZ: [+x.toFixed(1), +z.toFixed(1)], views: {} };
    for (const v of [{ k: 'top', pitch: -90, range: 450 }, { k: 'oblique45', pitch: -45, range: 450 }]) {
      await ev(`${Q}.lookAtLocal(${x},${z},0,${v.range},${v.pitch},0)`);
      await settle();
      // 基準（全部 ON）
      await ev(`(()=>{for(const id of ${JSON.stringify(LAYERS)}) ${Q}.setLayer(id,true); ${Q}.setGlobe(true); ${Q}.setBuildingSlice(null,null); ${Q}.setBuildingColor(null); ${Q}.setTilesetShow(true)})()`);
      await sleep(2500);
      const snap = JSON.parse(await ev(`JSON.stringify(${Q}.snapshot())`));
      const mpp = await (async () => { const a = JSON.parse(await ev(`JSON.stringify(${Q}.project(${x},${z},0))`)), c = JSON.parse(await ev(`JSON.stringify(${Q}.project(${x + 50},${z},0))`)); return a && c ? 50 / Math.hypot(c.x - a.x, c.y - a.y) : null; })();
      const base = await shotBuf(`${sp.n}-${v.k}-00-all`);
      const states = {
        '01-bg-only':        'for(const id of L) Q.setLayer(id,false); Q.setTilesetShow(false)',
        '02-bg+osm-vectors': 'for(const id of ["roads","waterways","parks","railways"]) Q.setLayer(id,true); for(const id of ["gsiroadedge","gsiwater"]) Q.setLayer(id,false); Q.setTilesetShow(false)',
        '03-bg+gsi-edge':    'for(const id of L) Q.setLayer(id,false); Q.setLayer("gsiroadedge",true); Q.setLayer("gsiwater",true); Q.setTilesetShow(false)',
        '04-bg+foot(0-2m)':  'for(const id of L) Q.setLayer(id,false); Q.setTilesetShow(true); Q.setBuildingColor("#ff00ff"); Q.setBuildingSlice(null,2)',
        '05-bg+roof(ge12m)': 'for(const id of L) Q.setLayer(id,false); Q.setTilesetShow(true); Q.setBuildingColor("#ff00ff"); Q.setBuildingSlice(12,null)',
        '06-nobg(globe-off)+all': 'for(const id of L) Q.setLayer(id,true); Q.setBuildingSlice(null,null); Q.setBuildingColor(null); Q.setTilesetShow(true); Q.setGlobe(false)',
        '07-bg-only+gsi-edge-vs-water': 'for(const id of L) Q.setLayer(id,false); Q.setLayer("waterways",true); Q.setLayer("parks",true); Q.setTilesetShow(false)',
      };
      rec.views[v.k] = { range: v.range, pitch: v.pitch, metersPerPixel: mpp && +mpp.toFixed(3), snapshot: snap, states: {} };
      const shots = {};
      for (const [name, js] of Object.entries(states)) {
        await ev(`(()=>{const Q=${Q},L=${JSON.stringify(LAYERS)};Q.setGlobe(true);${js}})()`);
        await sleep(2000);
        shots[name] = await shotBuf(`${sp.n}-${v.k}-${name}`);
        const errs = await ev(`${Q}.renderErrors()`); if (errs.length && !rec.renderErrorAt) rec.renderErrorAt = { view: v.k, state: name, errs };
        rec.views[v.k].states[name] = { vsAll: await ev(`(${DIFF})(${JSON.stringify(base)},${JSON.stringify(shots[name])})`) };
      }
      // 対比: 足元 vs 屋根 vs 背景のみ → 足元スライスと背景のみの差分 = 足元が占める画素
      rec.views[v.k].footVsRoof = await ev(`(${DIFF})(${JSON.stringify(shots['04-bg+foot(0-2m)'])},${JSON.stringify(shots['05-bg+roof(ge12m)'])})`);
      rec.views[v.k].bgVsFoot = await ev(`(${DIFF})(${JSON.stringify(shots['01-bg-only'])},${JSON.stringify(shots['04-bg+foot(0-2m)'])})`);
      await ev(`(()=>{for(const id of ${JSON.stringify(LAYERS)}) ${Q}.setLayer(id,true); ${Q}.setGlobe(true); ${Q}.setBuildingSlice(null,null); ${Q}.setBuildingColor(null); ${Q}.setTilesetShow(true)})()`);
      console.log(sp.n, v.k, 'gets', net.gets, 'bytes', net.bytes, 'lv', JSON.stringify(snap.globe.tilesToRenderByLevel));
    }
    out.spots.push(rec);
  }
} catch (e) { out.fatal = String(e && e.stack || e); }
out.noBg = process.argv.includes('--nobg'); out.net = { ...net, gsiTiles: [...new Set(net.gsiTiles)] };
fs.writeFileSync(path.join(OUT, 'ab.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ jsErrors: out.jsErrors, gets: net.gets, bytes: net.bytes, cached: net.cached, stubbed: net.stubbed, blocked: net.blocked, stop: net.stop, overBudget: net.overBudget, statuses: net.statuses, maxGsiZ: net.maxGsiZ, fatal: out.fatal }));
try { await b.close(); } catch { /* noop */ }
srv.close(); process.exit(0);
