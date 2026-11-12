// tools/experiments/mission160_nishi2025_browser.mjs
// [Mission 160] Real-browser (Chrome/Edge via CDP) acceptance of the locally built PLATEAU 2025 Nishi tileset, served read-only on 127.0.0.1.
//   node tools/experiments/mission160_nishi2025_browser.mjs --root temp/mission79 [--shots] [--out <json>]
// Checks: tileset.json/GLB HTTP 200 (and no 404), tileset mounted from /ext-3dtiles/nishi-2025/, detail (tiles/) vs coarse (lod/) GLBs actually requested at
// near/far camera, pixel difference with the ward OFF vs ON, JS errors, Google traffic, building canonicalId pick, source vintage, ward-polygon/coverage.
// "LOD1/LOD2" here means the tileset's detail tiles vs its simplified group LOD; the CityGML source is LOD1 only (Mission 79).
// The report records the browser version and whether the run is on a fixture. A run on a fixture, or on CI headless, is NOT owner-PC acceptance.
// Read-only: the tileset dir is never written. headless = software rendering; timings are not real-device performance.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchBrowser } from '../lib/cdp-browser.js';
const require = createRequire(import.meta.url);
const { makeServer } = require('../mission40f-serve-local.cjs');
const { audit } = require('../mission160/nishi2025-audit.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const get = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const root = path.resolve(get('--root', path.join('temp', 'mission79')));
const NAME = 'nishi-2025', dir = path.join(root, NAME);
const outFile = get('--out', path.join('data', 'reports', 'mission160-nishi2025', 'browser-local.json'));
const GOOGLE = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;

const out = { mission: '160', scope: 'browser', generatedAt: new Date().toISOString(), root, fixture: args.includes('--fixture'),
  ownerPcAcceptance: false, note: 'ownerPcAcceptance is set true only by a human after viewing the page on the owner PC. This tool never sets it.',
  static: null, http: { tileset200: 0, detailGlb200: 0, coarseGlb200: 0, notFound: [] }, errors: [], google: [] };
const finish = (code) => {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ pass: out.pass, report: outFile, fixture: out.fixture, failed: out.failed }, null, 1));
  process.exit(code);
};
if (!fs.existsSync(path.join(dir, 'tileset.json'))) { out.pass = false; out.failed = ['tileset-not-found: ' + dir]; finish(2); }

out.static = audit(dir, { fixture: out.fixture });
const att = new Map();
for (const f of fs.readdirSync(path.join(dir, 'attrs'))) for (const [id, a] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, 'attrs', f), 'utf8')).byId)) att.set(id, a);
// pick-target: tallest building with height 20..120 m (a stable, clickable one)
const target = [...att.entries()].filter(([, a]) => a[0] >= 20 && a[0] <= 120).sort((p, q) => q[1][0] - p[1][0])[0];

