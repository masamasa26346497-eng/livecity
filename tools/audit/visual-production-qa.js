#!/usr/bin/env node
// tools/audit/visual-production-qa.js
// [Mission 35J §6/§7/§8/§9/§13] 35I の見た目を反映した production HTML を実ブラウザで確認する。
//   前提: `npm run preview`。対象は production（osaka_3d_buildings.html）。
//   出力: data/reports/visual-production-qa.json / data/reports/visual-production-qa/*.jpg
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';
import { MIN_SCENE_LUMA, MAX_CLIPPED_FRACTION, LUMA_RATIO_TARGET, directionStats } from './directional-balance-qa.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_PROD_URL || 'http://localhost:8000/osaka_3d_buildings.html';
export const OUT = P('data', 'reports', 'visual-production-qa.json');
export const SHOTS = P('data', 'reports', 'visual-production-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** §6 の必須地点。`dirs` を持つ地点は §6 のとおり 4 方向以上から見る。 */
export const SITES = [
  { id: 'umeda', label: '梅田', lat: 34.70250, lon: 135.49586, dirs: [0, 90, 180, 270] },
  { id: 'honmachi', label: '本町', lat: 34.68200, lon: 135.49900, dirs: [0, 90, 180, 270] },
  { id: 'namba', label: '難波', lat: 34.66600, lon: 135.50100, dirs: [0, 90, 180, 270] },
  { id: 'shin-osaka', label: '新大阪', lat: 34.73340, lon: 135.50020, dirs: [180] },
  { id: 'higashiyodogawa', label: '東淀川', lat: 34.74640, lon: 135.53170, dirs: [180] },
];
export const VIEW = { r: 620, phDeg: 36, fov: 44 };
export const PERF_SITES = ['umeda', 'shin-osaka'];
export const PERF_SECONDS = 15;
/** §2 production で使われるべき 35I の値。 */
export const EXPECTED = {
  profile: 'DEPTH', tuning: '35I', lightLevel: 'STANDARD',
  wall: { lit: 0.96, side: 0.885, dark: 0.81 },
  light: { exposure: 1.01, hemi: 0.58, sun: 1.45, fill: 0.55 },
  fillColor: '#c6ced6',
};
/** §5 production で見えてはいけない開発用 UI。 */
export const DEV_ONLY_IDS = [
  'canonical-runtime-status', 'canonical-runtime-road-v2-controls',
  'visual-profile-toggle', 'visual-light-toggle', 'visual-tuning-toggle',
  'max-lod-qa-toggle', 'inferred-roof-toggle', 'landmark-hd-toggle',
  'missing-recovery-toggle', 'lod-view-toggle', 'coverage-qa-toggle',
  'gsi-road-edge-toggle', 'ward-diag', 'perf-hud', 'fps',
];
export const PRODUCTION_UI_IDS = ['lc-topbar', 'search-input'];

export function worldOf(s) {
  const w = latLonToLiveCityWorld(s.lat, s.lon);
  return { x: Math.round(w.x), z: Math.round(w.z) };
}

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, az) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    CAMERA_MODE_FOV[cameraMode] = ${VIEW.fov};
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${VIEW.r};
    cs.ph = (90 - ${VIEW.phDeg}) * Math.PI / 180; cs.th = ${(az * Math.PI / 180).toFixed(6)}; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  boot: `(() => { const bv = CanonicalRuntime.getBuildingsVersionDebug(); const d = CanonicalRuntime.getDepthDebug();
    return { version: bv.version, base: bv.base, profile: LIVECITY_BUILD_PROFILE,
      buildAttr: document.documentElement.getAttribute('data-livecity-build'),
      visual: { profile: d.profile, tuning: d.tuning, lightLevel: d.lightLevel,
        shades: d.shades, style: d.style, wallShades: d.wallShades, live: d.live } }; })()`,
  /** §7 実際に描かれた画素の輝度（35I の QA と同じ測り方）。 */
  luma: `(() => {
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const W = renderer.domElement.width, H = renderer.domElement.height;
    const x0 = Math.floor(W * 0.10), y0 = Math.floor(H * 0.10);
    const w = Math.floor(W * 0.80), h = Math.floor(H * 0.80);
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0, n = 0, clipped = 0, rs = 0, gs = 0, bs = 0;
    for (let i = 0; i < buf.length; i += 16) {
      const r = buf[i] / 255, g = buf[i + 1] / 255, b = buf[i + 2] / 255;
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b; n++; rs += r; gs += g; bs += b;
      if (r > 0.98 && g > 0.98 && b > 0.98) clipped++;
    }
    const mean = sum / n, mr = rs / n, mb = bs / n;
    return { mean: +mean.toFixed(4), clippedFraction: +(clipped / n).toFixed(4),
      blueBias: +((mb - mr) / Math.max(1e-6, mean)).toFixed(4) };
  })()`,
  /** §7 建物だけの輝度（背景・地表を隠して測る）。 */
  buildingLuma: `(() => {
    const hidden = [];
    scene.traverse((o) => {
      if ((!o.isMesh && !o.isLineSegments) || !o.visible) return;
      if (o.userData && o.userData.usageCategory != null) return;
      let q = o, keep = false;
      while (q) { if (q.name === 'CR_buildingLodHigh' || q.name === 'LandmarkHDLayer') { keep = true; break; } q = q.parent; }
      if (keep) return;
      o.visible = false; hidden.push(o);
    });
    let out = null;
    try {
      renderer.render(scene, camera);
      const gl = renderer.getContext();
      const W = renderer.domElement.width, H = renderer.domElement.height;
      const x0 = Math.floor(W * 0.10), y0 = Math.floor(H * 0.10);
      const w = Math.floor(W * 0.80), h = Math.floor(H * 0.80);
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const cc = renderer.getClearColor(new THREE.Color());
      const cr = Math.round(cc.r * 255), cg = Math.round(cc.g * 255), cb = Math.round(cc.b * 255);
      let sum = 0, n = 0, min = 1, max = 0, sat = 0;
      for (let i = 0; i < buf.length; i += 16) {
        const R = buf[i], G = buf[i + 1], B = buf[i + 2];
        if (Math.abs(R - cr) < 4 && Math.abs(G - cg) < 4 && Math.abs(B - cb) < 4) continue;
        const y = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
        const mx = Math.max(R, G, B) / 255, mn = Math.min(R, G, B) / 255;
        sat += (mx === mn) ? 0 : (mx - mn) / (1 - Math.abs(mx + mn - 1) || 1e-6);
        sum += y; n++; if (y < min) min = y; if (y > max) max = y;
      }
      out = n ? { mean: +(sum / n).toFixed(4), min: +min.toFixed(4), max: +max.toFixed(4),
        saturation: +(sat / n).toFixed(4), pixels: n } : { mean: null, pixels: 0 };
    } finally { for (const o of hidden) o.visible = true; renderer.render(scene, camera); }
    return out;
  })()`,
  ui: `(() => {
    const vis = (id) => { const el = document.getElementById(id); if (!el) return 'absent';
      const cs2 = getComputedStyle(el);
      if (cs2.display === 'none' || cs2.visibility === 'hidden' || +cs2.opacity === 0) return 'hidden';
      const r = el.getBoundingClientRect();
      return (r.width > 0 && r.height > 0) ? 'visible' : 'hidden'; };
    const devOnly = {}; for (const id of ${JSON.stringify(DEV_ONLY_IDS)}) devOnly[id] = vis(id);
    const prod = {}; for (const id of ${JSON.stringify(PRODUCTION_UI_IDS)}) prod[id] = vis(id);
    return { devOnly, production: prod };
  })()`,
  bench: (sec) => `new Promise((resolve) => {
    const ts = [], calls = [], tris = [];
    const t0 = performance.now();
    function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }
    function f(t) { ts.push(t);
      if (renderer && renderer.info) { calls.push(renderer.info.render.calls); tris.push(renderer.info.render.triangles); }
      if (performance.now() - t0 < ${sec * 1000}) requestAnimationFrame(f); else {
        const dt = []; for (let i = 1; i < ts.length; i++) dt.push(ts[i] - ts[i - 1]);
        const dur = (ts[ts.length - 1] - ts[0]) / 1000;
        const p = CanonicalRuntime.getPerf();
        resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1), frameMsP95: +pct(dt, 0.95).toFixed(1),
          drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
          trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)),
          loadedTiles: p.tiles ? p.tiles.loaded : null });
      } }
    requestAnimationFrame(f); })`,
  /** §8 回帰。LOD1 / 高 LOD / HD ランドマークも数える。 */
  regression: `(() => {
    const r = {};
    try { r.roadMode = __SEMANTIC_DISPLAY_DEBUG__().normalViewRoadMode; } catch (e) { r.roadMode = 'ERR'; }
    try { r.buildingsVersion = CanonicalRuntime.getBuildingsVersionDebug().version; } catch (e) { r.buildingsVersion = 'ERR'; }
    try { r.selfCheck = __CANONICAL_SELF_CHECK__().total; } catch (e) { r.selfCheck = -1; }
    try { r.highLod = !!(window.__BUILDING_LOD_DEBUG__ && window.__BUILDING_LOD_DEBUG__()); } catch (e) { r.highLod = false; }
    try { r.labels = (typeof window.__CITY_LABEL_DEBUG__ === 'function' && window.__CITY_LABEL_DEBUG__()) ? 'ok' : 'missing'; } catch (e) { r.labels = 'ERR'; }
    try { r.labelsVisible = window.__CITY_LABEL_DEBUG__().visible; } catch (e) { r.labelsVisible = -1; }
    try { r.search = typeof findSpot === 'function'; } catch (e) { r.search = false; }
    try { r.hover = typeof pickHit === 'function'; } catch (e) { r.hover = false; }
    let lod1 = 0, shaded = 0, hi = 0, hd = 0;
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      if (o.userData && o.userData.usageCategory != null) {
        lod1++;
        if (o.geometry && o.geometry.getAttribute && o.geometry.getAttribute('color')) shaded++;
        return;
      }
      let q = o; while (q) { if (q.name === 'CR_buildingLodHigh') { hi++; break; } if (q.name === 'LandmarkHDLayer') { hd++; break; } q = q.parent; }
    });
    r.lod1Meshes = lod1; r.lod1Shaded = shaded; r.highLodMeshes = hi; r.landmarkHdMeshes = hd;
    let hit = null;
    for (let gy = 0.35; gy <= 0.65 && !hit; gy += 0.05) {
      for (let gx = 0.3; gx <= 0.7 && !hit; gx += 0.05) {
        const h = pickHit({ clientX: Math.round(innerWidth * gx), clientY: Math.round(innerHeight * gy) });
        if (h && h.d && h.d.id) hit = h;
      }
    }
    r.pick = !!hit;
    if (hit) { try { selectBuilding({ clientX: innerWidth / 2, clientY: innerHeight / 2 }, hit); } catch (e) { r.cardError = String(e.message); }
      const el = document.getElementById('prop-card');
      r.card = !!(el && el.style.display !== 'none');
      r.cardHasWard = !!(el && /区/.test(el.innerText || '')); }
    const tags = new Set();
    scene.traverse((o) => { if (o.name) tags.add(o.name); const cp = o.userData && o.userData.creationPath; if (cp) tags.add(cp); });
    const has = (re) => [...tags].some((n) => re.test(n));
    r.hasRail = has(/rail/i); r.hasWater = has(/water|river/i);
    r.hasParks = has(/park/i); r.hasRoad = has(/road/i); r.hasBuildings = has(/BUILDING/i);
    return r;
  })()`,
};

