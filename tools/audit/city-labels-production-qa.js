#!/usr/bin/env node
// tools/audit/city-labels-production-qa.js
// [Mission 33B] production HTML でのラベル + 配色の確認。
//   --phase before : cutover 前の production（比較用の screenshot と画面統計だけ取る）
//   --phase after  : cutover 後の production（7 地点 QA / 当たり判定・検索の回帰 / fetch 監査 / 性能）
//   前提: `npm run preview`。出力: data/reports/city-labels-production-qa.json（phase ごとにマージ）
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { PROBE } from './legacy-residual-probe.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_PROD_URL || 'http://localhost:8000/osaka_3d_buildings.html';
const OUT = P('data', 'reports', 'city-labels-production-qa.json');
const SHOTS = P('data', 'reports', 'city-labels-production-qa');
const BUILDINGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SITES = [
  { id: 'umeda', name: '梅田', x: -2668.18, z: -10941.87 },
  { id: 'honmachi', name: '本町', x: -2072.6, z: -8693.2 },
  { id: 'namba', name: '難波', x: -2173.39, z: -6511.33 },
  { id: 'tennoji', name: '天王寺', x: -1055.54, z: -4618.89 },
  { id: 'sumiyoshi', name: '住吉', x: -2952.22, z: -811.75 },
  { id: 'higashiyodogawa', name: '東淀川', x: 574, z: -15576 },
];
// before/after で見比べる地点（§20）
export const COMPARE_SITES = ['umeda', 'namba', 'sumiyoshi'];
// 性能計測（§17）
export const PERF_SITES = ['umeda', 'namba', 'sumiyoshi'];
const VIEW = { r: 900, ph: Math.PI / 3.4 };
// 3 種のラベルが同時に見える地点（トグル確認用）
const SITE_FOR_TOGGLE = { x: -2668.18, z: -10941.87 };   // 梅田（地名・駅・ランドマークが揃う）
export const FORBIDDEN_FETCH = [
  { id: 'v1-buildings', re: /\/derived\/(near|mid|far)\/buildings\// },
  { id: 'v1-building-placement', re: /\/derived\/building-placement\// },
  { id: 'old-osm-buildings', re: /\/derived-v2-corrected\// },
  { id: 'raw-gsi-road-edge', re: /gsi-road-edge/ },
];
const DEV_ONLY_IDS = ['canonical-runtime-status', 'ward-diag', 'perf-hud', 'residual-detail-panel', 'fps'];

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, ph) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  pixels: `(() => {
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const w = 240, h = Math.max(1, Math.round(w * src.height / src.width));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let lum = 0, sat = 0, n = 0, colored = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
      const s = (mx === mn) ? 0 : (l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn));
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * b; sat += s; n++;
      if (s > 0.18) colored++;
    }
    return { meanLuminance: +(lum / n).toFixed(4), meanSaturation: +(sat / n).toFixed(4), coloredPixelRatio: +(colored / n).toFixed(4) };
  })()`,
  // 表示中のラベル sprite を集め、画面座標の矩形で重なりを独立に数える（§5/§16）
  labels: `(() => {
    const city = (typeof window.__CITY_LABEL_DEBUG__ === 'function') ? window.__CITY_LABEL_DEBUG__() : null;
    const station = (typeof window.__STATION_LABEL_DEBUG__ === 'function') ? window.__STATION_LABEL_DEBUG__() : null;
    const rects = []; let overlaps = 0, severe = 0, tiny = 0;
    const stationLayerInScene = scene.children.some((c) => c.name === 'StationLabelLayer');
    try {
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
          rects.push({ sx: v.x, sy: v.y, hw, hh, layer: ch.name, px: hh * innerHeight });   // NDC 半高 × 画面高 = 文字枠の高さ(px)
        });
      }
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const dx = Math.abs(a.sx - b.sx), dy = Math.abs(a.sy - b.sy);
        if (dx < (a.hw + b.hw) * 0.9 && dy < (a.hh + b.hh) * 0.9) {
          overlaps++;
          // 完全重複（中心がほぼ一致）は「文字が読めない」に相当する重大な重なり
          if (dx < Math.min(a.hw, b.hw) * 0.5 && dy < Math.min(a.hh, b.hh) * 0.5) severe++;
        }
      }
      for (const r of rects) if (r.px < 8) tiny++;   // 8px 未満は読めない大きさ
    } catch (e) { /* 計測用。失敗しても続行 */ }
    const px = rects.map((r) => +r.px.toFixed(1)).sort((a, b) => a - b);
    return { city, station, spriteCount: rects.length, overlapPairs: overlaps, severeOverlaps: severe, tooSmallLabels: tiny,
      stationLayerInScene,
      labelPx: { min: px[0] ?? null, median: px[Math.floor(px.length / 2)] ?? null, max: px[px.length - 1] ?? null, smallest: px.slice(0, 5) } };
  })()`,
  card: `(() => {
    const t = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : null; };
    const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
    const pick = window.__LAST_BUILDING_PICK__;
    const card = document.getElementById('prop-card');
    return {
      pick: pick ? pick.id : null, cardDisplay: card.style.display,
      title: t('pc-title'), ward: vis('pc-ward-row') ? t('pc-ward') : null, station: t('pc-station'),
      height: vis('pc-height-stat') ? t('pc-height') : null, floors: vis('pc-floors-stat') ? t('pc-floors') : null,
      townSectionVisible: vis('pc-town-section'),
      fakeValues: ['推定利回り', '想定賃料', '仮の参考値', '町丁目データなし', '徒歩', '推定階数'].filter((w) => (card.innerText || '').includes(w)),
    };
  })()`,
  ui: `(() => {
    const vis = (id) => { const el = document.getElementById(id); if (!el) return 'absent'; const s = getComputedStyle(el); return (s.display === 'none' || s.visibility === 'hidden') ? 'hidden' : 'visible'; };
    const out = { devOnly: {}, userUi: {} };
    for (const id of ${JSON.stringify(DEV_ONLY_IDS)}) out.devOnly[id] = vis(id);
    for (const id of ['search-box', 'prop-card', 'controls', 'visual-panel', 'compass', 'layer-toggle-panel', 'ward-selector-panel']) out.userUi[id] = vis(id);
    const rows = [...document.querySelectorAll('[data-layer-key]')].map((r) => r.dataset.layerKey);
    out.layerRows = rows;
    out.buildProfile = document.documentElement.getAttribute('data-livecity-build');
    return out;
  })()`,
  selfCheck: `window.__PRODUCTION_SELF_CHECK__()`,
  bench: (sec) => `new Promise((resolve) => {
    const ts = [], calls = [], tris = [];
    const t0 = performance.now();
    function f(t) { ts.push(t); if (renderer && renderer.info) { calls.push(renderer.info.render.calls); tris.push(renderer.info.render.triangles); }
      if (performance.now() - t0 < ${sec * 1000}) requestAnimationFrame(f); else done(); }
    function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }
    function done() {
      const dt = []; for (let i = 1; i < ts.length; i++) dt.push(ts[i] - ts[i - 1]);
      const dur = (ts[ts.length - 1] - ts[0]) / 1000;
      const fpsInst = dt.map((d) => 1000 / d);
      const mem = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
      const lbl = (typeof window.__CITY_LABEL_DEBUG__ === 'function') ? window.__CITY_LABEL_DEBUG__().visible : null;
      resolve({ seconds: +dur.toFixed(1), fpsAverage: +((ts.length - 1) / dur).toFixed(1), fpsP5: +pct(fpsInst, 0.05).toFixed(1),
        frameMsP95: +pct(dt, 0.95).toFixed(1), drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
        trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)),
        jsHeapMB: mem == null ? null : +mem.toFixed(1), visibleLabels: lbl });
    }
    requestAnimationFrame(f);
  })`,
};

// §13 レイヤーパネルの 地名 / 駅名 / 施設名 トグル（型別の件数で効きを確かめる）
const TOGGLE_JS = `(async () => {
        const res = {};
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (const key of ['placeLabels', 'railStations', 'landmarkLabels']) {
          const row = document.querySelector('[data-layer-key="' + key + '"]');
          if (!row) { res[key] = 'row-absent'; continue; }
          const cb = row.querySelector('input');
          const count = (d) => ({ total: d.visible, place: d.visiblePlaces, station: d.visibleStations, landmark: d.visibleLandmarks, ward: d.visibleWards, park: d.visibleParks });
          const typeOf = { placeLabels: 'place', railStations: 'station', landmarkLabels: 'landmark' }[key];
          const before = count(window.__CITY_LABEL_DEBUG__());
          cb.click(); await wait(900);
          const off = count(window.__CITY_LABEL_DEBUG__());
          cb.click(); await wait(900);
          const on = count(window.__CITY_LABEL_DEBUG__());
          res[key] = { type: typeOf, before, off, on, typeVisible: window.__CITY_LABEL_DEBUG__().typeVisible };
        }
        return res;
      })()`;

/** 区切替のカメラ演出などで上書きされることがあるので、狙った camera に落ち着くまで入れ直す */
async function ensureCamera(page, x, z, r, ph) {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(JS.camera(x, z, r, ph));
    await sleep(900);
    const ok = await page.evaluate(`(() => Math.abs(cs.tgt.x - (${x})) < 5 && Math.abs(cs.tgt.z - (${z})) < 5 && Math.abs(cs.r - ${r}) < 5)()`);
    if (ok) return true;
  }
  return false;
}

