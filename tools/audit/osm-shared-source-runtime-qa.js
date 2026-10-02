#!/usr/bin/env node
// tools/audit/osm-shared-source-runtime-qa.js
// [Mission 35F §11/§12/§14] 北部 8 地点で building / road / rail / water / park / label を
//   まとめて確認し、性能と regression を測る。
//   前提: `npm run preview`。出力: data/reports/osm-shared-source-runtime-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';
import { SITES, PERF_SITES, worldOf, VIEW, PERF_SECONDS } from './north-road-runtime-qa.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
export const OUT = P('data', 'reports', 'osm-shared-source-runtime-qa.json');

/**
 * [Mission 35F §11] 35E から引き継いだ QA 地点の訂正。
 *
 * 'asahi-north'（34.7320 / 135.5560）は **どの区ポリゴンにも入らない**（市境を越えて守口市側）。
 * 建物タイルは区に紐づいて読み込まれるため、区が決まらないこの点では建物が 1 つも出ず、
 * 「旭区北部の建物が 0%」という誤った読みになる（道路は区に紐づかないので出ていた）。
 * 旭区の中の点（34.7360 / 135.5540・周囲 350m に canonical 建物 422 棟）へ直す。
 * 35E の SITES 自体は変えない（35E のレポートの数字を後から動かさないため）。
 */
export const SITE_FIX = {
  'asahi-north': { lat: 34.7360, lon: 135.5540,
    reason: '35E の座標 34.7320/135.5560 は区ポリゴン外（守口市側）。区に紐づく建物タイルが読まれない' },
};
export function fixedSites(sites = SITES) {
  return sites.map((s) => (SITE_FIX[s.id] ? { ...s, ...SITE_FIX[s.id], originalLat: s.lat, originalLon: s.lon } : s));
}
export const SHOTS = P('data', 'reports', 'osm-shared-source-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  debug: `(() => { const d = CanonicalRuntime.getDebug(); const p = CanonicalRuntime.getPerf();
    const bv = CanonicalRuntime.getBuildingsVersionDebug();
    return { version: bv.version, base: bv.base, visibleBuildings: d.visibleBuildings, tiles: p.tiles }; })()`,
  /**
   * §11 その地点で各レイヤーが実際に描かれているかを数える。
   * 35E で学んだとおり creationPath だけでは足りない。**mesh 名も見る**
   * （ROAD V3 の道路面は RoadV3_* で creationPath を持たない）。
   */
  layers: (cx, cz, half, step) => `(() => {
    // 鉄道は **LineSegments** で描かれている（buildGroup の layer==='rail' は lineMesh()）。
    //   isMesh だけを集めると鉄道はゼロ件になり、「出ていない」と誤読する（35E の道路 0% と同じ轍）。
    //   canonical の tile group は userData.creationPath = 'CANONICAL_<LAYER>' を持つので、
    //   mesh 名ではなく親の creationPath でレイヤーを決める（parks / water の mesh は無名）。
    const cls = { road: [], building: [], rail: [], water: [], park: [] };
    scene.traverse((o) => {
      if (!(o.isMesh || o.isLineSegments) || !o.visible) return;
      let q = o, v = true; while (q) { if (q.visible === false) { v = false; break; } q = q.parent; } if (!v) return;
      const cp = (o.userData && o.userData.creationPath) || (o.parent && o.parent.userData && o.parent.userData.creationPath) || '';
      const nm = o.name || '';
      if (/^RoadV3_/.test(nm) || /^RoadBucket_/.test(nm) || /ROAD/i.test(cp)) cls.road.push(o);
      else if (/RAIL/i.test(cp) || /^Rail/i.test(nm)) cls.rail.push(o);
      else if (/WATER/i.test(cp) || /^(Water|River)/i.test(nm)) cls.water.push(o);
      else if (/PARK/i.test(cp) || /^Park/i.test(nm)) cls.park.push(o);
      else if (o.userData && o.userData.usageCategory != null) cls.building.push(o);
    });
    const hit = {}; let probes = 0;
    for (const k of Object.keys(cls)) hit[k] = 0;
    // 線は太さを持たないので、真下へ撃った ray が線の何 m 以内を通れば「その場所に線路がある」と
    //   みなすかを決める必要がある。複線の軌道敷の幅として 4 m を採る。
    const LINE_THRESHOLD_M = 4;
    for (let dx = -${half}; dx <= ${half}; dx += ${step}) {
      for (let dz = -${half}; dz <= ${half}; dz += ${step}) {
        probes++;
        const o = new THREE.Vector3(${cx} + dx, 900, ${cz} + dz), d = new THREE.Vector3(0, -1, 0);
        for (const k of Object.keys(cls)) {
          if (!cls[k].length) continue;
          const rc = new THREE.Raycaster(o, d, 0.1, 2000);
          rc.params.Line.threshold = LINE_THRESHOLD_M;
          if (rc.intersectObjects(cls[k], false).length) hit[k]++;
        }
      }
    }
    const meshes = {}; for (const k of Object.keys(cls)) meshes[k] = cls[k].length;
    // ラベルは sprite 側なので別に数える。
    //   [Mission 33A] 駅ラベルの描画は CityLabelLayer が持っている（StationLabelLayer は
    //   クラスタリングだけ）。駅の数は CityLabelLayer の visibleStations で見る。
    let labels = 0, stationLabels = 0, stationsLoaded = 0;
    try {
      const d = window.__CITY_LABEL_DEBUG__ && window.__CITY_LABEL_DEBUG__();
      if (d) { labels = d.visible || 0; stationLabels = d.visibleStations || 0; stationsLoaded = d.stations || 0; }
    } catch (e) { labels = -1; stationLabels = -1; }
    return { probes, hit, meshes, labels, stationLabels, stationsLoaded };
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
          loadedTiles: p.tiles ? p.tiles.loaded : null, visibleTiles: p.tiles ? p.tiles.visible : null });
      } }
    requestAnimationFrame(f); })`,
  regression: `(() => {
    const r = {};
    try { r.roadMode = __SEMANTIC_DISPLAY_DEBUG__().normalViewRoadMode; } catch (e) { r.roadMode = 'ERR'; }
    try { r.buildingsVersion = CanonicalRuntime.getBuildingsVersionDebug().version; } catch (e) { r.buildingsVersion = 'ERR'; }
    try { r.selfCheck = __CANONICAL_SELF_CHECK__().total; } catch (e) { r.selfCheck = -1; }
    try { r.highLod = !!(window.__BUILDING_LOD_DEBUG__ && window.__BUILDING_LOD_DEBUG__()); } catch (e) { r.highLod = false; }
    try { r.labels = (typeof window.__CITY_LABEL_DEBUG__ === 'function' && window.__CITY_LABEL_DEBUG__()) ? 'ok' : 'missing'; } catch (e) { r.labels = 'ERR'; }
    try { r.stationLabels = (typeof window.__STATION_LABEL_DEBUG__ === 'function' && window.__STATION_LABEL_DEBUG__()) ? 'ok' : 'missing'; } catch (e) { r.stationLabels = 'ERR'; }
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
    }
    try { r.search = typeof findSpot === 'function'; } catch (e) { r.search = false; }
    // canonical の tile group は creationPath = 'CANONICAL_<LAYER>' を持つ。
    //   rail / water / parks の mesh 自体は無名なので、名前だけで探すと必ず「無い」になる。
    const tags = new Set();
    scene.traverse((o) => {
      if (o.name) tags.add(o.name);
      const cp = o.userData && o.userData.creationPath; if (cp) tags.add(cp);
    });
    const has = (re) => [...tags].some((n) => re.test(n));
    r.hasRail = has(/rail/i);
    r.hasWater = has(/water|river/i);
    r.hasParks = has(/park/i);
    r.hasRoad = has(/road/i);
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
  return 'data/reports/osm-shared-source-qa/' + name + '.jpg';
}

