// Mission 144: read-only real-Chrome (CDP) ACCEPTANCE of road / river layers on the canonical page (?nobuiltin=1&ext45=1&qa=1), per ward.
//   Owner PC, real data, one command (own port, an already running launcher on 8137 is NOT touched):
//     node tools/experiments/mission144_acceptance_e2e.mjs --root C:\lc141 [--layers-root <dir>|auto] [--sample 6|all] [--wards a,b] [--port 8192] [--out <dir>]
//   Any other flag is passed to tools/mission141-local-24.mjs (e.g. --build-layers --src ...). Needs Chrome/Edge (tools/lib/cdp-browser.js).
//   Sandbox self-test with committed samples:  node tools/experiments/mission144_acceptance_e2e.mjs --fixture
//     --fixture uses repo PLATEAU 2024 samples renamed kita25/chuo25 and SYNTHETIC road/river lines: it proves the harness, NOT owner data.
//     Its report says acceptance:"fixture" and must never be quoted as a real-data result.
// Per ward it measures: layer files fetched with HTTP status, scene primitive counts, pixel difference when roads / waterways are toggled OFF/ON
// (top-down, same camera), lon/lat of the page vs the shared projection constants, pickPosition round trip, ground height vs layer heights,
// road-vs-building overlap (needs --root on disk), disposal of the previous ward, JS errors, Google traffic. headless = software rendering, no FPS claims.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchBrowser } from '../lib/cdp-browser.js';
const require = createRequire(import.meta.url);
const L = require('../mission144-lib.cjs');

const argv = process.argv.slice(2);
const take = (k, def = null) => { const i = argv.indexOf(k); if (i < 0) return def; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (k) => { const i = argv.indexOf(k); if (i < 0) return false; argv.splice(i, 1); return true; };
const FIXTURE = flag('--fixture');
const PORT = Number(take('--port', '8192')), OUT = take('--out', 'data/reports/mission144'), SAMPLE = take('--sample', '6'), ONLY = take('--wards');
let ROOT = take('--root'), LROOT = take('--layers-root');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

if (FIXTURE) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm144-'));
  ROOT = path.join(tmp, 'data'); LROOT = path.join(tmp, 'layers');
  for (const [w, s] of Object.entries({ kita: 'public/mission37h-3dtiles/kita-sample', chuo: 'public/mission37h-3dtiles/chuo-sample' })) fs.cpSync(s, path.join(ROOT, w + '25'), { recursive: true });
  const real = (f) => readJson('public/mission37c-layers/osaka-sumiyoshi-9tile/' + f);
  const roads = real('roads.json'), water = real('waterways.json');
  for (const w of ['kita', 'chuo']) {
    const att = {}; for (const f of fs.readdirSync(path.join(ROOT, w + '25', 'attrs'))) Object.assign(att, readJson(path.join(ROOT, w + '25', 'attrs', f)).byId);
    const c = Object.values(att).filter((a) => a[0] >= 30).map((a) => ({ x: a[2], z: a[3] }))[0];
    const d = path.join(LROOT, w, 'layers'); fs.mkdirSync(d, { recursive: true });
    const bbox = { minX: c.x - 400, maxX: c.x + 400, minZ: c.z - 400, maxZ: c.z + 400 };
    const hdr = (base) => { const { features, ...h } = base; return { ...h, mission: '144-SYNTHETIC-FIXTURE', source: 'SYNTHETIC test geometry; NOT real', bboxLocal: bbox }; };
    const rf = { ...roads.features.find((f) => f.tier === 'major'), id: 'road_syn_' + w, name: 'SYNTHETIC', p: [[c.x - 350, c.z + 60], [c.x, c.z + 60], [c.x + 350, c.z + 60]] };
    const wf = { ...water.features[0], id: 'water_syn_' + w, name: 'SYNTHETIC', p: [[c.x - 350, c.z - 90], [c.x, c.z - 90], [c.x + 350, c.z - 90]] };
    fs.writeFileSync(path.join(d, 'roads.json'), JSON.stringify({ ...hdr(roads), count: 1, features: [rf] }));
    fs.writeFileSync(path.join(d, 'waterways.json'), JSON.stringify({ ...hdr(water), count: 1, features: [wf] }));
    fs.writeFileSync(path.join(d, 'layers-report.json'), JSON.stringify({ synthetic: true }));
  }
}

