// Mission 213: 合成 fixture の LOD0 を実ブラウザ(headless Chromium+SwiftShader WebGL)で描画する localhost E2E。
//   ※ 実データではない。合成 fixture での配線・描画・非クリック性の確認専用(実PLATEAU24区の検証とは別物)。
//   使い方: node tools/cloud/e2e-city-lod0.mjs [--chrome /usr/bin/chromium] [--out e2e-report.json]
//   ネットワーク: Cesium 1.121.1 を jsDelivr CDN から読む(HTML 既存仕様)。到達不能なら理由を出して exit 2。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { buildCityLod0 } from './city-lod0.mjs';
import { recordHttp, realFailures } from './http-classify.mjs';
import { planRoute as planRouteImpl, pendingWork, classify, runState, summarize, mergeRows, classifyCellPure, swapStable, comparableDiag, SWAP_SNAP_EXPR } from './sweep-plan.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; }; const has = (k) => a.includes('--' + k);
const CHROME = opt('chrome', '/usr/bin/chromium'), OUT = opt('out', null);
// --static <build出力dir>: 実ビルド出力(build-cloud-preview.mjs --city-lod0 の temp/cloud-preview/static 等)を読み取り専用で配信する実データモード。
//   省略時は合成 fixture。実データと合成は result.fixture で区別する。--lon/--lat で最初の観測地点(既定: 大阪北区)。
const STATIC = opt('static', null);
// --cesium-local <dir>: Cesium 1.121.1 の Build/Cesium を localhost から配信し CDN の代わりに使う(検証環境限定・A/B 用。成果物には含めない)
const CESIUM_LOCAL = opt('cesium-local', null);
// --ward <id>: --lat/--lon 省略時に <static>/ext-3dtiles/<id>/tileset.json の region から区中心を算出(区ごとの座標手入力ミス=選択0の誤診を防ぐ)
{ const w = opt('ward', null); if (w && STATIC && !a.includes('--lat')) { try { const r = JSON.parse(fs.readFileSync(path.join(STATIC, 'ext-3dtiles', w, 'tileset.json'), 'utf8')).root.boundingVolume.region; const d = 180 / Math.PI; a.push('--lon', String(((r[0] + r[2]) / 2 * d).toFixed(5)), '--lat', String(((r[1] + r[3]) / 2 * d).toFixed(5))); } catch (e) { throw new Error('--ward の中心算出失敗: ' + e.message); } } }

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
  if (CESIUM_LOCAL && u.startsWith('/__cesium/')) { f = path.join(path.resolve(CESIUM_LOCAL), u.slice(10)); if (!f.startsWith(path.resolve(CESIUM_LOCAL))) { res.writeHead(403); return res.end(); } return fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'public, max-age=3600' }); res.end(d); }); }
  if (u.startsWith('/ext-3dtiles/')) f = path.join(ext, u.slice(13)); else f = path.join(STATIC ? path.resolve(STATIC) : path.join(ROOT, 'public'), u === '/' ? 'mission37g-osaka-24ward-mvp.html' : u);
  if (!f.startsWith(ext) && !f.startsWith(STATIC ? path.resolve(STATIC) : path.join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => { if (!e && f.endsWith('mission37g-osaka-24ward-mvp.html')) { let t = d.toString('utf8'); const k = 'const scene = viewer.scene;'; if (CESIUM_LOCAL) t = t.split('https://cdn.jsdelivr.net/npm/cesium@1.121.1/Build/Cesium/').join('/__cesium/'); if (!t.includes(k)) { e = new Error('注入点が無い'); } else d = Buffer.from(t.replace(k, k + ' window.__v = viewer;')); } if (e) { res.writeHead(404); return res.end(); } const hd = { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }; if (u.startsWith('/ext-3dtiles/')) hd['cache-control'] = 'public, max-age=3600'; /* vercel.json の headers と同じ。無いと warm でキャッシュが効かず計測が不正になる */ res.writeHead(200, hd); res.end(d); });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;

// ---- chrome + CDP ----
const port2 = 9333 + Math.floor(Math.random() * 500);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1000,700', ...(process.env.E2E_CHROME_ARGS ? process.env.E2E_CHROME_ARGS.split(' ') : []), '--remote-debugging-port=' + port2, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port2}/json`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
if (!targets) throw new Error('chrome のデバッグポートに接続できません');
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const j = JSON.parse(m.data);
  // URL種別ごとの HTTP status 集計(打切りなし。httpErrors は先頭50件で打切られるため別集計)
  if (j.method === 'Network.responseReceived') recordHttp((result.httpStat ||= {}), j.params.response.url, j.params.response.status);
  if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); }
  else if (j.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(j.params.type)) result.console.push(j.params.type + ': ' + j.params.args.map((x) => x.value ?? x.description).join(' ').slice(0, 300));
  else if (j.method === 'Runtime.exceptionThrown') result.console.push('exception: ' + (j.params.exceptionDetails.exception?.description || j.params.exceptionDetails.text).slice(0, 300));
  else if (j.method === 'Network.requestWillBeSent') { const u = j.params.request.url.replace(/^http:\/\/127.0.0.1:\d+/, '').split('?')[0]; (result._reqs ||= []).push(u); (result._reqT ||= []).push([Date.now(), u]); (result._rid ||= {})[j.params.requestId] = u; }
  else if (j.method === 'Network.responseReceived' && j.params.response.status < 400) { const u = j.params.response.url.replace(/^http:\/\/127.0.0.1:\d+/, '').split('?')[0]; (result._sz ||= {})[u] = j.params.response.encodedDataLength || 0; }
  else if (j.method === 'Network.requestServedFromCache') { result._cached = (result._cached || 0) + 1; (result._cachedU ||= []).push((result._rid || {})[j.params.requestId]); }
  else if (j.method === 'Network.loadingFinished') { const u = (result._rid || {})[j.params.requestId]; if (u) (result._fin ||= {})[u] = (result._fin[u] || 0) + (j.params.encodedDataLength || 0); result.bytes = (result.bytes || 0) + (j.params.encodedDataLength || 0); }
  else if (j.method === 'Network.loadingFailed') { (result.netFailed ||= []).length < 50 && result.netFailed.push({ err: j.params.errorText, canceled: !!j.params.canceled }); }
  else if (j.method === 'Network.responseReceived') { if (j.params.response.status >= 400) { const he = (result.httpErrors ||= []); if (he.length < 50) he.push({ url: j.params.response.url.replace(/^http:\/\/127.0.0.1:\d+/, '').slice(0, 120), status: j.params.response.status }); } const u = j.params.response.url; if (/city-lod0|index\.json|Cesium\.js/.test(u)) result.network.push({ url: u.replace(/^http:\/\/127.0.0.1:\d+/, ''), status: j.params.response.status }); } };
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
const pixelStat = () => ev(`(async()=>{const v=window.__v;const grab=()=>{v.scene.render();const c=v.scene.canvas;const t=document.createElement('canvas');t.width=c.width;t.height=c.height;const g=t.getContext('2d');g.drawImage(c,0,0);return g.getImageData(0,0,t.width,t.height).data};const ps=(v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined);const real=ps.filter(p=>!p._lcCityLod0);const sv=window.__t.show;const rv=real.map(p=>p.show);const frac=(A,B)=>{let d=0;for(let i=0;i<A.length;i+=4){if(Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2])>12)d++}return +(d/(A.length/4)).toFixed(4)};window.__t.show=true;const on=grab();window.__t.show=false;const off=grab();real.forEach(p=>p.show=false);const none=grab();window.__t.show=sv;real.forEach((p,i)=>p.show=rv[i]);const w=v.scene.canvas.width,n=on.length/4;let diff=0;const cols=new Array(10).fill(0);for(let i=0;i<on.length;i+=4){const d=Math.abs(on[i]-off[i])+Math.abs(on[i+1]-off[i+1])+Math.abs(on[i+2]-off[i+2]);if(d>12){diff++;cols[Math.min(9,Math.floor(((i/4)%w)/w*10))]++}}return {w,h:v.scene.canvas.height,lod0Share:+(diff/n).toFixed(4),realShare:frac(off,none),cols:cols.map(x=>+(x/(n/10)).toFixed(3))}})()`);
// タイルのロード状況(read-only 診断): 未ロード/保留リクエスト/失敗/選択タイル数
const tileDiag = () => ev(`(()=>{const v=window.__v;const ps=(v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined);const f=window.__tileFail||0;return {tilesets:ps.length,notLoaded:ps.filter(p=>!p.tilesLoaded).length,pending:ps.reduce((s,p)=>s+((p.statistics&&p.statistics.numberOfPendingRequests)||0),0),processing:ps.reduce((s,p)=>s+((p.statistics&&p.statistics.numberOfTilesProcessing)||0),0),failed:f,lod0Selected:window.__t&&window.__t._selectedTiles?window.__t._selectedTiles.length:null,lod0Shown:window.__t?window.__t.show:null}})()`);
const hookFail = () => ev(`(()=>{const v=window.__v;window.__tileFail=window.__tileFail||0;for(const p of (v.scene.primitives._primitives||[])){if(p.tilesLoaded!==undefined&&!p.__fh&&p.tileFailed){p.__fh=1;p.tileFailed.addEventListener(()=>{window.__tileFail++})}}return true})()`);
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

