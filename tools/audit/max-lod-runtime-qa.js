#!/usr/bin/env node
// tools/audit/max-lod-runtime-qa.js
// [Mission 34D §25/§27/§28/§29/§30/§34/§35/§37/§38] 実ブラウザでの確認。
//   - 近景で highestValidLOD が使われているか（LOD3 > LOD2 > LOD1）
//   - 高 LOD 表示数 == LOD1 抑制数（二重表示なし）
//   - tile 境界での重複 / 消失 / 欠け
//   - LOD1/LOD2/LOD3 どれをクリックしても同じ canonicalId / card
//   - MAX LOD QA と click inspection
//   - 性能（7 地点 + City Mode）
//   - 高 LOD 密度上位地点の screenshot
//   前提: `npm run preview`。出力: data/reports/max-lod-runtime-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const OUT = P('data', 'reports', 'max-lod-runtime-qa.json');
const SHOTS = P('data', 'reports', 'max-lod-qa');
const MATRIX = P('data', 'reports', 'max-lod-coverage-matrix.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// §37 性能を測る地点
export const PERF_SITES = [
  { id: 'umeda', name: '梅田', x: -2668, z: -10942 },
  { id: 'honmachi', name: '本町', x: -2073, z: -8693 },
  { id: 'nakanoshima', name: '中之島', x: -2620, z: -9942 },
  { id: 'shinosaka', name: '新大阪', x: -2110, z: -14380 },
  { id: 'osakacastle', name: '大阪城', x: 76, z: -9258 },
  { id: 'namba', name: '難波', x: -1360, z: -6890 },
  { id: 'tennoji', name: '天王寺', x: -1020, z: -4900 },
];
export const PERF_SECONDS = 30;
export const VIEW = { r: 900, phDeg: 50, th: -0.35, fov: 44 };   // §38 斜め 50°
export const VISUAL_SITES = 10;    // §38 最低 10 地点（密度上位から）

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    CAMERA_MODE_FOV[cameraMode] = ${VIEW.fov};
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = (90 - ${VIEW.phDeg}) * Math.PI / 180; cs.th = ${VIEW.th}; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  lod: `(() => window.__BUILDING_LOD_DEBUG__())()`,
  // §28 高 LOD 表示数 == LOD1 抑制数
  suppress: `(() => { const d = window.__BUILDING_LOD_DEBUG__(); return { visible: d.visibleLod2 + d.visibleLod3, suppressed: d.suppressedLod1, band: d.band, match: (d.visibleLod2 + d.visibleLod3) === d.suppressedLod1 }; })()`,
  // §29 tile 境界: 同じ canonicalId が 2 つ以上の高 LOD mesh に現れないか / 画面内の棟が card を引けるか
  tileBoundary: `(() => {
    const seen = new Map();
    let ranges = 0;
    scene.traverse((o) => {
      if (!o.isMesh || !o.userData || !o.userData.lodHigh || !o.visible) return;
      let q = o, vis = true; while (q) { if (q.visible === false) { vis = false; break; } q = q.parent; }
      if (!vis) return;
      let g = o.parent; while (g && !/^CR_lodHigh_/.test(g.name || '')) g = g.parent;
      const tile = g ? g.name : '?';
      for (const r of (o.userData.lodHigh.ranges || [])) {
        ranges++;
        const cur = seen.get(r.canonicalId);
        if (!cur) seen.set(r.canonicalId, new Set([tile]));
        else cur.add(tile);
      }
    });
    let multiTile = 0; const sample = [];
    for (const [id, tiles] of seen) if (tiles.size > 1) { multiTile++; if (sample.length < 5) sample.push({ id: id.slice(-12), tiles: [...tiles] }); }
    // card を引けるか（欠けの検出）
    let withCard = 0, without = 0;
    let n = 0;
    for (const id of seen.keys()) { if (++n > 400) break; const d = CanonicalRuntime.buildingDataById(id); if (d && d.fp) withCard++; else without++; }
    return { distinctBuildings: seen.size, ranges, buildingsInMultipleTiles: multiTile, sample, cardChecked: n, withCard, without };
  })()`,
  // §30 picking: 高 LOD の棟を押しても LOD1 の棟を押しても同じ canonicalId へ
  picking: `(() => {
    const out = { tried: 0, sameId: 0, cardOk: 0, mismatch: [] };
    const pts = [];
    for (let gy = 0.3; gy <= 0.7 && pts.length < 12; gy += 0.04) for (let gx = 0.2; gx <= 0.7 && pts.length < 12; gx += 0.04) {
      const x = Math.round(innerWidth * gx), y = Math.round(innerHeight * gy);
      const h = pickHit({ clientX: x, clientY: y });
      if (h && h.d && h.d.id) pts.push({ x, y, id: h.d.id });
    }
    for (const p of pts) {
      out.tried++;
      // 高 LOD レイヤーから直接 pick した結果と、通常の pickHit の結果が一致するか
      mouse.x = (p.x / innerWidth) * 2 - 1; mouse.y = -(p.y / innerHeight) * 2 + 1;
      ray.setFromCamera(mouse, camera);
      const hl = window.__BUILDING_LOD_LAYER__ ? window.__BUILDING_LOD_LAYER__.pick(ray) : null;
      const again = pickHit({ clientX: p.x, clientY: p.y });
      const sameId = again && again.d && again.d.id === p.id;
      if (sameId) out.sameId++; else out.mismatch.push({ at: p, got: again && again.d ? again.d.id.slice(-12) : null });
      const d = CanonicalRuntime.buildingDataById(p.id);
      if (d && d.fp) out.cardOk++;
      if (hl && hl.canonicalId !== p.id) out.mismatch.push({ at: p, highLod: hl.canonicalId.slice(-12), pick: p.id.slice(-12) });
    }
    return out;
  })()`,
  // §35 click inspection
  inspect: `(() => {
    const out = [];
    for (let gy = 0.32; gy <= 0.62 && out.length < 6; gy += 0.05) for (let gx = 0.25; gx <= 0.65 && out.length < 6; gx += 0.05) {
      const h = pickHit({ clientX: Math.round(innerWidth * gx), clientY: Math.round(innerHeight * gy) });
      if (h && h.d && h.d.id) { const i = window.__MAX_LOD_INSPECT__(h.d.id); if (i) out.push(i); }
    }
    return out;
  })()`,
  maxLodQa: (on) => `(() => { const r = window.__MAX_LOD_QA__(${on ? 'true' : 'false'}); return window.__MAX_LOD_QA_DEBUG__(); })()`,
  bench: (sec) => `new Promise((resolve) => {
    const ts = [], calls = [], tris = [];
    const t0 = performance.now();
    function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }
    function f(t) { ts.push(t);
      if (renderer && renderer.info) { calls.push(renderer.info.render.calls); tris.push(renderer.info.render.triangles); }
      if (performance.now() - t0 < ${sec * 1000}) requestAnimationFrame(f); else {
        const dt = []; for (let i = 1; i < ts.length; i++) dt.push(ts[i] - ts[i - 1]);
        const dur = (ts[ts.length - 1] - ts[0]) / 1000;
        const d = window.__BUILDING_LOD_DEBUG__();
        const dg = CanonicalRuntime.getDebug ? CanonicalRuntime.getDebug() : {};
        resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1), fpsP5: +pct(dt.map((x) => 1000 / x), 0.05).toFixed(1),
          frameMsP95: +pct(dt, 0.95).toFixed(1),
          drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
          trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)),
          jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
          visibleLod2: d.visibleLod2, visibleLod3: d.visibleLod3, suppressedLod1: d.suppressedLod1,
          visibleBuildings: dg.visibleBuildings != null ? dg.visibleBuildings : null });
      } }
    requestAnimationFrame(f);
  })`,
  cityMode: `(() => { if (!CityModeManager.isActive()) CityModeManager.enter(); return CityModeManager.isActive(); })()`,
  exitCity: `(() => { if (CityModeManager.isActive()) CityModeManager.exit('kita'); return !CityModeManager.isActive(); })()`,
  // §25 距離帯ごとの representation
  bandCheck: (r) => `(() => { cs.r = ${r}; camUpd(); return 1; })()`,
};
const HIDE_UI = `(() => {
  for (const el of document.querySelectorAll('div')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|layer-toggle|prop-card|^tip$|search-box|^pl$|^pr$|^lc-panel|^lc-topbar|^controls$/.test(id)) el.style.display = 'none'; }
  for (const sel of ['#lc-panel', '#lc-topbar', '#controls', '#pl', '#pr']) { const e = document.querySelector(sel); if (e) e.style.display = 'none'; }
  return 1; })()`;

