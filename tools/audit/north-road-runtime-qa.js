#!/usr/bin/env node
// tools/audit/north-road-runtime-qa.js
// [Mission 35E §9/§10/§12/§13] 実ブラウザで北側の道路補完と建物 V4 昇格を確認する。
//   §9  北部 8 地点の見た目（道路空白が減っているか / rail と混線しないか）
//   §10 追加した建物と道路の関係（道路から孤立していないか）
//   §12 性能（FPS / frame p95 / draw call / triangle / tile 数）
//   §13 既存機能の regression（label / hover / click / card / search / rail / water / parks / ward 切替）
//   前提: `npm run preview`。出力: data/reports/north-road-runtime-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
export const OUT = P('data', 'reports', 'north-road-runtime-qa.json');
export const SHOTS = P('data', 'reports', 'north-road-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const VIEW = { r: 700, phDeg: 50, th: -0.35, fov: 44 };
export const PERF_SECONDS = 15;

/** §9 北部の必須確認地点（緯度経度で書く。world は正本の変換を通す）。 */
export const SITES = [
  { id: 'shin-osaka', label: '新大阪', lat: 34.73340, lon: 135.50020, ward: 'yodogawa' },
  { id: 'higashi-mikuni', label: '東三国', lat: 34.74100, lon: 135.49860, ward: 'yodogawa' },
  { id: 'awaji', label: '淡路', lat: 34.74640, lon: 135.53170, ward: 'higashiyodogawa' },
  { id: 'kami-shinjo', label: '上新庄', lat: 34.74770, lon: 135.54700, ward: 'higashiyodogawa' },
  { id: 'juso', label: '十三', lat: 34.72170, lon: 135.48420, ward: 'yodogawa' },
  { id: 'nishinakajima', label: '西中島', lat: 34.72640, lon: 135.49820, ward: 'yodogawa' },
  { id: 'kunijima', label: '柴島', lat: 34.73530, lon: 135.51900, ward: 'higashiyodogawa' },
  { id: 'asahi-north', label: '旭区北部', lat: 34.73200, lon: 135.55600, ward: 'asahi' },
];
/** §12 性能を測る地点。 */
export const PERF_SITES = [
  { id: 'umeda', label: '梅田', lat: 34.70250, lon: 135.49586 },
  { id: 'shin-osaka', label: '新大阪', lat: 34.73340, lon: 135.50020 },
  { id: 'higashiyodogawa', label: '東淀川', lat: 34.74640, lon: 135.53170 },
  { id: 'yodogawa', label: '淀川', lat: 34.72640, lon: 135.49820 },
];

export function worldOf(s) {
  const w = latLonToLiveCityWorld(s.lat, s.lon);
  return { x: Math.round(w.x), z: Math.round(w.z) };
}

const HIDE_UI = `(() => {
  for (const el of document.querySelectorAll('div')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|layer-toggle|^tip$|search-box|^pl$|^pr$|^lc-panel|^lc-topbar|^controls$/.test(id)) el.style.display = 'none'; }
  return 1; })()`;
const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    CAMERA_MODE_FOV[cameraMode] = ${VIEW.fov};
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = (90 - ${VIEW.phDeg}) * Math.PI / 180; cs.th = ${VIEW.th}; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  // 建物の版は getDebug() ではなく getBuildingsVersionDebug() が持っている。
  debug: `(() => { const d = CanonicalRuntime.getDebug(); const p = CanonicalRuntime.getPerf();
    const bv = CanonicalRuntime.getBuildingsVersionDebug();
    return { version: bv.version, base: bv.base, label: bv.label, buildingCount: bv.buildingCount,
      visibleBuildings: d.visibleBuildings, tiles: p.tiles }; })()`,
  /**
   * §9/§10 地表を格子で撃って、道路面と建物がどれだけ出ているかを数える。
   * 道路は runtimeOwner ではなく creationPath / roadKey ではなく **実際の mesh** で数える。
   */
  ground: (cx, cz, half, step) => `(() => {
    const roadMeshes = [], bldgMeshes = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      let q = o, v = true; while (q) { if (q.visible === false) { v = false; break; } q = q.parent; } if (!v) return;
      const cp = (o.userData && o.userData.creationPath) || (o.parent && o.parent.userData && o.parent.userData.creationPath) || '';
      const nm = o.name || '';
      // ROAD V3 の道路面は mesh 名が RoadV3_* で、creationPath を持たない。
      // creationPath だけで判定すると RoadBucket_* しか拾えず、道路が 0 と出る。
      if (/^RoadV3_/.test(nm) || /^RoadBucket_/.test(nm) || /ROAD/i.test(cp)) roadMeshes.push(o);
      else if (o.userData && o.userData.usageCategory != null) bldgMeshes.push(o);
    });
    let probes = 0, roadHit = 0, bldgHit = 0;
    for (let dx = -${half}; dx <= ${half}; dx += ${step}) {
      for (let dz = -${half}; dz <= ${half}; dz += ${step}) {
        probes++;
        const o = new THREE.Vector3(${cx} + dx, 900, ${cz} + dz), d = new THREE.Vector3(0, -1, 0);
        if (roadMeshes.length && new THREE.Raycaster(o, d, 0.1, 2000).intersectObjects(roadMeshes, false).length) roadHit++;
        if (bldgMeshes.length && new THREE.Raycaster(o, d, 0.1, 2000).intersectObjects(bldgMeshes, false).length) bldgHit++;
      }
    }
    return { probes, roadHit, bldgHit, roadMeshes: roadMeshes.length, bldgMeshes: bldgMeshes.length };
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
        resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1),
          frameMsP95: +pct(dt, 0.95).toFixed(1),
          drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
          trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)),
          roadTiles: p.tiles && p.tiles.byLayer ? (p.tiles.byLayer.roads || null) : null,
          buildingTiles: p.tiles && p.tiles.byLayer ? (p.tiles.byLayer.buildings || null) : null,
          tiles: p.tiles });
      } }
    requestAnimationFrame(f); })`,
  /** §13 既存機能がそのまま動くか。 */
  regression: `(() => {
    const r = {};
    try { r.roadMode = __SEMANTIC_DISPLAY_DEBUG__().normalViewRoadMode; } catch (e) { r.roadMode = 'ERR:' + e.message; }
    try { r.buildingsVersion = CanonicalRuntime.getBuildingsVersionDebug().version; } catch (e) { r.buildingsVersion = 'ERR'; }
    try { r.selfCheck = __CANONICAL_SELF_CHECK__().total; } catch (e) { r.selfCheck = -1; }
    try { r.highLod = !!(window.__BUILDING_LOD_DEBUG__ && window.__BUILDING_LOD_DEBUG__()); } catch (e) { r.highLod = false; }
    try { r.labels = (typeof window.__CITY_LABEL_DEBUG__ === 'function' && window.__CITY_LABEL_DEBUG__()) ? 'ok' : 'missing'; } catch (e) { r.labels = 'ERR'; }
    try { r.stationLabels = (typeof window.__STATION_LABEL_DEBUG__ === 'function' && window.__STATION_LABEL_DEBUG__()) ? 'ok' : 'missing'; } catch (e) { r.stationLabels = 'ERR'; }
    // hover / click / card
    let hit = null;
    for (let gy = 0.35; gy <= 0.65 && !hit; gy += 0.05) {
      for (let gx = 0.3; gx <= 0.7 && !hit; gx += 0.05) {
        const h = pickHit({ clientX: Math.round(innerWidth * gx), clientY: Math.round(innerHeight * gy) });
        if (h && h.d && h.d.id) hit = h;
      }
    }
    r.pick = !!hit;
    if (hit) {
      try { selectBuilding({ clientX: innerWidth / 2, clientY: innerHeight / 2 }, hit); } catch (e) { r.cardError = String(e.message); }
      const el = document.getElementById('prop-card');
      r.card = !!(el && el.style.display !== 'none');
      r.cardHasWard = !!(el && /区/.test(el.innerText || ''));
      r.pickedId = hit.d.id;
    }
    // search
    try { r.search = typeof findSpot === 'function'; } catch (e) { r.search = false; }
    // rail / water / parks のレイヤーが scene にあるか
    const names = new Set();
    scene.traverse((o) => { if (o.name) names.add(o.name); });
    r.hasRail = [...names].some((n) => /rail/i.test(n));
    r.hasWater = [...names].some((n) => /water/i.test(n));
    r.hasParks = [...names].some((n) => /park/i.test(n));
    r.hasRoad = [...names].some((n) => /road/i.test(n));
    return r;
  })()`,
};