// ---- --sweep: 24区の中心＋隣接区境を最近傍順に巡回し、高度 3000/6000/10000m で LOD0 の寄与と未ロード/穴を区別して記録 ----
//   判定: 「全タイルがロード済み(tilesLoaded)」なのに LOD0 寄与率が閾値未満 = hole(真の欠落候補)。ロード未完は not-loaded として別集計(欠落と混同しない)。
//   画面全域が描かれないこと(海・市域外)は hole としない: 点は区の重心/隣接重心の中点なので市域内。
const planRoute = (extDir) => planRouteImpl(extDir, path.join(ROOT, 'config/wards/registry.json'));
async function sweepMode() {
  const { route, wardsFound } = planRoute(ext); const ALTS = opt('alts', '3000,6000,10000').split(',').map(Number), MIN_SHARE = Number(opt('min-share', 0.02));
  // 再開: --resume <前回 --out JSON> の確定行(ok/hole/covered-by-real)は撮り直さない。--start-point <n> は経路 index の下限。
  let prevRows = []; const RES = opt('resume', null);
  if (RES && fs.existsSync(RES)) { try { prevRows = JSON.parse(fs.readFileSync(RES, 'utf8')).sweep?.rows || []; } catch { prevRows = []; } }
  const work = pendingWork(route, ALTS, { startPoint: Number(opt('start-point', 0)), prevRows });
  const rows = []; result.sweep = { wardsFound, altitudes: ALTS, minShare: MIN_SHARE, rows, resumedFrom: RES && prevRows.length ? prevRows.length : 0, startPoint: Number(opt('start-point', 0)) };
  if (wardsFound < 24) result.error = 'attrs のある区が 24 未満: ' + wardsFound;
  // 再発防止: 全体の壁時計予算(--budget-min, 既定20分)と --max-points(今回撮る点数)。超過したら打ち切り、途中結果を JSON に残す
  const deadline = Date.now() + Number(opt('budget-min', 20)) * 60000, maxPts = Number(opt('max-points', route.length));
  const waitS = Number(opt('load-wait-s', 20)), extraS = Number(opt('load-extra-wait-s', 40));
  result.sweep.budgetMin = Number(opt('budget-min', 20)); result.sweep.routePlanned = route.length; result.sweep.pendingPoints = work.length;
  const flush = () => { if (OUT) try { const all = mergeRows(prevRows, rows); fs.writeFileSync(OUT, JSON.stringify({ ...result, sweep: { ...result.sweep, rows: all, summary: summarize(all) } }, null, 1)); } catch {} };
  let n = 0, last = null;
  outer: for (const { point: p, alts } of work) { if (n++ >= maxPts) { result.sweep.truncated = 'max-points'; result.sweep.nextStartPoint = p.index; break; } last = p.index; for (const h of alts) {
    if (Date.now() > deadline) { result.sweep.truncated = 'budget-min'; result.sweep.nextStartPoint = p.index; break outer; }
    const [lon, lat] = ll(p.x, p.z);
    const held = await holdCam(lon, lat, h); await hookFail();
    const isLoaded = () => ev(`(()=>{const v=window.__v;v.scene.requestRender();const ps=v.scene.primitives._primitives||[];return ps.filter(p=>p.tilesLoaded!==undefined).every(p=>p.tilesLoaded)})()`);
    // not-loaded は「待機不足」か「実エラー」かを区別: 通常待機 → 未収束なら追加待機。追加待機で収束すれば waitedMs に残り、収束しなければ pending/failed/HTTP エラーを記録
    const t0 = Date.now(); let loaded = false, extended = false;
    for (let i = 0; i < waitS * 2; i++) { loaded = await isLoaded(); if (loaded) break; await sleep(500); }
    if (!loaded && Date.now() < deadline) { extended = true; for (let i = 0; i < extraS * 2; i++) { loaded = await isLoaded(); if (loaded) break; await sleep(500); } }
    const waitedMs = Date.now() - t0, httpErr0 = (result.httpErrors || []).length, netFail0 = (result.netFailed || []).length;
    await sleep(800); const ps = await pixelStat(); const diag = await tileDiag(); const camH = await ev('Math.round(window.__v.camera.positionCartographic.height)');
    const status = classify({ held, loaded, lod0Share: ps.lod0Share, realShare: ps.realShare, minShare: MIN_SHARE });
    rows.push({ kind: p.kind, ward: p.ward, index: p.index, alt: h, x: Math.round(p.x), z: Math.round(p.z), lon: +lon.toFixed(5), lat: +lat.toFixed(5), camH, lod0Share: ps.lod0Share, realShare: ps.realShare, loaded, waitedMs, extendedWait: extended, diag, httpErrorsTotal: (result.httpErrors || []).length, netFailedTotal: (result.netFailed || []).length, status }); flush();
  } }
  if (!result.sweep.truncated && last !== null) result.sweep.nextStartPoint = null;
  const all = mergeRows(prevRows, rows); result.sweep.rows = all; result.sweep.summary = summarize(all);
  // 24区完了の判定: 全 (点,高度) が確定済み(ok/covered-by-real)で hole 0、かつ打ち切り無し。
  result.ok = result.sweep.summary.hole === 0 && result.sweep.summary.notLoaded === 0 && result.sweep.summary.cameraNotHeld === 0 && result.sweep.summary.ok > 0 && wardsFound === 24 && !result.sweep.truncated;
  // 機械可読な実行状態。max-points による予定どおりの分割終了(品質 pass)は exit 0。品質不合格・予定外の打切りは exit 1(quality gate は維持)。
  result.sweep.runState = runState({ ...result, sweep: result.sweep }); result.exitOk = result.sweep.runState.exitOk;
  if (OUT) try { fs.writeFileSync(OUT, JSON.stringify(result, null, 1)); } catch {}
}

// ---- --compare: 同一カメラで「置換ON / 置換OFF(citylod0swap=0) / LOD0なし」を近・中・遠で撮り比べる(--static 必須)。 --shots <dir> に PNG、結果は result.compare。
//   スクリーンショットは実データ由来の画素を含むため artifact 公開しないこと(ローカル確認用)。
// ---- --baseline: Phase0 性能ベースライン(cold/warm)。初回可視・LOD0完了時間、リクエスト数、重複/4xx、転送量、フレーム p50/p95 を測る(--static 必須) ----
// 第6段階: 段階別タイミング用プローブ。定義: tFirstRealPixel=実タイル(非LOD0)を隠したフレームとの差が画素に出た最初の時刻(選択数>0だけでは描画を意味しない)。
// tClickable=画面格子のpickで実建物(canonicalId, 非LOD0)が最初に取れた時刻。ロード成功/空画面の偽陽性を避けるため画素差とpickの両方で確認する。
const realPixelProbe = () => ev(`(()=>{const v=window.__v;const grab=()=>{v.scene.render();const c=v.scene.canvas;const t=document.createElement('canvas');t.width=c.width>>1;t.height=c.height>>1;const g=t.getContext('2d');g.drawImage(c,0,0,t.width,t.height);return g.getImageData(0,0,t.width,t.height).data};const real=(v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined&&!p._lcCityLod0);const sv=real.map(p=>p.show);const A=grab();real.forEach(p=>p.show=false);const B=grab();real.forEach((p,i)=>p.show=sv[i]);v.scene.render();let d=0;for(let i=0;i<A.length;i+=4)if(Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2])>24)d++;return d/(A.length/4)})()`).catch(() => null);
const clickSpotProbe = () => ev(`(()=>{const v=window.__v,c=v.scene.canvas;const cx=c.clientWidth/2,cy=c.clientHeight/2;const cand=[];for(let i=1;i<20;i++)for(let j=1;j<14;j++)cand.push([c.clientWidth*i/20,c.clientHeight*j/14]);cand.sort((a,b)=>Math.hypot(a[0]-cx,a[1]-cy)-Math.hypot(b[0]-cx,b[1]-cy));for(const [x,y] of cand){const p=v.scene.pick(new Cesium.Cartesian2(x,y));if(p&&p.getProperty&&p.getProperty('canonicalId')&&!(p.tileset&&p.tileset._lcCityLod0))return {x,y,id:p.getProperty('canonicalId')}}return null})()`).catch(() => null);
async function baselineMode() {
  const lat0 = Number(opt('lat', 34.7055)), lon0 = Number(opt('lon', 135.51)), qs = opt('qs', 'citylod0=1&citylod0min=2500');
  result.baseline = [];
  for (const phase of ['cold', 'warm']) {
    result._reqs = []; result.httpErrors = []; const b0 = result.bytes || 0; let t0 = Date.now();
    result._fin = {}; result._cached = 0; result._cachedU = [];
    if (phase === 'cold') await send('Network.clearBrowserCache');
    // 旧ページの window.__v 残留で待機判定が即成立するのを防ぐ: about:blank へ遷移し __v 不在を確認してから計測を始める
    await send('Page.navigate', { url: 'about:blank' }); await sleep(500);
    result._reqs = []; result._reqT = []; result.httpErrors = [];
    t0 = Date.now(); await send('Page.navigate', { url: `http://127.0.0.1:${port}/mission37g-osaka-24ward-mvp.html?${qs}` });
    let tViewer = null, tLod0 = null, tAllLoaded = null, tFirstReal = null, tFirstRealPixel = null, tClickable = null, realPixelShare = null, clickSpot = null, clickToCardMs = null, escCloseOk = null, clickInPage = null;
    // 修正: 旧版は固定視点を持たず(起動時 flyTo でカメラが動く)、実タイルが1枚も選択されない時点の tilesLoaded=true を「全完了」と誤判定して
    // cold が早期終了していた(cold 4.4MB/8s vs warm 19.6MB/21s の不整合)。ここでは flyTo を無効化し起動直後から固定視点(--h 既定3000m -60°)に保持、
    // 「全 tileset tilesLoaded かつ 実タイル(非LOD0)の選択数>0」が 6 回連続(約1.5s)で成立した時刻を完了とする。
    const bh = Number(opt('h', 3000)), bp = Number(opt('pitch', -60));
    let ok6 = 0, locked = false;
    for (let i = 0; i < 600; i++) {
      const st = await ev(`(()=>{const v=window.__v;if(!v)return null;if(!window.__lcBase){window.__lcBase=1;const c=v.camera;for(const k of ['flyToBoundingSphere','flyTo','flyHome']){c[k]=function(){}}}v.camera.cancelFlight();v.camera.setView({destination:Cesium.Cartesian3.fromDegrees(${lon0},${lat0},${bh}),orientation:{heading:0,pitch:Cesium.Math.toRadians(${bp}),roll:0}});v.scene.requestRender();const ps=(v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined);const l0=ps.find(p=>p._lcCityLod0);const real=ps.filter(p=>!p._lcCityLod0);const rsel=real.reduce((s,p)=>s+((p._selectedTiles&&p._selectedTiles.length)||0),0);return {n:ps.length,l0:!!(l0&&l0.tilesLoaded),all:ps.length>0&&ps.every(p=>p.tilesLoaded),rsel}})()`).catch(() => null);
      if (st) { await hookFail().catch(() => {}); locked = true; tViewer ??= Date.now() - t0; if (st.l0) tLod0 ??= Date.now() - t0; if (st.rsel > 0) tFirstReal ??= Date.now() - t0; if (st.rsel > 0 && tFirstRealPixel == null) { const sh = await realPixelProbe(); if (sh != null && sh > 0.002) { tFirstRealPixel = Date.now() - t0; realPixelShare = sh; } } if (tFirstRealPixel != null && tClickable == null) { const sp = await clickSpotProbe(); if (sp) { tClickable = Date.now() - t0; clickSpot = sp; } } ok6 = (st.all && st.n >= 2 && st.rsel > 0) ? ok6 + 1 : 0; if (ok6 >= 6) { tAllLoaded = Date.now() - t0 - 1250; break; } }
      await sleep(250);
    }
    result.baselineView = { h: bh, pitch: bp, lon: lon0, lat: lat0 };
    // 診断: t0 からの最初の20リクエストの経過ms(warm 起動遅延の切り分け用)と、最大の無通信ギャップ
    const rt = (result._reqT || []).map(([t, u]) => [t - t0, u.slice(0, 70)]); let gap = { ms: 0, at: 0 }; for (let k = 1; k < rt.length; k++) if (rt[k][0] - rt[k - 1][0] > gap.ms) gap = { ms: rt[k][0] - rt[k - 1][0], at: rt[k - 1][0], next: rt[k][1] };
    const reqs = result._reqs, cnt = {}; for (const u of reqs) cnt[u] = (cnt[u] || 0) + 1;
    const dups = Object.entries(cnt).filter(([, c]) => c > 1).map(([u, c]) => ({ u: u.slice(0, 90), c })).slice(0, 15);
    const byKind = {}; for (const u of reqs) { const k = u.includes('_city-lod0') ? 'lod0' : /\.(glb|b3dm|i3dm)$/.test(u) ? 'tile-content' : /tileset\.json$/.test(u) ? 'tileset.json' : /\.json$/.test(u) ? 'json' : 'other'; byKind[k] = (byKind[k] || 0) + 1; }
    const lod0Bytes = Object.entries(result._fin || {}).filter(([u]) => u.includes('_city-lod0')).reduce((s, [, b]) => s + b, 0);
    await sleep(500);
    const frame = await ev(`(async()=>{const v=window.__v;const t=[];for(let i=0;i<5;i++)v.scene.render();for(let i=0;i<60;i++){const a=performance.now();v.scene.render();t.push(performance.now()-a)}t.sort((x,y)=>x-y);return {p50:+t[30].toFixed(1),p95:+t[57].toFixed(1)}})()`);
    const tileFail = await ev('window.__tileFail||0').catch(() => null);
    // クリック実入力→情報カード(#lc-bldg-body.on)表示までの反応時間(CDP実マウス。建物IDは結果に出さない)
    if (clickSpot) { const r = await ev(`(()=>{const c=window.__v.scene.canvas.getBoundingClientRect();return {l:c.left,t:c.top}})()`); await ev(`(()=>{window.__ck={lt:[]};try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__ck.lt.push(Math.round(e.duration))}).observe({entryTypes:['longtask']})}catch(e){}const c=window.__v.scene.canvas;{const a=performance.now();window.__v.scene.pick(new Cesium.Cartesian2(${clickSpot.x},${clickSpot.y}));window.__ck.pickMs=Math.round(performance.now()-a)}c.addEventListener('pointerdown',()=>{window.__ck.down=performance.now()},{once:true,capture:true});window.addEventListener('livecity:37d-building-selected',()=>{window.__ck.sel??=performance.now()},{once:true});const b=document.getElementById('lc-bldg-body');if(b)new MutationObserver(()=>{if(b.classList.contains('on'))window.__ck.card??=performance.now()}).observe(b,{attributes:true,attributeFilter:['class']});return 1})()`); const tc = Date.now(); for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: clickSpot.x + r.l, y: clickSpot.y + r.t, button: 'left', clickCount: 1 }); for (let k = 0; k < 100; k++) { if (await ev(`!!document.getElementById('lc-bldg-body')?.classList.contains('on')`)) { clickToCardMs = Date.now() - tc; break; } await sleep(30); } clickInPage = await ev(`(()=>{const k=window.__ck||{};return {pickMs:k.pickMs,longTasks:(k.lt||[]).length,longTaskMaxMs:Math.max(0,...(k.lt||[])),longTaskTotalMs:(k.lt||[]).reduce((a,b)=>a+b,0),downToSelMs:k.sel&&k.down?Math.round(k.sel-k.down):null,downToCardMs:k.card&&k.down?Math.round(k.card-k.down):null}})()`).catch(() => null); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(500); escCloseOk = await ev(`!document.getElementById('lc-bldg-body')?.classList.contains('on')`); }
    const hs = result.httpStat || {};
    const mem = await ev(`performance.memory?{usedMB:Math.round(performance.memory.usedJSHeapSize/1048576)}:null`);
    result.baseline.push({ phase, reqHead: rt.slice(0, 12), maxGap: gap, tViewerMs: tViewer, tFirstRealMs: tFirstReal, tFirstRealPixelMs: tFirstRealPixel, realPixelShare, tClickableMs: tClickable, clickToCardMs, clickInPage, escCloseOk, httpStatSoFar: hs, tLod0LoadedMs: tLod0, tAllTilesLoadedMs: tAllLoaded, requests: reqs.length, byKind, bytes: (result.bytes || 0) - b0, lod0Bytes, lod0Glb: reqs.filter((u) => u.includes('_city-lod0') && u.endsWith('.glb')).length, fromCache: result._cached, lod0FromCache: (result._cachedU || []).filter((u) => u && u.includes('_city-lod0')).length, duplicates: dups, http4xx: result.httpErrors.length, http4xxSample: result.httpErrors.slice(0, 8), frame, mem, tileFail, cesiumLocal: !!CESIUM_LOCAL });
  }
  delete result._reqs; delete result._sz; result.ok = result.baseline.every((b) => b.tAllTilesLoadedMs != null);
}

