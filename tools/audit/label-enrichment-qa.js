#!/usr/bin/env node
// tools/audit/label-enrichment-qa.js
// [Mission 33C §21/§22/§28/§29] ラベル拡充の実ブラウザ確認。
//   --phase before : 現 production（33B）を同じ camera で撮る（比較用）
//   --phase after  : development（33C）で 11 地点 + City Mode を確認し、性能も測る
//   前提: `npm run preview`。出力: data/reports/label-enrichment-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { PROBE } from './legacy-residual-probe.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URLS = {
  before: process.env.LIVECITY_PROD_URL || 'http://localhost:8000/osaka_3d_buildings.html',
  after: process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html',
};
const OUT = P('data', 'reports', 'label-enrichment-qa.json');
const SHOTS = P('data', 'reports', 'label-enrichment-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// §22 の 11 地点（座標は canonical / labels データから取った実位置）
export const SITES = [
  { id: 'umeda', name: '梅田', x: -2668, z: -10942 },
  { id: 'shinosaka', name: '新大阪', x: -2110, z: -14380 },
  { id: 'awaji', name: '淡路', x: 435, z: -14760 },
  { id: 'honmachi', name: '本町', x: -2073, z: -8693 },
  { id: 'kyobashi', name: '京橋', x: 655, z: -10328 },
  { id: 'namba', name: '難波', x: -2173, z: -6511 },
  { id: 'tennoji', name: '天王寺', x: -1056, z: -4619 },
  { id: 'sumiyoshi', name: '住吉', x: -2952, z: -812 },
  { id: 'osakacastle', name: '大阪城', x: 74, z: -9251 },
  { id: 'nakanoshima', name: '中之島', x: -2620, z: -9942 },
  { id: 'osakaport', name: '大阪港', x: -8763, z: -5672 },
];
export const COMPARE_SITES = ['shinosaka', 'umeda', 'osakacastle', 'nakanoshima'];
export const PERF_SITES = ['umeda', 'shinosaka', 'namba'];
const VIEW = { r: 900, ph: Math.PI / 3.4 };

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, ph) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  labels: `(() => {
    const city = (typeof window.__CITY_LABEL_DEBUG__ === 'function') ? window.__CITY_LABEL_DEBUG__() : null;
    const rects = []; let overlaps = 0, severe = 0;
    const names = { place: [], station: [], landmark: [], river: [], ward: [], park: [] };
    try {
      camera.updateMatrixWorld();
      const v = new THREE.Vector3(), wp = new THREE.Vector3();
      const tanHalf = Math.tan((camera.fov || 60) * Math.PI / 360);
      const aspect = innerWidth / innerHeight;
      for (const ch of scene.children) {
        if (ch.name !== 'CityLabelLayer' && ch.name !== 'StationLabelLayer') continue;
        ch.traverse((o) => {
          if (!o.isSprite || !o.visible) return;
          o.getWorldPosition(wp); v.copy(wp).project(camera);
          if (v.z > 1) return;
          const dist = camera.position.distanceTo(wp);
          const hh = (o.scale.y / 2) / (tanHalf * Math.max(1, dist));
          const hw = ((o.scale.x / 2) / (tanHalf * Math.max(1, dist))) / aspect;
          rects.push({ sx: v.x, sy: v.y, hw, hh, px: hh * innerHeight, layer: ch.name, kind: (o.name || '').replace('CityLabel_', '') });
        });
      }
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const dx = Math.abs(a.sx - b.sx), dy = Math.abs(a.sy - b.sy);
        if (dx < (a.hw + b.hw) * 0.9 && dy < (a.hh + b.hh) * 0.9) {
          overlaps++;
          if (dx < Math.min(a.hw, b.hw) * 0.5 && dy < Math.min(a.hh, b.hh) * 0.5) severe++;
        }
      }
    } catch (e) { /* 計測用 */ }
    const px = rects.map((r) => +r.px.toFixed(1)).sort((a, b) => a - b);
    return { city, spriteCount: rects.length, overlapPairs: overlaps, severeOverlaps: severe,
      byKind: rects.reduce((m, r) => ({ ...m, [r.kind || 'other']: (m[r.kind || 'other'] || 0) + 1 }), {}),
      labelPx: { min: px[0] ?? null, median: px[Math.floor(px.length / 2)] ?? null, max: px[px.length - 1] ?? null },
      visibleNames: city ? city.visibleNames : [] };
  })()`,
  pixels: `(() => {
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const w = 240, h = Math.max(1, Math.round(w * src.height / src.width));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let lum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { lum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; n++; }
    return { meanLuminance: +(lum / n).toFixed(4) };
  })()`,
  bench: (sec) => `new Promise((resolve) => {
    const ts = [], calls = [];
    const t0 = performance.now();
    function f(t) { ts.push(t); if (renderer && renderer.info) calls.push(renderer.info.render.calls);
      if (performance.now() - t0 < ${sec * 1000}) requestAnimationFrame(f); else done(); }
    function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }
    function done() {
      const dt = []; for (let i = 1; i < ts.length; i++) dt.push(ts[i] - ts[i - 1]);
      const dur = (ts[ts.length - 1] - ts[0]) / 1000;
      const mem = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
      const lbl = (typeof window.__CITY_LABEL_DEBUG__ === 'function') ? window.__CITY_LABEL_DEBUG__().visible : null;
      resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1), fpsP5: +pct(dt.map((d) => 1000 / d), 0.05).toFixed(1),
        frameMsP95: +pct(dt, 0.95).toFixed(1), drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
        jsHeapMB: mem == null ? null : +mem.toFixed(1), visibleLabels: lbl });
    }
    requestAnimationFrame(f);
  })`,
};

