// Mission 45V: 45E preview server + 45I layers-root + viewer -> do roads / rivers actually reach the screen? Synthetic fixture only.
//   node tools/experiments/mission45v_roads_e2e.mjs [--out <json>]
// (1) HTTP GET checks against the real 45E server (index.json layersWards, layers files, whitelist / 404),
// (2) headless Chrome opens ?ext45=1&qa=1, enables all-ward 3D, looks at the fixture road, compares canvas pixels with the roads layer ON vs OFF.
// Needs CesiumJS from the jsDelivr CDN. If a browser or the CDN is unavailable the browser part reports { skipped } (never "passed").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launchBrowser, BROWSER_CANDIDATES } from '../lib/cdp-browser.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const A = require('../mission45d-convert-all.cjs');
const L = require('../mission40b-legacy-tiles-batch.cjs');
const E = require('../mission45e-preview.cjs');
const B = require('../mission45i-build-layers-24.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n));
const wards24 = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const TARGET = 'kita';

function buildingSrc() {
  const src = tmp('m45v-bld-'); const ds = [];
  reg.forEach((w, wi) => {
    const dir = path.join(src, 'osaka-' + w.id); const tiles = [];
    for (let t = 0; t < 2; t++) {
      const bs = [0, 1, 2].map((k) => ({ id: 'bldg_' + String(wi).padStart(2, '0') + t + k + '-fixture', fp: [[t * 600, 0], [t * 600 + 10, 0], [t * 600 + 10, 10], [t * 600, 10]], h: 10, repX: 5 + t * 600, repZ: 5 }));
      wj(path.join(dir, 'tile_' + t + '_0.json'), { buildings: bs }); tiles.push({ tx: t, tz: 0, count: 3, file: 'tile_' + t + '_0.json' });
    }
    wj(path.join(dir, 'manifest.json'), { wardCode: w.code, coordinateConvention: 'znorth-neg-v1', tiles }); ds.push({ id: 'osaka-' + w.id, wardId: w.id, buildings: 6, tiles: 2 });
  });
  wj(path.join(src, 'manifest.json'), { datasets: ds });
  return src;
}
function layersSrc(w) {
  const src = tmp('m45v-lay-'); const cx = (w.bbox.minX + w.bbox.maxX) / 2, cz = (w.bbox.minZ + w.bbox.maxZ) / 2, size = 2000;
  for (const l of ['roads', 'waterways', 'parks', 'railways']) {
    fs.mkdirSync(path.join(src, l));
    wj(path.join(src, l, 'manifest.json'), { tileSize: size, coordinateSystem: 'meters-local', coordinateConvention: 'znorth-neg-v1', bboxLocal: { minX: -30000, maxX: 30000, minZ: -30000, maxZ: 30000 } });
    const f = [];
    if (l === 'roads') for (let i = -5; i <= 5; i++) f.push({ id: 'r' + i, kind: 'line', tier: 'local', p: [[cx - 100, cz + i * 30], [cx + 100, cz + i * 30]] }, { id: 'c' + i, kind: 'line', tier: 'local', p: [[cx + i * 30, cz - 150], [cx + i * 30, cz + 150]] });
    wj(path.join(src, l, 'tile_' + Math.floor(cx / size) + '_' + Math.floor(cz / size) + '.json'), { features: f });
  }
  return { src, cx, cz };
}
const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { Host: '127.0.0.1:' + port } }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c) })); }).on('error', rej);
});
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (pos < buf.length) { const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), body = buf.subarray(pos + 8, pos + 8 + len); if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); ct = body[9]; } else if (type === 'IDAT') idat.push(body); pos += 12 + len; }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, data = Buffer.alloc(w * h * 4); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b2 = prev[i], c = i >= bpp ? prev[i - bpp] : 0; let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b2; else if (f === 3) v += (a + b2) >> 1;
      else if (f === 4) { const pp = a + b2 - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b2), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b2 : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) { data[(y * w + x) * 4] = line[x * bpp]; data[(y * w + x) * 4 + 1] = line[x * bpp + 1]; data[(y * w + x) * 4 + 2] = line[x * bpp + 2]; data[(y * w + x) * 4 + 3] = 255; }
    prev = line;
  }
  return { w, h, data };
}
const diff = (x, y) => { let n = 0; for (let i = 0; i < x.data.length; i += 4) if (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]) > 30) n++; return n; };