async function settle(page, min = 2500, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/city-labels-production-qa/' + name + '.jpg';
}
async function clickAt(page, x, y) {
  await page.evaluate(`(() => { window.__LAST_BUILDING_PICK__ = null; if (typeof closePropCard === 'function' && document.getElementById('prop-card').style.display === 'block') closePropCard(); return 1; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(300);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 1, y }); await sleep(400);
  const hover = await page.evaluate(`(() => tip.style.display)()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(900);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 620 }); await sleep(200);
  return hover;
}
/** 各地点で真上から確実に選べる PLATEAU 建物 */
function pickTargets() {
  const out = {};
  for (const s of SITES) {
    let best = null;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const f = path.join(BUILDINGS, `tile_${Math.floor(s.x / 500) + dx}_${Math.floor(s.z / 500) + dz}.json`);
      if (!fs.existsSync(f)) continue;
      const t = JSON.parse(fs.readFileSync(f, 'utf-8'));
      const a = JSON.parse(fs.readFileSync(path.join(BUILDINGS, 'attributes', path.basename(f)), 'utf-8')).attributes;
      for (const ft of t.features) {
        const at = a[ft.canonicalId];
        const d = Math.hypot(ft.centroid[0] - s.x, ft.centroid[1] - s.z);
        if (at.source !== 'plateau-building' || ft.areaM2 < 400 || ft.areaM2 > 4000 || d > 600) continue;
        if (!best || d < best.d) best = { d, id: ft.canonicalId, c: ft.centroid };
      }
    }
    out[s.id] = best;
  }
  return out;
}

