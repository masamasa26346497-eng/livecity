// [derived from 45V helpers] Mission 45X: 45E preview server + 45I layers-root + viewer -> do roads / rivers actually reach the screen? Synthetic fixture only.
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
const TARGET = 'chuo', OTHER = 'sumiyoshi';

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

const ev = (p, js) => p.evaluate(js);
const J = async (p, js) => JSON.parse(await p.evaluate('JSON.stringify(' + js + ')'));
async function waitFor(p, js, n = 40, ms = 1000) { for (let i = 0; i < n; i++) { await sleep(ms); if (await p.evaluate(js).catch(() => false)) return true; } return false; }

async function main() {
  const R = { mission: '45X', scenarios: {}, errors: [], note: 'synthetic fixture only; no private 45I data was available or read' };
  const w = wards24.find((x) => x.wardId === TARGET);
  const bsrc = buildingSrc(), outRoot = path.join(tmp('m45x-out-'), 'out');
  const synth = (s) => (dir) => { L.setSource(s); return L.convertWard('sumiyoshi', { out: dir, force: true }); };
  const r0 = A.run({ src: bsrc, outRoot, execute: true, approved: true, sumiyoshiRun: synth(bsrc) });
  if (r0.complete !== true) throw new Error('fixture 45D not complete');
  const ls = layersSrc(w);
  const layersRoot = path.join(tmp('m45x-lroot-'), 'layers');
  B.run({ src: ls.src, layersRoot, wards: [TARGET] });
  R.diagnoseCli = require('../mission45x-diagnose-layers.cjs').diagnose(layersRoot, reg).summary;
  if (!BROWSER_CANDIDATES.some((p) => fs.existsSync(p))) { R.browserSkipped = 'no browser'; return R; }
  const b = await launchBrowser({ width: 1280, height: 800 });
  const p = b.page;
  p.on('Runtime.exceptionThrown', (e) => R.errors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
  const bad = [];
  p.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/favicon/.test(e.response.url)) bad.push(e.response.status + ' ' + e.response.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')); });
  await p.send('Network.enable');
  await p.send('Network.setBlockedURLs', { urls: ['*://cyberjapandata.gsi.go.jp/*', '*://*.tile.openstreetmap.org/*', '*://*.basemaps.cartocdn.com/*'] });
  const shot = async () => decodePng(Buffer.from((await p.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const open = async (port) => {
    await p.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/mission37g-osaka-24ward-mvp.html?ext45=1&qa=1&basemap=none' });
    return waitFor(p, "!!(window.__mission37dQA && window.__mission37g && document.querySelector('#sel-bldg-mode option[value=all]') && !document.querySelector('#sel-bldg-mode option[value=all]').disabled && document.querySelector('#sel-bldg-ward option[value=\"27128\"]'))", 60);
  };
  const pick = (code) => ev(p, "(function(){var s=document.getElementById('sel-bldg-ward');s.value='" + code + "';s.dispatchEvent(new Event('change'));})()");
  const look = (x, z, r) => ev(p, 'window.__mission37dQA.lookAtLocal(' + x + ', ' + z + ', 0, ' + r + ', -75, 0)');
  const roadsOnOff = async () => {
    await ev(p, "window.__mission37dQA.setLayer('roads', true)"); await sleep(2000); const on = await shot();
    await ev(p, "window.__mission37dQA.setLayer('roads', false)"); await sleep(2000); const off = await shot();
    await ev(p, "window.__mission37dQA.setLayer('roads', true)"); await sleep(1500);
    return diff(on, off);
  };
  try {
    // Scenario 1: 45I layers delivered for chuo; the user selects wards in SINGLE mode (not "all")
    let srv = await E.serve({ src: bsrc, outRoot, allowSynthetic: true, sumiyoshiRun: synth(bsrc), layersRoot, port: 0 });
    try {
      const S = (R.scenarios.singleMode = {});
      S.pageReady = await open(srv.port);
      S.vecAvailable = await J(p, 'window.__mission37g.vec45i.available');
      await pick('27128');
      S.chuoReady = await waitFor(p, "window.__mission37g.wardVec.state==='ready'", 60);
      S.wardVec = await J(p, 'window.__mission37g.wardVec');
      S.roadFeaturesInFile = JSON.parse((await get(srv.port, '/ext-3dtiles/' + TARGET + '/layers/roads.json')).body.toString()).features.length;
      await look(ls.cx, ls.cz, 900); await sleep(4000);
      S.chuoRoadsOnOffPx = await roadsOnOff();
      S.chuoCoverage = await J(p, 'window.__mission37g.vecCoverage');
      await pick('27120');
      await sleep(5000);
      S.afterSwitch = { wardVec: await J(p, 'window.__mission37g.wardVec'), mounted: await J(p, 'window.__mission37g.vec45i.mounted') };
      await pick('27128');
      S.chuoReadyAgain = await waitFor(p, "window.__mission37g.wardVec.state==='ready'&&window.__mission37g.wardVec.ward==='27128'", 60);
      S.wardVecAgain = await J(p, 'window.__mission37g.wardVec');
      await pick('');
      await sleep(2500);
      S.afterDeselect = await J(p, 'window.__mission37g.wardVec');
      // all-ward 3D mode on the same server
      const A2 = (R.scenarios.allMode = {});
      await ev(p, "(function(){var s=document.getElementById('sel-bldg-mode');s.value='all';s.dispatchEvent(new Event('change'));})()");
      await sleep(1500); await look(ls.cx, ls.cz, 900);
      for (let i = 0; i < 40; i++) { await sleep(1000); const m = await J(p, 'window.__mission37g.vec45i.mounted'); if (Object.keys(m).length) { A2.mounted = m; break; } }
      await sleep(5000); await look(ls.cx, ls.cz, 900); await sleep(9000);
      A2.mountedAfter = await J(p, 'window.__mission37g.vec45i.mounted'); A2.coverageAfterMount = await J(p, 'window.__mission37g.vecCoverage'); A2.hit = await J(p, '({m:Object.keys(window.__mission37g.vec45i.mounted)})');
      A2.vecStats = await J(p, '({lastError:window.__mission37g.vec45i.lastError,polylines:window.__mission37g.vec45i.polylines,vertices:window.__mission37g.vec45i.vertices})');
      A2.roadsOnOffPx = await roadsOnOff();
      A2.coverage = await J(p, 'window.__mission37g.vecCoverage');
    } finally { srv.server.close(); }

    // Scenario 2: server WITHOUT a layers root (not delivered). Must say so, draw nothing, and not reuse the Sumiyoshi counts.
    srv = await E.serve({ src: bsrc, outRoot, allowSynthetic: true, sumiyoshiRun: synth(bsrc), port: 0 });
    try {
      const S = (R.scenarios.notDelivered = {});
      S.pageReady = await open(srv.port);
      S.vecAvailable = await J(p, 'window.__mission37g.vec45i.available');
      await pick('27128'); await sleep(8000);
      S.wardVec = await J(p, 'window.__mission37g.wardVec');
      await look(ls.cx, ls.cz, 900); await sleep(4500);
      S.roadsOnOffPx = await roadsOnOff();
      S.coverage = await J(p, 'window.__mission37g.vecCoverage');
      S.sumiyoshiBundleRoadCount = await J(p, 'window.__mission37g.layers.roads.count');
    } finally { srv.server.close(); }
  } catch (e) { R.fatal = String(e && e.stack || e); }
  R.badResponses = bad;
  try { await b.close(); } catch (e) { /* noop */ }
  return R;
}
main().then((R) => {
  const s = JSON.stringify(R, null, 1); console.log(s); if (out) fs.writeFileSync(out, s);
  process.exit(0);
}, (e) => { console.error('E2E error: ' + (e && e.stack || e)); process.exit(1); });