async function settle(page, min = 2500, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function ensureCamera(page, x, z, r, ph) {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(JS.camera(x, z, r, ph));
    await sleep(900);
    if (await page.evaluate(`(() => Math.abs(cs.tgt.x - (${x})) < 5 && Math.abs(cs.tgt.z - (${z})) < 5 && Math.abs(cs.r - ${r}) < 5)()`)) return true;
  }
  return false;
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/label-enrichment-qa/' + name + '.jpg';
}

async function run(phase) {
  const full = phase === 'after';
  const url = URLS[phase];
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  const out = { phase, url, generatedAt: new Date().toISOString(), sites: [], errors: [] };
  try {
    await page.send('Page.navigate', { url });
    await sleep(42000);
    const siteList = full ? SITES : SITES.filter((s) => COMPARE_SITES.includes(s.id));
    for (const s of siteList) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(2500);
      await ensureCamera(page, s.x, s.z, VIEW.r, VIEW.ph);
      await settle(page);
      await ensureCamera(page, s.x, s.z, VIEW.r, VIEW.ph);
      await sleep(2000);
      const rec = {
        site: s.id, siteName: s.name,
        labels: await page.evaluate(JS.labels),
        pixels: await page.evaluate(JS.pixels),
        residual: (await page.evaluate(PROBE)).selfCheck.total,
        shot: await shot(page, `${s.id}-${phase}`),
      };
      out.sites.push(rec);
      const c = rec.labels.city;
      console.log(`[label-enrich:${phase}]`, s.id, JSON.stringify({
        total: c ? c.visible : 0, place: c ? c.visiblePlaces : 0, station: c ? c.visibleStations : 0,
        lm: c ? c.visibleLandmarks : 0, river: c ? c.visibleRivers : 0, ward: c ? c.visibleWards : 0, park: c ? c.visibleParks : 0,
        ovl: rec.labels.overlapPairs, sev: rec.labels.severeOverlaps,
      }));
    }
    // City Mode
    await page.evaluate(`(() => { CityModeManager.enter(); return 1; })()`);
    await sleep(8000); await settle(page, 2500); await sleep(6000);
    out.cityMode = {
      labels: await page.evaluate(JS.labels), pixels: await page.evaluate(JS.pixels),
      residual: (await page.evaluate(PROBE)).selfCheck.total, shot: await shot(page, `city-${phase}`),
    };
    console.log(`[label-enrich:${phase}] cityMode`, JSON.stringify({ total: out.cityMode.labels.city.visible, byKind: out.cityMode.labels.byKind, ovl: out.cityMode.labels.overlapPairs, sev: out.cityMode.labels.severeOverlaps }));

    if (full) {
      out.performance = [];
      out.performance.push({ site: 'cityMode', ...(await page.evaluate(JS.bench(30), { timeoutMs: 120000 })) });
      await page.evaluate(`(() => { CityModeManager.exit('kita'); return 1; })()`); await sleep(1500);
      for (const id of PERF_SITES) {
        const s = SITES.find((q) => q.id === id);
        await page.evaluate(JS.ward(s.x, s.z)); await sleep(2000);
        await ensureCamera(page, s.x, s.z, 700, Math.PI / 4);
        await settle(page);
        out.performance.push({ site: id, ...(await page.evaluate(JS.bench(30), { timeoutMs: 120000 })) });
        console.log(`[label-enrich:${phase}] perf`, id, JSON.stringify(out.performance[out.performance.length - 1]));
      }
      // 河川名トグル（§25）
      out.riverToggle = await page.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const row = document.querySelector('[data-layer-key="riverLabels"]');
        if (!row) return 'row-absent';
        const cb = row.querySelector('input');
        const count = () => { const d = window.__CITY_LABEL_DEBUG__(); return { total: d.visible, river: d.visibleRivers }; };
        const before = count();
        cb.click(); await wait(900);
        const off = count();
        cb.click(); await wait(900);
        return { before, off, on: count() };
      })()`, { timeoutMs: 60000 });
      console.log(`[label-enrich:${phase}] riverToggle`, JSON.stringify(out.riverToggle));
    }
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }
  return out;
}

async function main() {
  const i = process.argv.indexOf('--phase');
  const phase = (i >= 0 ? process.argv[i + 1] : 'after') === 'before' ? 'before' : 'after';
  const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch { return null; } })();
  const result = await run(phase);
  const doc = { version: 1, generatedAt: new Date().toISOString(), missionId: '33C', view: VIEW, urls: URLS,
    phases: { ...(prev && prev.phases ? prev.phases : {}), [phase]: result } };
  if (doc.phases.before && doc.phases.after) {
    doc.comparison = COMPARE_SITES.map((id) => {
      const a = doc.phases.before.sites.find((s) => s.site === id);
      const b2 = doc.phases.after.sites.find((s) => s.site === id);
      if (!a || !b2) return { site: id, missing: true };
      const ca = a.labels.city, cb = b2.labels.city;
      return { site: id, siteName: b2.siteName,
        labels: { before: ca ? ca.visible : 0, after: cb ? cb.visible : 0 },
        byType: { before: ca ? { place: ca.visiblePlaces, station: ca.visibleStations, landmark: ca.visibleLandmarks, river: ca.visibleRivers || 0 } : null,
          after: cb ? { place: cb.visiblePlaces, station: cb.visibleStations, landmark: cb.visibleLandmarks, river: cb.visibleRivers || 0 } : null },
        luminance: { before: a.pixels.meanLuminance, after: b2.pixels.meanLuminance } };
    });
    doc.comparison.push({ site: 'cityMode',
      labels: { before: doc.phases.before.cityMode.labels.city.visible, after: doc.phases.after.cityMode.labels.city.visible },
      luminance: { before: doc.phases.before.cityMode.pixels.meanLuminance, after: doc.phases.after.cityMode.pixels.meanLuminance } });
  }
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  return doc;
}

if (isMainModule(import.meta.url)) {
  main().then((d) => { console.log('[label-enrich] out', OUT, JSON.stringify(Object.keys(d.phases))); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
