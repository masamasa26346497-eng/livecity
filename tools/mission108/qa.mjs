#!/usr/bin/env node
// Mission 108: read-only headless-Chrome QA over archives already verified by fetch-verify.mjs. Runs on 127.0.0.1 only.
//   node tools/mission108/qa.mjs --root <dir holding nishi25/ fukushima25/ ...> --wards nishi,fukushima,yodogawa --summary <qa-summary.json> [--port 8188]
// Per ward: tileset/GLB HTTP 200 counted server-side, WebGL readback pixel delta (tileset on/off), 3 real mouse clicks (pick-verified screen points),
// N03 containment (>=95%), road/water layer state (reported as-is; archives carry no layers -> "no-layers", never claimed), Google requests, JS errors.
// The summary contains counts and booleans only. It is NEVER acceptance: origin is ci-runner/local, Mission86 decides.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';
import { readOutput, pickClickTargets, insidePolygonStats, detectOrigin } from '../mission88-collect-evidence.mjs';

const GOOGLE = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Phase B (prepared): identical camera for building / road / water comparison. No coordinate shift is ever applied by this tool.
export const PHASE_B_VIEWS = [
  { name: 'top-2500', range: 2500, pitch: -90, heading: 0 },
  { name: 'oblique-1200', range: 1200, pitch: -45, heading: 30 },
];

export function startServer({ root, pub, ward, stats }) {
  const base = path.resolve(root, ward + '25');
  const srv = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
    let u; try { u = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.statusCode = 400; return res.end(); }
    const m = u.match(/^\/ext-3dtiles\/([a-z0-9]+)\/(.*)$/);
    let p;
    if (m) { p = m[1] === ward + '25' ? path.resolve(base, m[2]) : null; if (p && !p.startsWith(base + path.sep)) p = null; }
    else { p = path.resolve(pub, '.' + u); if (!p.startsWith(pub + path.sep)) p = null; }
    if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); if (m && !/(index\.json|layers-report\.json|labels\.json|layers\/)/.test(u)) stats.assetErrors.push('404 ' + u.slice(0, 80)); return; }
    if (m && /tileset\.json$/.test(u)) stats.tileset200++;
    if (m && /\.glb$/.test(u)) stats.glb200++;
    res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
    fs.createReadStream(p).pipe(res);
  });
  return srv;
}