async function run(phase) {
  const full = phase === 'after';
  const targets = pickTargets();
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [], requests = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  page.on('Network.requestWillBeSent', (e) => requests.push(e.request.url));
  const out = { phase, url: URL_, generatedAt: new Date().toISOString(), sites: [], errors: [] };
  try {
    if (full) await page.send('Network.enable');
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    out.startup = { ui: await page.evaluate(JS.ui), residual: (await page.evaluate(PROBE)).selfCheck.total };
    if (full) out.startup.selfCheck = await page.evaluate(JS.selfCheck);
    console.log(`[prod-label-qa:${phase}] startup`, JSON.stringify(out.startup).slice(0, 260));

    const siteList = full ? SITES : SITES.filter((s) => COMPARE_SITES.includes(s.id));
    for (const s of siteList) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(2500);
      await ensureCamera(page, s.x, s.z, VIEW.r, VIEW.ph);
      await settle(page);
      await ensureCamera(page, s.x, s.z, VIEW.r, VIEW.ph);   // settle 中に動かされていたら入れ直す
      await sleep(2000);                                      // ラベル配置の throttle を確実に跨ぐ
      const rec = {
        site: s.id, siteName: s.name,
        pixels: await page.evaluate(JS.pixels),
        labels: await page.evaluate(JS.labels),
        residual: (await page.evaluate(PROBE)).selfCheck.total,
        shot: await shot(page, `${s.id}-${phase}`),
      };
      // §19 クリック・hover の回帰（ラベル sprite が当たり判定を邪魔しないこと）
      if (full && targets[s.id]) {
        const t = targets[s.id];
        await ensureCamera(page, t.c[0], t.c[1], 220, 0.05); await settle(page, 1500); await sleep(800);
        const hover = await clickAt(page, 800, 500);
        const card = await page.evaluate(JS.card);
        rec.picking = { target: t.id, hover, ...card, pickedExpected: card.pick === t.id };
        await page.evaluate(`closePropCard()`);
      }
      out.sites.push(rec);
      console.log(`[prod-label-qa:${phase}]`, s.id, JSON.stringify({
        lum: rec.pixels.meanLuminance, sat: rec.pixels.meanSaturation,
        labels: rec.labels.city && rec.labels.city.visible, overlap: rec.labels.overlapPairs, severe: rec.labels.severeOverlaps,
        pick: rec.picking && rec.picking.pickedExpected,
      }));
    }

    // City Mode（§16/§18）
    // City Mode は flyTo（約 0.9s）と 1s 後のフォールバック補正があるので、収まるまで十分待つ
    await page.evaluate(`(() => { CityModeManager.enter(); return 1; })()`); await sleep(8000); await settle(page, 2500); await sleep(6000);
    out.cityMode = {
      pixels: await page.evaluate(JS.pixels),
      labels: await page.evaluate(JS.labels),
      residual: (await page.evaluate(PROBE)).selfCheck.total,
      shot: await shot(page, `city-${phase}`),
    };
    console.log(`[prod-label-qa:${phase}] cityMode`, JSON.stringify({ lum: out.cityMode.pixels.meanLuminance, labels: out.cityMode.labels.city && out.cityMode.labels.city.visible, overlap: out.cityMode.labels.overlapPairs, severe: out.cityMode.labels.severeOverlaps, tiny: out.cityMode.labels.tooSmallLabels }));

    if (full) {
      // §17 性能（City Mode を含む 4 条件・各 30 秒）
      out.performance = [];
      out.performance.push({ site: 'cityMode', ...(await page.evaluate(JS.bench(30), { timeoutMs: 120000 })) });
      await page.evaluate(`(() => { CityModeManager.exit('kita'); return 1; })()`); await sleep(1500);
      for (const id of PERF_SITES) {
        const s = SITES.find((q) => q.id === id);
        await page.evaluate(JS.ward(s.x, s.z)); await sleep(1500);
        await ensureCamera(page, s.x, s.z, 700, Math.PI / 4); await settle(page);
        out.performance.push({ site: id, ...(await page.evaluate(JS.bench(30), { timeoutMs: 120000 })) });
        console.log(`[prod-label-qa:${phase}] perf`, id, JSON.stringify(out.performance[out.performance.length - 1]));
      }

      // §13 レイヤートグル（地名 / 駅名 / 施設名）。3 種すべてが画面に出ている視点で確かめる
      await page.evaluate(JS.ward(SITE_FOR_TOGGLE.x, SITE_FOR_TOGGLE.z)); await sleep(2500);
      await ensureCamera(page, SITE_FOR_TOGGLE.x, SITE_FOR_TOGGLE.z, VIEW.r, VIEW.ph);
      await settle(page);
      await ensureCamera(page, SITE_FOR_TOGGLE.x, SITE_FOR_TOGGLE.z, VIEW.r, VIEW.ph);
      await sleep(2000);
      out.layerToggles = await page.evaluate(TOGGLE_JS, { timeoutMs: 60000 });
      console.log(`[prod-label-qa:${phase}] layerToggles`, JSON.stringify(out.layerToggles));

      // §19 検索の回帰
      out.search = await page.evaluate(`(async () => {
        searchInput.value = '難波'; doSearch();
        await new Promise((z) => setTimeout(z, 1800));
        const spot = findSpot('難波'); const g = geoToThree(spot.lat, spot.lon);
        return { msgShown: searchMsg.style.display === 'block', distanceM: Math.round(Math.hypot(cs.tgt.x - g.x, cs.tgt.z - g.z)) };
      })()`);
      // §23 fetch 監査
      out.fetchAudit = {
        totalRequests: requests.length,
        forbidden: FORBIDDEN_FETCH.map((f) => ({ id: f.id, count: requests.filter((u) => f.re.test(u)).length })),
        v2nBuildingRequests: requests.filter((u) => /\/derived-v2-osmv2\/(near|mid|far)\/buildings\//.test(u)).length,
        labelDataRequests: requests.filter((u) => /place-labels\.json|map-label-anchors\.json|rail-stations\.json|landmarks\.json/.test(u)).length,
        namespaceCounters: await page.evaluate(`window.__BUILDINGS_VERSION_DEBUG__().fetchByNamespace`),
      };
      out.finalSelfCheck = await page.evaluate(JS.selfCheck);
      out.finalUi = await page.evaluate(JS.ui);
    }
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }
  return out;
}

