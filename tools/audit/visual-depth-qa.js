#!/usr/bin/env node
// tools/audit/visual-depth-qa.js
// [Mission 35H §23/§24/§25/§29] CURRENT と 35H DEPTH を **同じカメラ** で撮り比べ、
//   面ごとの明暗が実際に付いているか・性能が落ちていないかを測る。
//   前提: `npm run preview`。対象は dev（ward-ux-v1.html）。production は触らない（§28）。
//   出力: data/reports/visual-depth-qa.json / data/reports/visual-depth-qa/<site>.<profile>.jpg
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
export const OUT = P('data', 'reports', 'visual-depth-qa.json');
export const SHOTS = P('data', 'reports', 'visual-depth-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** §23 必須の確認地点。CITY MODE は別扱い（ward ではないため）。 */
export const SITES = [
  { id: 'umeda', label: '梅田', lat: 34.70250, lon: 135.49586 },
  { id: 'nakanoshima', label: '中之島', lat: 34.69280, lon: 135.49330 },
  { id: 'honmachi', label: '本町', lat: 34.68200, lon: 135.49900 },
  { id: 'namba', label: '難波', lat: 34.66600, lon: 135.50100 },
  { id: 'tennoji', label: '天王寺', lat: 34.64550, lon: 135.51400 },
  { id: 'shin-osaka', label: '新大阪', lat: 34.73340, lon: 135.50020 },
  { id: 'higashiyodogawa', label: '東淀川', lat: 34.74640, lon: 135.53170 },
];
/** §23 立体感は低い角度でこそ出る。俯瞰と斜めの 2 つで撮る。 */
export const VIEWS = {
  overview: { r: 900, phDeg: 52, th: -0.35, fov: 44 },
  low: { r: 520, phDeg: 34, th: -0.35, fov: 44 },   // §23 30〜45° の斜め視点
};
/** §25 性能を測る地点。 */
export const PERF_SITES = ['umeda', 'shin-osaka'];
export const PERF_SECONDS = 15;
export const PROFILES = ['CURRENT', 'DEPTH'];

export function worldOf(s) {
  const w = latLonToLiveCityWorld(s.lat, s.lon);
  return { x: Math.round(w.x), z: Math.round(w.z) };
}

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, v) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    CAMERA_MODE_FOV[cameraMode] = ${v.fov};
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${v.r}; cs.ph = (90 - ${v.phDeg}) * Math.PI / 180; cs.th = ${v.th}; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  depth: `JSON.stringify(window.__VISUAL_DEPTH_DEBUG__())`,
  setProfile: (p) => `JSON.stringify(window.__VISUAL_PROFILE__('${p}'))`,
  /**
   * §24 画面そのものの明るさ分布を測る。
   * 画素は取れないので、**建物 mesh の頂点カラーの分布**と、
   * 画面に出ている建物 mesh 数・三角形数で「面の差が付いているか」を数える。
   */
  shading: `(() => {
    let meshes = 0, withColor = 0, verts = 0;
    const hist = new Array(10).fill(0);
    let min = 255, max = 0, sum = 0, n = 0;
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      if (!(o.userData && o.userData.usageCategory != null)) return;
      meshes++;
      const a = o.geometry && o.geometry.getAttribute && o.geometry.getAttribute('color');
      if (!a) return;
      withColor++; verts += a.count;
      // 全頂点は多すぎるので間引いて分布を見る
      const step = Math.max(1, Math.floor(a.count / 400));
      for (let i = 0; i < a.count; i += step) {
        const v = a.array[i * a.itemSize];   // Uint8（0..255）
        if (v < min) min = v; if (v > max) max = v;
        sum += v; n++;
        hist[Math.min(9, Math.floor(v / 25.6))]++;
      }
    });
    return { meshes, withColor, verts, sampled: n,
      min: n ? min : null, max: n ? max : null, mean: n ? +(sum / n).toFixed(1) : null,
      hist };
  })()`,
  /** §18 白飛びしていないか（material 色が 255 に張り付いていないか）を代表値で見る。 */
  clipping: `(() => {
    const seen = new Map();
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const cat = o.userData && o.userData.usageCategory;
      if (cat == null || !o.material || !o.material.color) return;
      if (seen.has(cat)) return;
      const c = o.material.color;
      seen.set(cat, { r: +(c.r).toFixed(3), g: +(c.g).toFixed(3), b: +(c.b).toFixed(3),
        band: o.userData.crBuildingBand || null });
    });
    const out = {}; let clipped = 0, maxCh = 0;
    for (const [k, v] of seen) { out[k] = v; const m = Math.max(v.r, v.g, v.b); if (m > maxCh) maxCh = m; if (m >= 0.999) clipped++; }
    return { byCategory: out, categories: seen.size, clippedCategories: clipped, maxChannel: +maxCh.toFixed(3) };
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
        const mem = (performance.memory && performance.memory.usedJSHeapSize) ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
        resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1), frameMsP95: +pct(dt, 0.95).toFixed(1),
          drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
          trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)),
          loadedTiles: p.tiles ? p.tiles.loaded : null, jsHeapMB: mem,
          geometriesLive: renderer.info.memory ? renderer.info.memory.geometries : null,
          texturesLive: renderer.info.memory ? renderer.info.memory.textures : null });
      } }
    requestAnimationFrame(f); })`,
  /** §13/§10 高 LOD と HD ランドマークが壊れていないか。 */
  highLod: `(() => {
    const r = {};
    try { const d = window.__BUILDING_LOD_DEBUG__ && window.__BUILDING_LOD_DEBUG__(); r.debug = !!d; r.stats = d ? { buildings: d.buildings ?? null, lod2: d.lod2 ?? null, lod3: d.lod3 ?? null } : null; } catch (e) { r.debug = false; }
    let hi = 0, hd = 0;
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      let q = o, tag = '';
      while (q) { if (q.name === 'CR_buildingLodHigh') { tag = 'hi'; break; } if (q.name === 'LandmarkHDLayer') { tag = 'hd'; break; } q = q.parent; }
      if (tag === 'hi') hi++; else if (tag === 'hd') hd++;
    });
    r.highLodMeshes = hi; r.landmarkHdMeshes = hd;
    // 高 LOD の mesh に LOD1 用の頂点カラーが混ざっていないこと（§13）
    let leaked = 0;
    scene.traverse((o) => {
      if (!o.isMesh) return;
      let q = o, inHigh = false;
      while (q) { if (q.name === 'CR_buildingLodHigh') { inHigh = true; break; } q = q.parent; }
      if (inHigh && o.userData && o.userData.usageCategory != null) leaked++;
    });
    r.lod1ShadeLeakedIntoHighLod = leaked;
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
  return 'data/reports/visual-depth-qa/' + name + '.jpg';
}
const HIDE_UI = `(() => {
  for (const el of document.querySelectorAll('div')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|layer-toggle|^tip$|search-box|^pl$|^pr$|^lc-panel|^lc-topbar|^controls$/.test(id)) el.style.display = 'none'; }
  return 1; })()`;

export async function run() {
  const t0 = Date.now();
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35H', url: URL_,
    profiles: {}, performance: [], errors: [] };
  const b = await launchBrowser({ width: 1500, height: 950 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    await page.evaluate(HIDE_UI);

    for (const profile of PROFILES) {
      await page.evaluate(JS.setProfile(profile));
      await sleep(1500);
      const rec = { profile, sites: [], depth: null, highLod: null };
      for (const s of SITES) {
        const w = worldOf(s);
        await page.evaluate(JS.ward(w.x, w.z)); await sleep(2000);
        const per = {};
        for (const [vk, v] of Object.entries(VIEWS)) {
          await page.evaluate(JS.camera(w.x, w.z, v));
          await settle(page);
          await page.evaluate(HIDE_UI); await sleep(900);
          per[vk] = { view: v, shading: await page.evaluate(JS.shading, { timeoutMs: 120000 }),
            shot: await shot(page, `${s.id}.${vk}.${profile}`) };
        }
        rec.sites.push({ ...s, world: w, ...per });
        const sh = per.overview.shading;
        console.log('[depth]', profile.padEnd(7), s.id.padEnd(16),
          'mesh', String(sh.meshes).padStart(4), '色付き', String(sh.withColor).padStart(4),
          '明暗 min/mean/max', sh.min, '/', sh.mean, '/', sh.max);
      }
      // City Mode（§23/§19）
      try {
        await page.evaluate('(() => { CityModeManager.enter(); return 1; })()');
        await settle(page, 4000, 120000);
        await page.evaluate(HIDE_UI); await sleep(1200);
        rec.cityMode = { shading: await page.evaluate(JS.shading, { timeoutMs: 120000 }),
          shot: await shot(page, `city-mode.${profile}`) };
        console.log('[depth]', profile.padEnd(7), 'city-mode       mesh',
          rec.cityMode.shading.meshes, '色付き', rec.cityMode.shading.withColor);
        await page.evaluate('(() => { CityModeManager.exit("kita"); return 1; })()');
        await sleep(3000);
      } catch (e) { rec.cityModeError = String(e && e.message || e).slice(0, 200); }

      // 代表地点へ戻して状態と高 LOD を確認
      const w0 = worldOf(SITES[0]);
      await page.evaluate(JS.ward(w0.x, w0.z)); await sleep(2000);
      await page.evaluate(JS.camera(w0.x, w0.z, VIEWS.low));
      await settle(page);
      rec.depth = JSON.parse(await page.evaluate(JS.depth));
      rec.clipping = await page.evaluate(JS.clipping, { timeoutMs: 60000 });
      rec.highLod = await page.evaluate(JS.highLod, { timeoutMs: 60000 });
      out.profiles[profile] = rec;

      // §25 性能
      for (const id of PERF_SITES) {
        const s = SITES.find((x) => x.id === id); const w = worldOf(s);
        await page.evaluate(JS.ward(w.x, w.z)); await sleep(2000);
        await page.evaluate(JS.camera(w.x, w.z, VIEWS.overview));
        await settle(page);
        const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
        out.performance.push({ profile, id, label: s.label, mode: 'ward', ...r });
        console.log('[depth] perf', profile.padEnd(7), id.padEnd(16), 'fps', r.fpsAverage,
          'p95', r.frameMsP95 + 'ms', 'calls', r.drawCallsAvg, 'tri', r.trianglesAvg, 'heap', r.jsHeapMB + 'MB');
      }
      try {
        await page.evaluate('(() => { CityModeManager.enter(); return 1; })()');
        await settle(page, 4000, 120000);
        const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
        out.performance.push({ profile, id: 'city-mode', label: 'City Mode', mode: 'city', ...r });
        console.log('[depth] perf', profile.padEnd(7), 'city-mode        fps', r.fpsAverage, 'p95', r.frameMsP95 + 'ms');
        await page.evaluate('(() => { CityModeManager.exit("kita"); return 1; })()');
        await sleep(3000);
      } catch (e) { /* noop */ }
    }
    // 最後は DEPTH に戻す（dev の既定）
    await page.evaluate(JS.setProfile('DEPTH'));
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }

  // ── まとめ ──────────────────────────────────────────────────────────
  const cur = out.profiles.CURRENT, dep = out.profiles.DEPTH;
  const perfOf = (profile, id) => out.performance.find((p) => p.profile === profile && p.id === id);
  const perfDelta = {};
  for (const id of [...PERF_SITES, 'city-mode']) {
    const a = perfOf('CURRENT', id), c = perfOf('DEPTH', id);
    if (!a || !c) continue;
    perfDelta[id] = { current: a.fpsAverage, depth: c.fpsAverage,
      dropPct: +(((a.fpsAverage - c.fpsAverage) / a.fpsAverage) * 100).toFixed(1),
      drawCalls: { current: a.drawCallsAvg, depth: c.drawCallsAvg },
      triangles: { current: a.trianglesAvg, depth: c.trianglesAvg } };
  }
  const worstDrop = Object.values(perfDelta).length ? Math.max(...Object.values(perfDelta).map((d) => d.dropPct)) : null;
  const depShade = dep ? dep.sites.map((s) => s.overview.shading) : [];
  out.summary = {
    profilesMeasured: Object.keys(out.profiles),
    // §24 DEPTH では全建物 mesh に頂点カラーが入り、CURRENT では 1 つも入らない
    depthAllMeshesShaded: depShade.length > 0 && depShade.every((s) => s.meshes > 0 && s.withColor === s.meshes),
    currentNoVertexColor: cur ? cur.sites.every((s) => s.overview.shading.withColor === 0) : null,
    // 面の明暗が実際に開いているか（屋根 255 と陰の壁の差）
    shadeSpread: depShade.length ? {
      min: Math.min(...depShade.map((s) => s.min)),
      max: Math.max(...depShade.map((s) => s.max)),
      meanOfMeans: +(depShade.reduce((a, s) => a + s.mean, 0) / depShade.length).toFixed(1),
    } : null,
    // §18 白飛びしていないこと
    clipping: { current: cur ? cur.clipping : null, depth: dep ? dep.clipping : null },
    noWhiteClipping: !!(dep && dep.clipping && dep.clipping.clippedCategories === 0),
    // §13 高 LOD に LOD1 の補正が漏れていないこと
    highLod: { current: cur ? cur.highLod : null, depth: dep ? dep.highLod : null },
    highLodIntact: !!(dep && dep.highLod && dep.highLod.lod1ShadeLeakedIntoHighLod === 0
      && dep.highLod.highLodMeshes > 0),
    // §25 性能
    perfDelta, worstFpsDropPct: worstDrop,
    perfWithinBudget: worstDrop != null && worstDrop <= 10,
    perfIdeal: worstDrop != null && worstDrop <= 5,
    jsErrors: out.errors.length,
    elapsedMs: Date.now() - t0,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { console.log('[depth] summary', JSON.stringify(o.summary, null, 1)); console.log('[depth] out', OUT); })
    .catch((e) => { console.error(e); process.exit(1); });
}
