#!/usr/bin/env node
// tools/audit/coverage-click-perf.js
// [Mission 34C §28/§30] 建物を足したあとの性能と、既存機能の回帰確認。
//   V2N（現行）と V3（回収後）を同じ camera で測り、主要レイヤー・操作が壊れていないか確かめる。
//   前提: `npm run preview`。出力: data/reports/coverage-click-perf.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const OUT = P('data', 'reports', 'coverage-click-perf.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PERF_SITES = [
  { id: 'umeda', name: '梅田', x: -2668, z: -10942, r: 900 },
  { id: 'dojima', name: '堂島', x: -2607, z: -10386, r: 900 },
  { id: 'honmachi', name: '本町', x: -2073, z: -8693, r: 900 },
];
export const PERF_SECONDS = 30;
export const VERSIONS = ['V2N', 'V3'];

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = (90 - 50) * Math.PI / 180; cs.th = -0.35; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  setVersion: (v) => `(async () => await window.__SET_BUILDINGS_VERSION__('${v}'))()`,
  versionDebug: `(() => CanonicalRuntime.getBuildingsVersionDebug())()`,
  cityMode: `(() => { if (!CityModeManager.isActive()) CityModeManager.enter(); return CityModeManager.isActive(); })()`,
  exitCity: `(() => { if (CityModeManager.isActive()) CityModeManager.exit('kita'); return !CityModeManager.isActive(); })()`,
  bench: (sec) => `new Promise((resolve) => {
    const ts = [], calls = [], tris = [];
    const t0 = performance.now();
    function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }
    function f(t) { ts.push(t);
      if (renderer && renderer.info) { calls.push(renderer.info.render.calls); tris.push(renderer.info.render.triangles); }
      if (performance.now() - t0 < ${sec * 1000}) requestAnimationFrame(f); else {
        const dt = []; for (let i = 1; i < ts.length; i++) dt.push(ts[i] - ts[i - 1]);
        const dur = (ts[ts.length - 1] - ts[0]) / 1000;
        const pf = CanonicalRuntime.getPerf();
        const dg = CanonicalRuntime.getDebug ? CanonicalRuntime.getDebug() : {};
        resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1), fpsP5: +pct(dt.map((x) => 1000 / x), 0.05).toFixed(1),
          frameMsP95: +pct(dt, 0.95).toFixed(1),
          drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
          trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)),
          jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
          visibleBuildings: dg.visibleBuildings != null ? dg.visibleBuildings : null,
          buildingsVersion: dg.buildings ? dg.buildings.version : null,
          tilesLoaded: pf.tiles ? pf.tiles.loaded : null, tilesVisible: pf.tiles ? pf.tiles.visible : null,
          cacheMB: pf.tiles ? pf.tiles.cachedMB : null });
      } }
    requestAnimationFrame(f);
  })`,
  // §28 既存機能が生きているか（存在・件数・状態を読むだけ）
  regression: `(() => {
    const out = {};
    const d = CanonicalRuntime.getDebug ? CanonicalRuntime.getDebug() : {};
    out.visibleBuildings = d.visibleBuildings != null ? d.visibleBuildings : null;
    out.visibleRoadFeatures = d.visibleRoadFeatures != null ? d.visibleRoadFeatures : null;
    out.canonicalOwnsBase = !!window.__CANONICAL_OWNS_BASE__;
    out.legacyResidual = d.legacyResidual != null ? d.legacyResidual : (d.residual != null ? d.residual : null);
    // 建物 hover / click（picking が生きているか）
    let hit = null;
    for (let gy = 0.35; gy <= 0.65 && !hit; gy += 0.05) for (let gx = 0.25; gx <= 0.6 && !hit; gx += 0.05) {
      const h = pickHit({ clientX: Math.round(innerWidth * gx), clientY: Math.round(innerHeight * gy) });
      if (h && h.d && h.d.id) hit = h;
    }
    out.picking = !!hit;
    if (hit) {
      showPropertyCard(hit.d);
      const pc = document.getElementById('prop-card');
      out.propertyCard = !!pc && pc.style.display === 'block';
      out.pickedId = hit.d.id;
      out.pickedSource = hit.d.source || 'plateau';
      closePropCard();
    }
    out.labels = (typeof CityLabelLayer !== 'undefined') ? CityLabelLayer.getDebug().visibleIds.length : null;
    out.highLod = window.__BUILDING_LOD_DEBUG__ ? (() => { const b = window.__BUILDING_LOD_DEBUG__(); return { visible: b.visibleLod2 + b.visibleLod3, suppressed: b.suppressedLod1, enabled: b.enabled }; })() : null;
    out.landmarkHd = window.__LANDMARK_HD_DEBUG__ ? (() => { const l = window.__LANDMARK_HD_DEBUG__(); return { loaded: l.loaded, landmarks: l.landmarks.length, error: l.dataError }; })() : null;
    out.roadV3 = d.roadVisualSurface ? { classMapLoaded: d.roadVisualSurface.classMapLoaded } : null;
    out.coverageQa = window.__COVERAGE_QA_DEBUG__ ? window.__COVERAGE_QA_DEBUG__() : null;
    return out;
  })()`,
  search: (q) => `(async () => {
    const input = document.getElementById('search-input');
    input.value = ${JSON.stringify(q)};
    doSearch();
    await new Promise((r) => setTimeout(r, 2500));
    return { x: +cs.tgt.x.toFixed(1), z: +cs.tgt.z.toFixed(1), r: +cs.r.toFixed(1) };
  })()`,
};