export async function qaWard({ ward, root, polys, port }) {
  const out = { ward, status: 'failed', googleRequests: 0, jsErrors: 0 };
  const dir = path.join(root, ward + '25');
  const stats = { tileset200: 0, glb200: 0, assetErrors: [] };
  const { byId, idSet, idCount } = readOutput(dir);
  const src = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
  const w = polys.wards.find((x) => x.wardId === ward);
  if (!w) throw new Error('no N03 polygon for ' + ward);
  out.buildings = Object.keys(byId).length;
  // ids/*.json can also list group (LOD) members, so raw counts may exceed buildings; the contract is: unique id set == attrs id set.
  out.idsUnique = idSet.size === out.buildings && Object.keys(byId).every((id) => idSet.has(id));
  out.idListEntries = idCount;
  out.coverage = insidePolygonStats(Object.values(byId).map((a) => [a[2], a[3]]), w);
  const clicks = pickClickTargets(byId, 3);
  const srv = startServer({ root, pub: path.resolve('public'), ward, stats });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const { launchBrowser } = await import('../lib/cdp-browser.js');
  const b = await launchBrowser({ width: 1500, height: 940 });
  const page = b.page;
  const ev = (js) => page.evaluate(js);
  const J = (js) => ev('JSON.stringify(' + js + ')').then(JSON.parse);
  page.on('Runtime.exceptionThrown', () => { out.jsErrors++; });
  page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE.test(new URL(e.request.url).hostname)) out.googleRequests++; } catch { /* data: */ } });
  const ready = async () => { for (let i = 0; i < 120; i++) { if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(500); } await sleep(1000); };
  const click = async (x, y) => { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await page.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); };
  const diff = async (v, c) => {
    await ev('window.__mission37dQA.lookAtLocal(' + c.x + ',' + c.z + ',0,' + v.range + ',' + v.pitch + ',' + v.heading + ')'); await sleep(2500); await ready();
    if (!(await ev('typeof window.__mission37dQA.readbackCanvas === "function"'))) return { unsupported: true };
    return ev(`(async () => { const Q = window.__mission37dQA; const sl = (m) => new Promise((r) => setTimeout(r, m));
      const L = (u) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = u; });
      const px = async (u) => { const i = await L(u); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
      const A = await px(Q.readbackCanvas()); Q.setTilesetShow(false); await sl(1500); const B = await px(Q.readbackCanvas()); Q.setTilesetShow(true); await sl(1000);
      let n = 0; for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 30) n++;
      return { diffPx: n, totalPx: A.length / 4 }; })()`);
  };
  try {
    await page.send('Network.enable');
    await page.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/mission37g-osaka-24ward-mvp.html?qa=1&fac=0&nobuiltin=1&ext=' + ward + '25' });
    for (let i = 0; i < 90; i++) { await sleep(1000); if ((await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break; }
    await sleep(1500);
    await ev("window.__mission37dQA.setBuildingWard('" + src.wardCode + "')"); await ready();
    out.tilesets = await J('window.__mission37dQA.tilesetCount()');
    out.buildingState = await ev('window.__mission37g.buildingState');
    out.hudBuildings = await ev("document.getElementById('hs-bldg').textContent");
    if (clicks.length >= 3) {
      const c0 = clicks[0];
      out.pixelTop = await diff(PHASE_B_VIEWS[0], c0);
      out.pixelOblique = await diff(PHASE_B_VIEWS[1], c0);
      out.clicks = [];
      for (const t of clicks) {
        let rec = { realMouseClick: false, selected: false, idInOutput: idSet.has(t.id) };
        outer: for (const range of [250, 400]) {
          await ev('window.__mission37dQA.lookAtLocal(' + t.x + ',' + t.z + ',' + t.h / 2 + ',' + range + ',-50,0)'); await sleep(1500); await ready();
          for (const f of [0.5, 1, 0.1]) {
            const p = await J('window.__mission37dQA.project(' + t.x + ',' + t.z + ',' + t.h * f + ')');
            if (!p || !p.inCanvas) continue;
            for (const [dx, dy] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [10, 5], [-10, 5], [10, -5], [-10, -5], [18, 0], [-18, 0]]) {
              if ((await ev('window.__mission37dQA.pickId(' + (p.x + dx) + ',' + (p.y + dy) + ')')) !== t.id) continue;
              await click(p.x + dx, p.y + dy);
              for (let i = 0; i < 40; i++) { if ((await ev('window.__mission37g.selectedCanonicalId')) === t.id) break; await sleep(250); }
              rec = { realMouseClick: true, selected: (await ev('window.__mission37g.selectedCanonicalId')) === t.id, idInOutput: idSet.has(t.id) };
              break outer;
            }
          }
        }
        out.clicks.push(rec);
      }
    } else out.clicks = [];
    // Road / water: report what the page actually has. Archives carry no layers/ dir, so this stays unverified (never counted as accepted).
    out.roadWater = { state: await ev('(window.__mission37g.stats && window.__mission37g.stats.wardVec && window.__mission37g.stats.wardVec.state) || "none"').catch(() => 'none'), status: 'unverified', phaseB: { views: PHASE_B_VIEWS.map((v) => v.name), shiftApplied: false } };
    out.browser = b.version;
  } finally { try { await b.close?.(); } catch { /* noop */ } srv.close(); }
  out.http = { tileset200: stats.tileset200, glb200: stats.glb200, assetErrorCount: stats.assetErrors.length };
  const pass = (p) => p && !p.unsupported && p.diffPx > 0;
  out.checks = {
    tileset200: stats.tileset200 > 0, glb200: stats.glb200 > 0, idsUnique: out.idsUnique,
    pixelDelta: pass(out.pixelTop) && pass(out.pixelOblique),
    realClicks3of3: out.clicks.length === 3 && out.clicks.every((c) => c.realMouseClick && c.selected && c.idInOutput),
    n03Inside95: out.coverage && out.coverage.insideWardPolygonPct >= 95,
    noGoogle: out.googleRequests === 0, noJsErrors: out.jsErrors === 0, noAssetErrors: stats.assetErrors.length === 0,
  };
  out.status = Object.values(out.checks).every(Boolean) ? 'pass' : 'fail';
  return out;
}

async function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const wards = L.validateWards((opt('wards', '') || '').split(',').filter(Boolean));
  const root = path.resolve(opt('root', ''));
  const summaryPath = path.resolve(opt('summary', 'mission108-qa-summary.json'));
  const polys = JSON.parse(fs.readFileSync('data/processed/osaka-city/boundaries/ward-classification-polygons.json', 'utf8'));
  const summary = { mission: 108, kind: 'private-2025-headless-qa', origin: detectOrigin().origin, acceptance: false, note: 'headless software rendering; counts/booleans only; not acceptance, not a device value', wards: {} };
  let n = 0;
  for (const w of wards) {
    try { summary.wards[w] = await qaWard({ ward: w, root, polys, port: Number(opt('port', 8188)) + n++ }); }
    catch (e) { summary.wards[w] = { ward: w, status: 'error', error: String(e && e.message || e).slice(0, 200) }; }
  }
  summary.allPass = wards.every((w) => summary.wards[w].status === 'pass');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 1));
  console.log(JSON.stringify({ allPass: summary.allPass, wards: Object.fromEntries(Object.entries(summary.wards).map(([k, v]) => [k, v.status])) }));
  process.exitCode = summary.allPass ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error('FAILED', String(e && e.message).slice(0, 200)); process.exit(1); });
