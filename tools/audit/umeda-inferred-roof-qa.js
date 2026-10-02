#!/usr/bin/env node
// tools/audit/umeda-inferred-roof-qa.js
// [Mission 35A §23/§24/§27/§28/§29/§31] 梅田 PoC の実ブラウザ確認。
//   - INFERRED_ROOF 表示時に同じ canonicalId の LOD1 が抑制されるか（二重表示 0）
//   - 実 LOD2/LOD3 は INFERRED_ROOF より優先されるか
//   - クリック診断が「推定である」ことを返すか
//   - LOD1 ONLY / REAL MAX LOD / REAL + INFERRED の 3 モードを同一 camera で比較
//   - 性能
//   前提: `npm run preview`。出力: data/reports/umeda-inferred-roof-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { UMEDA } from './umeda-roof-evidence.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const OUT = P('data', 'reports', 'umeda-inferred-roof-qa.json');
const SHOTS = P('data', 'reports', 'umeda-inferred-roof');
const BUILD = P('data', 'reports', 'umeda-inferred-roof-build.json');
const ROOFS = P('data', 'processed', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const MODES = ['lod1', 'real', 'real+inferred'];
export const PERF_SECONDS = 20;
export const VIEW = { r: 700, phDeg: 50, th: -0.35, fov: 44 };
// §29 斜め 45〜55° で見る地点（梅田の中と、生成した棟の周り）
export const VISUAL_SITES = 10;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    CAMERA_MODE_FOV[cameraMode] = ${VIEW.fov};
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = (90 - ${VIEW.phDeg}) * Math.PI / 180; cs.th = ${VIEW.th}; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  mode: (m) => `(() => window.__UMEDA_ROOF_MODE__('${m}'))()`,
  inferred: `(() => window.__INFERRED_ROOF_DEBUG__())()`,
  lod: `(() => window.__BUILDING_LOD_DEBUG__())()`,
  crDebug: `(() => { const d = CanonicalRuntime.getDebug(); return { visibleBuildings: d.visibleBuildings }; })()`,
  // §24 二重表示が無いか: 推定屋根を出している棟の footprint の中心に真上から ray を撃ち、
  //   LOD1 の箱がまだ描かれていないかを見る。
  doubleCheck: (ids) => `(() => {
    const out = [];
    for (const id of ${JSON.stringify(ids)}) {
      const d = CanonicalRuntime.buildingDataById(id);
      const sup = window.__INFERRED_ROOF_LAYER__.isSuppressedBuilding(id);
      let lod1Drawn = false;
      if (d && d.fp && d.fp.length) {
        let cx = 0, cz = 0; for (const q of d.fp) { cx += q[0]; cz += q[1]; }
        cx /= d.fp.length; cz /= d.fp.length;
        const rc = new THREE.Raycaster(new THREE.Vector3(cx, 900, cz), new THREE.Vector3(0, -1, 0), 0.1, 2000);
        const meshes = [];
        CanonicalRuntime.getBuildingsGroup ? null : null;
        scene.traverse((o) => { if (o.isMesh && o.visible && o.userData && o.userData.usageCategory != null) { let q = o, v = true; while (q) { if (q.visible === false) { v = false; break; } q = q.parent; } if (v) meshes.push(o); } });
        lod1Drawn = rc.intersectObjects(meshes, false).length > 0;
      }
      out.push({ id, suppressed: sup, lod1StillDrawn: lod1Drawn, hasCard: !!(d && d.fp) });
    }
    return out;
  })()`,
  inspect: (id) => `(() => ({ inferred: window.__INFERRED_ROOF_INSPECT__(${JSON.stringify(id)}),
    maxLod: window.__MAX_LOD_INSPECT__ ? window.__MAX_LOD_INSPECT__(${JSON.stringify(id)}) : null }))()`,
  bench: (sec) => `new Promise((resolve) => {
    const ts = [], calls = [], tris = [];
    const t0 = performance.now();
    function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }
    function f(t) { ts.push(t);
      if (renderer && renderer.info) { calls.push(renderer.info.render.calls); tris.push(renderer.info.render.triangles); }
      if (performance.now() - t0 < ${sec * 1000}) requestAnimationFrame(f); else {
        const dt = []; for (let i = 1; i < ts.length; i++) dt.push(ts[i] - ts[i - 1]);
        const dur = (ts[ts.length - 1] - ts[0]) / 1000;
        const inf = window.__INFERRED_ROOF_DEBUG__();
        const d = window.__BUILDING_LOD_DEBUG__();
        resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1), fpsP5: +pct(dt.map((x) => 1000 / x), 0.05).toFixed(1),
          frameMsP95: +pct(dt, 0.95).toFixed(1),
          drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
          trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)),
          jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
          visibleInferred: inf.enabled ? inf.drawn : 0, visibleLod2: d.visibleLod2, visibleLod3: d.visibleLod3 });
      } }
    requestAnimationFrame(f);
  })`,
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
  return 'data/reports/umeda-inferred-roof/' + name + '.jpg';
}