async function settle(page, min = 2500, max = 120000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/visual-production-qa/' + name + '.jpg';
}

export async function run() {
  const t0 = Date.now();
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35J', url: URL_,
    sites: [], performance: [], regression: null, ui: null, errors: [] };
  const b = await launchBrowser({ width: 1400, height: 900 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    out.boot = await page.evaluate(JS.boot);
    console.log('[prod-vis] 起動時', JSON.stringify(out.boot.visual.style), out.boot.visual.profile, out.boot.visual.tuning);
    out.ui = await page.evaluate(JS.ui);
    console.log('[prod-vis] UI 開発用の可視', JSON.stringify(Object.entries(out.ui.devOnly).filter(([, v]) => v === 'visible')),
      '通常 UI', JSON.stringify(out.ui.production));

    for (const s of SITES) {
      const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2200);
      const dirs = [];
      for (const az of s.dirs) {
        await page.evaluate(JS.camera(w.x, w.z, az));
        await settle(page);
        await sleep(700);
        const luma = await page.evaluate(JS.luma, { timeoutMs: 120000 });
        const bl = await page.evaluate(JS.buildingLuma, { timeoutMs: 120000 });
        dirs.push({ az, luma, building: bl, shot: await shot(page, `${s.id}.az${az}`) });
      }
      const sceneStats = directionStats(dirs.map((d) => d.luma.mean));
      const bldgStats = directionStats(dirs.map((d) => d.building.mean));
      out.sites.push({ ...s, world: w, dirs, sceneStats, bldgStats });
      console.log('[prod-vis]', s.id.padEnd(16),
        '画面', dirs.map((d) => d.luma.mean.toFixed(3)).join(' '),
        '| 建物', dirs.map((d) => (d.building.mean == null ? '  -  ' : d.building.mean.toFixed(3))).join(' '),
        '| 比', bldgStats ? bldgStats.ratio.toFixed(3) : '-');
    }

    // City Mode（§6/§13）
    try {
      await page.evaluate('(() => { CityModeManager.enter(); return 1; })()');
      await settle(page, 4000, 150000);
      await sleep(1200);
      out.cityMode = { luma: await page.evaluate(JS.luma, { timeoutMs: 120000 }),
        building: await page.evaluate(JS.buildingLuma, { timeoutMs: 120000 }),
        shot: await shot(page, 'city-mode') };
      console.log('[prod-vis] city-mode 画面', out.cityMode.luma.mean, '建物', out.cityMode.building.mean);
      const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ id: 'city-mode', label: 'City Mode', mode: 'city', ...r });
      console.log('[prod-vis] perf city-mode      fps', r.fpsAverage, 'p95', r.frameMsP95 + 'ms');
      await page.evaluate('(() => { CityModeManager.exit("kita"); return 1; })()');
      await sleep(3000);
    } catch (e) { out.cityModeError = String(e && e.message || e).slice(0, 200); }

    // §9 性能
    for (const id of PERF_SITES) {
      const s = SITES.find((x) => x.id === id); const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2000);
      await page.evaluate(JS.camera(w.x, w.z, 0));
      await settle(page);
      const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ id, label: s.label, mode: 'ward', ...r });
      console.log('[prod-vis] perf', id.padEnd(16), 'fps', r.fpsAverage, 'p95', r.frameMsP95 + 'ms',
        'calls', r.drawCallsAvg, 'tri', r.trianglesAvg);
    }

    const w0 = worldOf(SITES[0]);
    await page.evaluate(JS.ward(w0.x, w0.z)); await sleep(2200);
    await page.evaluate(JS.camera(w0.x, w0.z, 0));
    await settle(page);
    out.regression = await page.evaluate(JS.regression, { timeoutMs: 120000 });
    console.log('[prod-vis] regression', JSON.stringify(out.regression));
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }

  // ── まとめ ──────────────────────────────────────────────────────────
  const v = out.boot ? out.boot.visual : null;
  const allDirs = out.sites.flatMap((s) => s.dirs);
  const multi = out.sites.filter((s) => s.dirs.length >= 4);
  const devVisible = Object.entries(out.ui.devOnly).filter(([, x]) => x === 'visible').map(([k]) => k);
  const prodMissing = Object.entries(out.ui.production).filter(([, x]) => x !== 'visible').map(([k]) => k);
  const r = out.regression || {};
  const eq = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
  out.summary = {
    // §2 35I の値がそのまま使われているか
    visual: v,
    visualMatches35I: !!(v && v.profile === EXPECTED.profile && v.tuning === EXPECTED.tuning
      && v.lightLevel === EXPECTED.lightLevel
      && eq(v.wallShades.lit, EXPECTED.wall.lit) && eq(v.wallShades.side, EXPECTED.wall.side)
      && eq(v.wallShades.dark, EXPECTED.wall.dark)
      && eq(v.style.exposure, EXPECTED.light.exposure) && eq(v.style.hemi, EXPECTED.light.hemi)
      && eq(v.style.sun, EXPECTED.light.sun) && eq(v.style.fill, EXPECTED.light.fill)
      && String(v.live.fillColor).toLowerCase() === EXPECTED.fillColor),
    buildProfile: out.boot ? out.boot.profile : null,
    buildingsVersion: out.boot ? out.boot.version : null,
    // §7 方向 QA
    darkFacingViewStillReadable: allDirs.every((d) => d.luma.mean >= MIN_SCENE_LUMA),
    darkestSceneLuma: +Math.min(...allDirs.map((d) => d.luma.mean)).toFixed(4),
    darkestBuildingLuma: +Math.min(...allDirs.map((d) => d.building.mean)).toFixed(4),
    brightFacingViewNotWashedOut: allDirs.every((d) => d.luma.clippedFraction <= MAX_CLIPPED_FRACTION),
    maxClippedFraction: +Math.max(...allDirs.map((d) => d.luma.clippedFraction)).toFixed(4),
    worstDirectionRatio: multi.length ? +Math.max(...multi.map((s) => s.bldgStats.ratio)).toFixed(4) : null,
    directionRatioWithinTarget: multi.length ? multi.every((s) => s.bldgStats.ratio <= LUMA_RATIO_TARGET) : null,
    // §7 色が残っているか（無彩色に潰れていないか）
    buildingColorRetained: allDirs.every((d) => d.building.saturation > 0.05),
    minBuildingSaturation: +Math.min(...allDirs.map((d) => d.building.saturation)).toFixed(4),
    maxBlueBias: +Math.max(...allDirs.map((d) => d.luma.blueBias)).toFixed(4),
    // §7 接地・量感は式で担保（頂点カラーが全 LOD1 mesh に入っていること）
    contactDepthRetained: !!(v && v.shades.baseDarken < 1 && v.shades.massDarken > 0),
    highRiseMassRetained: !!(v && v.shades.massDarken > 0 && v.shades.roof === 1),
    lod1AllShaded: !!(r.lod1Meshes > 0 && r.lod1Shaded === r.lod1Meshes),
    // §5 開発用 UI
    devUiVisible: devVisible, productionUiMissing: prodMissing,
    devUiHidden: devVisible.length === 0 && prodMissing.length === 0,
    // §8 回帰
    regressionOk: !!(r.roadMode === 'ROAD_V3' && r.buildingsVersion === 'V4' && r.selfCheck === 0
      && r.highLod && r.labels === 'ok' && r.search && r.hover && r.pick && r.card && r.cardHasWard
      && r.hasRail && r.hasWater && r.hasParks && r.hasRoad && r.hasBuildings
      && r.highLodMeshes > 0),
    regression: r,
    cityMode: out.cityMode || null,
    perf: Object.fromEntries(out.performance.map((p) => [p.id, { fps: p.fpsAverage, p95: p.frameMsP95, calls: p.drawCallsAvg, tris: p.trianglesAvg }])),
    jsErrors: out.errors.length,
    elapsedMs: Date.now() - t0,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { console.log('[prod-vis] summary', JSON.stringify(o.summary, null, 1).slice(0, 2600)); console.log('[prod-vis] out', OUT); })
    .catch((e) => { console.error(e); process.exit(1); });
}
