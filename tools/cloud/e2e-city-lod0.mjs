// Mission 213: 合成 fixture の LOD0 を実ブラウザ(headless Chromium+SwiftShader WebGL)で描画する localhost E2E。
//   ※ 実データではない。合成 fixture での配線・描画・非クリック性の確認専用(実PLATEAU24区の検証とは別物)。
//   使い方: node tools/cloud/e2e-city-lod0.mjs [--chrome /usr/bin/chromium] [--out e2e-report.json]
//   ネットワーク: Cesium 1.121.1 を jsDelivr CDN から読む(HTML 既存仕様)。到達不能なら理由を出して exit 2。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { buildCityLod0 } from './city-lod0.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const CHROME = opt('chrome', '/usr/bin/chromium'), OUT = opt('out', null);
// --static <build出力dir>: 実ビルド出力(build-cloud-preview.mjs --city-lod0 の temp/cloud-preview/static 等)を読み取り専用で配信する実データモード。
//   省略時は合成 fixture。実データと合成は result.fixture で区別する。--lon/--lat で最初の観測地点(既定: 大阪北区)。
const STATIC = opt('static', null);

// ---- fixture: 2 区が x=3000 で接する 6km×3km の街区(各 200m セルに 6 棟) ----
const ext = STATIC ? path.join(path.resolve(STATIC), 'ext-3dtiles') : fs.mkdtempSync(path.join(os.tmpdir(), 'lod0e2e-'));
if (STATIC && !fs.existsSync(path.join(ext, 'index.json'))) { console.error('--static に ext-3dtiles/index.json がありません: ' + STATIC); process.exit(3); }
const mk = (xs) => { const byId = {}; let i = 0; for (const [x, z, h] of xs) byId['bldg_s' + (i++)] = [h, null, x, z, 0]; return { fields: ['h', 'usage', 'repX', 'repZ', 'z0'], byId }; };
const put = (w, items) => { const d = path.join(ext, w, 'attrs'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 't_0_0.json'), JSON.stringify(mk(items))); };
const A = [], B = [];
for (let cx = 0; cx < 30; cx++) for (let cz = 0; cz < 15; cz++) for (let k = 0; k < 6; k++) (cx < 15 ? A : B).push([cx * 200 + 20 + k * 25, cz * 200 + 30 + k * 20, 8 + ((cx * 7 + cz * 3 + k) % 40)]);
let rep;
if (!STATIC) { put('a', A); put('b', B); fs.writeFileSync(path.join(ext, 'index.json'), JSON.stringify({ wards: [], lod0Wards: [] })); rep = buildCityLod0({ extRoot: ext, wards: [{ id: 'a', code: '27101' }, { id: 'b', code: '27102' }], tileCells: 10 }); }
else { const ix = JSON.parse(fs.readFileSync(path.join(ext, 'index.json'), 'utf8')); rep = { totals: ix.cityLod0 || null }; if (!rep.totals) { console.error('index.json に cityLod0 がありません(--city-lod0 でビルドしていない)'); process.exit(3); } }
const result = { fixture: STATIC ? 'real-build-output' : 'synthetic', coverage: rep.totals, ok: false, checks: {}, console: [], network: [] };

// ---- static server ----
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.css': 'text/css' };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]); let f;
  if (u.startsWith('/ext-3dtiles/')) f = path.join(ext, u.slice(13)); else f = path.join(STATIC ? path.resolve(STATIC) : path.join(ROOT, 'public'), u === '/' ? 'mission37g-osaka-24ward-mvp.html' : u);
  if (!f.startsWith(ext) && !f.startsWith(STATIC ? path.resolve(STATIC) : path.join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => { if (!e && f.endsWith('mission37g-osaka-24ward-mvp.html')) { const t = d.toString('utf8'), k = 'const scene = viewer.scene;'; if (!t.includes(k)) { e = new Error('注入点が無い'); } else d = Buffer.from(t.replace(k, k + ' window.__v = viewer;')); } if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d); });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;