// ---- --profile: Mission216 第6段階B。CDP Profiler + longtask でロード中のメインスレッド占有を関数単位で特定する(--static 必須)。
//   条件A(既定): 計測介入なし。ロード中は軽量eval(選択数の読み取りのみ。render/pick/画素差/格子pick なし)を 500ms 周期で呼ぶだけ。
//   条件B(--probe): 既存 --baseline と同じ介入(画素差プローブ=scene.render×2+canvas読出し)を実タイル選択後に毎周期実行。A/B の差が「計測が作る遅延」。
//   プロファイルは JS 関数名/URL/行のみ出力(建物ID・画像・GLB は出さない)。
async function profileMode() {
  const lat0 = Number(opt('lat', 34.7055)), lon0 = Number(opt('lon', 135.51)), qs = opt('qs', 'citylod0=1&citylod0min=2500'), probe = has('probe');
  const bh = Number(opt('h', 3000)), bp = Number(opt('pitch', -60)), maxMs = Number(opt('profile-max-ms', 70000));
  await send('Page.enable'); await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 1000 });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__lt=[];${has('labels-off') ? "let C;Object.defineProperty(window,'Cesium',{configurable:true,get(){return C},set(v){C=v;try{const u=v.LabelCollection.prototype.update;v.LabelCollection.prototype.update=function(f){if(!this.__keep)return;return u.call(this,f)}}catch(e){}}});" : ''}try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push([Math.round(e.startTime),Math.round(e.duration)])}).observe({entryTypes:['longtask']})}catch(e){}` });
  const profiles = [];
  result.profile = { cond: (probe ? 'B-probe' : 'A-passive') + (has('labels-off') ? '+labels-off(診断用: 全LabelCollection.show=false)' : ''), runs: [] };
  for (const phase of ['cold', 'cold2']) {   // 毎回 HTTP キャッシュ消去(cold 2回)
    result._reqs = []; result._reqT = []; result.httpErrors = []; const b0 = result.bytes || 0;
    await send('Network.clearBrowserCache'); await send('Page.navigate', { url: 'about:blank' }); await sleep(500);
    result._reqT = []; result._reqs = [];
    await send('Profiler.start'); const t0 = Date.now();
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/mission37g-osaka-24ward-mvp.html?${qs}` });
    let tViewer = null, tFirstReal = null, tFirstPix = null, tStable = null, ok = 0, pollMs = [];
    while (Date.now() - t0 < maxMs) {
      const q0 = Date.now();
      const st = await ev(`(()=>{const v=window.__v;if(!v)return null;if(!window.__lcP){window.__lcP=1;const c=v.camera;for(const k of ['flyToBoundingSphere','flyTo','flyHome'])c[k]=function(){};c.cancelFlight();c.setView({destination:Cesium.Cartesian3.fromDegrees(${lon0},${lat0},${bh}),orientation:{heading:0,pitch:Cesium.Math.toRadians(${bp}),roll:0}})}let rsel=0,all=true,n=0;window.__lbl=window.__lbl||{};for(const p of (v.scene.primitives._primitives||[])){if(p._labels!==undefined){${has('labels-off') ? 'p.show=false;' : ''}window.__lbl.n=Math.max(window.__lbl.n||0,(v.scene.primitives._primitives||[]).filter(q=>q._labels!==undefined).reduce((a,q)=>a+q._labels.length,0));window.__lbl.colls=(v.scene.primitives._primitives||[]).filter(q=>q._labels!==undefined).length}if(p.tilesLoaded===undefined)continue;n++;if(!p.tilesLoaded)all=false;if(!p._lcCityLod0)rsel+=(p._selectedTiles||[]).length}return{rsel,all,n}})()`).catch(() => null);
      pollMs.push(Date.now() - q0);
      if (st) {
        tViewer ??= Date.now() - t0;
        if (st.rsel > 0) tFirstReal ??= Date.now() - t0;
        if (probe && st.rsel > 0 && tFirstPix == null) { const sh = await realPixelProbe().catch(() => null); if (sh != null && sh > 0.002) tFirstPix = Date.now() - t0; }
        if (st.rsel > 0 && st.all) { if (++ok >= 3 && tStable == null) { tStable = Date.now() - t0; break; } } else ok = 0;
      }
      await sleep(500);
    }
    if (has('settle')) for (let k = 0; k < 40; k++) { await ev('window.__v.scene.requestRender()').catch(() => {}); await sleep(500); }   // 安定後 20秒待ち、遅延ラベルの全解放を確認
    let pickProf = null;
    if (has('pick') && tStable != null) {   // 安定後の最初の scene.pick(中央1点)単体をプロファイル: pick 外れ値(約21秒)が shader compile 等かを関数単位で特定
      await send('Profiler.stop'); await send('Profiler.start');
      const pm = await ev(`(()=>{const v=window.__v,c=v.scene.canvas;const a=performance.now();v.scene.pick(new Cesium.Cartesian2(c.clientWidth/2,c.clientHeight/2));const b=performance.now();v.scene.pick(new Cesium.Cartesian2(c.clientWidth/2+3,c.clientHeight/2));return {firstPickMs:Math.round(b-a),secondPickMs:Math.round(performance.now()-b)}})()`);
      const pp = (await send('Profiler.stop')).result.profile; const nm = new Map(pp.nodes.map((n) => [n.id, n])); const mm = new Map(); for (let i = 0; i < pp.samples.length; i++) { const cf = nm.get(pp.samples[i]).callFrame; const k = `${cf.functionName || '(anon)'} ${(cf.url || '').slice(-40)}:${cf.lineNumber + 1}`; mm.set(k, (mm.get(k) || 0) + (pp.timeDeltas[i + 1] ?? pp.timeDeltas[i]) / 1000); }
      pickProf = { ...pm, top: [...mm].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => [k, Math.round(v)]) };
      await send('Profiler.start');
    }
    const { profile } = (await send('Profiler.stop')).result;
    const lt = await ev('window.__lt||[]').catch(() => []);
    // 集計: サンプルごとの経過時刻(ms, プロファイル開始起点)
    const nodes = new Map(profile.nodes.map((n) => [n.id, n])); const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id); const appOf = (id) => { for (let x = id; x != null; x = parent.get(x)) { const cf = nodes.get(x).callFrame; if (cf.url && !/cesium/i.test(cf.url) && !['(root)', '(program)', '(idle)'].includes(cf.functionName)) return `${cf.functionName || '(anon)'}:${cf.lineNumber + 1}`; } return '(no-app-frame)'; }; const t = []; let acc = 0; for (const d of profile.timeDeltas) { acc += d; t.push(acc / 1000); }
    const agg = (from, to) => { const m = new Map(), am = new Map(); let busy = 0, idle = 0, total = 0; for (let i = 0; i < profile.samples.length; i++) { if (t[i] < from || t[i] >= to) continue; const d = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i]) / 1000; const cf = nodes.get(profile.samples[i]).callFrame; total += d; if (['(idle)', '(program)'].includes(cf.functionName)) { idle += d; continue; } busy += d; { const ak = appOf(profile.samples[i]); am.set(ak, (am.get(ak) || 0) + d); } const k = `${cf.functionName || '(anon)'} ${(cf.url || '').replace(/^https?:\/\/[^/]+/, '').slice(-60)}:${cf.lineNumber + 1}`; m.set(k, (m.get(k) || 0) + d); } return { totalMs: Math.round(total), busyMs: Math.round(busy), idleMs: Math.round(idle), byAppFrame: [...am].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => [k, Math.round(v)]), top: [...m].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => [k, Math.round(v)]) }; };
    const w1 = tViewer ?? 0, w2 = tFirstReal ?? (Date.now() - t0);
    const buckets = []; for (let b = 0; b < (tStable ?? maxMs); b += 2000) { const g = agg(b, b + 2000); buckets.push({ fromS: b / 1000, busyPct: g.totalMs ? Math.round(100 * g.busyMs / g.totalMs) : null, top: g.top[0] || null }); }
    const gaps = []; const rt = (result._reqT || []).map(([tt, u]) => [tt - t0, u.slice(0, 60)]); for (let k = 1; k < rt.length; k++) if (rt[k][0] - rt[k - 1][0] > 2000) gaps.push({ fromMs: rt[k - 1][0], ms: rt[k][0] - rt[k - 1][0], next: rt[k][1] });
    const ltSorted = [...lt].sort((x, y) => y[1] - x[1]); const tileFail = await ev('window.__tileFail||0').catch(() => null);
    const bytes = (result.bytes || 0) - b0; const sorted = [...pollMs].sort((x, y) => x - y);
    result.profile.runs.push({ phase, tViewerMs: tViewer, tFirstRealMs: tFirstReal, tFirstRealPixelMs: tFirstPix, tStableMs: tStable, bytes, requests: (result._reqs || []).length, idleNetworkGaps: gaps, viewerToFirstRealWindow: { fromMs: w1, toMs: w2, ...agg(w1, w2) }, buckets2s: buckets, longtasks: { count: lt.length, over1s: lt.filter((x) => x[1] > 1000).length, top: ltSorted.slice(0, 8), sumMs: lt.reduce((s, x) => s + x[1], 0) }, evalPollMs: { n: pollMs.length, p50: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] }, tileFail, pickProf, labels: await ev('window.__lbl||null').catch(() => null), lblGate: await ev('JSON.stringify(window.__lblGate?{open:window.__lblGate.open,pending:window.__lblGate.pending.length,released:window.__lblGate.released,triggerMs:window.__lblGate.triggerMs,reason:window.__lblGate.reason,doneMs:window.__lblGate.doneMs}:null)').then(JSON.parse).catch(() => null), httpNon2xxReal: realFailures(result.httpStat || {}) });
  }
  delete result._reqs; delete result._sz; result.ok = result.profile.runs.every((r) => r.tStableMs != null);
}
// 置換状態が安定するまで(hidden/visible/total/swapEnabled が3回連続同一かつ全 tileset tilesLoaded)待ち、スナップショット列と待機時間を返す。
async function awaitSwapStable(maxMs = 30000) {
  const t0 = Date.now(), samples = [];
  while (Date.now() - t0 < maxMs) { await ev('window.__v.scene.requestRender()').catch(() => {}); await sleep(700); const s = await ev(SWAP_SNAP_EXPR).catch(() => null); if (s) { samples.push(s); if (swapStable(samples)) break; } }
  const last = samples[samples.length - 1] || null;
  return { stable: swapStable(samples), waitMs: Date.now() - t0, nSamples: samples.length, snap: last, httpNon2xx: (result.httpErrors || []).length };
}
async function compareMode() {
  const lat0 = Number(opt('lat', 34.7055)), lon0 = Number(opt('lon', 135.51)), shots = opt('shots', null);
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const VIEWS_ALL = [{ n: 'far', h: 10000, pitch: -90 }, { n: 'far15k', h: 15000, pitch: -90 }, { n: 'far20k', h: 20000, pitch: -90 }, { n: 'mid', h: 3000, pitch: -50 }, { n: 'mid4k', h: 4000, pitch: -60 }, { n: 'mid6k', h: 6000, pitch: -45 }, { n: 'near', h: 1200, pitch: -35 }, { n: 'mid3kb', h: 3000, pitch: -30, aim: true }, { n: 'mid6kb', h: 6000, pitch: -30, aim: true }];
  const pick = (all, key) => { const f = opt(key, ''); return f ? all.filter((x) => f.split(',').includes(x.n)) : all; };   // --views far,mid4k / --variants swapOn,lod0Off で絞り込み(前景10分上限対策)
  const VIEWS = pick(VIEWS_ALL, 'views');
  const VARIANTS = [{ n: 'swapOn', qs: 'citylod0=1&citylod0min=2500' }, { n: 'swapOff', qs: 'citylod0=1&citylod0min=2500&citylod0swap=0' }, { n: 'lod0Off', qs: '' }, { n: 'dseOn', qs: 'citylod0=1&citylod0min=2500&dse=1' }];
  result.compare = [];
  for (const v of pick(VARIANTS, 'variants')) {
    const b0 = result.bytes || 0, t0 = Date.now();
    const up = await load(v.qs); if (!up) { result.compare.push({ variant: v.n, error: 'viewer 起動不可' }); continue; }
    await hookFail();
    for (const w of VIEWS) {
      const camLat = w.aim ? lat0 - (w.h / Math.tan(-w.pitch * D2R)) / 111320 : lat0;   // aim: 視線の着地点が (lon0,lat0) になるようカメラを南へ退避(斜め視で空白域を見ないため)
      const held = await holdCam(lon0, camLat, w.h, w.pitch); await hookFail();
      let loaded = false; for (let i = 0; i < 120; i++) { await ev('window.__v.scene.requestRender()'); loaded = await ev(`(()=>{const ps=(window.__v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined);return ps.length>0&&ps.every(p=>p.tilesLoaded)})()`); if (loaded) break; await sleep(500); }
      await sleep(2500);
      // 起動後のカメラ移動で要求高度が上書きされる(10000→30225m)ため、撮影直前に再固定し、最終高度が要求±10%のときだけ held とする
      const held2 = await holdCam(lon0, camLat, w.h, w.pitch); await hookFail();
      for (let i = 0; i < 40; i++) { await ev('window.__v.scene.requestRender()'); if (await ev(`(()=>{const ps=(window.__v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined);return ps.length>0&&ps.every(p=>p.tilesLoaded)})()`)) break; await sleep(500); }
      await ev('window.__v.scene.requestRender()'); await sleep(800);
      const swap = await ev(`JSON.stringify((window.__mission37g&&window.__mission37g.perf&&window.__mission37g.perf.cityLod0Swap)||null)`);
      const l0 = await ev(`JSON.stringify((window.__mission37g&&window.__mission37g.perf&&window.__mission37g.perf.cityLod0)||null)`);
      const camH = await ev('Math.round(window.__v.camera.positionCartographic.height)');
      await ev(`(()=>{window.__t=null;for(const p of (window.__v.scene.primitives._primitives||[])) if(p._lcCityLod0) window.__t=p; return !!window.__t})()`);
      const l0Show = await ev('window.__t ? window.__t.show : null');
      const swapPre = v.n === 'lod0Off' ? null : await awaitSwapStable();   // 診断前の置換状態(安定待機つき)。--lod --cells と比較可能かの判定に使う
      const ps = (v.n === 'lod0Off' || l0Show !== true) ? null : await pixelStat();   // LOD0 が実際に表示されている高度のときだけ画素寄与を測る

      // UI パネルによる遮蔽を除去(スクリーンショット用。DOM のみ非表示、データ・描画は不変)
      await ev(`(()=>{for(const e of document.querySelectorAll('body > *:not(#cesiumContainer):not(script):not(style)')){if(!e.contains(window.__v.container)&&e.id!=='lc-lod0-note')e.style.visibility='hidden'}return 1})()`);
      // 残存(表示中)LOD0セルの分類: 中心が「ロード済み実タイルの境界球」内か否か。球内=実タイルはあるが未選択(粗い/遠景)、球外=実建物が存在しない範囲(妥当なfallback)
      // 画素レベル分類: 表示中セルの中心の周囲(9x9px)で「LOD0なし・実建物のみ」フレームが「全タイル非表示」フレームと異なるか。異なる=実建物が下にある(二重描画の疑い)、同じ=実建物なし(妥当なfallback or 未選択)。画面座標は匿名の 4x4 ビン件数のみ。
      const pix = (v.n === 'lod0Off' || l0Show !== true) ? null : await ev(`(()=>{const v=window.__v,T=window.__t;if(!T||!T._lcCells)return null;const grab=()=>{v.scene.render();const c=v.scene.canvas;const t=document.createElement('canvas');t.width=c.width;t.height=c.height;const g=t.getContext('2d');g.drawImage(c,0,0);return g.getImageData(0,0,t.width,t.height).data};const real=(v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined&&!p._lcCityLod0);const sv=T.show,rv=real.map(p=>p.show);const H0=new Map();for(const arr of T._lcCells.values())for(const c of arr)H0.set(c,c.f.show);T.show=false;const A=grab();real.forEach(p=>p.show=false);const B=grab();T.show=sv;real.forEach((p,i)=>p.show=rv[i]);v.scene.render();const W=v.scene.canvas.width,H=v.scene.canvas.height,k=W/v.scene.canvas.clientWidth;const o={shown:0,offscreen:0,realUnder:0,noRealUnder:0,realUnder3x3:0,bins:{realUnder:Array(16).fill(0),noRealUnder:Array(16).fill(0)}};for(const arr of T._lcCells.values())for(const c of arr){if(!H0.get(c))continue;o.shown++;const w=Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,c.p);if(!w){o.offscreen++;continue}const x=Math.round(w.x*k),y=Math.round(w.y*k);if(x<4||y<4||x>=W-4||y>=H-4){o.offscreen++;continue}let d=0,d1=0;for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const i=((y+dy)*W+(x+dx))*4;if(Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2])>12){d=1;if(Math.abs(dx)<=1&&Math.abs(dy)<=1)d1=1}}if(d1)o.realUnder3x3++;const bin=Math.min(3,Math.floor(x/W*4))+4*Math.min(3,Math.floor(y/H*4));if(d){o.realUnder++;o.bins.realUnder[bin]++}else{o.noRealUnder++;o.bins.noRealUnder[bin]++}}return o})()`);
      // 残存セル詳細診断(--resid-detail): 各表示中セルについて、(a)3x3で実建物画素があるか(realUnder)、(b)LOD0を載せたフレームが「LOD0非表示」フレームと3x3で異なるか(lod0Front=LOD0が実際に前面で見えている)、
      // (c)選択中(_selectedTiles)の実タイル境界球までの最短距離-半径(distOut<=0なら球内=置換漏れではなく別要因)、を記録。realUnder かつ !lod0Front は深度で実建物が手前=二重表示ではない。
      const swapAtDetailRaw = v.n === 'lod0Off' ? null : await ev(SWAP_SNAP_EXPR).catch(() => null);   // pix 直後・待機なし(pix が置換を崩すかの観測)
      const swapAtDetail = v.n === 'lod0Off' ? null : (await awaitSwapStable(15000)).snap;   // 再安定後。rdetail はこの状態で実行する   // 画素診断(pix)の直後の状態: pix が置換状態を壊していないかを見る
      const rdetail = (!has('resid-detail') || v.n === 'lod0Off' || l0Show !== true) ? null : await ev(`(()=>{const v=window.__v,T=window.__t;if(!T||!T._lcCells)return null;const grab=()=>{v.scene.render();const c=v.scene.canvas;const t=document.createElement('canvas');t.width=c.width;t.height=c.height;const g=t.getContext('2d');g.drawImage(c,0,0);return g.getImageData(0,0,t.width,t.height).data};const real=(v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined&&!p._lcCityLod0);const sv=T.show,rv=real.map(p=>p.show);const H0=new Map();for(const arr of T._lcCells.values())for(const c of arr)H0.set(c,c.f.show);const ON=grab();T.show=false;const A=grab();real.forEach(p=>p.show=false);const B=grab();T.show=sv;real.forEach((p,i)=>p.show=rv[i]);v.scene.render();const W=v.scene.canvas.width,H=v.scene.canvas.height,k=W/v.scene.canvas.clientWidth;const sel=[];for(const ts of real)for(const t of (ts._selectedTiles||[])){if(t.content&&t.boundingSphere)sel.push({c:t.boundingSphere.center,r:t.boundingSphere.radius,ge:t.geometricError,leaf:!t.children||t.children.length===0})}const df=(X,Y,i)=>Math.abs(X[i]-Y[i])+Math.abs(X[i+1]-Y[i+1])+Math.abs(X[i+2]-Y[i+2])>12;const o={hidden:0,shown:0,offscreen:0,realUnder:0,lod0Front:0,realUnderLod0Front:0,realUnderOccluded:0,noRealLod0Front:0,inSelSphere:0,inSelSphereRealUnderFront:0,inLeafSphere:0,shownIds:[],samples:[]};for(const [tile,arr] of T._lcCells.entries())for(const c of arr){if(!H0.get(c)){o.hidden++;continue}o.shown++;o.shownIds.push(String(c.f.getProperty('canonicalId')));const w=Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,c.p);if(!w){o.offscreen++;continue}const x=Math.round(w.x*k),y=Math.round(w.y*k);if(x<2||y<2||x>=W-2||y>=H-2){o.offscreen++;continue}let ru=0,fr=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const i=((y+dy)*W+(x+dx))*4;if(df(A,B,i))ru=1;if(df(ON,A,i))fr=1}let best=1e12,bestS=null,inSel=false,inLeaf=false;for(const s of sel){const d=Cesium.Cartesian3.distance(c.p,s.c)-s.r;if(d<best){best=d;bestS=s}if(d<=0){inSel=true;if(s.leaf)inLeaf=true}}if(ru)o.realUnder++;if(fr)o.lod0Front++;if(ru&&fr)o.realUnderLod0Front++;if(ru&&!fr)o.realUnderOccluded++;if(!ru&&fr)o.noRealLod0Front++;if(inSel)o.inSelSphere++;if(inLeaf)o.inLeafSphere++;if(inSel&&ru&&fr)o.inSelSphereRealUnderFront++;if(o.samples.length<12&&ru)o.samples.push({id:c.f.getProperty('canonicalId'),sx:Math.round(w.x),sy:Math.round(w.y),realUnder3:!!ru,lod0Front:!!fr,distOutOfNearestSelSphere:Math.round(best),nearestR:bestS&&Math.round(bestS.r),nearestGe:bestS&&bestS.ge,nearestLeaf:bestS&&bestS.leaf})}o.selTiles=sel.length;o.selLeaf=sel.filter(s=>s.leaf).length;return o})()`);
      const resid = (v.n === 'lod0Off' || l0Show !== true) ? null : await ev(`(()=>{const T=window.__t;if(!T||!T._lcCells)return null;const real=(window.__v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined&&!p._lcCityLod0);const sph=[];for(const ts of real){const st=[ts.root];while(st.length){const t=st.pop();if(!t)continue;if(t.contentReady&&t.boundingSphere&&t.boundingSphere.radius<4000&&((!t.children||t.children.length===0)||t.geometricError<=8))sph.push({s:t.boundingSphere,sel:t._selectedFrame===window.__v.scene.frameState.frameNumber-0||false});if(t.children)for(const c of t.children)st.push(c)}}const o={shown:0,hidden:0,shownInLoadedRealSphere:0,shownNoRealTile:0,realLoadedTiles:sph.length};for(const arr of T._lcCells.values())for(const c of arr){if(!c.f.show){o.hidden++;continue}o.shown++;let hit=false;for(const x of sph){if(Cesium.Cartesian3.distance(c.p,x.s.center)<=x.s.radius){hit=true;break}}if(hit)o.shownInLoadedRealSphere++;else o.shownNoRealTile++}return o})()`);
      const frame = await ev(`(async()=>{const v=window.__v;const t=[];for(let i=0;i<5;i++)v.scene.render();for(let i=0;i<90;i++){const a=performance.now();v.scene.render();t.push(performance.now()-a)}t.sort((x,y)=>x-y);return {p50:+t[45].toFixed(1),p95:+t[85].toFixed(1),max:+t[89].toFixed(1)}})()`);
      let png = null; if (shots) { const r = await send('Page.captureScreenshot', { format: 'png' }); png = path.join(shots, `${v.n}-${w.n}.png`); fs.writeFileSync(png, Buffer.from(r.result.data, 'base64')); }
      if (swapPre && rdetail) swapPre.rdetailHiddenMatchesPre = rdetail.hidden === swapPre.snap.hidden;
      result.compare.push({ variant: v.n, view: w.n, swapState: { pre: swapPre, atDetailRaw: swapAtDetailRaw, atDetail: swapAtDetail, rawVsPre: swapPre && swapAtDetailRaw ? comparableDiag(swapPre.snap, swapAtDetailRaw) : null, rdetailHiddenMatchesPre: swapPre ? swapPre.rdetailHiddenMatchesPre : null, preVsDetail: swapPre && swapAtDetail ? comparableDiag(swapPre.snap, swapAtDetail) : null }, rdetail, h: w.h, camH, held: held && held2 && Math.abs(camH - w.h) < w.h * 0.1, loaded, lod0Show: l0Show, swap: JSON.parse(swap), swapDbg: await ev('JSON.stringify(window.__mission37g.perf.cityLod0SwapDbg||null)').then(JSON.parse), lod0: JSON.parse(l0), resid, pix, lod0Share: ps && ps.lod0Share, realShare: ps && ps.realShare, renderMs: frame, png });
    }
    result.compare.push({ variant: v.n, summary: true, ms: Date.now() - t0, bytes: (result.bytes || 0) - b0, tileFail: await ev('window.__tileFail||0') });
  }
  result.ok = result.compare.filter((c) => c.view).every((c) => c.held && c.loaded);
}

