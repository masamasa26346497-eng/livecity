// tools/experiments/mission44a_render_e2e.mjs
// [Mission 44A] Git 追跡済みの実 3D Tiles が、実 Chrome（headless）で「画面に描画される」ことを区ごとに確認する E2E。
//   手順（区ごと）: 建物なし（ward=null）で同じカメラのスクリーンショット A → 区を選択 → tileset/GLB の HTTP 200・
//   Cesium3DTileset が primitives にある・tilesLoaded → 同じカメラで B → A と B をキャンバス上で画素比較し、
//   建物の分だけ画素が変わっていること（差分画素数・割合）を確認する。ピクセル値の絶対評価ではなく「建物あり/なし」の差分。
//   画像・データ実体はコミットしない（--shots を付けたときだけ temp/ に保存。既定は保存しない）。
//   headless はソフトウェア描画。時間は実機値ではない。外部 CDN（CesiumJS）に接続できない環境では WebGL/Cesium が起動せず失敗する（その場合は原因をそのまま出力して終了コード 1）。
//   使い方: node tools/experiments/mission44a_render_e2e.mjs [--wards 27120,27127] [--shots]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const want = (args.includes('--wards') ? args[args.indexOf('--wards') + 1] : '').split(',').filter(Boolean);
const SHOTS = args.includes('--shots');
const GOOGLE = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const hits = [];   // 配信した tileset/GLB の応答
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const p = path.join(root, u);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); if (/\.(glb|json)$/.test(u)) hits.push({ u, s: 404 }); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  if (/\/(tileset\.json|tiles\/.*\.glb|lod\/.*\.glb)$/.test(u)) hits.push({ u, s: 200 });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const URL_ = `http://127.0.0.1:${PORT}/mission37g-osaka-24ward-mvp.html?qa=1&fac=0`;

function loadTargets(dir) {
  const byId = {};
  for (const f of fs.readdirSync(dir + 'attrs')) Object.assign(byId, JSON.parse(fs.readFileSync(dir + 'attrs/' + f, 'utf8')).byId);
  const all = Object.entries(byId).filter(([, a]) => a[0] >= 30 && a[0] <= 120);
  // 建物が密集している所を狙う: 最も多くの建物が 200m 以内にある高層建物を選ぶ（上位 400 件の中で比較）
  const cand = all.sort((a, b) => b[1][0] - a[1][0]).slice(0, 400);
  let best = null;
  for (const [id, a] of cand) {
    let n = 0; for (const [, b] of all) if (Math.hypot(a[2] - b[2], a[3] - b[3]) < 200) n++;
    if (!best || n > best.n) best = { id, h: a[0], x: a[2], z: a[3], n };
  }
  return best;
}
const WARDS = [
  { name: '住吉区', dir: 'public/mission37c-layers/osaka-sumiyoshi-9tile/' },
  { name: '北区', dir: 'public/mission37h-3dtiles/kita-sample/' },
  { name: '中央区', dir: 'public/mission37h-3dtiles/chuo-sample/' },
  { name: '天王寺区', dir: 'public/mission37h-3dtiles/tennoji-sample/' },
  { name: '西区', dir: 'public/mission37h-3dtiles/nishi-sample/' },
  { name: '浪速区', dir: 'public/mission38e-3dtiles/naniwa-mesh/' },
].map((w) => ({ ...w, code: w.dir.includes('37c-layers') ? '27120' : JSON.parse(fs.readFileSync(w.dir + 'source.json', 'utf8')).wardCode, target: loadTargets(w.dir) }))
  .filter((w) => !want.length || want.includes(w.code));

const out = { mission: '44A', browser: null, generatedAt: new Date().toISOString(), wards: [], googleRequests: [], jsErrors: [], failedRequests: [] };
let b;
try { b = await launchBrowser({ width: 1280, height: 800 }); } catch (e) { console.error('browser launch failed:', e.message); process.exit(1); }
const page = b.page; out.browser = b.version;
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE.test(new URL(e.request.url).hostname)) out.googleRequests.push(e.request.url); } catch { /* data: */ } });
page.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/tile\.|cyberjapandata|favicon/.test(e.response.url)) out.failedRequests.push(e.response.status + ' ' + e.response.url); });
const ev = (js) => page.evaluate(js);
const J = (js) => ev(`JSON.stringify(${js})`).then(JSON.parse);
async function waitReady() { for (let i = 0; i < 90; i++) { if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(500); } await sleep(1200); }
async function grab() {
  // 再描画を 2 フレーム待ってから PNG を取り、ページ内にだけ保持する（画素比較用）
  await sleep(1500);
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  return data;
}
async function diffPixels(a64, b64) {
  return ev(`(async () => JSON.stringify(await (async () => {
    const load = async (d) => { const bl = await (await fetch('data:image/png;base64,' + d)).blob(); const bm = await createImageBitmap(bl);
      const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };
    const A = await load(${JSON.stringify(a64)}), B = await load(${JSON.stringify(b64)});
    let diff = 0, strong = 0; const n = A.width * A.height;
    for (let i = 0; i < n; i++) { const d = Math.abs(A.data[i*4]-B.data[i*4]) + Math.abs(A.data[i*4+1]-B.data[i*4+1]) + Math.abs(A.data[i*4+2]-B.data[i*4+2]); if (d > 24) diff++; if (d > 90) strong++; }
    return { w: A.width, h: A.height, diff, strong, pct: +(diff / n * 100).toFixed(2) };
  })()))()`).then(JSON.parse);
}