export async function run() {
  const roofs = rj(ROOFS) || { buildings: [] };
  const build = rj(BUILD);
  const ids = (roofs.buildings || []).map((b) => b.canonicalId);
  // §29 視点: 生成した棟の周り + 梅田内の格子
  const sites = [];
  for (const b of (roofs.buildings || [])) {
    const c = b.fp && b.fp.length ? b.fp.reduce((a, q) => [a[0] + q[0] / b.fp.length, a[1] + q[1] / b.fp.length], [0, 0]) : null;
    if (c) sites.push({ id: 'inferred-' + sites.length, name: '推定屋根', x: Math.round(c[0]), z: Math.round(c[1]), r: 200 });
  }
  const ring = [[0, 0], [350, 0], [-350, 0], [0, 350], [0, -350], [250, 250], [-250, 250], [250, -250], [-250, -250], [500, 100]];
  for (const [dx, dz] of ring) {
    if (sites.length >= VISUAL_SITES) break;
    sites.push({ id: 'umeda-' + sites.length, name: '梅田', x: UMEDA.x + dx, z: UMEDA.z + dz, r: VIEW.r });
  }

  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35A', url: URL_,
    area: UMEDA, inferredCount: ids.length, modes: MODES, view: VIEW,
    modeComparison: [], doubleDisplay: null, inspect: [], performance: [], visual: [], errors: [] };
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    const focus = sites[0] || { x: UMEDA.x, z: UMEDA.z, r: VIEW.r };
    await page.evaluate(JS.ward(focus.x, focus.z)); await sleep(2500);

    // ── §28 3 モード比較（同一 camera）────────────────────────────────
    for (const m of MODES) {
      await page.evaluate(JS.mode(m));
      await sleep(1500);
      await page.evaluate(JS.camera(focus.x, focus.z, focus.r || VIEW.r));
      await settle(page);
      await sleep(2000);
      const rec = { mode: m, inferred: await page.evaluate(JS.inferred), lod: await page.evaluate(JS.lod),
        cr: await page.evaluate(JS.crDebug) };
      await page.evaluate(HIDE_UI);
      await sleep(1200);
      rec.shot = await shot(page, 'mode-' + m.replace('+', '-'));
      out.modeComparison.push(rec);
      console.log('[inferred-qa] mode', m, JSON.stringify({ inferred: rec.inferred.drawn, sup: rec.inferred.suppressed,
        lod2: rec.lod.visibleLod2, lod3: rec.lod.visibleLod3, bldg: rec.cr.visibleBuildings }));
    }

    // ── §24 二重表示の確認（REAL + INFERRED のまま）──────────────────
    await page.evaluate(JS.mode('real+inferred'));
    await sleep(2500);
    await page.evaluate(JS.camera(focus.x, focus.z, 200));
    await settle(page);
    await sleep(2500);
    if (ids.length) out.doubleDisplay = await page.evaluate(JS.doubleCheck(ids), { timeoutMs: 120000 });
    // §27 クリック診断
    for (const id of ids.slice(0, 3)) out.inspect.push(await page.evaluate(JS.inspect(id)));
    // 生成しなかった棟の診断も 1 件
    const notGen = build && build.stats ? null : null;
    const anyLod1 = await page.evaluate(`(() => { for (let gy = 0.35; gy <= 0.65; gy += 0.05) for (let gx = 0.3; gx <= 0.6; gx += 0.05) {
      const h = pickHit({ clientX: Math.round(innerWidth*gx), clientY: Math.round(innerHeight*gy) });
      if (h && h.d && h.d.id && !window.__INFERRED_ROOF_LAYER__.isSuppressedBuilding(h.d.id)) return h.d.id; } return null; })()`);
    if (anyLod1) out.inspect.push(await page.evaluate(JS.inspect(anyLod1)));
    console.log('[inferred-qa] double', JSON.stringify(out.doubleDisplay));

    // ── §29 visual QA ─────────────────────────────────────────────────
    for (const s of sites) {
      await page.evaluate(JS.camera(s.x, s.z, s.r || VIEW.r));
      await settle(page);
      await page.evaluate(HIDE_UI);
      await sleep(1800);
      const inf = await page.evaluate(JS.inferred);
      out.visual.push({ ...s, inferredDrawn: inf.drawn, shot: await shot(page, 'visual-' + s.id) });
    }
    console.log('[inferred-qa] visual', out.visual.length, '地点');

    // ── §31 性能（3 モード）────────────────────────────────────────────
    for (const m of MODES) {
      await page.evaluate(JS.mode(m));
      await sleep(1500);
      await page.evaluate(JS.camera(UMEDA.x, UMEDA.z, VIEW.r));
      await settle(page);
      const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ mode: m, ...r });
      console.log('[inferred-qa] perf', m, JSON.stringify({ fps: r.fpsAverage, tri: r.trianglesAvg, inf: r.visibleInferred }));
    }
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }

  out.summary = {
    inferredCount: ids.length,
    suppressionOk: !out.doubleDisplay || out.doubleDisplay.every((d) => d.suppressed && !d.lod1StillDrawn),
    cardOk: !out.doubleDisplay || out.doubleDisplay.every((d) => d.hasCard),
    inspectSaysInferred: out.inspect.some((i) => i.inferred && i.inferred.inferred === true),
    visualSites: out.visual.length,
    modes: out.modeComparison.map((m) => ({ mode: m.mode, inferred: m.inferred.drawn, lod2: m.lod.visibleLod2 })),
    jsErrors: out.errors.length,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { console.log('[inferred-qa] summary', JSON.stringify(o.summary)); console.log('[inferred-qa] out', OUT); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
