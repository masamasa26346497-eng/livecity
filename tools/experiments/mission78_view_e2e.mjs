// [Mission 78] Before/After of default pitch on tracked Sumiyoshi data: measured roof parallax (parallax74), tile selection and frame time at far/mid/near.
// Headless = software rendering: frame times are NOT device FPS. Usage: node tools/experiments/mission78_view_e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT = 'data/reports/mission78-view';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve('public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8144, r));
const dir = 'public/mission37c-layers/osaka-sumiyoshi-9tile/';
const byId = {};
for (const f of fs.readdirSync(dir + 'attrs')) Object.assign(byId, JSON.parse(fs.readFileSync(dir + 'attrs/' + f, 'utf8')).byId);
const t = Object.entries(byId).filter(([, a]) => a[0] >= 40 && a[0] <= 120).sort((a, b) => b[1][0] - a[1][0])[0];
const tgt = { id: t[0], h: t[1][0], x: t[1][2], z: t[1][3] };
const b = await launchBrowser({ width: 1400, height: 900 });
const page = b.page;
const out = { mission: '78', browser: b.version, target: tgt, jsErrors: [], googleRequests: [], failed: [], rows: [], note: 'headless software rendering; frame times are not device FPS' };
page.on('Runtime.exceptionThrown', (e) => { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); });
page.on('Network.requestWillBeSent', (e) => { try { if (/(googleapis|google|gstatic)\.com$/i.test(new URL(e.request.url).hostname)) out.googleRequests.push(e.request.url); } catch (x) { /* data: */ } });
page.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/tile\.|cyberjapandata/.test(e.response.url)) out.failed.push(e.response.status + ' ' + e.response.url); });
const ev = (js) => page.evaluate(js);
const J = (js) => ev('JSON.stringify(' + js + ')').then(JSON.parse);
await page.send('Page.navigate', { url: 'http://localhost:8144/mission37g-osaka-24ward-mvp.html?qa=1&fac=0&bw=27120' });
for (let i = 0; i < 90; i++) { if (await ev('window.__mission37dQA && window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(500); }
await sleep(1000);
out.defaults = await J('window.LC78 ? { def: LC78.DEFAULT_PITCH_DEG, sel: LC78.SELECT_PITCH_DEG } : null');
const VIEWS = [['far', 2500], ['mid', 700], ['near', 250]];
const PITCHES = [['before-45', -45], ['before-55', -55], ['before-62', -62], ['after-68', -68]];
const FT = '(new Promise((r) => { const d = []; let l = performance.now(), n = 0; const f = () => { const t = performance.now(); d.push(t - l); l = t; if (++n < 20) requestAnimationFrame(f); else { d.sort((a, b) => a - b); r(JSON.stringify({ p50: +d[10].toFixed(1), p95: +d[18].toFixed(1) })); } }; requestAnimationFrame(f); }))';
for (const [vn, range] of VIEWS) {
  for (const [pn, pitch] of PITCHES) {
    await ev('window.__mission37dQA.lookAtLocal(' + [tgt.x, tgt.z, tgt.h / 2, range, pitch, 0].join(',') + ')');
    await sleep(2500);
    for (let i = 0; i < 40; i++) { if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(400); }
    const par = await J('window.__mission37dQA.parallax74(12,8)');
    const ft = JSON.parse(await ev(FT));
    const st = await J('({ vt: window.__mission37g.visibleTiles, vb: window.__mission37g.visibleBuildings, loaded: window.__mission37g.loadedTilesTotal })');
    out.rows.push({ view: vn, rangeM: range, variant: pn, pitch, samples: par.samples, shiftP50M: par.predictedApparentShiftM.p50, shiftP95M: par.predictedApparentShiftM.p95, frameMs: ft, visibleTiles: st.vt, visibleBuildings: st.vb, loadedTilesTotal: st.loaded });
    if (vn !== 'far') {
      const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
      fs.writeFileSync(path.join(OUT, vn + '-' + pn + '.jpg'), Buffer.from(data, 'base64'));
    }
  }
}
fs.writeFileSync(path.join(OUT, 'e2e.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ defaults: out.defaults, rows: out.rows, js: out.jsErrors.length, google: out.googleRequests.length, failed: out.failed }, null, 1));
srv.close();
process.exit(0);
