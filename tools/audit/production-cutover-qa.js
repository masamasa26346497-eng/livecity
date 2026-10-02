#!/usr/bin/env node
// tools/audit/production-cutover-qa.js
// [Mission 32U §19-§22/§28] production HTML（public/osaka_3d_buildings.html）を実ブラウザで確認する。
//   - 9 地点（梅田/本町/難波/天王寺/住吉/東淀川/鶴見/旭/東成）で建物 hover・click・property card
//   - 河川 2 地点（大川/淀川）で建物の水域侵入を目視できる screenshot
//   - fetch 監査: V1 building / 旧 OSM fallback / raw GSI edge を 1 度も取りに行かないこと（CDP Network で全 URL 記録）
//   - 開発用 QA UI が見えないこと / 通常 UI が出ていること
//   - 性能: 梅田・住吉で 30 秒静止計測
//   - smoke: ward 切替 / City Mode / 検索 / hover / click / card close / zoom / pan
//   前提: `npm run preview`（http://localhost:8000）。出力: data/reports/production-cutover-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { readFileRetry } from '../lib/synced-dir-writer.js';
import { PROBE } from './legacy-residual-probe.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_PROD_URL || 'http://localhost:8000/osaka_3d_buildings.html';
const OUT = P('data', 'reports', 'production-cutover-qa.json');
const SHOTS = P('data', 'reports', 'production-cutover-qa');
const BUILDINGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2');
const rj = (p) => JSON.parse(readFileRetry(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 建物を選ぶ 9 地点（座標は canonical から求めた区の建物重心 / 既存 QA 地点）
export const SITES = [
  { id: 'umeda', name: '梅田', x: -2668.18, z: -10941.87 },
  { id: 'honmachi', name: '本町', x: -2072.6, z: -8693.2 },
  { id: 'namba', name: '難波', x: -2173.39, z: -6511.33 },
  { id: 'tennoji', name: '天王寺', x: -1055.54, z: -4618.89 },
  { id: 'sumiyoshi', name: '住吉', x: -2952.22, z: -811.75 },
  { id: 'higashiyodogawa', name: '東淀川', x: 574, z: -15576 },
  { id: 'tsurumi', name: '鶴見', x: 4536, z: -10822 },
  { id: 'asahi', name: '旭', x: 2089, z: -13194 },
  { id: 'higashinari', name: '東成', x: 1951, z: -7598 },
];
// 河川の確認地点（canonical water の名称付き feature の重心）
export const RIVER_SITES = [
  { id: 'okawa', name: '大川', x: -442, z: -11473 },
  { id: 'yodogawa', name: '淀川', x: -7648, z: -9632 },
];
// fetch 監査で「出てはいけない」URL（§21）
export const FORBIDDEN_FETCH = [
  { id: 'v1-buildings', re: /\/derived\/(near|mid|far)\/buildings\// },
  { id: 'v1-building-placement', re: /\/derived\/building-placement\// },
  { id: 'v1-ward-index', re: /\/derived\/building-ward-index\.json/ },
  { id: 'old-osm-buildings', re: /\/derived-v2-corrected\// },
  { id: 'raw-gsi-road-edge', re: /gsi-road-edge/ },
];
const DEV_ONLY_IDS = ['canonical-runtime-status', 'ward-diag', 'perf-hud', 'residual-detail-panel', 'fps'];
const USER_UI_IDS = ['search-box', 'prop-card', 'controls', 'visual-panel', 'compass', 'layer-toggle-panel', 'ward-selector-panel'];

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, ph) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  selfCheck: `window.__PRODUCTION_SELF_CHECK__()`,
  uiVisibility: `(() => {
    const vis = (id) => { const el = document.getElementById(id); if (!el) return 'absent'; const s = getComputedStyle(el); return (s.display === 'none' || s.visibility === 'hidden' || el.offsetParent === null && s.position !== 'fixed') ? 'hidden' : 'visible'; };
    const out = { devOnly: {}, userUi: {} };
    for (const id of ${JSON.stringify(DEV_ONLY_IDS)}) out.devOnly[id] = vis(id);
    for (const id of ${JSON.stringify(USER_UI_IDS)}) out.userUi[id] = vis(id);
    out.buildProfile = document.documentElement.getAttribute('data-livecity-build');
    return out;
  })()`,
  card: `(() => {
    const t = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : null; };
    const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
    const pick = window.__LAST_BUILDING_PICK__;
    return {
      pick: pick ? pick.id : null, cardDisplay: document.getElementById('prop-card').style.display,
      title: t('pc-title'), usage: t('pc-usage-full'), area: t('pc-area'), ward: vis('pc-ward-row') ? t('pc-ward') : null,
      station: t('pc-station'), height: vis('pc-height-stat') ? t('pc-height') : null, floors: vis('pc-floors-stat') ? t('pc-floors') : null,
      townSectionVisible: vis('pc-town-section'),
      forbidden: ['推定利回り', '想定賃料', '仮の参考値', '町丁目データなし', '徒歩'].filter((w) => (document.getElementById('prop-card').innerText || '').includes(w)),
    };
  })()`,
  bench: (sec) => `new Promise((resolve) => {
    const ts = [], calls = [], tris = []; let maxQ = 0;
    const t0 = performance.now();
    function f(t) {
      ts.push(t);
      if (renderer && renderer.info) { calls.push(renderer.info.render.calls); tris.push(renderer.info.render.triangles); }
      const p = CanonicalRuntime.getPerf(); const q = p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; if (q > maxQ) maxQ = q;
      if (performance.now() - t0 < ${sec * 1000}) requestAnimationFrame(f); else done();
    }
    function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }
    function done() {
      const dt = []; for (let i = 1; i < ts.length; i++) dt.push(ts[i] - ts[i - 1]);
      const dur = (ts[ts.length - 1] - ts[0]) / 1000;
      const fpsInst = dt.map((d) => 1000 / d);
      const p = CanonicalRuntime.getPerf();
      const mem = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
      resolve({
        seconds: +dur.toFixed(1), frames: ts.length,
        fpsAverage: +((ts.length - 1) / dur).toFixed(1), fpsP5: +pct(fpsInst, 0.05).toFixed(1),
        frameMsP95: +pct(dt, 0.95).toFixed(1), frameMsMax: +dt.reduce((a, b) => Math.max(a, b), 0).toFixed(1),
        drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)), drawCallsMax: calls.reduce((a, b) => Math.max(a, b), 0),
        trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)), trianglesMax: tris.reduce((a, b) => Math.max(a, b), 0),
        jsHeapMB: mem == null ? null : +mem.toFixed(1),
        gpuMemory: renderer.info.memory ? { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures } : null,
        tiles: p.tiles, loadingTilesMaxDuringBench: maxQ,
      });
    }
    requestAnimationFrame(f);
  })`,
};

/** 各地点で真上から選べる PLATEAU 建物 */
function targets() {
  return SITES.map((s) => {
    let best = null;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const f = path.join(BUILDINGS, `tile_${Math.floor(s.x / 500) + dx}_${Math.floor(s.z / 500) + dz}.json`);
      if (!fs.existsSync(f)) continue;
      const t = rj(f); const a = rj(path.join(BUILDINGS, 'attributes', path.basename(f))).attributes;
      for (const ft of t.features) {
        const at = a[ft.canonicalId];
        const d = Math.hypot(ft.centroid[0] - s.x, ft.centroid[1] - s.z);
        if (at.source !== 'plateau-building' || ft.areaM2 < 400 || ft.areaM2 > 4000 || d > 600) continue;
        if (!best || d < best.d) best = { d, id: ft.canonicalId, c: ft.centroid, wardId: at.wardId, usageLabel: at.usageLabel };
      }
    }
    return { ...s, target: best };
  });
}

async function settle(page, min = 2500, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return Date.now() - t0; await sleep(700); }
  return -1;
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 78 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/production-cutover-qa/' + name + '.jpg';
}
async function hoverAndClick(page, x, y) {
  await page.evaluate(`(() => { window.__LAST_BUILDING_PICK__ = null; if (typeof closePropCard === 'function' && document.getElementById('prop-card').style.display === 'block') closePropCard(); return 1; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(400);
  const hover = await page.evaluate(`(() => tip.style.display)()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 1, y });
  await sleep(500);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(1000);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 600 });
  await sleep(200);
  return hover;
}