async function settle(page, min = 3000, max = 120000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/north-road-qa/' + name + '.jpg';
}

export async function run() {
  const t0 = Date.now();
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35E', url: URL_,
    sites: [], performance: [], regression: null, errors: [] };
  const b = await launchBrowser({ width: 1500, height: 950 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    const boot = await page.evaluate(JS.debug);
    out.boot = boot;
    console.log('[qa] 起動時', JSON.stringify(boot.version), boot.base);

    // ── §9/§10 北部 8 地点 ───────────────────────────────────────────
    for (const s of SITES) {
      const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2200);
      await page.evaluate(JS.camera(w.x, w.z, VIEW.r));
      await settle(page);
      const d = await page.evaluate(JS.debug);
      const g = await page.evaluate(JS.ground(w.x, w.z, 350, 14), { timeoutMs: 180000 });
      await page.evaluate(HIDE_UI); await sleep(1300);
      const rec = { ...s, world: w, visibleBuildings: d.visibleBuildings,
        roadCoverage: g.probes ? +(g.roadHit / g.probes).toFixed(4) : null,
        buildingCoverage: g.probes ? +(g.bldgHit / g.probes).toFixed(4) : null,
        ground: g, shot: await shot(page, s.id) };
      out.sites.push(rec);
      console.log('[qa]', s.id.padEnd(16), '建物', String(rec.visibleBuildings).padStart(6),
        '| 道路被覆', ((rec.roadCoverage || 0) * 100).toFixed(1) + '%',
        '| 建物被覆', ((rec.buildingCoverage || 0) * 100).toFixed(1) + '%');
    }

    // ── §12 性能 ─────────────────────────────────────────────────────
    for (const s of PERF_SITES) {
      const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2000);
      await page.evaluate(JS.camera(w.x, w.z, VIEW.r));
      await settle(page);
      const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ id: s.id, label: s.label, mode: 'ward', ...r });
      console.log('[qa] perf', s.id.padEnd(16), 'fps', r.fpsAverage, 'p95', r.frameMsP95 + 'ms',
        'calls', r.drawCallsAvg, 'tri', r.trianglesAvg);
    }
    // City Mode
    try {
      await page.evaluate('(() => { CityModeManager.enter(); return 1; })()');
      await settle(page, 4000, 120000);
      const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ id: 'city-mode', label: 'City Mode', mode: 'city', ...r });
      console.log('[qa] perf city-mode      fps', r.fpsAverage, 'p95', r.frameMsP95 + 'ms');
      await page.evaluate('(() => { CityModeManager.exit("kita"); return 1; })()');
      await sleep(3000);
    } catch (e) { out.cityModeError = String(e && e.message || e).slice(0, 200); }

    // ── §13 regression ───────────────────────────────────────────────
    const w0 = worldOf(PERF_SITES[0]);
    await page.evaluate(JS.ward(w0.x, w0.z)); await sleep(2200);
    await page.evaluate(JS.camera(w0.x, w0.z, 400));
    await settle(page);
    out.regression = await page.evaluate(JS.regression, { timeoutMs: 120000 });
    console.log('[qa] regression', JSON.stringify(out.regression));
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }

  const r = out.regression || {};
  out.summary = {
    sites: out.sites.length,
    allSitesHaveRoads: out.sites.every((s) => (s.roadCoverage || 0) > 0.02),
    minRoadCoverage: out.sites.length ? Math.min(...out.sites.map((s) => s.roadCoverage || 0)) : null,
    medianRoadCoverage: out.sites.length
      ? [...out.sites.map((s) => s.roadCoverage || 0)].sort((a, b) => a - b)[Math.floor(out.sites.length / 2)] : null,
    buildingsVersion: out.boot ? out.boot.version : null,
    regressionOk: !!(r.roadMode === 'ROAD_V3' && r.buildingsVersion === 'V4' && r.selfCheck === 0
      && r.pick && r.card && r.cardHasWard && r.search && r.hasRail && r.hasWater && r.hasParks && r.hasRoad
      && r.labels === 'ok' && r.highLod),
    regression: r,
    perfMinFps: out.performance.length ? Math.min(...out.performance.map((p) => p.fpsAverage)) : null,
    jsErrors: out.errors.length,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { console.log('[qa] summary', JSON.stringify(o.summary)); console.log('[qa] out', OUT); })
    .catch((e) => { console.error(e); process.exit(1); });
}