async function main() {
  const R = { http: {}, browser: {}, errors: [] };
  const w = wards24.find((x) => x.wardId === TARGET);
  const bsrc = buildingSrc(), outRoot = path.join(tmp('m45v-out-'), 'out');
  const synth = (s) => (dir) => { L.setSource(s); return L.convertWard('sumiyoshi', { out: dir, force: true }); };
  const r0 = A.run({ src: bsrc, outRoot, execute: true, approved: true, sumiyoshiRun: synth(bsrc) });
  if (r0.complete !== true) throw new Error('fixture 45D not complete');
  const ls = layersSrc(w);
  const layersRoot = path.join(tmp('m45v-lroot-'), 'layers');
  B.run({ src: ls.src, layersRoot, wards: [TARGET] });
  const srv = await E.serve({ src: bsrc, outRoot, allowSynthetic: true, sumiyoshiRun: synth(bsrc), layersRoot, port: 0 });
  const port = srv.port;
  try {
    const idx = JSON.parse((await get(port, '/ext-3dtiles/index.json')).body.toString());
    R.http.indexLayersWards = idx.layersWards; R.http.indexWards = idx.wards.length;
    for (const f of ['roads', 'waterways', 'parks', 'railways', 'labels', 'layers-report']) R.http[f] = (await get(port, '/ext-3dtiles/' + TARGET + '/layers/' + f + '.json')).status;
    R.http.notWhitelisted = (await get(port, '/ext-3dtiles/' + TARGET + '/layers/secret.json')).status;
    R.http.wardWithoutLayers = (await get(port, '/ext-3dtiles/abeno/layers/roads.json')).status;
    R.http.roadFeatures = JSON.parse((await get(port, '/ext-3dtiles/' + TARGET + '/layers/roads.json')).body.toString()).count;
    if (!BROWSER_CANDIDATES.some((p) => fs.existsSync(p))) { R.browser = { skipped: 'no browser' }; return R; }
    const b = await launchBrowser({ width: 1280, height: 800 });
    try {
      const p = b.page;
      p.on('Runtime.exceptionThrown', (e) => R.errors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
      p.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/favicon/.test(e.response.url)) (R.browser.badResponses = R.browser.badResponses || []).push(e.response.status + ' ' + e.response.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')); });
      await p.send('Network.enable');
      await p.send('Network.setBlockedURLs', { urls: ['*://cyberjapandata.gsi.go.jp/*', '*://*.tile.openstreetmap.org/*', '*://*.basemaps.cartocdn.com/*'] });
      await p.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/mission37g-osaka-24ward-mvp.html?ext45=1&qa=1&basemap=none' });
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        await sleep(1000);
        ready = await p.evaluate("!!(window.__mission37dQA && window.__mission37g && document.querySelector('#sel-bldg-mode option[value=all]') && !document.querySelector('#sel-bldg-mode option[value=all]').disabled)").catch(() => false);
      }
      R.browser.pageReady = ready;
      if (!ready) { R.browser.skipped = 'page/Cesium not ready (CDN unreachable?)'; return R; }
      R.browser.ext45 = JSON.parse(await p.evaluate('JSON.stringify(window.__mission37g.ext45)'));
      await p.evaluate("(function(){var s=document.getElementById('sel-bldg-mode');s.value='all';s.dispatchEvent(new Event('change'));})()");
      await sleep(1500);
      await p.evaluate('window.__mission37dQA.lookAtLocal(' + ls.cx + ', ' + ls.cz + ', 0, 900, -75, 0)');
      let mounted = {};
      for (let i = 0; i < 40; i++) {
        await sleep(1000);
        mounted = JSON.parse(await p.evaluate('JSON.stringify(window.__mission37g.vec45i.mounted)'));
        if (Object.keys(mounted).length) { await sleep(2500); break; }
      }
      R.browser.vecMounted = mounted;
      await sleep(8000);
      R.browser.vecMountedAfter8s = JSON.parse(await p.evaluate('JSON.stringify(window.__mission37g.vec45i.mounted)'));
      R.browser.vecStats = JSON.parse(await p.evaluate('JSON.stringify({available:window.__mission37g.vec45i.available,lastError:window.__mission37g.vec45i.lastError,lastPlan:window.__mission37g.vec45i.lastPlan,fetches:window.__mission37g.vec45i.layerFetches,ticks:window.__mission37g.vec45i.ticks})'));
      const shot = async () => Buffer.from((await p.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      await p.evaluate("window.__mission37dQA.setLayer('roads', true)"); await sleep(2000);
      const on = await shot();
      await p.evaluate("window.__mission37dQA.setLayer('roads', false)"); await sleep(2000);
      const off = await shot();
      await p.evaluate("window.__mission37dQA.setLayer('roads', true)"); await sleep(2000);
      const on2 = await shot();
      const a = decodePng(on), c = decodePng(off), d = decodePng(on2);
      R.browser.pixelDiffOnVsOff = diff(a, c); R.browser.pixelDiffOnVsOnAgain = diff(a, d);
      R.browser.roadsVisibleOnScreen = R.browser.pixelDiffOnVsOff > 200;
      if (out) { const base = out.replace(/\.json$/, ''); fs.writeFileSync(base + '-on.png', on); fs.writeFileSync(base + '-off.png', off); }
    } finally { await b.close(); }
  } finally { srv.server.close(); }
  return R;
}
main().then((R) => { const s = JSON.stringify(R, null, 1); console.log(s); if (out) fs.writeFileSync(out, s); process.exit(0); }, (e) => { console.error('E2E error: ' + (e && e.stack || e)); process.exit(1); });