async function main() {
  const T = targets();
  const report = { version: 1, generatedAt: new Date().toISOString(), missionId: '32U', url: URL_, sites: [], rivers: [] };
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [], requests = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)));
  page.on('Network.requestWillBeSent', (e) => requests.push(e.request.url));
  const consoleMsgs = [];
  page.on('Runtime.consoleAPICalled', (e) => {
    const t = (e.args || []).map((a) => (a.value !== undefined ? JSON.stringify(a.value) : (a.description || a.type))).join(' ').slice(0, 300);
    if (/self-check|MISMATCH/i.test(t)) consoleMsgs.push({ type: e.type, text: t });
  });
  try {
    await page.send('Network.enable');
    await page.send('Page.navigate', { url: URL_ });
    await sleep(45000);
    report.startup = {
      selfCheck: await page.evaluate(JS.selfCheck),
      ui: await page.evaluate(JS.uiVisibility),
      residual: (await page.evaluate(PROBE)).selfCheck.total,
      shot: await shot(page, 'startup'),
    };
    console.log('[cutover-qa] startup', JSON.stringify(report.startup.selfCheck), JSON.stringify(report.startup.ui.devOnly));

    // ── §22 性能（32P dev 実測と同じ camera・同じ 30 秒。tile cache が膨らむ前に測る） ──
    report.performance = [];
    for (const s of [SITES[0], SITES[4]]) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(1500);
      await page.evaluate(JS.camera(s.x, s.z, 700, Math.PI / 4)); await settle(page);
      const bench = await page.evaluate(JS.bench(30), { timeoutMs: 120000 });
      report.performance.push({ site: s.id, siteName: s.name, camera: { r: 700, ph: Math.PI / 4 }, ...bench });
      console.log('[cutover-qa] perf', s.id, JSON.stringify({ fps: bench.fpsAverage, p5: bench.fpsP5, p95: bench.frameMsP95, draws: bench.drawCallsAvg, tris: bench.trianglesAvg, heap: bench.jsHeapMB, q: bench.loadingTilesMaxDuringBench }));
    }

    // ── §19/§20 9 地点 ──
    for (const t of T) {
      const vp = await page.evaluate(`[innerWidth, innerHeight]`);
      const c = t.target ? t.target.c : [t.x, t.z];
      await page.evaluate(JS.ward(c[0], c[1])); await sleep(1200);
      let hover = null, card = null;
      for (const rr of [260, 140, 80]) {
        await page.evaluate(JS.camera(c[0], c[1], rr, 0.03)); await settle(page, 1500);
        hover = await hoverAndClick(page, Math.round(vp[0] / 2), Math.round(vp[1] / 2));
        card = await page.evaluate(JS.card);
        if (!t.target || card.pick === t.target.id) break;
      }
      const r = {
        site: t.id, siteName: t.name, expected: t.target ? t.target.id : null, hover, ...card,
        pickedExpected: !!t.target && card.pick === t.target.id,
        ward: card.ward, residual: (await page.evaluate(PROBE)).selfCheck.total,
        shot: await shot(page, `site-${t.id}`),
      };
      report.sites.push(r);
      console.log('[cutover-qa]', t.id, JSON.stringify({ pick: r.pickedExpected, hover: r.hover, ward: r.ward, station: r.station, forbidden: r.forbidden, residual: r.residual }));
      await page.evaluate(`closePropCard()`);
    }

    // ── §20 河川 2 地点（俯瞰で水域への建物侵入を見る） ──
    for (const s of RIVER_SITES) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(1200);
      await page.evaluate(JS.camera(s.x, s.z, 900, 0.55)); await settle(page);
      report.rivers.push({ site: s.id, name: s.name, residual: (await page.evaluate(PROBE)).selfCheck.total, shot: await shot(page, `river-${s.id}`) });
      console.log('[cutover-qa] river', s.id);
    }

    // ── §28 smoke（ward 切替 / City Mode / 検索 / zoom / pan） ──
    const smoke = {};
    smoke.wardSwitch = await page.evaluate(JS.ward(-2668.18, -10941.87));
    await settle(page);
    smoke.cityMode = await page.evaluate(`(async () => { CityModeManager.enter(); await new Promise((r) => setTimeout(r, 4000)); return CityModeManager.isActive(); })()`);
    await settle(page, 2000);
    smoke.cityModeResidual = (await page.evaluate(PROBE)).selfCheck.total;
    smoke.exitCity = await page.evaluate(JS.ward(-2072.6, -8693.2));
    await settle(page);
    smoke.search = await page.evaluate(`(async () => {
      searchInput.value = '難波'; doSearch();
      await new Promise((z) => setTimeout(z, 1800));
      const spot = findSpot('難波'); const g = geoToThree(spot.lat, spot.lon);
      return { msgShown: searchMsg.style.display === 'block', msg: searchMsg.textContent, distanceM: Math.round(Math.hypot(cs.tgt.x - g.x, cs.tgt.z - g.z)) };
    })()`);
    await settle(page);
    smoke.zoomPan = await page.evaluate(`(() => { const r0 = cs.r, x0 = cs.tgt.x; cs.r = Math.max(120, cs.r * 0.5); cs.tgt.x += 400; camUpd(); return { r0, r1: cs.r, dx: Math.round(cs.tgt.x - x0) }; })()`);
    await settle(page);
    const vp = await page.evaluate(`[innerWidth, innerHeight]`);
    // hover / click は建物があると分かっている地点（本町の対象建物）で確認する
    const smokeTarget = T.find((t) => t.id === "honmachi").target;
    await page.evaluate(JS.camera(smokeTarget.c[0], smokeTarget.c[1], 140, 0.03)); await settle(page, 1500);
    smoke.hoverClick = await hoverAndClick(page, Math.round(vp[0] / 2), Math.round(vp[1] / 2));
    smoke.cardAfterClick = (await page.evaluate(JS.card)).cardDisplay;
    await page.evaluate(`closePropCard()`);
    smoke.cardAfterClose = await page.evaluate(`document.getElementById('prop-card').style.display`);
    smoke.residual = (await page.evaluate(PROBE)).selfCheck.total;
    report.smoke = smoke;
    console.log('[cutover-qa] smoke', JSON.stringify(smoke));


    // ── §21 fetch 監査 ──
    report.fetchAudit = {
      totalRequests: requests.length,
      forbidden: FORBIDDEN_FETCH.map((f) => ({ id: f.id, count: requests.filter((u) => f.re.test(u)).length, sample: requests.filter((u) => f.re.test(u)).slice(0, 3) })),
      v2nBuildingRequests: requests.filter((u) => /\/derived-v2-osmv2\/(near|mid|far)\/buildings\//.test(u)).length,
      buildingFactsRequests: requests.filter((u) => /\/derived-v2-osmv2\/building-facts\//.test(u)).length,
      namespaceCounters: await page.evaluate(`window.__BUILDINGS_VERSION_DEBUG__().fetchByNamespace`),
    };
    report.finalSelfCheck = await page.evaluate(JS.selfCheck);
    report.finalUi = await page.evaluate(JS.uiVisibility);
    report.selfCheckConsole = consoleMsgs.slice(0, 10);
    report.consoleErrors = errors.slice(0, 30);
  } finally {
    await b.close();
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  main().then((r) => {
    console.log('[cutover-qa] fetchAudit', JSON.stringify(r.fetchAudit));
    console.log('[cutover-qa] errors', JSON.stringify(r.consoleErrors));
    console.log('[cutover-qa] out', OUT);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