try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  let up = false;
  for (let i = 0; i < 90; i++) { await sleep(1000); if (await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) { up = true; break; } }
  if (!up) { out.fatal = 'ビューアが起動しない（CesiumJS の CDN 取得または WebGL 失敗の可能性）'; throw new Error(out.fatal); }
  out.webgl = await ev("(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); })()");
  await sleep(1500);
  for (const w of WARDS) {
    const r = { ward: w.name, code: w.code, target: w.target };
    await ev(`window.__mission37dQA.setBuildingWard(null)`); await sleep(800);
    // 利用者導線: 左パネルの「3D建物の区」セレクトで区を選ぶだけで、カメラが建物のある範囲へ寄ること（寄れた距離 <= 半径の 4 倍）
    await ev(`(() => { const s = document.getElementById('sel-bldg-ward'); s.value = '${w.code}'; s.dispatchEvent(new Event('change')); })()`);
    await waitReady(); await sleep(3500);
    const cam = await J('window.__mission37dQA.cameraVsTilesets()');
    r.userPath = { cameras: cam, focused: cam.length > 0 && cam.every((c) => c.distM <= c.radiusM * 4 + 500) };
    await ev(`window.__mission37dQA.setBuildingWard(null)`); await sleep(800);
    await ev(`window.__mission37dQA.lookAtLocal(${w.target.x}, ${w.target.z}, ${w.target.h / 2}, 600, -45, 0)`);
    const hitsBefore = hits.length;
    const A = await grab();
    await ev(`window.__mission37dQA.setBuildingWard('${w.code}')`); await waitReady();
    await ev(`window.__mission37dQA.lookAtLocal(${w.target.x}, ${w.target.z}, ${w.target.h / 2}, 600, -45, 0)`);
    await waitReady();
    const B = await grab();
    const t = await J('window.__mission37dQA.tilesetCount()');
    r.tilesets = t.n; r.state = await ev('window.__mission37g.buildingState');
    r.tilesLoaded = await ev('window.__mission37dQA.tilesReady()');
    r.http = { tileset200: hits.slice(hitsBefore).filter((h) => /tileset\.json$/.test(h.u) && h.s === 200).length, glb200: hits.slice(hitsBefore).filter((h) => /\.glb$/.test(h.u) && h.s === 200).length, notFound: hits.slice(hitsBefore).filter((h) => h.s === 404).length };
    r.pixels = await diffPixels(A, B);
    r.pass = r.tilesets >= 1 && r.state === 'ready' && r.tilesLoaded && r.http.tileset200 >= 1 && r.http.glb200 >= 1 && r.http.notFound === 0 && r.pixels.pct >= 1.0 && r.userPath.focused;
    if (SHOTS) { fs.mkdirSync('temp/mission44a', { recursive: true }); fs.writeFileSync(`temp/mission44a/${w.code}-off.png`, Buffer.from(A, 'base64')); fs.writeFileSync(`temp/mission44a/${w.code}-on.png`, Buffer.from(B, 'base64')); }
    out.wards.push(r);
    console.log(JSON.stringify({ ward: r.ward, pass: r.pass, tilesets: r.tilesets, state: r.state, http: r.http, diffPct: r.pixels.pct, focus: r.userPath }));
  }
} catch (e) { out.error = String(e.message || e); }
finally { try { await b.close?.(); } catch { /* noop */ } srv.close(); }
out.pass = !out.error && out.wards.length === WARDS.length && out.wards.every((x) => x.pass) && out.jsErrors.length === 0 && out.googleRequests.length === 0 && out.failedRequests.length === 0;
console.log(JSON.stringify({ pass: out.pass, wards: out.wards.length, passed: out.wards.filter((x) => x.pass).length, jsErrors: out.jsErrors.length, google: out.googleRequests.length, failed: out.failedRequests, error: out.error }));
process.exit(out.pass ? 0 : 1);