const server = makeServer({ publicDir: path.resolve('public'), extDir: root });
server.on('request', (req, res) => {
  const u = (req.url || '').split('?')[0];
  res.on('finish', () => {
    if (!u.startsWith('/ext-3dtiles/' + NAME + '/')) return;
    if (res.statusCode === 404) out.http.notFound.push(u);
    else if (res.statusCode === 200) {
      if (/\/tileset\.json$/.test(u)) out.http.tileset200++;
      else if (/\/tiles\/.*\.glb$/.test(u)) out.http.detailGlb200++;
      else if (/\/lod\/.*\.glb$/.test(u)) out.http.coarseGlb200++;
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const URL_ = 'http://127.0.0.1:' + PORT + '/mission37g-osaka-24ward-mvp.html?qa=1&fac=0&ext=' + NAME;

let b;
try { b = await launchBrowser({ width: 1280, height: 800 }); } catch (e) { out.pass = false; out.failed = ['browser-launch: ' + e.message]; server.close(); finish(1); }
const page = b.page; out.browser = b.version;
page.on('Runtime.exceptionThrown', (e) => { try { out.errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE.test(new URL(e.request.url).hostname)) out.google.push(e.request.url); } catch { /* data: */ } });
const ev = (js) => page.evaluate(js);
const J = (js) => ev('JSON.stringify(' + js + ')').then(JSON.parse);
async function ready() { for (let i = 0; i < 120; i++) { if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(500); } await sleep(1500); }
async function shot() { await sleep(1500); return (await page.send('Page.captureScreenshot', { format: 'png' })).data; }
async function diff(a64, b64) {
  return ev('(async () => JSON.stringify(await (async () => {' +
    'const load = async (d) => { const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + d)).blob()); const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext("2d"); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };' +
    'const A = await load(' + JSON.stringify(a64) + '), B = await load(' + JSON.stringify(b64) + '); let n = 0; const N = A.width * A.height;' +
    'for (let i = 0; i < N; i++) { const d = Math.abs(A.data[i*4]-B.data[i*4]) + Math.abs(A.data[i*4+1]-B.data[i*4+1]) + Math.abs(A.data[i*4+2]-B.data[i*4+2]); if (d > 24) n++; }' +
    'return { w: A.width, h: A.height, diffPx: n, pct: +(n / N * 100).toFixed(2) }; })()))()').then(JSON.parse);
}
try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  let up = false;
  for (let i = 0; i < 90; i++) { await sleep(1000); if (await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) { up = true; break; } }
  if (!up) throw new Error('viewer did not start (CesiumJS CDN unreachable or WebGL unavailable)');
  out.webgl = await ev("(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); })()");
  const cov = await J('window.__mission37g.coverage || null').catch(() => null);
  out.viewerCoverage = cov;
  // far (coarse LOD expected) view, ward OFF baseline then ON
  const lx = target[1][2], lz = target[1][3], lh = target[1][0] / 2;
  await ev('window.__mission37dQA.setBuildingWard(null)'); await sleep(800);
  await ev('window.__mission37dQA.lookAtLocal(' + lx + ',' + lz + ',' + lh + ',600,-45,0)');
  const A = await shot();
  await ev("window.__mission37dQA.setBuildingWard('27106')");
  await ev('window.__mission37dQA.lookAtLocal(' + lx + ',' + lz + ',' + lh + ',6000,-60,0)'); await ready();
  const coarseAtFar = out.http.coarseGlb200;
  await ev('window.__mission37dQA.lookAtLocal(' + lx + ',' + lz + ',' + lh + ',600,-45,0)'); await ready();
  const B = await shot();
  out.mounted = await J('window.__mission37dQA.tilesetCount()');
  out.state = await ev('window.__mission37g.buildingState');
  out.lod = { coarseGlb200AfterFarView: coarseAtFar, coarseGlb200Total: out.http.coarseGlb200, detailGlb200Total: out.http.detailGlb200 };
  out.pixels = await diff(A, B);
  if (args.includes('--shots')) { fs.mkdirSync('temp/mission160', { recursive: true }); fs.writeFileSync('temp/mission160/off.png', Buffer.from(A, 'base64')); fs.writeFileSync('temp/mission160/on.png', Buffer.from(B, 'base64')); }
  // canonicalId via REAL mouse clicks (CDP Input.dispatchMouseEvent) at screen points from the read-only probe144 hook; up to 12 tall buildings.
  // Pass = a click selects a canonicalId that exists in this tileset's attrs. Clicked target and selected id are both recorded.
  out.pick = { attempts: [], selectedFromTileset: null };
  const cands = [...att.entries()].filter(([, a]) => a[0] >= 25 && a[0] <= 120)
    .sort((p, q) => Math.hypot(p[1][2] - lx, p[1][3] - lz) - Math.hypot(q[1][2] - lx, q[1][3] - lz)).slice(0, 12);
  for (const [id, a] of cands) {
    await ev('window.__mission37dQA.lookAtLocal(' + a[2] + ',' + a[3] + ',' + (a[0] / 2) + ',500,-50,0)'); await ready();
    const pr = await J('window.__mission37dQA.probe144(' + a[2] + ',' + a[3] + ')');
    if (!pr || !pr.screen) { out.pick.attempts.push({ target: id, screen: null }); continue; }
    for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) {
      await page.send('Input.dispatchMouseEvent', { type, x: pr.screen.x, y: pr.screen.y, ...extra });
    }
    await sleep(1500);
    const sel = await ev('window.__mission37g.selectedCanonicalId');
    out.pick.attempts.push({ target: id, screen: pr.screen, selected: sel, exact: sel === id, inTileset: !!(sel && att.has(sel)) });
    if (sel && att.has(sel)) { out.pick.selectedFromTileset = sel; break; }
  }
} catch (e) { out.error = String(e.message || e); }
finally { try { await b.close?.(); } catch { /* noop */ } server.close(); }

const f = [];
if (out.error) f.push('error: ' + out.error);
if (!out.static.pass) f.push('static-audit: ' + out.static.failed.join('; '));
if (out.http.tileset200 < 1) f.push('tileset.json never served 200 under /ext-3dtiles/' + NAME);
if (out.http.detailGlb200 < 1) f.push('no detail GLB served 200');
if (out.http.coarseGlb200 < 1) f.push('no coarse-LOD GLB served 200');
if (out.http.notFound.length) f.push('404: ' + out.http.notFound.slice(0, 3).join(','));
if (!(out.mounted && (out.mounted.bases || []).some((x) => x && x.includes('ext-3dtiles/' + NAME)))) f.push('tileset not mounted from ext-3dtiles/' + NAME);
if (!out.pixels || out.pixels.pct < 1) f.push('pixel difference ward OFF vs ON < 1%');
if (out.errors.length) f.push('JS errors: ' + out.errors.length);
if (out.google.length) f.push('Google traffic: ' + out.google.length);
if (!out.pick || !out.pick.selectedFromTileset) f.push('no real click selected a canonicalId from this tileset');
out.failed = f; out.pass = f.length === 0;
finish(out.pass ? 0 : 1);
