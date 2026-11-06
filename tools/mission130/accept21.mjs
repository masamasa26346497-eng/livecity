#!/usr/bin/env node
// Mission 130: PRIVATE per-ward Cesium WebGL acceptance for the 21 unrendered wards. Run where the extracted data already sits in a temp dir.
// Serves 127.0.0.1 only, read-only. Writes NOTHING except the optional --out (new file; refuses to overwrite). No screenshots saved, no upload.
// A ward is accepted only if: source found, tileset+GLB HTTP 200, no 404, Cesium3DTileset mounted+ready, real WebGL pixel diff (buildings on/off) >= 1%,
// and a REAL mouse click selects the target canonicalId, which is in the ids sidecar and inside the N03 ward polygon.
//   node tools/mission130/accept21.mjs --root <extracted-dir> [--wards a,b] [--out new.json] [--discover-only]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchBrowser } from '../lib/cdp-browser.js';
const require = createRequire(import.meta.url);
const L = require('./accept-lib.cjs');
const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
const root = opt('root'), only = opt('wards') ? opt('wards').split(',') : null, outFile = opt('out');
if (!root) { console.error('usage: --root <dir> [--wards a,b] [--out file] [--discover-only]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wards = L.target21().filter((w) => !only || only.includes(w.wardId));
const rows = wards.map((w) => ({ ward: w.wardId, wardCode: w.wardCode, source: null, verdict: null }));
console.log('root:', JSON.stringify(L.describeRoot(root)));
const map = {}, uris = {};
wards.forEach((w, i) => {
  const d = L.discoverWard(root, w.wardId);
  rows[i].source = d ? { found: !!d.dir, layout: d.layout, rel: d.rel } : { found: false, layout: 'none' };
  if (d && d.dir) { map[w.wardId] = d.dir; uris[w.wardId] = new Set(L.LAYOUT.contentUris(d.dir) || []); }
});
console.log('discovered:', Object.keys(map).length + '/' + wards.length, JSON.stringify(rows.map((r) => r.ward + '=' + r.source.layout)));
const finish = (extra) => {
  rows.forEach((r) => { r.verdict = L.verdict(r); });
  const s = L.summarize(rows, Object.assign({ discovered: Object.keys(map).length }, extra));
  if (outFile) {
    if (fs.existsSync(outFile)) { console.error('refusing to overwrite ' + outFile); process.exit(2); }
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(s, null, 1), { flag: 'wx' });
  }
  console.log(JSON.stringify({ ...s, rows: undefined }));
  console.log('| ward | source | tileset/glb 200 | 404 | mounted | pixel% | click | coverage | verdict |\n|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.ward} | ${r.source.layout} | ${r.http ? r.http.tileset200 + '/' + r.http.glb200 : '-'} | ${r.http ? r.http.notFound : '-'} | ${r.state || '-'} | ${r.pixels ? r.pixels.pct : '-'} | ${r.click ? (r.click.selected === r.click.target ? 'id-ok' : 'FAIL') : '-'} | ${r.coverage ? r.coverage.class + (r.coverage.ratio ? ' ' + r.coverage.ratio : '') : '-'} | ${r.verdict.accepted ? 'ACCEPTED' : 'NOT ACCEPTED: ' + r.verdict.why.join(',')} |`);
  process.exit(s.acceptedWards === s.targetWards ? 0 : 1);
};
if (a.includes('--discover-only') || !Object.keys(map).length) {
  if (!Object.keys(map).length) console.log('no ward directory with tileset.json found under the root; browser run skipped');
  finish({ browser: null, mode: a.includes('--discover-only') ? 'discover-only' : 'no-data' });
}
const hits = []; let port = 0;
const srv = L.makeServer(map, hits, () => port, uris);
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); port = srv.address().port;
const GOOGLE = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const meta = { browser: null, jsErrors: [], googleRequests: 0, failedRequests: [], webgl: null };
let b;
try {
  b = await launchBrowser({ width: 1280, height: 800 }); const page = b.page; meta.browser = b.version;
  page.on('Runtime.exceptionThrown', (e) => { try { meta.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 200)); } catch { /* noop */ } });
  page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE.test(new URL(e.request.url).hostname)) meta.googleRequests++; } catch { /* noop */ } });
  page.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/tile\.|cyberjapandata|favicon|layers\/|labels\.json|layers-report/.test(e.response.url)) meta.failedRequests.push(e.response.status + ' ' + new URL(e.response.url).pathname.slice(0, 80)); });
  const ev = (js) => page.evaluate(js), J = (js) => ev(`JSON.stringify(${js})`).then(JSON.parse);
  await page.send('Network.enable');
  const ext = Object.keys(map).map((w) => w + '25').join(',');
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/mission37g-osaka-24ward-mvp.html?qa=1&fac=0&ext=${ext}` });
  let up = false;
  for (let i = 0; i < 120; i++) { await sleep(1000); if (await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) { up = true; break; } }
  if (!up) throw new Error('viewer did not start (Cesium CDN or WebGL unavailable)');
  meta.webgl = await ev("(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); })()");
  await sleep(1500);
  const waitReady = async () => { for (let i = 0; i < 120; i++) { if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(500); } await sleep(1200); };
  const grab = async () => { await sleep(1500); return (await page.send('Page.captureScreenshot', { format: 'png' })).data; };
  const diff = (A, B) => ev(`(async () => JSON.stringify(await (async () => {
    const ld = async (d) => { const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + d)).blob()); const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };
    const P = await ld(${JSON.stringify(A)}), Q = await ld(${JSON.stringify(B)}); let d = 0; const n = P.width * P.height;
    for (let i = 0; i < n; i++) { if (Math.abs(P.data[i*4]-Q.data[i*4]) + Math.abs(P.data[i*4+1]-Q.data[i*4+1]) + Math.abs(P.data[i*4+2]-Q.data[i*4+2]) > 24) d++; }
    return { diff: d, pct: +(d / n * 100).toFixed(2) }; })()))()`).then(JSON.parse);
  for (let k = 0; k < wards.length; k++) {
    const w = wards[k], r = rows[k];
    if (!map[w.wardId]) continue;
    try {
      const data = L.loadWardData(map[w.wardId]);
      r.dupIds = data.dup; r.ids = data.ids.size; r.wardCodeInSource = (data.source && data.source.wardCode) || null;
      r.coverage = L.coverage(data.ids.size, w.sourceBuildings);
      const cands = Object.entries(data.byId).filter(([id, v]) => data.ids.has(id) && v[0] >= 20 && v[0] <= 120 && L.insideWard(w, v[2], v[3]));
      if (!cands.length) { r.note = 'no tall in-ward building in attrs'; continue; }
      let best = null;
      for (const c of cands.sort((p, q) => q[1][0] - p[1][0]).slice(0, 300)) {
        let n = 0; for (const o of cands) if (Math.hypot(c[1][2] - o[1][2], c[1][3] - o[1][3]) < 200) n++;
        if (!best || n > best.n) best = { id: c[0], h: c[1][0], x: c[1][2], z: c[1][3], n };
      }
      const code = r.wardCodeInSource || w.wardCode, look = () => ev(`window.__mission37dQA.lookAtLocal(${best.x}, ${best.z}, ${best.h / 2}, 500, -50, 0)`);
      await ev('window.__mission37dQA.setBuildingWard(null)'); await sleep(800); await look(); const A = await grab();
      const h0 = hits.length;
      await ev(`window.__mission37dQA.setBuildingWard('${code}')`); await waitReady(); await look(); await waitReady(); const B = await grab();
      const mine = hits.slice(h0).filter((h) => h.ward === w.wardId);
      r.http = { tileset200: mine.filter((h) => /tileset\.json$/.test(h.u) && h.s === 200).length, glb200: mine.filter((h) => /\.glb$/.test(h.u) && h.s === 200).length, notFound: mine.filter((h) => h.s === 404).length };
      r.tilesets = (await J('window.__mission37dQA.tilesetCount()')).n; r.state = await ev('window.__mission37g.buildingState');
      r.pixels = await diff(A, B);
      // real mouse click: find a screen point whose scene.pick is the target, then click with CDP input events
      let pt = null; const p0 = await J(`window.__mission37dQA.project(${best.x}, ${best.z}, ${best.h})`);
      if (p0) for (let dy = -60; dy <= 40 && !pt; dy += 8) for (let dx = -50; dx <= 50 && !pt; dx += 8) { const x = p0.x + dx, y = p0.y + dy; if ((await ev(`window.__mission37dQA.pickId(${x}, ${y})`)) === best.id) pt = { x, y }; }
      r.click = { target: best.id, attempted: !!pt, selected: null, idInSidecar: data.ids.has(best.id), insideWardPolygon: L.insideWard(w, best.x, best.z) };
      if (pt) {
        for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type: t, x: pt.x, y: pt.y, button: t === 'mouseMoved' ? 'none' : 'left', clickCount: t === 'mouseMoved' ? 0 : 1 });
        for (let i = 0; i < 20 && r.click.selected !== best.id; i++) { await sleep(500); r.click.selected = await ev('window.__mission37g.stats.selectedCanonicalId'); }
        r.click.selectedKey = await ev('window.__mission37g.stats.selectedKey');
      }
      console.log(JSON.stringify({ ward: r.ward, http: r.http, mounted: r.tilesets, state: r.state, px: r.pixels.pct, clickOk: r.click.selected === best.id }));
    } catch (e) { r.error = String(e.message || e).slice(0, 200); }
    await ev('window.__mission37dQA.setBuildingWard(null)').catch(() => {});
  }
} catch (e) { meta.fatal = String(e.message || e); }
finally { try { await b?.close?.(); } catch { /* noop */ } srv.close(); }
finish({ browser: meta.browser, webgl: meta.webgl, jsErrors: meta.jsErrors.length, jsErrorSamples: meta.jsErrors.slice(0, 3), googleRequests: meta.googleRequests, failedRequests: meta.failedRequests.slice(0, 10), fatal: meta.fatal || null, softwareRendering: 'headless software GL: timings are not device performance' });
