// tools/experiments/mission44a_ext_e2e.mjs
// [Mission 44A] 43F（PC-only 23 区変換）→ 43G（検証・loopback 配信）→ 37G ビューア（?ext=）の配線を、合成 fixture で実 Chrome 上に通す E2E。
//   ※ 実データではない。fixture は 43F 本物のコードで変換した極小の合成建物（区コードは config/wards/registry.json の実コード）。
//   PC の実 23 区データがオンラインにあることを意味しない。画像・データは一時ディレクトリのみ（終了時に削除）。
//   確認: 43G が verified とした区だけが /ext-3dtiles/<区>/ で配信され、ビューアが source.json.wardCode で区選択に結び付け、
//         tileset/GLB が 200 で読めて Cesium3DTileset が 1 本以上 mount され、建物あり/なしの画素差が出ること。
//   使い方: node tools/experiments/mission44a_ext_e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchBrowser } from '../lib/cdp-browser.js';
const require = createRequire(import.meta.url);
const C = require('../mission43f-pc-convert.cjs');
const P = require('../mission43g-local-preview.cjs');
const L = require('../mission40b-legacy-tiles-batch.cjs');
const ROOT = path.resolve('.');
const wards = JSON.parse(fs.readFileSync('config/wards/registry.json', 'utf8')).wards;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm44a-'));
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };

// 合成ソース（旧タイル形式）: 全 24 区ぶん。建物は 60m 角・高さ 40m の箱を原点付近に並べる
const src = path.join(tmp, 'src'); const ds = [];
wards.forEach((w, wi) => {
  const dir = path.join(src, 'osaka-' + w.id); const tiles = [];
  for (let t = 0; t < 2; t++) {
    const bs = [0, 1, 2].map((k) => { const x0 = t * 500 + k * 100 + 20; return { id: 'bldg_' + String(wi).padStart(2, '0') + t + k + '-fixture', fp: [[x0, 0], [x0 + 60, 0], [x0 + 60, 60], [x0, 60]], h: 40, repX: x0 + 30, repZ: 30 }; });
    wj(path.join(dir, 'tile_' + t + '_0.json'), { buildings: bs });
    tiles.push({ tx: t, tz: 0, count: 3, file: 'tile_' + t + '_0.json' });
  }
  wj(path.join(dir, 'manifest.json'), { wardCode: w.code, coordinateConvention: 'znorth-neg-v1', tiles });
  ds.push({ id: 'osaka-' + w.id, wardId: w.id, buildings: 6, tiles: 2 });
});
wj(path.join(src, 'manifest.json'), { datasets: ds });
const W = wards.map((w) => w.id).find((id) => !['sumiyoshi', 'kita', 'chuo', 'tennoji', 'nishi', 'naniwa'].includes(id));   // Git 追跡の 3D が無い区
const WCODE = wards.find((w) => w.id === W).code;
const out = path.join(tmp, 'out');
const conv = C.runConvert({ src, outRoot: out, execute: true, wards: W });
if (!conv.ok) { console.error('43F convert failed', JSON.stringify(conv.results)); process.exit(1); }
const { server, port, servable } = await P.serve({ outRoot: out, port: 0, wards: W });
const res = { mission: '44A-ext', ward: W, wardCode: WCODE, servable: servable.map((s) => s.ward), steps: {}, jsErrors: [], failed: [], google: [] };
let b;
try {
  b = await launchBrowser({ width: 1280, height: 800 });
  const page = b.page; const ev = (js) => page.evaluate(js);
  page.on('Runtime.exceptionThrown', (e) => { try { res.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
  page.on('Network.requestWillBeSent', (e) => { try { if (/(googleapis|google|gstatic)\.com$/i.test(new URL(e.request.url).hostname)) res.google.push(e.request.url); } catch { /* noop */ } });
  const ext = [];
  page.on('Network.responseReceived', (e) => { if (/\/ext-3dtiles\//.test(e.response.url)) ext.push({ u: e.response.url.replace(/^.*ext-3dtiles\//, ''), s: e.response.status }); if (e.response.status >= 400 && !/tile\.|cyberjapandata|favicon|layers\//.test(e.response.url)) res.failed.push(e.response.status + ' ' + e.response.url); });
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/mission37g-osaka-24ward-mvp.html?qa=1&fac=0&ext=${W}` });
  let up = false;
  for (let i = 0; i < 90; i++) { await sleep(1000); if (await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) { up = true; break; } }
  if (!up) throw new Error('viewer did not start (CesiumJS CDN / WebGL)');
  await sleep(1500);
  const grab = async () => { await sleep(1500); return (await page.send('Page.captureScreenshot', { format: 'png' })).data; };
  const look = () => ev('window.__mission37dQA.lookAtLocal(300, 30, 20, 500, -45, 0)');
  const waitReady = async () => { for (let i = 0; i < 60; i++) { if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(500); } await sleep(1200); };
  await ev("window.__mission37dQA.setBuildingWard(null)"); await look(); const A = await grab();
  await ev(`window.__mission37dQA.setBuildingWard('${WCODE}')`); await waitReady(); await look(); await waitReady(); const B = await grab();
  res.steps.state = await ev('window.__mission37g.buildingState');
  res.steps.tilesets = JSON.parse(await ev('JSON.stringify(window.__mission37dQA.tilesetCount())')).n;
  res.steps.extraSets = JSON.parse(await ev('JSON.stringify(window.__mission37g.extraSets || window.__mission37g.stats && window.__mission37g.stats.extraSets || null)'));
  for (let i = ext.length - 1; i >= 0; i--) if (/layers-report\.json$/.test(ext[i].u)) ext.splice(i, 1);   // 40G の区別レイヤーは任意（無ければ no-layers）
  res.steps.extUrls = ext.map((x) => x.s + ' ' + x.u).slice(0, 20);
  res.steps.http = { tileset200: ext.filter((x) => /tileset\.json$/.test(x.u) && x.s === 200).length, glb200: ext.filter((x) => /\.glb(\?|$)/.test(x.u) && x.s === 200).length, bad: ext.filter((x) => x.s >= 400) };
  res.steps.pixels = JSON.parse(await ev(`(async () => JSON.stringify(await (async () => {
    const load = async (d) => { const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + d)).blob()); const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };
    const A = await load(${JSON.stringify(A)}), B = await load(${JSON.stringify(B)}); let diff = 0; const n = A.width * A.height;
    for (let i = 0; i < n; i++) { if (Math.abs(A.data[i*4]-B.data[i*4]) + Math.abs(A.data[i*4+1]-B.data[i*4+1]) + Math.abs(A.data[i*4+2]-B.data[i*4+2]) > 24) diff++; }
    return { diff, pct: +(diff / n * 100).toFixed(3) };
  })()))()`));
  // 区外（verified でない区）は配信されないこと: 別の区コードを選んでも ext tileset は mount されない
  await ev("window.__mission37dQA.setBuildingWard('27103')"); await sleep(800);
  res.steps.otherWardTilesets = JSON.parse(await ev('JSON.stringify(window.__mission37dQA.tilesetCount())')).n;
} catch (e) { res.error = String(e.message || e); }
finally { try { await b?.close?.(); } catch { /* noop */ } await new Promise((r) => server.close(r)); L.setSource && L.setSource(path.join(ROOT, 'public/map-data/osaka-city/buildings')); fs.rmSync(tmp, { recursive: true, force: true }); }
const s = res.steps;
res.pass = !res.error && s.state === 'ready' && s.tilesets >= 1 && s.http?.tileset200 >= 1 && s.http?.glb200 >= 1 && s.http.bad.length === 0 && s.pixels?.pct > 0.05 && s.otherWardTilesets === 0 && res.jsErrors.length === 0 && res.google.length === 0 && res.failed.length === 0;
console.log(JSON.stringify(res, null, 1));
process.exit(res.pass ? 0 : 1);