async function settle(page, min = 3000, max = 120000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/max-lod-qa/' + name + '.jpg';
}

export async function run() {
  const matrix = JSON.parse(fs.readFileSync(MATRIX, 'utf-8'));
  const visual = matrix.topDensity.slice(0, VISUAL_SITES).map((t) => ({ id: 'top' + t.rank, name: (t.wardJa || '?') + ' #' + t.rank, x: t.centerX, z: t.centerZ, buildings: t.buildings }));
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34D', url: URL_,
    view: VIEW, seconds: PERF_SECONDS, sites: [], performance: [], cityMode: null, visual: [], errors: [] };
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);

    // ── §28/§29/§30/§35 ランタイム検証（密度上位 3 地点 + 大阪城）──
    for (const s of [...visual.slice(0, 3), { id: 'osakacastle', name: '大阪城', x: 76, z: -9258 }]) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(2500);
      await page.evaluate(JS.camera(s.x, s.z, VIEW.r));
      await settle(page);
      await sleep(2000);
      const rec = { site: s.id, siteName: s.name, x: s.x, z: s.z };
      rec.lod = await page.evaluate(JS.lod);
      rec.suppress = await page.evaluate(JS.suppress);
      rec.tileBoundary = await page.evaluate(JS.tileBoundary, { timeoutMs: 120000 });
      rec.picking = await page.evaluate(JS.picking, { timeoutMs: 120000 });
      rec.inspect = await page.evaluate(JS.inspect, { timeoutMs: 120000 });
      // §25 距離帯
      rec.bands = [];
      for (const r of [500, 900, 2000, 2400, 3000]) {
        await page.evaluate(JS.bandCheck(r));
        await sleep(2500);
        const d = await page.evaluate(JS.lod);
        rec.bands.push({ r, band: d.band, visibleHigh: d.visibleLod2 + d.visibleLod3, suppressed: d.suppressedLod1 });
      }
      await page.evaluate(JS.camera(s.x, s.z, VIEW.r));
      await settle(page, 2000);
      out.sites.push(rec);
      console.log('[maxlod-qa]', s.id, JSON.stringify({ vis: rec.suppress.visible, sup: rec.suppress.suppressed,
        match: rec.suppress.match, multiTile: rec.tileBoundary.buildingsInMultipleTiles,
        card: rec.tileBoundary.withCard + '/' + rec.tileBoundary.cardChecked,
        pickSame: rec.picking.sameId + '/' + rec.picking.tried }));
    }

    // ── §34 MAX LOD QA ────────────────────────────────────────────────
    await page.evaluate(JS.camera(visual[0].x, visual[0].z, VIEW.r));
    await settle(page, 2000);
    out.maxLodQaOn = await page.evaluate(JS.maxLodQa(true), { timeoutMs: 120000 });
    await sleep(4000);
    await page.evaluate(HIDE_UI);
    out.maxLodQaShot = await shot(page, 'maxlodqa-top1');
    await page.evaluate(JS.maxLodQa(false));
    await sleep(2000);

    // ── §38 visual QA（密度上位 10 地点）────────────────────────────────
    for (const s of visual) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(2200);
      await page.evaluate(JS.camera(s.x, s.z, VIEW.r));
      await settle(page);
      await page.evaluate(HIDE_UI);
      await sleep(2000);
      const d = await page.evaluate(JS.lod);
      const file = await shot(page, 'visual-' + s.id);
      out.visual.push({ ...s, visibleLod2: d.visibleLod2, visibleLod3: d.visibleLod3, suppressedLod1: d.suppressedLod1, shot: file });
      console.log('[maxlod-qa] visual', s.id, s.name, 'high=' + (d.visibleLod2 + d.visibleLod3));
    }

    // ── §37 性能 ───────────────────────────────────────────────────────
    for (const s of PERF_SITES) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(2200);
      await page.evaluate(JS.camera(s.x, s.z, VIEW.r));
      await settle(page);
      const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ site: s.id, siteName: s.name, ...r });
      console.log('[maxlod-qa] perf', s.id, JSON.stringify({ fps: r.fpsAverage, p5: r.fpsP5, tri: r.trianglesAvg, l2: r.visibleLod2, l3: r.visibleLod3, sup: r.suppressedLod1 }));
    }
    await page.evaluate(JS.cityMode); await sleep(3500);
    await settle(page, 4000);
    out.cityMode = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
    console.log('[maxlod-qa] cityMode', JSON.stringify({ fps: out.cityMode.fpsAverage, tri: out.cityMode.trianglesAvg, l2: out.cityMode.visibleLod2 }));
    await page.evaluate(JS.exitCity);
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }

  out.summary = {
    suppressMatchAll: out.sites.every((s) => s.suppress.match),
    multiTileBuildings: out.sites.reduce((a, s) => a + s.tileBoundary.buildingsInMultipleTiles, 0),
    cardMissing: out.sites.reduce((a, s) => a + s.tileBoundary.without, 0),
    pickSameAll: out.sites.every((s) => s.picking.sameId === s.picking.tried),
    worstFps: Math.min(...out.performance.map((p) => p.fpsAverage)),
    cityModeFps: out.cityMode ? out.cityMode.fpsAverage : null,
    visualSites: out.visual.length,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { console.log('[maxlod-qa] summary', JSON.stringify(o.summary)); console.log('[maxlod-qa] out', OUT); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