// ---- --lod: 親→葉 LOD 切替の独立E2E(--static 必須)。遠景→近景で実タイルの選択数/geometricError/葉数の変化、tileFail、クリックを測る。 --shots <dir> で PNG(公開禁止) ----
async function lodMode() {
  const lat0 = Number(opt('lat', 34.7055)), lon0 = Number(opt('lon', 135.51)), shots = opt('shots', null);
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const up = await load(opt('qs', 'citylod0=1&citylod0min=2500')); result.checks.viewerLoaded = up; if (!up) throw new Error('viewer 起動せず');
  result.checks.allDiag = await ev(`(()=>{const m=document.getElementById('sel-bldg-mode');const o=m&&m.querySelector('option[value="all"]');const s=window.__mission37g||{};return JSON.stringify({modeValue:m&&m.value,allDisabled:o&&o.disabled,extraMeta:s.extraMeta,ext45:s.ext45,allOn:s.allMode&&s.allMode.on,state:s.buildingState,ward:s.buildingWard,lc152:window.__lc152&&Object.keys(window.__lc152)})})()`).then(JSON.parse).catch(() => null);
  await ev(`window.__ev=[];window.addEventListener('livecity:37d-building-selected',e=>window.__ev.push(e.detail&&(e.detail.canonicalId||e.detail.id)))`);
  const views = [{ n: 'far30k', h: 30000, p: -90 }, { n: 'far15k', h: 15000, p: -90 }, { n: 'mid6kb', h: 6000, p: -30 }, { n: 'mid3k', h: 3000, p: -60 }, { n: 'near600', h: 600, p: -60 }];
  const rows = (result.checks.lod = []);
  // 起動後の非同期カメラ上書き(flyToBoundingSphere/flyTo, duration 1〜1.6s)対策(E2E専用計装。repo の HTML は改変しない):
  // 実行後に呼ばれた flyTo 系を無効化し、呼出し元の stack 先頭を記録して上書き主体を特定する。setView 系はそのまま(E2E自身が使う)。
  await ev(`(()=>{const t=(window.__v.scene.primitives._primitives||[]).find(p=>p._lcCityLod0&&p.tilesLoaded!==undefined);window.__t=t||window.__t;return !!t})()`).then((f) => { result.checks.lod0TilesetFound = f; });   // pixelStat が参照する window.__t(--lod では未設定で TypeError→null だった)
  result.checks.camLock = await ev(`(()=>{const c=window.__v.camera;window.__flyBlocked=[];for(const k of ['flyToBoundingSphere','flyTo','flyHome']){const o=c[k];if(!o||o.__lcLock)continue;c[k]=function(){const st=(new Error().stack||'').split('\\n').slice(2,4).map(x=>x.trim().slice(0,140));window.__flyBlocked.push({k,st});return undefined};c[k].__lcLock=1}return true})()`);
  for (const v of views) {
    const lat = v.p === -90 ? lat0 : lat0 - (v.h / Math.tan(-v.p * D2R)) / 111320;
    let held = await holdCam(lon0, lat, v.h, v.p); await hookFail();
    let loaded = false; for (let i = 0; i < 120; i++) { await ev('window.__v.scene.requestRender()'); loaded = await ev(`(()=>{const ps=(window.__v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined);return ps.length>0&&ps.every(p=>p.tilesLoaded)})()`); if (loaded) break; await sleep(500); }
    await ev('window.__v.scene.requestRender()'); await sleep(800);
    const SELQ = `(()=>{const v=window.__v;const out={tilesets:[]};let n=0,leaf=0,gmin=Infinity,gmax=0;for(const p of (v.scene.primitives._primitives||[])){if(p.tilesLoaded===undefined||p._lcCityLod0)continue;const st=p._selectedTiles||[];let l=0,a=Infinity,b=0;for(const t of st){const g=t.geometricError;if(!t.children||t.children.length===0)l++;a=Math.min(a,g);b=Math.max(b,g)}n+=st.length;leaf+=l;gmin=Math.min(gmin,a);gmax=Math.max(gmax,b);out.tilesets.push({sel:st.length,leaf:l,gMin:isFinite(a)?a:null,gMax:b})}out.selected=n;out.leaf=leaf;out.gMin=isFinite(gmin)?gmin:null;out.gMax=gmax;out.tileFail=window.__tileFail||0;out.camH=v.camera.positionCartographic.height;return out})()`;
    const sel = await ev(SELQ);
    // ロード待機中に上書きされた場合に備え、撮影直前に再固定してから選択タイルを読み直す
    const held2 = await holdCam(lon0, lat, v.h, v.p); await ev('window.__v.scene.requestRender()'); await sleep(1500);
    const sel2 = await ev('(()=>({camH:window.__v.camera.positionCartographic.height}))()'); sel.camH = sel2.camH;
    await ev(`(()=>{const t=(window.__v.scene.primitives._primitives||[]).find(p=>p._lcCityLod0&&p.tilesLoaded!==undefined);if(t)window.__t=t;return !!t})()`).then((f) => { result.checks.lod0TilesetFound = f || result.checks.lod0TilesetFound; });   // LOD0 primitive は遅れて追加されるため撮影ごとに再取得
    let psErr = null; const ps = await pixelStat().catch((e) => { psErr = String((e && e.message) || e).slice(0, 300); return null; });
    let png = null; if (shots) { await ev(`(()=>{for(const e of document.querySelectorAll('body > *:not(#cesiumContainer):not(script):not(style)')){if(!e.contains(window.__v.container)&&e.id!=='lc-lod0-note')e.style.visibility='hidden'}return 1})()`); const r = await send('Page.captureScreenshot', { format: 'png' }); png = path.join(shots, `lod-${v.n}.png`); fs.writeFileSync(png, Buffer.from(r.result.data, 'base64')); }
    held = held && Math.abs(sel.camH - v.h) < v.h * 0.1;   // 撮影時点の実高度で再判定(起動後カメラ移動の上書き対策)
    const am = await ev(`(()=>{const a=(window.__mission37g||{}).allMode||{};return JSON.stringify({on:a.on,mounted:a.mounted,lastPlan:a.lastPlan,lastError:a.lastError,ticks:a.ticks,culled:a.culledTotal,state:(window.__mission37g||{}).buildingState})})()`).then(JSON.parse).catch(() => null);   // 実タイルが 0 件のとき mount 状態を切り分ける診断
    let selLate = null; if (!sel.selected) { await sleep(12000); selLate = await ev(`(()=>{const v=window.__v;return JSON.stringify((v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined&&!p._lcCityLod0).map(p=>({sel:(p._selectedTiles||[]).length,vis:p.statistics&&p.statistics.visited,pend:p.statistics&&p.statistics.numberOfPendingRequests,proc:p.statistics&&p.statistics.numberOfTilesProcessing,camH:v.camera.positionCartographic.height,fog:v.scene.fog&&v.scene.fog.enabled,fogDen:v.scene.fog&&v.scene.fog.density,root:p._root&&{vis:p._root._visible,dist:p._root._distanceToCamera|0,sse:p._root._screenSpaceError,mask:p._root._visibilityPlaneMask,empty:p._root.hasEmptyContent,nkids:p._root.children.length,kidVis:p._root.children.map(c=>c._visible?1:0).join(''),kidDist:p._root.children.map(c=>c._distanceToCamera|0).join(',')},cullOk:(()=>{try{const f=v.camera.frustum,cv=f.computeCullingVolume(v.camera.positionWC,v.camera.directionWC,v.camera.upWC);return cv.computeVisibility(p._root.boundingVolume)}catch(e){return String(e)}})(),far:v.camera.frustum.far,near:v.camera.frustum.near,mem:p.totalMemoryUsageInBytes,cacheBytes:p.cacheBytes,memSse:p.memoryAdjustedScreenSpaceError,reqd:(p._requestedTiles||[]).length,k0:(()=>{const k=p._root.children[0];return {cs:k._contentState,ready:k.contentReady,sse:k._screenSpaceError,ge:k.geometricError,vis:k._visible,pri:k._priority,reqFail:k._contentResource&&k._contentResource.url&&k._contentResource.url.slice(-30)}})(),stat:p.statistics&&{visited:p.statistics.visited,selected:p.statistics.selected,numberOfCommands:p.statistics.numberOfCommands,tilesWithContent:p.statistics.numberOfTilesWithContentReady,total:p.statistics.numberOfTilesTotal,loaded:p.statistics.numberOfLoadedTilesTotal}})))})()`).then(JSON.parse).catch(() => null); }   // 選択 0 のとき 12 秒待って再読(ロード遅延か視錐台除外かの切り分け)
    if (!sel.selected && selLate) { const re = await ev(SELQ); if (re && re.selected) { const camH = sel.camH; Object.assign(sel, re, { camH, resampledAfterSettle: true }); } }   // 選択が起動直後に未確定(ロード判定が先に通る競合)の場合、待機後に再採取。実際に0のままなら0として扱う
    const tsd = await ev(`(()=>{const v=window.__v;return JSON.stringify((v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined&&!p._lcCityLod0).map(p=>({show:p.show,sse:p.maximumScreenSpaceError,ready:p._root&&p._root.contentReady,vis:p.statistics&&p.statistics.visited,sel:p.statistics&&p.statistics.selected,total:p.statistics&&p.statistics.numberOfTilesTotal,rootBV:p._root&&p._root.boundingSphere&&{c:[p._root.boundingSphere.center.x|0,p._root.boundingSphere.center.y|0,p._root.boundingSphere.center.z|0],r:p._root.boundingSphere.radius|0},cullMove:p.cullRequestsWhileMoving,k0:(()=>{const c=p._root&&p._root.children&&p._root.children[0];return c&&{cr:c.contentReady,ca:c.contentAvailable,rc:c.hasRenderableContent,vis:c._visible,sse:c._screenSpaceError,sf:c._selectedFrame,vf:c._visitedFrame,fin:c._finalResolution,frame:p._frameNumber,rootVf:p._root._visitedFrame,rootSse:p._root._screenSpaceError,rootSf:p._root._selectedFrame,trav:p._root.children.length}})(),tl:p.tilesLoaded,vpm:p._root&&p._root._visibilityPlaneMask,bvType:p._root&&p._root._boundingVolume&&p._root._boundingVolume.constructor&&p._root._boundingVolume.constructor.name,kids:(p._root&&p._root.children||[]).map(c=>(c.contentReady?1:0)+''+(c._visibilityPlaneMask)).join(',').slice(0,60),stat:p.statistics&&{req:p.statistics.numberOfPendingRequests,cull:p.statistics.numberOfTilesCulledWithChildrenUnion,tsel:p.statistics.numberOfTilesWithContentReady},dist:p._root&&p._root.boundingSphere?Cesium.Cartesian3.distance(v.camera.positionWC,p._root.boundingSphere.center)|0:null})))})()`).then(JSON.parse).catch(() => null);
    // 区外着地か実際の穴かの切り分け: 画面中心レイの地表着地点と、実tileset(LOD0除く)根の境界球(中心・半径)との水平距離
    const aimD = await ev(`(()=>{const v=window.__v,c=v.scene.canvas;const r=v.camera.pickEllipsoid(new Cesium.Cartesian2(c.clientWidth/2,c.clientHeight/2));if(!r)return JSON.stringify({hit:false});const g=Cesium.Cartographic.fromCartesian(r);const ts=(v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined&&!p._lcCityLod0&&p._root&&p._root.boundingSphere);return JSON.stringify({hit:true,lon:+(g.longitude*180/Math.PI).toFixed(5),lat:+(g.latitude*180/Math.PI).toFixed(5),roots:ts.map(p=>{const b=p._root.boundingSphere;const cc=Cesium.Cartographic.fromCartesian(b.center);const dx=(g.longitude-cc.longitude)*111320*Math.cos(cc.latitude),dy=(g.latitude-cc.latitude)*111320;return {radiusM:b.radius|0,hitDistM:Math.hypot(dx,dy)|0,inside:Math.hypot(dx,dy)<=b.radius}})})})()`).then(JSON.parse).catch(() => null);
    // 表示中の LOD0 セル(=画面の青白い方形の候補)を、セルID・画面位置・直下の実建物画素の有無で分類(--cells、ローカル JSON のみ。PNG/GLB は出さない)。
    // realUnder=LOD0 を隠した画面と全タイルを隠した画面の差(実建物の画素)がセル中心 9x9px にある。noRealUnder=模式セルのみ(実建物なし=fallback)。
    const swapState = await awaitSwapStable();   // --cells/--compare 共通の置換状態スナップショット(安定待機つき)
    let cells = null; if (a.includes('--cells')) cells = await ev(`(()=>{const v=window.__v,T=window.__t;if(!T||!T._lcCells)return null;const grab=()=>{v.scene.render();const c=v.scene.canvas;const t=document.createElement('canvas');t.width=c.width;t.height=c.height;const g=t.getContext('2d');g.drawImage(c,0,0);return g.getImageData(0,0,t.width,t.height).data};const real=(v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined&&!p._lcCityLod0);const sv=T.show,rv=real.map(p=>p.show);const H0=new Map();for(const arr of T._lcCells.values())for(const c of arr)H0.set(c,c.f.show);T.show=false;const A=grab();real.forEach(p=>p.show=false);const B=grab();T.show=sv;real.forEach((p,i)=>p.show=rv[i]);v.scene.render();const W=v.scene.canvas.width,H=v.scene.canvas.height,k=W/v.scene.canvas.clientWidth;const cls=${classifyCellPure.toString()};const o={hiddenByReplace:0,shown:0,offscreen:0,realUnder:0,realUnder3:0,realUnder9only:0,noRealUnder:0,noRealIds:[],realIds:[],real3Ids:[],shownIds:[]};const df=(i)=>Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2])>12;for(const arr of T._lcCells.values())for(const c of arr){const hidden=!H0.get(c);let w=null,d9=false,d3=false;if(!hidden){const q=Cesium.SceneTransforms.worldToWindowCoordinates(v.scene,c.p);if(q){w={x:q.x*k,y:q.y*k};const x=Math.round(w.x),y=Math.round(w.y);if(x>=4&&y>=4&&x<W-4&&y<H-4){for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){if(df(((y+dy)*W+(x+dx))*4)){d9=true;if(Math.abs(dx)<=1&&Math.abs(dy)<=1)d3=true}}}}}const r=cls({hidden,w,W,H,d9,d3});const id=String(c.f.getProperty('canonicalId'));if(r==='hidden'){o.hiddenByReplace++;continue}o.shown++;o.shownIds.push(id);if(r==='offscreen'){o.offscreen++;continue}if(r==='noRealUnder'){o.noRealUnder++;if(o.noRealIds.length<60)o.noRealIds.push([id,Math.round(w.x),Math.round(w.y)])}else{o.realUnder++;if(r==='realUnder3'){o.realUnder3++;if(o.real3Ids.length<60)o.real3Ids.push([id,Math.round(w.x),Math.round(w.y)])}else o.realUnder9only++;if(o.realIds.length<60)o.realIds.push([id,Math.round(w.x),Math.round(w.y)])}}return o})()`).catch((e) => ({ err: String(e && e.message || e).slice(0, 200) }));
    rows.push({ view: v.n, reqH: v.h, held: held && held2, loaded, aim: aimD, swapState, cells, selLate, tsDiag: tsd, allMode: am, ...sel, lod0Share: ps && ps.lod0Share, realShare: ps && ps.realShare, pixelStatErr: psErr, shot: !!png });
  }
  // 近景でクリック → canonicalId(LOD0 は pick 対象外)
  const spot = await ev(`(()=>{const v=window.__v,c=v.scene.canvas;const cx=c.clientWidth/2,cy=c.clientHeight/2;const cand=[];for(let i=1;i<40;i++)for(let j=1;j<28;j++)cand.push([c.clientWidth*i/40,c.clientHeight*j/28]);cand.sort((a,b)=>Math.hypot(a[0]-cx,a[1]-cy)-Math.hypot(b[0]-cx,b[1]-cy));for(const [x,y] of cand){const p=v.scene.pick(new Cesium.Cartesian2(x,y));if(p&&p.getProperty&&p.getProperty('canonicalId')&&!(p.tileset&&p.tileset._lcCityLod0))return {x,y,id:p.getProperty('canonicalId')}}return null})()`);
  result.checks.clickSpot = spot;
  if (spot) { const r = await ev(`(()=>{const c=window.__v.scene.canvas.getBoundingClientRect();return {l:c.left,t:c.top}})()`); for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: spot.x + r.l, y: spot.y + r.t, button: 'left', clickCount: 1 }); await sleep(1500); result.checks.clickSelectsBuilding = ((await ev('window.__ev')) || []).includes(spot.id); }
  // Mission215 第5: 情報カード(#lc-bldg-body.on / #lc-bldg-empty 非表示)→ Escape で閉じる(canonicalId=null)。実クリック後の DOM 状態のみ(検索→区選択は含まない)
  if (spot) {
    const cardState = `(()=>{const b=document.getElementById('lc-bldg-body'),e=document.getElementById('lc-bldg-empty');return {bodyOn:!!(b&&b.classList.contains('on')),emptyHidden:!!(e&&getComputedStyle(e).display==='none'),text:b?b.innerText.trim().slice(0,60).length:0,tc:b?b.textContent.replace(/\\s+/g,'').length:0,cid:(document.getElementById('lc-cid')||{}).textContent||null,rendered:!!(b&&b.getClientRects().length),hiddenBy:(()=>{for(let n=b;n&&n!==document.body;n=n.parentElement){const d=getComputedStyle(n);if(d.display==='none'||d.visibility==='hidden')return (n.id||n.tagName)+':'+(d.display==='none'?'display':'visibility')}return null})(),vw:innerWidth,vh:innerHeight}})()`;
    const opened = await ev(cardState);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(800);
    const closed = await ev(cardState);
    result.checks.infoCard = { opened, closed, cardOpensThenCloses: !!(opened && opened.bodyOn && opened.emptyHidden && closed && !closed.bodyOn && !closed.emptyHidden) };
  }
  result.checks.flyBlocked = await ev('JSON.stringify(window.__flyBlocked||[])').then(JSON.parse).catch(() => null);
  const far = rows[0], near = rows[rows.length - 1];
  // 合否: 全視点 held/loaded/tileFail=0、遠景で選択tileの geometricError 最大が近景より大きい(=粗い親が選ばれる)、近景は葉が選ばれる、クリック一致。 15km で親が選ばれない場合は不成立として ok=false にする(捏造しない)
  result.checks.lodSwitch = { farGMax: far.gMax, nearGMax: near.gMax, nearLeaf: near.leaf, nearSelected: near.selected, parentToLeaf: far.gMax > near.gMax && near.leaf > 0 };
  result.ok = !!(rows.every((r) => r.held && r.loaded && r.tileFail === 0) && result.checks.lodSwitch.parentToLeaf && result.checks.clickSelectsBuilding && (!result.checks.infoCard || result.checks.infoCard.cardOpensThenCloses));
}
// ---- --lblab: Mission218B 第7段階 第2サイクル。lblidle=0 対 1 を 同一区・同一視点で A/B(PC 1366x768 / mobile 390x844)。
//   ラベル有無は状態フラグではなく「全 LabelCollection.show=false/true の 2 フレーム画素差」で判定する(推定 bbox 内の差分画素も数える)。
//   併せて 検索→結果選択 / 区選択→飛行 / 建物クリック→canonicalId+カード本文→ESC を同じ変種で実行。フォントは canvas で 日 と 未定義コードポイントの描画一致=豆腐 を検査。
//   使い方: --static <出力> --lblab [--lblab-size 1366x768|390x844] [--lblab-v 0|1] [--ward-name 北区] [--lat --lon]
const LBL_JS = `(()=>{const sc=window.__v.scene;const o=[];const walk=(p)=>{if(!p)return;if(p instanceof Cesium.LabelCollection){o.push(p);return}if(p instanceof Cesium.PrimitiveCollection){for(let i=0;i<p.length;i++)walk(p.get(i))}};walk(sc.primitives);return o})()`;
const LBL_MEASURE = `(()=>{const v=window.__v,sc=v.scene,cv=sc.canvas;const cols=${LBL_JS};
 const grab=()=>{sc.render();const t=document.createElement('canvas');t.width=cv.width;t.height=cv.height;const g=t.getContext('2d');g.drawImage(cv,0,0);return g.getImageData(0,0,t.width,t.height).data};
 const k=cv.width/Math.max(1,cv.clientWidth);const bbs=[];let total=0,inView=0,heavyCols=0;
 for(const c of cols){if(c.length>40)heavyCols++;for(let i=0;i<c.length&&bbs.length<4000;i++){const l=c.get(i);total++;if(!l.show)continue;let wp=null;try{wp=Cesium.SceneTransforms.worldToWindowCoordinates(sc,l.position)}catch(e){}if(!wp)continue;
  const px=parseFloat((String(l.font).match(/(\\d+(?:\\.\\d+)?)px/)||[])[1])||30,s=l.scale||1,w=String(l.text||'').length*px*s,h=px*s;const ox=(l.pixelOffset&&l.pixelOffset.x)||0,oy=(l.pixelOffset&&l.pixelOffset.y)||0;
  const x0=(wp.x+ox-4)*k,x1=(wp.x+ox+w+4)*k,y0=(wp.y+oy-h*1.2)*k,y1=(wp.y+oy+h*0.5)*k;if(x1<0||y1<0||x0>cv.width||y0>cv.height)continue;inView++;bbs.push([x0,y0,x1,y1])}}
 const sv=cols.map(c=>c.show);cols.forEach(c=>c.show=false);const A=grab();const A2=grab();cols.forEach((c,i)=>c.show=sv[i]);const B=grab();
 const W=cv.width,H=cv.height,mask=new Uint8Array(W*H);for(const [x0,y0,x1,y1] of bbs){for(let y=Math.max(0,Math.floor(y0));y<Math.min(H,Math.ceil(y1));y++)for(let x=Math.max(0,Math.floor(x0));x<Math.min(W,Math.ceil(x1));x++)mask[y*W+x]=1}
 let diff=0,diffIn=0,maskPx=0,unstable=0;for(let i=0,p=0;i<A.length;i+=4,p++){if(mask[p])maskPx++;if(Math.abs(A[i]-A2[i])+Math.abs(A[i+1]-A2[i+1])+Math.abs(A[i+2]-A2[i+2])>24){unstable++;continue}const d=Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2]);if(d>24){diff++;if(mask[p])diffIn++}}
 return {cols:cols.length,heavyCols,labelsTotal:total,labelsInView:inView,canvas:[W,H],labelDiffPx:diff,labelDiffPxInBBox:diffIn,bboxPx:maskPx,unstablePx:unstable,bboxNote:'bbox は font px×文字数からの推定(実グリフ幅ではない)'}})()`;