const lArgs = ['tools/mission141-local-24.mjs', '--port', String(PORT)];
if (ROOT) lArgs.push('--root', ROOT); if (LROOT && LROOT !== 'auto') lArgs.push('--layers-root', LROOT);
if (FIXTURE) lArgs.push('--no-fetch'); if (ONLY) lArgs.push('--wards', ONLY);
lArgs.push(...argv);
const child = spawn(process.execPath, lArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => { log += d; process.stdout.write(d); }); child.stderr.on('data', (d) => { log += d; process.stderr.write(d); });
let url = null;
for (let i = 0; i < 2400 && !url; i++) { await sleep(250); const m = log.match(/\[141\] open: (\S+)/); if (m) url = m[1]; if (child.exitCode != null) break; }
if (!url) { console.error('launcher did not print a URL (see output above; if port ' + PORT + ' is busy use --port).'); process.exit(1); }

const out = { mission: '144', acceptance: FIXTURE ? 'fixture' : 'real-data-candidate', headless: true, url, googleRequests: [], httpErrors: [], layerFetches: [], jsErrors: [], wards: [], notes: [] };
const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE.test(new URL(e.request.url).hostname)) out.googleRequests.push(e.request.url); } catch { /* data: */ } });
page.on('Network.responseReceived', (e) => {
  const u = e.response.url; if (!u.includes('127.0.0.1:' + PORT)) return;
  const rel = u.replace(/^.*?:\d+/, '');
  if (/\/layers\/[a-z-]+\.json/.test(rel)) out.layerFetches.push({ url: rel, status: e.response.status });
  if (e.response.status >= 400 && !/favicon/.test(rel)) {
    // an optional layer file the ward simply does not have (404) is "absent", not an error; roads/waterways/anything else 4xx/5xx is an error
    if (e.response.status === 404 && /\/layers\/(water-surface|parks|railways|labels)\.json$/.test(rel)) out.optionalAbsent404 = (out.optionalAbsent404 || 0) + 1;
    else out.httpErrors.push(e.response.status + ' ' + rel);
  }
});
const ev = (js) => page.evaluate(js);
const J = (js) => ev(`JSON.stringify(${js})`).then((s) => (s === undefined ? null : JSON.parse(s)));
const shot = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name + '.jpg'), Buffer.from(data, 'base64')); return data; };
async function diffPx(a, c) {
  return ev(`(async () => { const L = (d) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/jpeg;base64,' + d; });
    const [a, b] = await Promise.all([L(${JSON.stringify(a)}), L(${JSON.stringify(c)})]); const cv = document.createElement('canvas'); cv.width = a.width; cv.height = a.height; const g = cv.getContext('2d');
    g.drawImage(a, 0, 0); const A = g.getImageData(0, 0, cv.width, cv.height).data; g.drawImage(b, 0, 0); const B = g.getImageData(0, 0, cv.width, cv.height).data; let n = 0;
    for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 30) n++; return n; })()`);
}
async function waitReady() { for (let i = 0; i < 160; i++) { if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(500); } await sleep(1200); }
const snap = () => J('({ ts: window.__mission37dQA.tilesetCount(), state: window.__mission37g.buildingState, ward: window.__mission37g.buildingWard, vec: window.__mission37g.wardVec })');

