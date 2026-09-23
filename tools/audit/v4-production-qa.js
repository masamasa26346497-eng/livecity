#!/usr/bin/env node
// tools/audit/v4-production-qa.js
// [Mission 35G §7/§8/§9/§10/§14] cutover 後の production HTML を実ブラウザで確認する。
//   前提: `npm run preview`（http://localhost:8000）
//   出力: data/reports/v4-production-qa.json / data/reports/v4-production-qa/*.jpg
//
//   ユーザーに DevTools 操作を求めない（§14）。すべて自動で取得する。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_PROD_URL || 'http://localhost:8000/osaka_3d_buildings.html';
export const OUT = P('data', 'reports', 'v4-production-qa.json');
export const SHOTS = P('data', 'reports', 'v4-production-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const VIEW = { r: 700, phDeg: 50, th: -0.35, fov: 44 };
export const PERF_SECONDS = 15;

/**
 * §7 の 12 地点。緯度経度で書き、world は正本の変換（latLonToLiveCityWorld）を通す。
 * **全地点が区ポリゴンの中にあることを確認済み**（35F で、区外の地点だと建物タイルが
 * 読み込まれず「建物 0%」に見える罠を踏んだため）。
 */
export const SITES = [
  { id: 'umeda', label: '梅田', lat: 34.70250, lon: 135.49586, ward: 'kita' },
  { id: 'nakanoshima', label: '中之島', lat: 34.69280, lon: 135.49330, ward: 'kita' },
  { id: 'honmachi', label: '本町', lat: 34.68200, lon: 135.49900, ward: 'chuo' },
  { id: 'namba', label: '難波', lat: 34.66600, lon: 135.50100, ward: 'chuo' },
  { id: 'tennoji', label: '天王寺', lat: 34.64550, lon: 135.51400, ward: 'abeno' },
  { id: 'shin-osaka', label: '新大阪', lat: 34.73340, lon: 135.50020, ward: 'yodogawa' },
  { id: 'higashi-mikuni', label: '東三国', lat: 34.74100, lon: 135.49860, ward: 'yodogawa' },
  { id: 'awaji', label: '淡路', lat: 34.74640, lon: 135.53170, ward: 'higashiyodogawa' },
  { id: 'kami-shinjo', label: '上新庄', lat: 34.74770, lon: 135.54700, ward: 'higashiyodogawa' },
  { id: 'juso', label: '十三', lat: 34.72170, lon: 135.48420, ward: 'yodogawa' },
  { id: 'kunijima', label: '柴島', lat: 34.73530, lon: 135.51900, ward: 'higashiyodogawa' },
  { id: 'asahi', label: '旭区内', lat: 34.73600, lon: 135.55400, ward: 'asahi' },
];
/** §10 性能を測る地点（35F dev と同じ 5 つ。比較できるように揃える）。 */
export const PERF_SITES = [
  { id: 'umeda', label: '梅田', lat: 34.70250, lon: 135.49586 },
  { id: 'shin-osaka', label: '新大阪', lat: 34.73340, lon: 135.50020 },
  { id: 'higashiyodogawa', label: '東淀川', lat: 34.74640, lon: 135.53170 },
  { id: 'yodogawa', label: '淀川', lat: 34.72640, lon: 135.49820 },
];
/** §5 production で見えてはいけない開発用 UI。 */
export const DEV_ONLY_IDS = [
  'canonical-runtime-status', 'canonical-runtime-road-v2-controls', 'ward-diag', 'perf-hud', 'fps',
  'max-lod-qa-toggle', 'inferred-roof-toggle', 'landmark-hd-toggle', 'missing-recovery-toggle',
  'lod-view-toggle', 'coverage-qa-toggle', 'gsi-road-edge-toggle',
];
/** §5/§9 production で出ているべき通常 UI。 */
export const PRODUCTION_UI_IDS = ['lc-topbar', 'search-input'];

export function worldOf(s) {
  const w = latLonToLiveCityWorld(s.lat, s.lon);
  return { x: Math.round(w.x), z: Math.round(w.z) };
}

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    CAMERA_MODE_FOV[cameraMode] = ${VIEW.fov};
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = (90 - ${VIEW.phDeg}) * Math.PI / 180; cs.th = ${VIEW.th}; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  boot: `(() => { const bv = CanonicalRuntime.getBuildingsVersionDebug();
    return { version: bv.version, base: bv.base, profile: LIVECITY_BUILD_PROFILE,
      buildAttr: document.documentElement.getAttribute('data-livecity-build') }; })()`,
  /**
   * §7 その地点で各レイヤーが描かれているか。
   * 35F と同じ数え方（鉄道は LineSegments、parks/water の mesh は無名なので親の creationPath で見る）。
   */
  layers: (cx, cz, half, step) => `(() => {
    // レイヤーの見分け方（35E / 35F で learned）:
    //   - 道路面は mesh 名 RoadV3_* / RoadBucket_* で creationPath を持たない
    //   - rail は LineSegments、water / parks の mesh は無名で、tile group の
    //     userData.creationPath = 'CANONICAL_<LAYER>' が唯一の手がかり
    //   - **高 LOD 棟と HD ランドマークは usageCategory を持たない**。別 group
    //     （CR_buildingLodHigh / LandmarkHDLayer / CityBuildingLOD）に入り、
    //     その棟の LOD1 の箱は抑制される。祖先の group 名も見ないと建物を数え落とす
    //     （本町・中之島のような高 LOD の多い場所ほど過少に出る）。
    const BUILDING_GROUPS = /^(CR_buildingLodHigh|LandmarkHDLayer|CR_inferredRoof|CityBuildingLOD)$/;
    const cls = { road: [], building: [], rail: [], water: [], park: [] };
    scene.traverse((o) => {
      if (!(o.isMesh || o.isLineSegments) || !o.visible) return;
      let q = o, v = true, cp = '', anc = '';
      while (q) {
        if (q.visible === false) { v = false; break; }
        if (!cp && q.userData && q.userData.creationPath) cp = q.userData.creationPath;
        if (!anc && q.name && BUILDING_GROUPS.test(q.name)) anc = q.name;
        q = q.parent;
      }
      if (!v) return;
      const nm = o.name || '';
      if (/^RoadV3_/.test(nm) || /^RoadBucket_/.test(nm) || /ROAD/i.test(cp)) cls.road.push(o);
      else if (/RAIL/i.test(cp) || /^Rail/i.test(nm)) cls.rail.push(o);
      else if (/WATER/i.test(cp) || /^(Water|River)/i.test(nm)) cls.water.push(o);
      else if (/PARK/i.test(cp) || /^Park/i.test(nm)) cls.park.push(o);
      else if (anc || (o.userData && o.userData.usageCategory != null)) cls.building.push(o);
    });
    const hit = {}; let probes = 0;
    for (const k of Object.keys(cls)) hit[k] = 0;
    for (let dx = -${half}; dx <= ${half}; dx += ${step}) {
      for (let dz = -${half}; dz <= ${half}; dz += ${step}) {
        probes++;
        const o = new THREE.Vector3(${cx} + dx, 900, ${cz} + dz), d = new THREE.Vector3(0, -1, 0);
        for (const k of Object.keys(cls)) {
          if (!cls[k].length) continue;
          const rc = new THREE.Raycaster(o, d, 0.1, 2000);
          rc.params.Line.threshold = 4;
          if (rc.intersectObjects(cls[k], false).length) hit[k]++;
        }
      }
    }
    const meshes = {}; for (const k of Object.keys(cls)) meshes[k] = cls[k].length;
    let labels = 0, stationLabels = 0;
    try { const d = window.__CITY_LABEL_DEBUG__ && window.__CITY_LABEL_DEBUG__();
      if (d) { labels = d.visible || 0; stationLabels = d.visibleStations || 0; } } catch (e) { labels = -1; }
    const cr = CanonicalRuntime.getDebug();
    return { probes, hit, meshes, labels, stationLabels, visibleBuildings: cr.visibleBuildings };
  })()`,
  /**
   * §7/§9 画面中央付近で建物を 1 つ掴み、hover / click / property card を確かめる。
   * card の「高さ」「階数」は building-facts が読めているかどうかで出方が変わる（§4）。
   */
  pickAndCard: `new Promise((resolve) => {
    let hit = null;
    for (let gy = 0.35; gy <= 0.65 && !hit; gy += 0.05) {
      for (let gx = 0.3; gx <= 0.7 && !hit; gx += 0.05) {
        const h = pickHit({ clientX: Math.round(innerWidth * gx), clientY: Math.round(innerHeight * gy) });
        if (h && h.d && h.d.id) hit = h;
      }
    }
    if (!hit) { resolve({ pick: false }); return; }
    const r = { pick: true, canonicalId: hit.d.canonicalId || null };
    try { selectBuilding({ clientX: innerWidth / 2, clientY: innerHeight / 2 }, hit); } catch (e) { r.error = String(e.message); }
    // card の高さ・階数は building-facts が届いてから書かれる（showPropertyCard が
    //   BuildingFacts.ensure().then(...) で後追いする）。**同期で読むと必ず「非表示」になる**。
    //   facts tile の取得を待ってから読む。
    const fin = () => {
      const el = document.getElementById('prop-card');
      r.card = !!(el && el.style.display !== 'none');
      const txt = el ? (el.innerText || '') : '';
      r.cardHasWard = /区/.test(txt);
      const hs = document.getElementById('pc-height-stat'), fs2 = document.getElementById('pc-floors-stat');
      r.heightShown = !!(hs && getComputedStyle(hs).display !== 'none');
      r.floorsShown = !!(fs2 && getComputedStyle(fs2).display !== 'none');
      r.factsLoaded = !!(hit.d.id && BuildingFacts.has(hit.d.id));
      const f = hit.d.id ? BuildingFacts.get(hit.d.id) : null;
      r.heightBasis = f ? f.basis : null;
      r.storeys = f ? f.storeys : null;
      r.factsStats = { loadedTiles: BuildingFacts.stats.loadedTiles, failedTiles: BuildingFacts.stats.failedTiles,
        entries: BuildingFacts.stats.entries, lastUrl: BuildingFacts.stats.lastUrl };
      r.nearestStation = /駅/.test(txt);
      resolve(r);
    };
    let c = null;
    try {
      const fp = hit.d.fp;
      if (Array.isArray(fp) && fp.length) { let sx = 0, sz = 0; for (const q of fp) { sx += q[0]; sz += q[1]; } c = [sx / fp.length, sz / fp.length]; }
    } catch (e) { c = null; }
    if (c) BuildingFacts.ensure(c[0], c[1]).then(() => setTimeout(fin, 350)).catch(() => setTimeout(fin, 350));
    else setTimeout(fin, 350);
  })`,
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
  /**
   * §5 開発用 UI が見えず、通常 UI が出ていること。
   * CSS スタイルシートの display:none は el.style に出ないので computedStyle で見る。
   * **offsetParent を「見えているか」の判定に使ってはいけない**: position:fixed の要素は
   * 見えていても offsetParent が null になる（#lc-topbar がこれで「hidden」と誤判定された）。
   * 実際に場所を占めているかは getBoundingClientRect の大きさで見る。
   */
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
  regression: `(() => {
    const r = {};
    try { r.roadMode = __SEMANTIC_DISPLAY_DEBUG__().normalViewRoadMode; } catch (e) { r.roadMode = 'ERR'; }
    try { r.buildingsVersion = CanonicalRuntime.getBuildingsVersionDebug().version; } catch (e) { r.buildingsVersion = 'ERR'; }
    try { r.selfCheck = __CANONICAL_SELF_CHECK__().total; } catch (e) { r.selfCheck = -1; }
    try { r.highLod = !!(window.__BUILDING_LOD_DEBUG__ && window.__BUILDING_LOD_DEBUG__()); } catch (e) { r.highLod = false; }
    try { r.highLodDrawn = (window.__BUILDING_LOD_DEBUG__ && window.__BUILDING_LOD_DEBUG__().visibleBuildings) ?? null; } catch (e) { r.highLodDrawn = null; }
    try { r.labels = (typeof window.__CITY_LABEL_DEBUG__ === 'function' && window.__CITY_LABEL_DEBUG__()) ? 'ok' : 'missing'; } catch (e) { r.labels = 'ERR'; }
    try { r.search = typeof findSpot === 'function'; } catch (e) { r.search = false; }
    try { r.hover = typeof pickHit === 'function'; } catch (e) { r.hover = false; }
    const tags = new Set();
    scene.traverse((o) => { if (o.name) tags.add(o.name); const cp = o.userData && o.userData.creationPath; if (cp) tags.add(cp); });
    const has = (re) => [...tags].some((n) => re.test(n));
    r.hasRail = has(/rail/i); r.hasWater = has(/water|river/i);
    r.hasParks = has(/park/i); r.hasRoad = has(/road/i); r.hasBuildings = has(/BUILDING/i);
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
  return 'data/reports/v4-production-qa/' + name + '.jpg';
}

/** §8 Brillia タワー堂島相当の建物を、canonical ではなく **画面上で** 確かめる。 */
// 座標は 35D の fixture と同じ（tools/audit/missing-recovery-fixtures.js の anchor）。
// 名称は OSM に無いので **名前で探さない**。その街区に建物が実際に描かれていて、
// クリックでき、card が出て、区が正しいことを確かめる（§8: 名称は今回の対象外）。
export const BRILLIA = { id: 'brillia', label: 'ブリリアタワー堂島相当', lat: 34.69466, lon: 135.49236, ward: 'kita' };

/**
 * `onlyUi` を渡すと UI の可視判定だけを測り直して既存レポートへ書き戻す
 * （地点・性能・regression は前回の値をそのまま引き継ぐ）。
 * 判定を直したときに全部を測り直さずに済ませるため。いつ測り直したかは残す。
 */
export async function run({ onlyUi = false } = {}) {
  const t0 = Date.now();
  const prev = onlyUi ? (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch { return null; } })() : null;
  if (onlyUi && !prev) throw new Error('--only-ui は既存レポートが要る。先に全体を測る');
  const out = prev
    ? { ...prev, uiRemeasuredAt: new Date().toISOString() }
    : { version: 1, generatedAt: new Date().toISOString(), missionId: '35G', url: URL_,
      sites: [], performance: [], regression: null, ui: null, brillia: null, errors: [], fetchAudit: null };
  const b = await launchBrowser({ width: 1500, height: 950 });
  const page = b.page;
  const errors = [], urls = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  try {
    try { await page.send('Network.enable'); page.on('Network.requestWillBeSent', (e) => { if (e.request && e.request.url) urls.push(e.request.url); }); } catch (e) { /* 取れなくても続行 */ }
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    out.boot = await page.evaluate(JS.boot);
    console.log('[prod-qa] 起動時', JSON.stringify(out.boot));
    out.ui = await page.evaluate(JS.ui);
    console.log('[prod-qa] UI', JSON.stringify(out.ui));

    for (const s of (onlyUi ? [] : SITES)) {
      const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2200);
      await page.evaluate(JS.camera(w.x, w.z, VIEW.r));
      await settle(page);
      const g = await page.evaluate(JS.layers(w.x, w.z, 350, 14), { timeoutMs: 240000 });
      const card = await page.evaluate(JS.pickAndCard, { timeoutMs: 120000 });
      const cov = {};
      for (const k of Object.keys(g.hit)) cov[k] = g.probes ? +(g.hit[k] / g.probes).toFixed(4) : null;
      out.sites.push({ ...s, world: w, coverage: cov, meshes: g.meshes,
        labels: g.labels, stationLabels: g.stationLabels, visibleBuildings: g.visibleBuildings,
        card, shot: await shot(page, s.id) });
      console.log('[prod-qa]', s.id.padEnd(15),
        '建物', ((cov.building || 0) * 100).toFixed(0) + '%',
        '道路', ((cov.road || 0) * 100).toFixed(0) + '%',
        '鉄道', ((cov.rail || 0) * 100).toFixed(0) + '%',
        '水域', ((cov.water || 0) * 100).toFixed(0) + '%',
        '公園', ((cov.park || 0) * 100).toFixed(0) + '%',
        '| card', card.card ? 'o' : 'x', '高さ', card.heightShown ? 'o' : 'x', '階数', card.floorsShown ? 'o' : 'x');
    }

    // §8 Brillia
    if (!onlyUi) {
      const w = worldOf(BRILLIA);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2200);
      await page.evaluate(JS.camera(w.x, w.z, 320));
      await settle(page);
      const g = await page.evaluate(JS.layers(w.x, w.z, 160, 8), { timeoutMs: 240000 });
      const card = await page.evaluate(JS.pickAndCard, { timeoutMs: 120000 });
      out.brillia = { ...BRILLIA, world: w, meshes: g.meshes, visibleBuildings: g.visibleBuildings,
        buildingCoverage: g.probes ? +(g.hit.building / g.probes).toFixed(4) : null,
        card, shot: await shot(page, 'brillia') };
      console.log('[prod-qa] brillia 建物被覆', ((out.brillia.buildingCoverage || 0) * 100).toFixed(0) + '%',
        '| card', card.card ? 'o' : 'x', '| id', card.canonicalId);
    }

    for (const s of (onlyUi ? [] : PERF_SITES)) {
      const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2000);
      await page.evaluate(JS.camera(w.x, w.z, VIEW.r));
      await settle(page);
      const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ id: s.id, label: s.label, mode: 'ward', ...r });
      console.log('[prod-qa] perf', s.id.padEnd(15), 'fps', r.fpsAverage, 'p95', r.frameMsP95 + 'ms',
        'calls', r.drawCallsAvg, 'tri', r.trianglesAvg, 'tiles', r.loadedTiles);
    }
    if (!onlyUi) try {
      await page.evaluate('(() => { CityModeManager.enter(); return 1; })()');
      await settle(page, 4000, 120000);
      const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ id: 'city-mode', label: 'City Mode', mode: 'city', ...r });
      out.cityModeShot = await shot(page, 'city-mode');
      console.log('[prod-qa] perf city-mode      fps', r.fpsAverage, 'p95', r.frameMsP95 + 'ms');
      await page.evaluate('(() => { CityModeManager.exit("kita"); return 1; })()');
      await sleep(3000);
    } catch (e) { out.cityModeError = String(e && e.message || e).slice(0, 200); }

    if (!onlyUi) {
      const w0 = worldOf(SITES[0]);
      await page.evaluate(JS.ward(w0.x, w0.z)); await sleep(2200);
      await page.evaluate(JS.camera(w0.x, w0.z, 400));
      await settle(page);
      out.regression = await page.evaluate(JS.regression, { timeoutMs: 120000 });
      console.log('[prod-qa] regression', JSON.stringify(out.regression));
    }
    out.errors = onlyUi ? (prev.errors || []) : errors.slice(0, 20);
  } finally { await b.close(); }

  // §11 fetch 監査: 古い建物 namespace を読んでいないこと
  const u = urls;
  if (!onlyUi) out.fetchAudit = {
    total: u.length,
    v4: u.filter((x) => x.includes('/derived-v4-final/')).length,
    v2n: u.filter((x) => x.includes('/derived-v2-osmv2/') && !x.includes('building-lod-high')).length,
    v2nHighLod: u.filter((x) => x.includes('/derived-v2-osmv2/building-lod-high')).length,
    v3: u.filter((x) => x.includes('/derived-v2-osmv3/')).length,
    v1Buildings: u.filter((x) => /\/derived\/(near|mid|far)\/buildings\//.test(x)).length,
    facts404Risk: u.filter((x) => x.includes('/building-facts/')).length,
  };

  const r = out.regression || {};
  const devVisible = Object.entries(out.ui.devOnly).filter(([, v]) => v === 'visible').map(([k]) => k);
  const prodMissing = Object.entries(out.ui.production).filter(([, v]) => v !== 'visible').map(([k]) => k);
  out.summary = {
    sites: out.sites.length,
    buildingsVersion: out.boot ? out.boot.version : null,
    buildProfile: out.boot ? out.boot.profile : null,
    allSitesHaveBuildings: out.sites.every((s) => (s.coverage.building || 0) > 0),
    allSitesHaveRoads: out.sites.every((s) => (s.coverage.road || 0) > 0),
    sitesWithRail: out.sites.filter((s) => (s.coverage.rail || 0) > 0).length,
    allSitesCardOk: out.sites.every((s) => s.card.pick && s.card.card && s.card.cardHasWard),
    // §4 facts が読めているか（読めていないと高さ・階数が全棟で消える）
    sitesWithHeight: out.sites.filter((s) => s.card.heightShown).length,
    sitesWithFloors: out.sites.filter((s) => s.card.floorsShown).length,
    factsFailedTiles: Math.max(0, ...out.sites.map((s) => (s.card.factsStats ? s.card.factsStats.failedTiles : 0))),
    brilliaOk: !!(out.brillia && out.brillia.card && out.brillia.card.card && out.brillia.buildingCoverage > 0),
    devUiVisible: devVisible, productionUiMissing: prodMissing,
    devUiHidden: devVisible.length === 0 && prodMissing.length === 0,
    regressionOk: !!(r.roadMode === 'ROAD_V3' && r.buildingsVersion === 'V4' && r.selfCheck === 0
      && r.highLod && r.labels === 'ok' && r.search && r.hover
      && r.hasRail && r.hasWater && r.hasParks && r.hasRoad && r.hasBuildings),
    regression: r,
    perfMinFps: out.performance.length ? Math.min(...out.performance.map((p) => p.fpsAverage)) : null,
    jsErrors: out.errors.length,
    elapsedMs: Date.now() - t0,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run({ onlyUi: process.argv.includes('--only-ui') }).then((o) => { console.log('[prod-qa] summary', JSON.stringify(o.summary)); console.log('[prod-qa] out', OUT); })
    .catch((e) => { console.error(e); process.exit(1); });
}