const REAL_SEL = `(()=>{const ps=(window.__v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined&&!p._lcCityLod0);return ps.some(p=>(p._selectedTiles||[]).length>0)})()`;
const REAL_SHARE = `(()=>{const v=window.__v,sc=v.scene,cv=sc.canvas;const grab=()=>{sc.render();const t=document.createElement('canvas');t.width=cv.width;t.height=cv.height;const g=t.getContext('2d');g.drawImage(cv,0,0);return g.getImageData(0,0,t.width,t.height).data};
 const real=(sc.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined&&!p._lcCityLod0);const sv=real.map(p=>p.show);const B=grab();real.forEach(p=>p.show=false);const A=grab();real.forEach((p,i)=>p.show=sv[i]);
 let d=0;for(let i=0;i<A.length;i+=4)if(Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2])>24)d++;return {realPx:d,total:A.length/4,realShare:+(d/(A.length/4)).toFixed(4)}})()`;
const FONT_JS = `(()=>{const t=(s)=>{const c=document.createElement('canvas');c.width=60;c.height=40;const g=c.getContext('2d');g.font='28px sans-serif';g.fillText(s,4,30);return c.toDataURL()};return {jaGlyphRendered:t('日')!==t('\\u{10FFFD}'),sameAsTofuForRare:t('龘')===t('\\u{10FFFD}')}})()`;
async function lblabMode() {
  const lat0 = Number(opt('lat', 34.7055)), lon0 = Number(opt('lon', 135.51)), wardName = opt('ward-name', '北区');
  const sizes = opt('lblab-size', '1366x768,390x844').split(','), vars = opt('lblab-v', '0,1').split(',');
  result.checks.lblab = []; result.checks.font = null;
  for (const sz of sizes) for (const lv of vars) {
    const [w, h] = sz.split('x').map(Number), R = { size: sz, lblidle: lv, ok: false, steps: {} }; result.checks.lblab.push(R);
    try {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
      const t0 = Date.now(); const up = await load(`citylod0=1&citylod0min=2500&lblidle=${lv}`); R.viewerMs = Date.now() - t0; if (!up) throw new Error('viewer 起動せず');
      if (!result.checks.font) result.checks.font = await ev(FONT_JS);
      await hookFail();
      await ev(`window.__ev=[];window.addEventListener('livecity:37d-building-selected',e=>window.__ev.push(e.detail&&(e.detail.canonicalId||e.detail.id)));window.__flyOrig={};const c=window.__v.camera;for(const k of ['flyToBoundingSphere','flyTo','flyHome']){window.__flyOrig[k]=c[k];c[k]=function(){}}`);
      // 同一視点(3000m,-45°): 起動時の初期カメラ移動に上書きされるため実高度に収まるまで再設定。最初の実タイル選択までの時刻を記録
      const pitch = -45, lat = lat0 - (3000 / Math.tan(-pitch * D2R)) / 111320; let tReal = null;
      for (let i = 0; i < 60; i++) { await fly(lon0, lat, 3000, pitch); await ev('window.__v.scene.requestRender()'); if (await ev(REAL_SEL)) { tReal = Date.now() - t0; break; } await sleep(1000); }
      R.firstRealTileSelectedMs = tReal; await sleep(2000); await fly(lon0, lat, 3000, pitch);
      R.heldH = await ev('Math.round(window.__v.camera.positionCartographic.height)');
      R.initialBuilding = await ev(REAL_SHARE);
      R.labelsEarly = await ev(LBL_MEASURE); R.gateEarly = await ev('window.__lblGate?JSON.stringify(window.__lblGate):null');
      // ラベル完了: lblidle=1 は gate 開放、さらに共通で「ラベル差分画素>0」になる最初の時刻(状態ではなく画素で判定)
      let tPx = null, tGate = null; const deadline = Date.now() + 60000;
      while (Date.now() < deadline) { await fly(lon0, lat, 3000, pitch); const m = await ev(LBL_MEASURE); if (tPx === null && m.labelDiffPx > 0) tPx = Date.now() - t0; const g = await ev('window.__lblGate?JSON.stringify(window.__lblGate):null'); if (g) { const gj = JSON.parse(g); if (gj.open && tGate === null) tGate = Date.now() - t0; } if (tPx !== null && (lv === '0' || tGate !== null)) break; await sleep(1000); }
      R.labelPixelFirstMs = tPx; R.gateOpenMs = tGate;
      R.labelsFinal = await ev(LBL_MEASURE); R.gateFinal = await ev('window.__lblGate?JSON.stringify(window.__lblGate):null');
      const lf = R.labelsFinal; R.labelReleasedButNoPixels = !!(lf.labelsInView > 0 && lf.labelDiffPx === 0 && (lv === '0' || (R.gateFinal && JSON.parse(R.gateFinal).open)));
      R.tileFail = await ev('window.__tileFail||0');
      // ---- 操作: 区選択→飛行 ----
      await ev(`(()=>{const c=window.__v.camera.positionWC;window.__c0=[c.x,c.y,c.z]})()`);
      const moved = `(()=>{const c=window.__v.camera.positionWC,o=window.__c0;return Math.hypot(c.x-o[0],c.y-o[1],c.z-o[2])})()`;
      await window_unlock(); await ev(`(()=>{const b=[...document.querySelectorAll('.lc-wardbtn')].find(x=>x.textContent.includes(${JSON.stringify(wardName)}));window.__wardBtn=!!b;if(b)b.click()})()`);
      R.steps.wardBtnFound = await ev('!!window.__wardBtn');
      let mv = 0, prevMv = -1; for (let i = 0; i < 20; i++) { await sleep(1000); mv = await ev(moved); if (mv >= 100 && Math.abs(mv - prevMv) < 50) break; prevMv = mv; } R.steps.wardSelectFlightMovedM = Math.round(mv); /* 飛行が止まる(2回連続で差<50m)まで待つ。以前は100m超えた最初の時点で採取し飛行途中の値(例:1.0km)を記録していた=ハーネス欠陥 */
      // ---- 操作: 検索→結果選択 ----
      await ev(`(()=>{const q=document.getElementById('lc-q');q.value='';q.focus()})()`); await send('Input.insertText', { text: '大阪' });
      let nopt = 0; for (let i = 0; i < 30 && !nopt; i++) { await sleep(500); nopt = await ev(`document.querySelectorAll('#lc-results button[role=option]').length`); } R.steps.searchResults = nopt;
      if (nopt) { await ev(`(()=>{const c=window.__v.camera.positionWC;window.__c0=[c.x,c.y,c.z]})()`); await ev(`document.querySelector('#lc-results button[role=option]').click()`); let m2 = 0; for (let i = 0; i < 20 && m2 < 100; i++) { await sleep(1000); m2 = await ev(moved); } R.steps.searchSelectFlightMovedM = Math.round(m2); }
      // ---- 操作: 建物クリック→canonicalId+カード本文→ESC(600m) ----
      await ev(`(()=>{const c=window.__v.camera;for(const k in window.__flyOrig)c[k]=function(){}})()`);
      const lat6 = lat0 - (600 / Math.tan(60 * D2R)) / 111320; R.steps.near600Held = await holdCam(lon0, lat6, 600, -60); await sleep(2500);
      let spot = await ev(`(()=>{const v=window.__v,c=v.scene.canvas;const cx=c.clientWidth/2,cy=c.clientHeight/2,cand=[];for(let i=1;i<40;i++)for(let j=1;j<28;j++)cand.push([c.clientWidth*i/40,c.clientHeight*j/28]);cand.sort((a,b)=>Math.hypot(a[0]-cx,a[1]-cy)-Math.hypot(b[0]-cx,b[1]-cy));const rc=c.getBoundingClientRect();let covered=0;for(const [x,y] of cand){const p=v.scene.pick(new Cesium.Cartesian2(x,y));if(p&&p.getProperty&&p.getProperty('canonicalId')&&!(p.tileset&&p.tileset._lcCityLod0)){const e=document.elementFromPoint(x+rc.left,y+rc.top);if(e!==c){covered++;continue}return {x,y,id:p.getProperty('canonicalId'),coveredSkipped:covered}}}return {none:true,coveredSkipped:covered}})()`);
      R.steps.coveredSpotsSkipped = spot && spot.coveredSkipped; if (spot && spot.none) spot = null;
      R.steps.clickSpot = !!spot;
      if (spot) {
        const r = await ev(`(()=>{const c=window.__v.scene.canvas.getBoundingClientRect();return {l:c.left,t:c.top}})()`); await ev('window.__ev=[]');
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: spot.x + r.l, y: spot.y + r.t, button: 'left', clickCount: 1 });
        await sleep(1500); R.steps.clickSelectsBuilding = ((await ev('window.__ev')) || []).includes(spot.id);
        const cs = `(()=>{const b=document.getElementById('lc-bldg-body');return {bodyOn:!!(b&&b.classList.contains('on')),innerText:b?b.innerText.trim().length:0,tc:b?b.textContent.replace(/\\s+/g,'').length:0,cid:(document.getElementById('lc-cid')||{}).textContent||null,rendered:!!(b&&b.getClientRects().length)}})()`;
        R.steps.cardOpen = await ev(cs); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(800);
        R.steps.cardClosed = await ev(cs);
      }
      const s = R.steps; R.ok = !!(R.heldH && Math.abs(R.heldH - 3000) < 300 && R.tileFail === 0 && R.firstRealTileSelectedMs !== null && s.wardBtnFound && s.wardSelectFlightMovedM >= 100 && s.searchResults > 0 && s.searchSelectFlightMovedM >= 100 && s.clickSelectsBuilding && s.cardOpen && s.cardOpen.bodyOn && s.cardOpen.tc > 0 && s.cardClosed && !s.cardClosed.bodyOn);
    } catch (e) { R.error = String(e.message || e); }
  }
  await send('Emulation.clearDeviceMetricsOverride');
  result.ok = result.checks.lblab.length > 0 && result.checks.lblab.every((r) => r.ok);
}
const window_unlock = () => ev(`(()=>{const c=window.__v.camera;for(const k in window.__flyOrig||{})c[k]=window.__flyOrig[k];return true})()`);
async function realMode() {
  const lat0 = Number(opt('lat', 34.7055)), lon0 = Number(opt('lon', 135.51));
  const t0 = Date.now();
  const up = await load('citylod0=1&citylod0min=2500'); result.checks.viewerLoaded = up; if (!up) throw new Error('viewer 起動不可: ' + JSON.stringify(result.console.slice(0, 3)));
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
  if (a.includes('--sweep')) { await sweepMode(); return; }
  // warm: 再読込(HTTP キャッシュ有り)での転送量と所要時間
  const b0 = result.bytes || 0, w0 = Date.now(); await load('citylod0=1&citylod0min=2500'); await sleep(4000); result.checks.warmBytes = (result.bytes || 0) - b0; result.checks.warmViewerMs = Date.now() - w0;
  const hp = result.checks.highWithReal;
  // 置換 ON(既定)では高所の lod0Share が小さくなるのが正常(旧判定 >0.02 は誤判定)。LOD0 が読み込まれ、低高度で非表示、クリックで建物選択、を合否とし、lod0Share は参考値(0 でも正常)。実建物の画素寄与 realShare>0.05 を要求
  result.ok = !!(result.checks.lod0Loaded && hp.realShare > 0.05 && result.checks.lowAltLod0Shown === false && result.checks.clickSelectsBuilding);
}
try {
  if (STATIC && a.includes('--lblab')) await lblabMode(); else if (STATIC && a.includes('--lod')) await lodMode(); else if (STATIC && a.includes('--profile')) await profileMode(); else if (STATIC && a.includes('--baseline')) await baselineMode(); else if (STATIC && a.includes('--compare')) await compareMode(); else if (STATIC) await realMode(); else {
  const up = await load('citylod0=1&citylod0min=2500'); result.checks.viewerLoaded = up; 
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
result.httpDiag = { realTileFailures: realFailures(result.httpStat || {}), httpErrorsCap: 50, httpErrorsTruncated: (result.httpErrors || []).length >= 50, examplesCapPerClass: 10, note: 'httpStat は分類別の全件数(打切りなし)。examples は種別ごと先頭10件。optionalAsset(towns/stations/favicon等)の404 は実建物の取得失敗ではない。対象: responseReceived の status のみ。loadingFailed は netFailed 別集計、キャッシュ提供は対象外。' };
const txt = JSON.stringify(result, null, 1); if (OUT) fs.writeFileSync(OUT, txt); console.log(txt);
process.exit((result.exitOk ?? result.ok) ? 0 : (result.checks.viewerLoaded === false ? 2 : 1));