async function runTogglesOnly() {
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    await page.evaluate(JS.ward(SITE_FOR_TOGGLE.x, SITE_FOR_TOGGLE.z)); await sleep(2500);
    await ensureCamera(page, SITE_FOR_TOGGLE.x, SITE_FOR_TOGGLE.z, VIEW.r, VIEW.ph);
    await settle(page);
    await ensureCamera(page, SITE_FOR_TOGGLE.x, SITE_FOR_TOGGLE.z, VIEW.r, VIEW.ph);
    await sleep(2000);
    return await page.evaluate(TOGGLE_JS, { timeoutMs: 60000 });
  } finally { await b.close(); }
}

async function main() {
  if (process.argv.includes('--only') && process.argv[process.argv.indexOf('--only') + 1] === 'city') {
    const doc = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
    const b2 = await launchBrowser({ width: 1600, height: 1000 });
    const page = b2.page;
    try {
      await page.send('Page.navigate', { url: URL_ });
      await sleep(42000);
      await page.evaluate(`(() => { CityModeManager.enter(); return 1; })()`);
      await sleep(8000); await settle(page, 2500); await sleep(6000);
      doc.phases.after.cityMode = {
        pixels: await page.evaluate(JS.pixels),
        labels: await page.evaluate(JS.labels),
        residual: (await page.evaluate(PROBE)).selfCheck.total,
        shot: await shot(page, 'city-after'),
      };
    } finally { await b2.close(); }
    doc.generatedAt = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
    console.log('[prod-label-qa] cityMode', JSON.stringify({ labels: doc.phases.after.cityMode.labels.city.visible, overlap: doc.phases.after.cityMode.labels.overlapPairs, severe: doc.phases.after.cityMode.labels.severeOverlaps, tiny: doc.phases.after.cityMode.labels.tooSmallLabels }));
    return doc;
  }
  if (process.argv.includes('--only') && process.argv[process.argv.indexOf('--only') + 1] === 'toggles') {
    const doc = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
    doc.phases.after.layerToggles = await runTogglesOnly();
    doc.generatedAt = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
    console.log('[prod-label-qa] layerToggles', JSON.stringify(doc.phases.after.layerToggles));
    return doc;
  }
  const i = process.argv.indexOf('--phase');
  const phase = (i >= 0 ? process.argv[i + 1] : 'after') === 'before' ? 'before' : 'after';
  const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch { return null; } })();
  const result = await run(phase);
  const doc = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '33B',
    view: VIEW, phases: { ...(prev && prev.phases ? prev.phases : {}), [phase]: result },
  };
  if (doc.phases.before && doc.phases.after) {
    doc.comparison = COMPARE_SITES.map((id) => {
      const a = doc.phases.before.sites.find((s) => s.site === id);
      const b = doc.phases.after.sites.find((s) => s.site === id);
      if (!a || !b) return { site: id, missing: true };
      return {
        site: id, siteName: b.siteName,
        luminance: { before: a.pixels.meanLuminance, after: b.pixels.meanLuminance },
        saturation: { before: a.pixels.meanSaturation, after: b.pixels.meanSaturation },
        labels: { before: a.labels.city ? a.labels.city.visible : 0, after: b.labels.city ? b.labels.city.visible : 0 },
      };
    });
    doc.comparison.push({
      site: 'cityMode',
      luminance: { before: doc.phases.before.cityMode.pixels.meanLuminance, after: doc.phases.after.cityMode.pixels.meanLuminance },
      saturation: { before: doc.phases.before.cityMode.pixels.meanSaturation, after: doc.phases.after.cityMode.pixels.meanSaturation },
      labels: { before: doc.phases.before.cityMode.labels.city ? doc.phases.before.cityMode.labels.city.visible : 0, after: doc.phases.after.cityMode.labels.city ? doc.phases.after.cityMode.labels.city.visible : 0 },
    });
  }
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  return doc;
}

if (isMainModule(import.meta.url)) {
  main().then((d) => { console.log('[prod-label-qa] out', OUT, JSON.stringify(Object.keys(d.phases))); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
