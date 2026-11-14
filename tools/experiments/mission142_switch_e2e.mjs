// Mission 142: real Chrome (CDP) E2E of the Mission 141 launcher on the CANONICAL page: 2+ wards, switch, switch back, reselect.
//   node tools/experiments/mission142_switch_e2e.mjs
// FIXTURE, not owner data: the ward tilesets are copies of the repo's committed REAL PLATEAU 2024 samples (kita, chuo) placed under the 2025 names
// (kita25 / chuo25) in a temp root, so the launcher's validation + serving + page switching path is exercised end to end. They are NOT 2025 data and say nothing
// about the owner's private release. The road/water layers for kita are SYNTHETIC lines (cloned schema, invented geometry) written to a temp layers-root to test
// wiring only: they are never real roads/rivers. chuo gets no layers on purpose (must report "no-layers", not draw anything).
// headless Chrome = software rendering: timings are not device values. This is NOT a Windows run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from '../lib/cdp-browser.js';

const PORT = 8191, OUT = 'data/reports/mission142';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const SAMPLES = { kita: 'public/mission37h-3dtiles/kita-sample', chuo: 'public/mission37h-3dtiles/chuo-sample' };

// ---- fixture ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm142-'));
const dataRoot = path.join(tmp, 'data'), layersRoot = path.join(tmp, 'layers');
for (const [w, src] of Object.entries(SAMPLES)) fs.cpSync(src, path.join(dataRoot, w + '25'), { recursive: true });
const attrsOf = (w) => { const d = path.join(dataRoot, w + '25', 'attrs'), byId = {}; for (const f of fs.readdirSync(d)) Object.assign(byId, JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')).byId); return byId; };
const srcOf = (w) => JSON.parse(fs.readFileSync(path.join(dataRoot, w + '25', 'source.json'), 'utf8'));
const pickTargets = (w) => Object.entries(attrsOf(w)).filter(([, a]) => a[0] >= 30 && a[0] <= 120).sort((a, b) => b[1][0] - a[1][0]).slice(0, 3).map(([id, a]) => ({ id, h: a[0], x: a[2], z: a[3] }));
const T = { kita: pickTargets('kita'), chuo: pickTargets('chuo') };
{
  const real = (f) => JSON.parse(fs.readFileSync('public/mission37c-layers/osaka-sumiyoshi-9tile/' + f, 'utf8'));
  const roads = real('roads.json'), water = real('waterways.json');
  const c = T.kita[0], d = path.join(layersRoot, 'kita', 'layers'); fs.mkdirSync(d, { recursive: true });
  const bbox = { minX: c.x - 400, maxX: c.x + 400, minZ: c.z - 400, maxZ: c.z + 400 };
  const hdr = (base, n) => { const { features, ...h } = base; return { ...h, mission: '142-SYNTHETIC-FIXTURE', source: 'SYNTHETIC test geometry; NOT real roads', bboxLocal: bbox, count: n }; };
  const rf = { ...roads.features.find((f) => f.tier === 'major'), id: 'road_synthetic_1', name: 'SYNTHETIC', p: [[c.x - 350, c.z + 60], [c.x, c.z + 60], [c.x + 350, c.z + 60]] };
  const wf = { ...water.features[0], id: 'water_synthetic_1', name: 'SYNTHETIC', p: [[c.x - 350, c.z - 90], [c.x, c.z - 90], [c.x + 350, c.z - 90]] };
  fs.writeFileSync(path.join(d, 'roads.json'), JSON.stringify({ ...hdr(roads, 1), features: [rf] }));
  fs.writeFileSync(path.join(d, 'waterways.json'), JSON.stringify({ ...hdr(water, 1), features: [wf] }));
  fs.writeFileSync(path.join(d, 'layers-report.json'), JSON.stringify({ schema: 'synthetic-fixture', synthetic: true, ward: 'kita', layers: { roads: 1, waterways: 1 } }));
}

// ---- launcher ----
const child = spawn(process.execPath, ['tools/mission141-local-24.mjs', '--no-fetch', '--root', dataRoot, '--layers-root', layersRoot, '--wards', 'kita,chuo,konohana', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
let url = null;
for (let i = 0; i < 120 && !url; i++) { await sleep(250); const m = log.match(/\[141\] open: (\S+)/); if (m) url = m[1]; if (child.exitCode != null) break; }
if (!url) { console.error('launcher did not print a URL\n' + log.slice(-1200)); process.exit(1); }

const out = { mission: '142', fixture: 'repo PLATEAU 2024 samples renamed kita25/chuo25 + SYNTHETIC kita road/water; not owner data; not Windows', headless: true, url,
  launcherLog: log.split('\n').filter((l) => /\[141\]|kita|chuo|konohana/.test(l)).slice(0, 14), googleRequests: [], httpErrors: [], jsErrors: [], steps: [] };
const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE.test(new URL(e.request.url).hostname)) out.googleRequests.push(e.request.url); } catch { /* data: */ } });
page.on('Network.responseReceived', (e) => { const u = e.response.url; if (u.includes('127.0.0.1:' + PORT) && e.response.status >= 400) out.httpErrors.push(e.response.status + ' ' + u.replace(/^.*?:\d+/, '')); });
const ev = (js) => page.evaluate(js);
const J = (js) => ev(`JSON.stringify(${js})`).then(JSON.parse);
const shot = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name + '.jpg'), Buffer.from(data, 'base64')); return data; };
async function click(x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function waitReady() { for (let i = 0; i < 120; i++) { if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(500); } await sleep(1200); }
async function diffPx(a, b2) {
  return ev(`(async () => { const L = (d) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/jpeg;base64,' + d; });
    const [a, b] = await Promise.all([L(${JSON.stringify(a)}), L(${JSON.stringify(b2)})]); const c = document.createElement('canvas'); c.width = a.width; c.height = a.height; const g = c.getContext('2d');
    g.drawImage(a, 0, 0); const A = g.getImageData(0, 0, c.width, c.height).data; g.drawImage(b, 0, 0); const B = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 30) n++; return n; })()`);
}
const snap = () => J('({ ts: window.__mission37dQA.tilesetCount(), state: window.__mission37g.buildingState, ward: window.__mission37g.buildingWard, hud: document.getElementById("hs-bldg").textContent, vec: window.__mission37g.wardVec, unmounted: (window.__mission37g.extraUnmountedTotal | 0) + (window.__mission37g.baseUnmountedTotal | 0) })');
async function selectWard(w) {
  await ev(`window.__mission37dQA.setBuildingWard('${srcOf(w).wardCode}')`); await waitReady();
  for (let i = 0; i < 40; i++) { const s = await snap(); if (s.vec && s.vec.state !== 'loading') break; await sleep(250); }
  return snap();
}
async function realClick(t) {
  for (const range of [250, 400]) {
    await ev(`window.__mission37dQA.lookAtLocal(${t.x}, ${t.z}, ${t.h / 2}, ${range}, -50, 0)`); await sleep(1500); await waitReady();
    for (const f of [0.5, 1, 0.1]) {
      const p = await J(`window.__mission37dQA.project(${t.x}, ${t.z}, ${t.h * f})`);
      if (!p || !p.inCanvas) continue;
      for (const [dx, dy] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [10, 5], [-10, 5], [10, -5], [-10, -5], [18, 0], [-18, 0]]) {
        if ((await ev(`window.__mission37dQA.pickId(${p.x + dx}, ${p.y + dy})`)) !== t.id) continue;
        await click(p.x + dx, p.y + dy);
        for (let i = 0; i < 40; i++) { if ((await ev('window.__mission37g.selectedCanonicalId')) === t.id) break; await sleep(250); }
        return { id: t.id, realMouseClick: true, selected: (await ev('window.__mission37g.selectedCanonicalId')) === t.id };
      }
    }
  }
  return { id: t.id, realMouseClick: false, selected: false };
}
const step = (name, data) => { out.steps.push({ name, ...data }); };