// ---- chrome + CDP ----
const port2 = 9333 + Math.floor(Math.random() * 500);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1000,700', '--remote-debugging-port=' + port2, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port2}/json`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
if (!targets) throw new Error('chrome のデバッグポートに接続できません');
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const j = JSON.parse(m.data);
  if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); }
  else if (j.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(j.params.type)) result.console.push(j.params.type + ': ' + j.params.args.map((x) => x.value ?? x.description).join(' ').slice(0, 300));
  else if (j.method === 'Runtime.exceptionThrown') result.console.push('exception: ' + (j.params.exceptionDetails.exception?.description || j.params.exceptionDetails.text).slice(0, 300));
  else if (j.method === 'Network.loadingFinished') { result.bytes = (result.bytes || 0) + (j.params.encodedDataLength || 0); }
  else if (j.method === 'Network.responseReceived') { const u = j.params.response.url; if (/city-lod0|index\.json|Cesium\.js/.test(u)) result.network.push({ url: u.replace(/^http:\/\/127.0.0.1:\d+/, ''), status: j.params.response.status }); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error'); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
// viewer の露出は E2E サーバが配信コピーへ 1 行注入して行う(リポジトリの HTML は無改変)

async function load(qs) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/mission37g-osaka-24ward-mvp.html?${qs}` });
  for (let i = 0; i < 120 && !(await ev('!!window.__v').catch(() => false)); i++) await sleep(500);
  return ev('!!window.__v');
}
// 同一カメラで LOD0 表示/非表示のフレームを比較し「LOD0 が寄与した画素率」を出す(背景色の推測に依存しない)。10 分割の列別も返す。
const pixelStat = () => ev(`(async()=>{const v=window.__v;const grab=()=>{v.scene.render();const c=v.scene.canvas;const t=document.createElement('canvas');t.width=c.width;t.height=c.height;const g=t.getContext('2d');g.drawImage(c,0,0);return g.getImageData(0,0,t.width,t.height).data};const sv=window.__t.show;window.__t.show=true;const on=grab();window.__t.show=false;const off=grab();window.__t.show=sv;const w=v.scene.canvas.width,n=on.length/4;let diff=0;const cols=new Array(10).fill(0);for(let i=0;i<on.length;i+=4){const d=Math.abs(on[i]-off[i])+Math.abs(on[i+1]-off[i+1])+Math.abs(on[i+2]-off[i+2]);if(d>12){diff++;cols[Math.min(9,Math.floor(((i/4)%w)/w*10))]++}}return {w,h:v.scene.canvas.height,lod0Share:+(diff/n).toFixed(4),cols:cols.map(x=>+(x/(n/10)).toFixed(3))}})()`);
const fly = (lon, lat, h, pitchDeg = -90) => ev(`(()=>{const v=window.__v;v.camera.cancelFlight();v.camera.setView({destination:Cesium.Cartesian3.fromDegrees(${lon},${lat},${h}),orientation:{heading:0,pitch:Cesium.Math.toRadians(${pitchDeg}),roll:0}});v.camera.moveEnd.raiseEvent&&v.camera.moveEnd.raiseEvent();v.scene.requestRender();return true})()`);
const CLAT = 34.604208, CLON = 135.525020, D2R = Math.PI / 180;
const ll = (x, z) => [CLON + x / (Math.cos(CLAT * D2R) * 111320), CLAT - z / 111320];

// ---- 実データモード(--static): 実LOD1/2 を載せた状態で LOD0 の寄与・重なり・クリックを計測。合成の判定(cross/ll(3000..))は使わない ----
// アプリ起動後の自動カメラ移動に上書きされるため、目標高度で 2 回連続して安定するまで再設定する
async function holdCam(lon, lat, h, pitch = -90) {
  let stable = 0;
  for (let i = 0; i < 20 && stable < 2; i++) { await fly(lon, lat, h, pitch); await sleep(1500); const cur = await ev('window.__v.camera.positionCartographic.height'); stable = Math.abs(cur - h) < h * 0.1 ? stable + 1 : 0; }
  return stable >= 2;
}
async function realMode() {
  const lat0 = Number(opt('lat', 34.7055)), lon0 = Number(opt('lon', 135.51));
  const t0 = Date.now();
  const up = await load('citylod0=1'); result.checks.viewerLoaded = up; if (!up) throw new Error('viewer 起動不可: ' + JSON.stringify(result.console.slice(0, 3)));
  result.checks.coldFirstViewerMs = Date.now() - t0; result.checks.coldBytesAtViewer = result.bytes || 0;
  await ev(`window.__ev=[];window.addEventListener('livecity:37d-building-selected',e=>window.__ev.push(e.detail&&e.detail.canonicalId||null))`);
  for (let i = 0; i < 12; i++) { await sleep(1500); await fly(lon0, lat0, 3000); if (Math.abs((await ev('window.__v.camera.positionCartographic.height')) - 3000) < 300) break; }
  for (let i = 0; i < 80; i++) { const st = await ev(`(()=>{const v=window.__v;v.scene.requestRender();const ps=v.scene.primitives._primitives||[];let l0=null,real=[];for(const p of ps){if(p._lcCityLod0)l0=p;else if(p.tilesLoaded!==undefined)real.push(p)};window.__t=l0;return {l0:!!l0&&l0.tilesLoaded,real:real.length,realLoaded:real.filter(x=>x.tilesLoaded).length}})()`); result.checks.loadState = st; if (st.l0 && st.real === st.realLoaded && st.real > 0) break; await sleep(750); }
  result.checks.coldBytesAfterSettle = result.bytes || 0; result.checks.coldSettleMs = Date.now() - t0;
  result.checks.lod0Loaded = !!(await ev('!!window.__t && window.__t.ready!==false'));
  // LOD0 + 実LOD1/2 が同時に出る高度 3000m: LOD0 の寄与画素率(同一カメラの表示/非表示差)。実タイルは全て表示のまま
  result.checks.highCamHeld = await holdCam(lon0, lat0, 3000); await sleep(1500);
  result.checks.highCamH = await ev('Math.round(window.__v.camera.positionCartographic.height)');
  result.checks.highWithReal = await pixelStat();
  // 近接 600m: LOD0 が自動非表示(高度しきい値)になり、実LOD1/2 だけが描画されること
  result.checks.lowCamHeld = await holdCam(lon0, lat0, 600, -60); await sleep(1500);
  result.checks.lowCamH = await ev('Math.round(window.__v.camera.positionCartographic.height)');
  result.checks.lowAltLod0Shown = await ev('window.__t ? window.__t.show : null');
  // pick 走査: 画面格子で scene.pick。LOD0 を拾う画素数 / 実建物(canonicalId)を拾う画素数
  result.checks.pickScan = await ev(`(()=>{const v=window.__v,c=v.scene.canvas,o={lod0:0,real:0,none:0,drillRealWhenLod0:0};for(let i=1;i<20;i++)for(let j=1;j<14;j++){const pos=new Cesium.Cartesian2(c.clientWidth*i/20,c.clientHeight*j/14);const p=v.scene.pick(pos);if(!p){o.none++;continue}if(p.tileset&&p.tileset._lcCityLod0){o.lod0++;const d=v.scene.drillPick(pos,8).find(f=>!(f&&f.tileset&&f.tileset._lcCityLod0));if(d&&d.getProperty&&d.getProperty('canonicalId'))o.drillRealWhenLod0++}else if(p.getProperty&&p.getProperty('canonicalId'))o.real++}return o})()`);
  // 実クリック(CDP の実マウスイベント): canonicalId を持つ建物が pick できる画素を探して click → livecity:37d-building-selected が発火するか
  const spot = await ev(`(()=>{const v=window.__v,c=v.scene.canvas;const cand=[];for(let i=1;i<40;i++)for(let j=1;j<28;j++)cand.push([c.clientWidth*i/40,c.clientHeight*j/28]);const cx=c.clientWidth/2,cy=c.clientHeight/2;cand.sort((a,b)=>Math.hypot(a[0]-cx,a[1]-cy)-Math.hypot(b[0]-cx,b[1]-cy));for(const [x,y] of cand){const p=v.scene.pick(new Cesium.Cartesian2(x,y));if(p&&p.getProperty&&p.getProperty('canonicalId')&&!(p.tileset&&p.tileset._lcCityLod0))return {x,y,id:p.getProperty('canonicalId')}}return null})()`);
  result.checks.clickSpot = spot;
  if (spot) { const r = await ev(`(()=>{const c=window.__v.scene.canvas.getBoundingClientRect();return {l:c.left,t:c.top}})()`); for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: spot.x + r.l, y: spot.y + r.t, button: 'left', clickCount: 1 }); await sleep(1500); result.checks.clickEvents = await ev('window.__ev'); result.checks.clickSelectsBuilding = (result.checks.clickEvents || []).includes(spot.id); }
  // warm: 再読込(HTTP キャッシュ有り)での転送量と所要時間
  const b0 = result.bytes || 0, w0 = Date.now(); await load('citylod0=1'); await sleep(4000); result.checks.warmBytes = (result.bytes || 0) - b0; result.checks.warmViewerMs = Date.now() - w0;
  const hp = result.checks.highWithReal;
  result.ok = !!(result.checks.lod0Loaded && hp.lod0Share > 0.02 && result.checks.lowAltLod0Shown === false && result.checks.clickSelectsBuilding);
}
try {
  if (STATIC) await realMode(); else {
  const up = await load('citylod0=1'); result.checks.viewerLoaded = up; 
  if (!up) { result.checks.error = 'Cesium/viewer が起動しません(CDN 到達不能の可能性): ' + JSON.stringify(result.console.slice(0, 3)); throw new Error(result.checks.error); }
  const [lx, lz] = ll(3000, 1500);
  for (let i = 0; i < 12; i++) { await sleep(1500); await fly(lx, lz, 6000); if (Math.abs((await ev('window.__v.camera.positionCartographic.height')) - 6000) < 300) break; }   // アプリ起動時の初期カメラ移動に上書きされるため、目標高度に収まるまで再設定
  for (let i = 0; i < 60 && !(await ev('window.__t && window.__t.tilesLoaded').catch(() => false)); i++) { await ev('window.__v.scene.requestRender()'); await sleep(500); }
  result.checks.perf = await ev('JSON.stringify(window.__mission37g.perf.cityLod0||null)');
  result.checks.lod0Loaded = !!(result.checks.perf && JSON.parse(result.checks.perf).loaded);
  await ev('(async()=>{const v=window.__v;for(const p of v.scene.primitives._primitives||[]) if(p._lcCityLod0) window.__t=p; return !!window.__t})()');
  result.checks.camHeightAtHigh = await ev('Math.round(window.__v.camera.positionCartographic.height)');
  result.checks.tilesetReady = await ev('!!window.__t && window.__t.ready!==false');
  result.checks.tilesLoadedAfter = await ev('window.__t ? window.__t.tilesLoaded : null');
  result.checks.highAlt = await pixelStat();                       // 高度9km: LOD0 が見える
  const [wx, wz] = ll(3000, 1500);
  // 区境(x=3000)を左右に横断: a 側 → 境界 → b 側 で穴がない(各位置で非背景画素 > 0)
  result.checks.cross = [];
  for (const x of [1500, 2800, 3000, 3200, 4500]) { const [x1, z1] = ll(x, 1500); await fly(x1, z1, 3000); await sleep(1500); for (let i = 0; i < 40 && !(await ev('window.__t.tilesLoaded')); i++) { await ev('window.__v.scene.requestRender()'); await sleep(500); } result.checks.cross.push({ x, ...(await pixelStat()), camH: await ev('Math.round(window.__v.camera.positionCartographic.height)') }); }
  // 非クリック: LOD0 の真上で pick
  result.checks.pickOnLod0 = await ev(`(()=>{const v=window.__v;const c=v.scene.canvas;const p=v.scene.pick(new Cesium.Cartesian2(c.clientWidth/2,c.clientHeight/2));const dr=v.scene.drillPick(new Cesium.Cartesian2(c.clientWidth/2,c.clientHeight/2));return p?JSON.stringify({isTileFeature:p instanceof Cesium.Cesium3DTileFeature,primitiveIsLod0:p.primitive===window.__t,tilesetIsLod0:p.tileset===window.__t,id:String(p.id||'').slice(0,40),drill:dr.length}):null})()`);
  await fly(lx, lz, 800); await sleep(2500);
  result.checks.lowAltShown = await ev('window.__t ? window.__t.show : null');   // 近づくと LOD0 は非表示(実LOD1/2へ)
  result.checks.noteText = await ev(`document.getElementById('lc-lod0-note')?.textContent||null`);
  result.checks.pickFallbackInHandler = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8').includes('tileset._lcCityLod0) { try { picked = scene.drillPick');   // 実測: LOD0 は pick に出るため click 側で除外していること
  const lodNetOn = result.network.filter((n) => /_city-lod0/.test(n.url)); result.network.length = 0;
  // flag OFF(既定): citylod0 無し → LOD0 は読み込まれない
  await load(''); await sleep(3000);
  result.checks.defaultOffFetchedLod0 = result.network.filter((n) => /_city-lod0/.test(n.url)).length;
  result.checks.lod0Http = { total: lodNetOn.length, non200: lodNetOn.filter((n) => n.status !== 200).length };
  const ca = result.checks.highAlt, bad = result.checks.cross.filter((c) => !(c.lod0Share > 0.02));
  result.ok = !!(result.checks.lod0Loaded && bad.length === 0 && result.checks.pickFallbackInHandler && result.checks.lowAltShown === false);
  }
} catch (e) { result.error = String(e.message || e); }
ws.close(); ch.kill(); srv.close();
const txt = JSON.stringify(result, null, 1); if (OUT) fs.writeFileSync(OUT, txt); console.log(txt);
process.exit(result.ok ? 0 : (result.checks.viewerLoaded === false ? 2 : 1));