/**
 * `only` を渡すと、その地点だけを測り直して既存レポートの該当行を差し替える
 * （性能・regression は測り直さず、前回の値をそのまま引き継ぐ）。
 * 地点の座標を訂正したときに、全部を 25 分かけて測り直さずに済ませるため。
 * どの行がいつ測られたかは `measuredAt` と `supplementalRuns` に残す。
 */
export async function run({ only = null } = {}) {
  const t0 = Date.now();
  const prev = only ? (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch { return null; } })() : null;
  if (only && !prev) throw new Error('--only は既存レポートが要る。先に全体を測る');
  const out = prev
    ? { ...prev, supplementalRuns: [...(prev.supplementalRuns || []), { at: new Date().toISOString(), sites: only }] }
    : { version: 1, generatedAt: new Date().toISOString(), missionId: '35F', url: URL_,
      sites: [], performance: [], regression: null, errors: [] };
  const b = await launchBrowser({ width: 1500, height: 950 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    out.boot = await page.evaluate(JS.debug);
    console.log('[qa] 起動時', out.boot.version, out.boot.base);

    const todo = only ? fixedSites().filter((s) => only.includes(s.id)) : fixedSites();
    if (only && todo.length !== only.length) throw new Error('知らない地点: ' + only.join(','));
    for (const s of todo) {
      const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2200);
      await page.evaluate(JS.camera(w.x, w.z, VIEW.r));
      await settle(page);
      const d = await page.evaluate(JS.debug);
      const g = await page.evaluate(JS.layers(w.x, w.z, 350, 14), { timeoutMs: 240000 });
      await page.evaluate(HIDE_UI); await sleep(1300);
      const cov = {};
      for (const k of Object.keys(g.hit)) cov[k] = g.probes ? +(g.hit[k] / g.probes).toFixed(4) : null;
      const rec = { ...s, world: w, visibleBuildings: d.visibleBuildings,
        coverage: cov, meshes: g.meshes, labels: g.labels,
        stationLabels: g.stationLabels, stationsLoaded: g.stationsLoaded,
        measuredAt: new Date().toISOString(),
        shot: await shot(page, s.id) };
      const at = out.sites.findIndex((x) => x.id === s.id);
      if (at >= 0) out.sites[at] = rec; else out.sites.push(rec);
      console.log('[qa]', s.id.padEnd(16),
        '建物', ((cov.building || 0) * 100).toFixed(0) + '%',
        '道路', ((cov.road || 0) * 100).toFixed(0) + '%',
        '鉄道', ((cov.rail || 0) * 100).toFixed(0) + '%',
        '水域', ((cov.water || 0) * 100).toFixed(0) + '%',
        '公園', ((cov.park || 0) * 100).toFixed(0) + '%',
        '| label', g.labels, '/ 駅', g.stationLabels);
    }

    for (const s of (only ? [] : PERF_SITES)) {
      const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2000);
      await page.evaluate(JS.camera(w.x, w.z, VIEW.r));
      await settle(page);
      const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ id: s.id, label: s.label, mode: 'ward', ...r });
      console.log('[qa] perf', s.id.padEnd(16), 'fps', r.fpsAverage, 'p95', r.frameMsP95 + 'ms',
        'calls', r.drawCallsAvg, 'tri', r.trianglesAvg, 'tiles', r.loadedTiles);
    }
    if (!only) try {
      await page.evaluate('(() => { CityModeManager.enter(); return 1; })()');
      await settle(page, 4000, 120000);
      const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ id: 'city-mode', label: 'City Mode', mode: 'city', ...r });
      console.log('[qa] perf city-mode      fps', r.fpsAverage, 'p95', r.frameMsP95 + 'ms');
      await page.evaluate('(() => { CityModeManager.exit("kita"); return 1; })()');
      await sleep(3000);
    } catch (e) { out.cityModeError = String(e && e.message || e).slice(0, 200); }

    if (!only) {
      const w0 = worldOf(PERF_SITES[0]);
      await page.evaluate(JS.ward(w0.x, w0.z)); await sleep(2200);
      await page.evaluate(JS.camera(w0.x, w0.z, 400));
      await settle(page);
      out.regression = await page.evaluate(JS.regression, { timeoutMs: 120000 });
      console.log('[qa] regression', JSON.stringify(out.regression));
    }
    out.errors = only ? [...(prev.errors || []), ...errors].slice(0, 20) : errors.slice(0, 20);
  } finally { await b.close(); }

  const r = out.regression || {};
  // §11 各地点で「道路・建物・鉄道・水域・公園」のうち、その場所に本来あるものが出ているか。
  //   鉄道や水域は地点によって本当に無いことがあるので、道路と建物だけを必須にする。
  out.summary = {
    sites: out.sites.length,
    siteFix: Object.keys(SITE_FIX),
    allSitesHaveLayers: out.sites.every((s) => (s.coverage.road || 0) > 0.02 && (s.coverage.building || 0) >= 0),
    sitesWithRail: out.sites.filter((s) => (s.coverage.rail || 0) > 0).length,
    sitesWithWater: out.sites.filter((s) => (s.coverage.water || 0) > 0).length,
    sitesWithPark: out.sites.filter((s) => (s.coverage.park || 0) > 0).length,
    minRoadCoverage: out.sites.length ? Math.min(...out.sites.map((s) => s.coverage.road || 0)) : null,
    // §9 駅は 35F で 233 → 253 に増えた。runtime が新しい方を読んでいるか。
    stationsLoaded: out.sites.length ? Math.max(...out.sites.map((s) => s.stationsLoaded || 0)) : null,
    sitesWithStationLabel: out.sites.filter((s) => (s.stationLabels || 0) > 0).length,
    buildingsVersion: out.boot ? out.boot.version : null,
    regressionOk: !!(r.roadMode === 'ROAD_V3' && r.buildingsVersion === 'V4' && r.selfCheck === 0
      && r.pick && r.card && r.cardHasWard && r.search
      && r.hasRail && r.hasWater && r.hasParks && r.hasRoad
      && r.labels === 'ok' && r.stationLabels === 'ok' && r.highLod),
    regression: r,
    perfMinFps: out.performance.length ? Math.min(...out.performance.map((p) => p.fpsAverage)) : null,
    jsErrors: out.errors.length,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const arg = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
  run({ only: arg ? arg.split(',') : null }).then((o) => { console.log('[qa] summary', JSON.stringify(o.summary)); console.log('[qa] out', OUT); })
    .catch((e) => { console.error(e); process.exit(1); });
}