async function settle(page, min = 2500, max = 120000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}

export async function run() {
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34C', url: URL_,
    seconds: PERF_SECONDS, sites: PERF_SITES.map((s) => s.id), measurements: [], cityMode: [], regression: {}, search: {}, errors: [] };
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    for (const v of VERSIONS) {
      const sw = await page.evaluate(JS.setVersion(v), { timeoutMs: 180000 });
      await sleep(3000);
      const vd = await page.evaluate(JS.versionDebug);
      console.log('[perf]', v, 'base=' + (vd && vd.base));
      for (const s of PERF_SITES) {
        await page.evaluate(JS.ward(s.x, s.z)); await sleep(2200);
        await page.evaluate(JS.camera(s.x, s.z, s.r));
        await settle(page);
        const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
        out.measurements.push({ version: v, site: s.id, siteName: s.name, ...r });
        console.log('[perf]', v, s.id, JSON.stringify({ fps: r.fpsAverage, p5: r.fpsP5, tri: r.trianglesAvg, draw: r.drawCallsAvg, bldg: r.visibleBuildings, tiles: r.tilesLoaded }));
      }
      // City Mode
      await page.evaluate(JS.cityMode); await sleep(3000);
      await settle(page, 4000);
      const cm = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.cityMode.push({ version: v, ...cm });
      console.log('[perf]', v, 'cityMode', JSON.stringify({ fps: cm.fpsAverage, tri: cm.trianglesAvg, bldg: cm.visibleBuildings }));
      await page.evaluate(JS.exitCity); await sleep(3000);
      // §28 回帰（その version のまま確認する）
      await page.evaluate(JS.ward(PERF_SITES[0].x, PERF_SITES[0].z)); await sleep(2000);
      await page.evaluate(JS.camera(PERF_SITES[0].x, PERF_SITES[0].z, 600));
      await settle(page);
      out.regression[v] = await page.evaluate(JS.regression, { timeoutMs: 120000 });
      console.log('[perf]', v, 'regression', JSON.stringify(out.regression[v]).slice(0, 320));
      out.search[v] = await page.evaluate(JS.search('新大阪駅'), { timeoutMs: 60000 });
    }
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }

  // 比較
  out.comparison = PERF_SITES.map((s) => {
    const a = out.measurements.find((m) => m.site === s.id && m.version === 'V2N');
    const c = out.measurements.find((m) => m.site === s.id && m.version === 'V3');
    if (!a || !c) return { site: s.id, missing: true };
    return { site: s.id, siteName: s.name,
      fps: { v2n: a.fpsAverage, v3: c.fpsAverage, deltaPct: +(((c.fpsAverage / a.fpsAverage) - 1) * 100).toFixed(1) },
      frameMsP95: { v2n: a.frameMsP95, v3: c.frameMsP95 },
      triangles: { v2n: a.trianglesAvg, v3: c.trianglesAvg },
      drawCalls: { v2n: a.drawCallsAvg, v3: c.drawCallsAvg },
      visibleBuildings: { v2n: a.visibleBuildings, v3: c.visibleBuildings },
      tilesLoaded: { v2n: a.tilesLoaded, v3: c.tilesLoaded },
      cacheMB: { v2n: a.cacheMB, v3: c.cacheMB },
      heapMB: { v2n: a.jsHeapMB, v3: c.jsHeapMB } };
  });
  const cmA = out.cityMode.find((m) => m.version === 'V2N'), cmB = out.cityMode.find((m) => m.version === 'V3');
  out.cityModeComparison = (cmA && cmB) ? { fps: { v2n: cmA.fpsAverage, v3: cmB.fpsAverage,
    deltaPct: +(((cmB.fpsAverage / cmA.fpsAverage) - 1) * 100).toFixed(1) },
    visibleBuildings: { v2n: cmA.visibleBuildings, v3: cmB.visibleBuildings } } : null;
  out.worstFpsDeltaPct = Math.min(...out.comparison.filter((c) => c.fps).map((c) => c.fps.deltaPct));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { console.log('[perf] comparison', JSON.stringify(o.comparison)); console.log('[perf] out', OUT); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