try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: url.replace('&ext45=1', '&ext45=1&qa=1&fac=0') });
  for (let i = 0; i < 90; i++) { await sleep(1000); if ((await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break; }
  await sleep(1500);
  out.index = await ev("fetch('ext-3dtiles/index.json').then((r) => r.json())");
  step('boot', await snap());

  // 1) kita: tileset + GLB, canvas pixels, click, road/water layers
  const s1 = await selectWard('kita');
  const c = T.kita[0];
  await ev(`window.__mission37dQA.lookAtLocal(${c.x}, ${c.z}, 0, 1500, -90, 0)`); await sleep(2500); await waitReady();
  const on = await shot('kita-top-on');
  await ev('window.__mission37dQA.setTilesetShow(false)'); await sleep(1500);
  const off = await shot('kita-top-tileset-off');
  await ev('window.__mission37dQA.setTilesetShow(true)'); await sleep(1200);
  const buildingsPx = await diffPx(on, off);
  await ev("window.__mission37dQA.setLayer('roads', false)"); await sleep(1500); const roadsOff = await shot('kita-roads-off');
  await ev("window.__mission37dQA.setLayer('roads', true)"); await sleep(1200);
  await ev("window.__mission37dQA.setLayer('waterways', false)"); await sleep(1500); const waterOff = await shot('kita-water-off');
  await ev("window.__mission37dQA.setLayer('waterways', true)"); await sleep(1200);
  const allOn = await shot('kita-layers-on');
  const roadsPx = await diffPx(allOn, roadsOff), waterPx = await diffPx(allOn, waterOff);
  const clicks1 = []; for (const t of T.kita) clicks1.push(await realClick(t));
  step('select-kita', { ...s1, buildingsDiffPx: buildingsPx, roadsToggleDiffPx: roadsPx, waterToggleDiffPx: waterPx, clicks: clicks1 });

  // 2) chuo: kita must be disposed; chuo has no layers
  const s2 = await selectWard('chuo');
  const clicks2 = []; for (const t of T.chuo.slice(0, 2)) clicks2.push(await realClick(t));
  await shot('chuo-click');
  step('select-chuo', { ...s2, clicks: clicks2 });

  // 3) back to kita (re-select): layers return
  const s3 = await selectWard('kita');
  const clicks3 = [await realClick(T.kita[1])];
  step('reselect-kita', { ...s3, clicks: clicks3 });

  // 4) clear
  await ev("window.__mission37dQA.setBuildingWard(null)"); await sleep(1500);
  step('clear', await snap());
} catch (e) { out.fatal = String(e && e.stack || e); }
child.kill('SIGINT'); for (let i = 0; i < 20 && child.exitCode == null; i++) await sleep(250);
const sm = log.match(/stopped\. (\{.*\})/); out.serverStats = sm ? JSON.parse(sm[1]) : null;
const S = (n) => out.steps.find((s) => s.name === n) || {};
const okClicks = (s) => (s.clicks || []).length > 0 && (s.clicks || []).every((c) => c.selected);
const checks = {
  loopbackOnly: /loopback only/.test(log),
  notDeliveredListed: /NOT DELIVERED[^\n]*konohana/.test(log),
  indexHasTwoWards: out.index?.wards?.length === 2 && out.index?.layersWards?.length === 1 && out.index.layersWards[0].ward === 'kita25',
  bootNoTileset: S('boot').ts?.n === 0,
  kitaOneTileset: S('select-kita').ts?.n === 1 && S('select-kita').state === 'ready' && String(S('select-kita').ts?.bases || '').includes('kita25'),
  kitaPixels: S('select-kita').buildingsDiffPx > 5000,
  kitaClicks: okClicks(S('select-kita')),
  kitaRoadsDrawn: S('select-kita').vec?.state === 'ready' && S('select-kita').vec?.layers?.roads >= 1 && S('select-kita').roadsToggleDiffPx > 50,
  kitaWaterDrawn: S('select-kita').vec?.layers?.waterways >= 1 && S('select-kita').waterToggleDiffPx > 50,
  chuoOneTilesetKitaDisposed: S('select-chuo').ts?.n === 1 && String(S('select-chuo').ts?.bases || '').includes('chuo25') && !String(S('select-chuo').ts?.bases || '').includes('kita25') && S('select-chuo').unmounted > S('select-kita').unmounted,
  chuoClicks: okClicks(S('select-chuo')),
  chuoNoLayersNotInvented: S('select-chuo').vec?.state === 'no-layers',
  reselectKita: S('reselect-kita').ts?.n === 1 && String(S('reselect-kita').ts?.bases || '').includes('kita25') && S('reselect-kita').vec?.state === 'ready' && okClicks(S('reselect-kita')),
  clearedToZero: S('clear').ts?.n === 0,
  glbAndTileset200: (out.serverStats?.glb200 || 0) > 0 && (out.serverStats?.tileset200 || 0) >= 3,
  noJsErrors: out.jsErrors.length === 0,
  noGoogle: out.googleRequests.length === 0,
  no404ExceptExpected: out.httpErrors.every((x) => /(favicon|parks\.json|railways\.json|labels\.json|layers-report\.json|status\.json|konohana)/.test(x)),
};
out.checks = checks; out.pass = !out.fatal && Object.values(checks).every(Boolean);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'e2e.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ pass: out.pass, checks, httpErrors: out.httpErrors.slice(0, 8), jsErrors: out.jsErrors.slice(0, 3), fatal: out.fatal && out.fatal.slice(0, 300), serverStats: out.serverStats }, null, 1));
await b.close?.(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(out.pass ? 0 : 1);