try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: url.replace('&ext45=1', '&ext45=1&qa=1&fac=0') });
  for (let i = 0; i < 120; i++) { await sleep(1000); if ((await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break; }
  await sleep(1500);
  const index = await ev("fetch('ext-3dtiles/index.json').then((r) => r.json())");
  const layerKeys = (index.layersWards || []).map((x) => x.ward);
  out.served = (index.wards || []).length; out.wardsWithLayers = layerKeys.length;
  const keys = ONLY ? layerKeys.filter((k) => ONLY.split(',').includes(k.replace(/25$/, ''))) : SAMPLE === 'all' ? layerKeys : L.sampleWards(layerKeys, Number(SAMPLE) || 6);
  out.sampled = keys;
  const boot = await snap(); const bootPrims = (await J('window.__mission37dQA.probe144(0,0)')).scenePrimitives;
  let prev = null;
  for (const key of keys) {
    const wardId = key.replace(/25$/, ''), rec = { ward: wardId, key, checks: {} };
    try {
      const src = await ev(`fetch('ext-3dtiles/${key}/source.json').then((r) => r.json())`);
      const files = {}; for (const f of ['roads', 'waterways', 'water-surface', 'parks', 'railways']) {
        const j = await ev(`fetch('ext-3dtiles/${key}/layers/${f}.json').then((r) => r.ok ? r.json() : null).catch(() => null)`);
        if (j) files[f] = { parsed: true, ...L.featureKinds(j), bbox: j.bboxLocal || null, roadsHead: f === 'roads' ? (j.features || []).filter((x) => x.p && x.p.length > 1).slice(0, 4000).map((x) => ({ p: x.p })) : undefined };
      }
      rec.class = L.classifyWard(files); rec.classLine = L.classLine(rec.class);
      rec.http = out.layerFetches.filter((f) => f.url.includes('/' + key + '/')).map((f) => f.status);
      await ev(`window.__mission37dQA.setBuildingWard('${src.wardCode}')`); await waitReady();
      for (let i = 0; i < 80; i++) { const s = await snap(); if (s.vec && s.vec.state !== 'loading') break; await sleep(250); }
      const s1 = await snap(); rec.state = s1.state; rec.vecState = s1.vec && s1.vec.state; rec.vecLayers = s1.vec && s1.vec.layers; rec.tilesets = s1.ts;
      rec.checks.oneTilesetThisWard = s1.ts.n === 1 && String(s1.ts.bases || '').includes(key);
      if (prev) rec.checks.previousWardDisposed = !String(s1.ts.bases || '').includes(prev);
      // centre = middle of road vertices (real roads), else of the layer bbox
      const rp = (files.roads && files.roads.roadsHead) || [];
      const allPts = rp.flatMap((r) => r.p); allPts.sort((a, c) => a[0] - c[0]); const mx = allPts.length ? allPts[Math.floor(allPts.length / 2)] : null;
      const bb = (files.roads && files.roads.bbox) || (files.waterways && files.waterways.bbox);
      const cx = mx ? mx[0] : bb ? (bb.minX + bb.maxX) / 2 : 0, cz = mx ? mx[1] : bb ? (bb.minZ + bb.maxZ) / 2 : 0;
      await ev(`window.__mission37dQA.lookAtLocal(${cx}, ${cz}, 0, 900, -90, 0)`); await sleep(2500); await waitReady();
      const allOn = await shot('m144-' + wardId + '-on');
      const tog = async (id, tag) => { await ev(`window.__mission37dQA.setLayer('${id}', false)`); await sleep(1500); const off = await shot('m144-' + wardId + '-' + tag + '-off'); await ev(`window.__mission37dQA.setLayer('${id}', true)`); await sleep(1200); return diffPx(allOn, off); };
      rec.roadsToggleDiffPx = files.roads ? await tog('roads', 'roads') : null;
      rec.waterToggleDiffPx = files.waterways ? await tog('waterways', 'water') : null;
      rec.checks.roadsDrawn = files.roads ? (rec.vecLayers && rec.vecLayers.roads >= 1 && rec.roadsToggleDiffPx > 50) : null;
      rec.checks.waterDrawn = files.waterways ? (rec.vecLayers && rec.vecLayers.waterways >= 1 && rec.waterToggleDiffPx > 50) : null;
      // projection: page lon/lat of the local point vs shared constants; pickPosition round trip; ground vs layer heights
      const pr = await J(`window.__mission37dQA.probe144(${cx}, ${cz})`);
      const exp = { lon: L.toLon(cx), lat: L.toLat(cz) };
      rec.projection = { localXZ: [Math.round(cx), Math.round(cz)], pageVsConstantsM: +L.lonLatDiffM(pr, exp).toFixed(4), globeGroundH: pr.globeGroundH, ellipsoidH: pr.ellipsoidH, terrainProvider: pr.terrainProvider,
        depthTestAgainstTerrain: pr.depthTestAgainstTerrain, layerHeightsM: pr.layerHeightsM, pickPositionVsPointM: pr.pickPosition ? +L.lonLatDiffM(pr.pickPosition, pr).toFixed(2) : null, pickPositionHeightM: pr.pickPosition ? +pr.pickPosition.h.toFixed(2) : null };
      rec.checks.projectionMatchesConstants = rec.projection.pageVsConstantsM < 0.5;
      rec.checks.layersAboveGround = pr.globeGroundH == null ? null : (pr.globeGroundH + 0.0) <= Math.min(...Object.values(pr.layerHeightsM)) + 1e-6 || pr.layerHeightsM.waterways > 0;
      // roads vs buildings (needs the converted attrs on disk)
      const ad = ROOT && path.join(ROOT, key, 'attrs');
      if (ad && fs.existsSync(ad) && rp.length) {
        const pts = []; for (const f of fs.readdirSync(ad)) { try { for (const a of Object.values(readJson(path.join(ad, f)).byId)) if (Number.isFinite(a[2]) && Number.isFinite(a[3])) pts.push([a[2], a[3]]); } catch { /* skip */ } }
        rec.roadBuildingOverlap = L.roadBuildingOverlap(rp, pts, {}); rec.checks.buildingsNotOnRoads = rec.roadBuildingOverlap.onRoadRatio != null ? rec.roadBuildingOverlap.onRoadRatio < 0.08 : null;
      } else rec.roadBuildingOverlap = 'not measured (attrs not on disk or no roads)';
      rec.heapMB = s1.ts.heapMB;
      delete rec.projection.x; prev = key;
    } catch (e) { rec.error = String(e && e.message || e).slice(0, 300); }
    out.wards.push(rec); fs.mkdirSync(OUT, { recursive: true });
  }
  await ev('window.__mission37dQA.setBuildingWard(null)'); await sleep(1500);
  const end = await snap(); const endPrims = (await J('window.__mission37dQA.probe144(0,0)')).scenePrimitives;
  out.clear = { tilesets: end.ts.n, scenePrimitivesBoot: bootPrims, scenePrimitivesAfterClear: endPrims, vecState: end.vec && end.vec.state };
  out.boot = boot.ts;
} catch (e) { out.fatal = String(e && e.stack || e); }
child.kill('SIGINT'); await sleep(1000);
const rendered = out.wards.filter((w) => (w.checks.roadsDrawn === true) || (w.checks.waterDrawn === true));
out.summary = {
  acceptance: out.acceptance, wardsServed: out.served, wardsWithLayerData: out.wardsWithLayers, wardsSampled: out.sampled && out.sampled.length,
  renderedVerifiedWards: rendered.map((w) => w.ward), renderedVerifiedCount: rendered.length,
  notRendered: out.wards.filter((w) => w.checks.roadsDrawn === false || w.checks.waterDrawn === false || w.error).map((w) => ({ ward: w.ward, roadsDrawn: w.checks.roadsDrawn, waterDrawn: w.checks.waterDrawn, error: w.error })),
  waterSurfaceReadyWards: out.wards.filter((w) => w.class && w.class.waterSurface === 'water-surface ready').length, waterPolygonWards: out.wards.filter((w) => w.class && w.class.waterAreas > 0).length,
  allProjectionOk: out.wards.every((w) => w.checks.projectionMatchesConstants), disposalOk: out.wards.every((w) => w.checks.previousWardDisposed !== false) && out.clear && out.clear.tilesets === 0,
  httpErrors: out.httpErrors.length, jsErrors: out.jsErrors.length, googleRequests: out.googleRequests.length,
  note: out.acceptance === 'fixture' ? 'FIXTURE (synthetic lines): proves the harness only. Not an owner-data result.' : 'Only the sampled wards are rendering-verified; unsampled wards stay "browser rendered unverified". Re-run with --sample all for the rest.',
};
fs.mkdirSync(OUT, { recursive: true });
const rep = path.join(OUT, FIXTURE ? 'acceptance-fixture.json' : 'acceptance-real.json');
fs.writeFileSync(rep, JSON.stringify(out, null, 1));
await b.close?.();
console.log('\n[144] report: ' + rep + '\n' + JSON.stringify(out.summary, null, 1));
for (const w of out.wards) console.log('  [144] ' + w.ward + ': ' + (w.classLine || '-') + ' | roadsDiffPx=' + w.roadsToggleDiffPx + ' waterDiffPx=' + w.waterToggleDiffPx + ' projDiffM=' + (w.projection && w.projection.pageVsConstantsM) + (w.error ? ' ERROR ' + w.error : ''));
process.exit(out.fatal || out.jsErrors.length || out.googleRequests.length ? 1 : 0);
