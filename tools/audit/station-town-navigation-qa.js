#!/usr/bin/env node
// tools/audit/station-town-navigation-qa.js
// [Mission 35K §23-§28/§35] 駅表示と町名クリックを実ブラウザで確認する。
//   前提: `npm run preview`。対象は dev。production は触らない（§30）。
//   出力: data/reports/station-town-navigation-qa.json
//         data/reports/station-town-navigation-qa/*.jpg
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
export const OUT = P('data', 'reports', 'station-town-navigation-qa.json');
export const SHOTS = P('data', 'reports', 'station-town-navigation-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** §23 駅の確認地点（複数事業者が集まる場所を含む）。 */
export const STATION_SITES = [
  { id: 'umeda', label: '梅田', lat: 34.70250, lon: 135.49586, r: 900,
    expect: ['大阪駅', '梅田駅', '東梅田駅', '西梅田駅'] },
  { id: 'namba', label: '難波', lat: 34.66600, lon: 135.50100, r: 900,
    expect: ['なんば駅', '大阪難波駅'] },
  { id: 'tennoji', label: '天王寺', lat: 34.64550, lon: 135.51400, r: 900,
    expect: ['天王寺駅', '大阪阿部野橋駅'] },
  { id: 'shin-osaka', label: '新大阪〜東淀川', lat: 34.73600, lon: 135.50300, r: 1100,
    expect: ['新大阪駅', '東淀川駅'] },
  { id: 'kita-osaka', label: '淡路・上新庄・十三', lat: 34.74100, lon: 135.52000, r: 1800,
    expect: ['淡路駅', '上新庄駅'] },
  // 本町・心斎橋・淀屋橋は南北に 1.7km 離れるので、r=900 では画面に入らない
  { id: 'honmachi', label: '本町・心斎橋', lat: 34.68150, lon: 135.50050, r: 1500,
    expect: ['本町駅', '心斎橋駅'] },
  { id: 'kyobashi', label: '京橋', lat: 34.69700, lon: 135.53400, r: 900, expect: ['京橋駅'] },
  // 淀屋橋は本町から約 1.4km 北。同じ画面に収めると文字が重なるので独立した地点で見る。
  { id: 'yodoyabashi', label: '淀屋橋', lat: 34.69340, lon: 135.50170, r: 800,
    expect: ['淀屋橋駅'] },
];
/** §24 町名の確認。`town` は町丁目データがある区、`ward` は区界へ落ちる区。 */
export const TOWN_SITES = [
  { id: 'sumiyoshi', label: '住吉', lat: 34.61200, lon: 135.49300, r: 1500, expectGranularity: 'chochome' },
  { id: 'umeda-town', label: '梅田', lat: 34.70250, lon: 135.49586, r: 1200, expectGranularity: 'ward' },
  { id: 'honmachi-town', label: '本町', lat: 34.68200, lon: 135.49900, r: 1200, expectGranularity: 'ward' },
  { id: 'awaji-town', label: '淡路', lat: 34.74640, lon: 135.53170, r: 1200, expectGranularity: 'ward' },
];
/** §27 性能を測る地点。 */
export const PERF_SITES = [
  { id: 'umeda', lat: 34.70250, lon: 135.49586, r: 900 },
  { id: 'namba', lat: 34.66600, lon: 135.50100, r: 900 },
  { id: 'shin-osaka', lat: 34.73340, lon: 135.50020, r: 900 },
];
export const PERF_SECONDS = 12;
/** §27 ON/OFF A/B の 1 回あたりの計測秒数（4 回測るので短め）。 */
export const PERF_AB_SECONDS = 8;
/** §27 35I baseline 比の FPS 低下許容。 */
export const FPS_DROP_BUDGET_PCT = 5;

export function worldOf(s) {
  const w = latLonToLiveCityWorld(s.lat, s.lon);
  return { x: Math.round(w.x), z: Math.round(w.z) };
}

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, phDeg = 40) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  /** 画面に出ている駅ラベル（名前・事業者・重要度）。 */
  visibleStations: `(() => {
    const d = window.__CITY_LABEL_DEBUG__();
    const ids = new Set(d.visibleIds || []);
    const out = [];
    // 出ているラベルのうち駅だけを、クリック判定に使っている矩形から拾う
    for (let gx = 0; gx <= 1.0001; gx += 0.02) {
      for (let gy = 0; gy <= 1.0001; gy += 0.02) {
        const it = CityLabelLayer.pickLabel(gx * innerWidth, gy * innerHeight);
        if (it && it.kind === 'station' && !out.some((o) => o.id === it.id)) {
          out.push({ id: it.id, name: it.name, op: it.operator ? it.operator.code : null,
            group: it.operator ? it.operator.group : null, importance: it.importance });
        }
      }
    }
    return { visibleStations: d.visibleStations, visible: d.visible, stations: d.stations, found: out };
  })()`,
  clickable: `CityLabelLayer.getClickableCount()`,
  areaDebug: `JSON.stringify(window.__AREA_SELECTION_DEBUG__())`,
  /**
   * §10/§24 画面上の町名ラベルを 1 つ選んでクリックする。
   * wantGranularity を渡すと、その粒度になるラベルを優先する
   * （町丁目データのある区を見ているのに、隣の区の地名を拾ってしまわないように）。
   */
  clickFirstPlace: (wantGranularity) => `(() => {
    const want = ${JSON.stringify(wantGranularity || null)};
    const found = [];
    for (let gy = 0.15; gy <= 0.85; gy += 0.02) {
      for (let gx = 0.15; gx <= 0.85; gx += 0.02) {
        const it = CityLabelLayer.pickLabel(gx * innerWidth, gy * innerHeight);
        if (it && it.kind === 'place' && AreaSelectionLayer.hasAreaForLabel(it.id)
          && !found.some((f) => f.id === it.id)) found.push(it);
      }
    }
    if (!found.length) return JSON.stringify({ clicked: null });
    let pick = found[0];
    if (want) {
      // いったん選んでみて粒度を見る（選び直すので副作用は残らない）
      for (const it of found) {
        const s = AreaSelectionLayer.selectFromLabel(it);
        const g = s && s.granularity;
        AreaSelectionLayer.clearSelection();
        if (g === want || (want === 'chochome' && g === 'chochome-union')) { pick = it; break; }
      }
    }
    const sel = AreaSelectionLayer.selectFromLabel(pick);
    updateAreaSelectionUI();
    return JSON.stringify({ clicked: pick.name, id: pick.id, selected: sel, candidates: found.length });
  })()`,
  /** §9 画面上の駅ラベルを 1 つクリックする。 */
  clickFirstStation: `(() => {
    for (let gy = 0.15; gy <= 0.85; gy += 0.02) {
      for (let gx = 0.15; gx <= 0.85; gx += 0.02) {
        const it = CityLabelLayer.pickLabel(gx * innerWidth, gy * innerHeight);
        if (it && it.kind === 'station') { const s = selectStationLabel(it); return JSON.stringify({ clicked: it.name, selected: s }); }
      }
    }
    return JSON.stringify({ clicked: null });
  })()`,
  /** §20 ラベルをクリックしたとき、背後の建物カードが開かないこと。 */
  clickConflict: `(() => {
    const card = document.getElementById('prop-card');
    const before = !!(card && card.style.display !== 'none');
    let target = null;
    for (let gy = 0.2; gy <= 0.8 && !target; gy += 0.02) {
      for (let gx = 0.2; gx <= 0.8 && !target; gx += 0.02) {
        const it = CityLabelLayer.pickLabel(gx * innerWidth, gy * innerHeight);
        if (it && (it.kind === 'place' || it.kind === 'station')) target = { it, x: gx * innerWidth, y: gy * innerHeight };
      }
    }
    if (!target) return JSON.stringify({ tested: false });
    // 実際の click 経路を通す（clickIntent を通すため合成イベント）
    clickIntentDown(target.x, target.y, 'mouse', 0);
    clickIntentUp();
    canvas.dispatchEvent(new MouseEvent('click', { clientX: target.x, clientY: target.y, bubbles: true }));
    const after = !!(card && card.style.display !== 'none');
    return JSON.stringify({ tested: true, kind: target.it.kind, name: target.it.name,
      cardBefore: before, cardAfter: after, cardOpened: !before && after });
  })()`,
  /** §21 ドラッグ後は click が発火しないこと（既存の clickIntent を使う）。 */
  dragNoClick: `(() => {
    clickIntentDown(700, 450, 'mouse', 0);
    clickIntentMove(760, 500);
    cs.tgt.x += 120;             // カメラが動いた状態にする
    clickIntentUp();
    return JSON.stringify({ allows: clickIntentAllows() });
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
        const d = window.__CITY_LABEL_DEBUG__();
        resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1), frameMsP95: +pct(dt, 0.95).toFixed(1),
          drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
          trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)),
          labelsVisible: d.visible, textures: d.createdTextures, cachedTextures: d.cachedTextures,
          sprites: d.spriteCount });
      } }
    requestAnimationFrame(f); })`,
  /** §28 回帰。 */
  regression: `(() => {
    const r = {};
    try { r.roadMode = __SEMANTIC_DISPLAY_DEBUG__().normalViewRoadMode; } catch (e) { r.roadMode = 'ERR'; }
    try { r.buildingsVersion = CanonicalRuntime.getBuildingsVersionDebug().version; } catch (e) { r.buildingsVersion = 'ERR'; }
    try { r.selfCheck = __CANONICAL_SELF_CHECK__().total; } catch (e) { r.selfCheck = -1; }
    try { r.highLod = !!(window.__BUILDING_LOD_DEBUG__ && window.__BUILDING_LOD_DEBUG__()); } catch (e) { r.highLod = false; }
    try { r.labels = window.__CITY_LABEL_DEBUG__() ? 'ok' : 'missing'; } catch (e) { r.labels = 'ERR'; }
    try { r.search = typeof findSpot === 'function'; } catch (e) { r.search = false; }
    try { r.hover = typeof pickHit === 'function'; } catch (e) { r.hover = false; }
    let hit = null;
    for (let gy = 0.35; gy <= 0.65 && !hit; gy += 0.05) {
      for (let gx = 0.3; gx <= 0.7 && !hit; gx += 0.05) {
        const lbl = CityLabelLayer.pickLabel(gx * innerWidth, gy * innerHeight);
        if (lbl) continue;                       // ラベルの上は建物クリックの対象にしない
        const h = pickHit({ clientX: Math.round(innerWidth * gx), clientY: Math.round(innerHeight * gy) });
        if (h && h.d && h.d.id) hit = h;
      }
    }
    r.pick = !!hit;
    if (hit) { try { selectBuilding({ clientX: innerWidth / 2, clientY: innerHeight / 2 }, hit); } catch (e) { r.cardError = String(e.message); }
      const el = document.getElementById('prop-card');
      r.card = !!(el && el.style.display !== 'none');
      r.cardHasWard = !!(el && /区/.test(el.innerText || ''));
      try { hideCard(); } catch (e) { const el2 = document.getElementById('prop-card'); if (el2) el2.style.display = 'none'; } }
    const tags = new Set();
    scene.traverse((o) => { if (o.name) tags.add(o.name); const cp = o.userData && o.userData.creationPath; if (cp) tags.add(cp); });
    const has = (re) => [...tags].some((n) => re.test(n));
    r.hasRail = has(/rail/i); r.hasWater = has(/water|river/i);
    r.hasParks = has(/park/i); r.hasRoad = has(/road/i); r.hasBuildings = has(/BUILDING/i);
    r.hasAreaLayer = has(/AreaSelectionLayer/);
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
  return 'data/reports/station-town-navigation-qa/' + name + '.jpg';
}
const HIDE_DEV_UI = `(() => {
  for (const el of document.querySelectorAll('div,button')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|layer-toggle|^tip$|^pl$|^pr$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery|stations-toggle|town-click|town-boundary/.test(id)) el.style.display = 'none'; }
  return 1; })()`;

export async function run() {
  const t0 = Date.now();
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35K', url: URL_,
    stationSites: [], townSites: [], performance: [], regression: null, errors: [] };
  const b = await launchBrowser({ width: 1440, height: 900 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(44000);
    out.boot = { area: JSON.parse(await page.evaluate(JS.areaDebug)) };
    console.log('[k-qa] area', JSON.stringify(out.boot.area.counts), 'townWards', JSON.stringify(out.boot.area.townWards));

    // ── §23 駅 ──────────────────────────────────────────────────────
    for (const s of STATION_SITES) {
      const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2200);
      await page.evaluate(JS.camera(w.x, w.z, s.r));
      await settle(page);
      await page.evaluate(HIDE_DEV_UI); await sleep(900);
      const vis = await page.evaluate(JS.visibleStations, { timeoutMs: 180000 });
      const names = vis.found.map((f) => f.name);
      const missing = (s.expect || []).filter((n) => !names.includes(n));
      const ops = [...new Set(vis.found.map((f) => f.op).filter(Boolean))];
      out.stationSites.push({ ...s, world: w, ...vis, names, missing, operators: ops,
        shot: await shot(page, 'station.' + s.id) });
      console.log('[k-qa] 駅', s.id.padEnd(12), '表示', vis.found.length, '事業者', ops.join(','),
        missing.length ? '★不足 ' + missing.join(',') : '');
    }

    // ── §24 町 ──────────────────────────────────────────────────────
    for (const s of TOWN_SITES) {
      const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2200);
      await page.evaluate(JS.camera(w.x, w.z, s.r));
      await settle(page);
      await page.evaluate(HIDE_DEV_UI); await sleep(900);
      const before = await shot(page, 'town.' + s.id + '.before');
      const clicked = JSON.parse(await page.evaluate(JS.clickFirstPlace(s.expectGranularity), { timeoutMs: 180000 }));
      await sleep(400);
      const afterClick = await shot(page, 'town.' + s.id + '.selected');
      await sleep(1400);                                   // §16 カメラ移動の完了を待つ
      const zoomed = await shot(page, 'town.' + s.id + '.zoomed');
      const dbg = JSON.parse(await page.evaluate(JS.areaDebug));
      const cleared = JSON.parse(await page.evaluate('JSON.stringify(window.__AREA_CLEAR__())') || 'null');
      const afterClear = JSON.parse(await page.evaluate(JS.areaDebug));
      out.townSites.push({ ...s, world: w, clicked, selected: dbg.selected, lastFitR: dbg.lastFitR,
        outlineMeshes: dbg.outlineMeshes, fillMeshes: dbg.fillMeshes,
        clearedSelected: afterClear.selected, clearedOutline: afterClear.outlineMeshes,
        shots: { before, selected: afterClick, zoomed } });
      console.log('[k-qa] 町', s.id.padEnd(14), 'クリック', clicked.clicked || '★なし',
        '| 粒度', dbg.selected ? dbg.selected.granularity : '-', '| fit', dbg.lastFitR ? Math.round(dbg.lastFitR) + 'm' : '-',
        '| 解除後', afterClear.outlineMeshes, 'mesh');
    }

    // ── §9 駅クリック ───────────────────────────────────────────────
    {
      const s = STATION_SITES[0], w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2000);
      await page.evaluate(JS.camera(w.x, w.z, s.r));
      await settle(page);
      await page.evaluate(HIDE_DEV_UI); await sleep(700);
      out.stationClick = JSON.parse(await page.evaluate(JS.clickFirstStation, { timeoutMs: 180000 }));
      await sleep(1400);
      out.stationClickShot = await shot(page, 'station-click');
      console.log('[k-qa] 駅クリック', out.stationClick.clicked || '★なし');
      await page.evaluate('window.__AREA_CLEAR__()');
    }

    // ── §20/§21 クリックの優先順位・ドラッグ保護 ─────────────────────
    {
      const s = STATION_SITES[0], w = worldOf(s);
      await page.evaluate(JS.camera(w.x, w.z, s.r));
      await settle(page);
      out.clickConflict = JSON.parse(await page.evaluate(JS.clickConflict, { timeoutMs: 120000 }));
      out.dragNoClick = JSON.parse(await page.evaluate(JS.dragNoClick, { timeoutMs: 60000 }));
      console.log('[k-qa] クリック衝突', JSON.stringify(out.clickConflict), '| ドラッグ', JSON.stringify(out.dragNoClick));
      await page.evaluate('window.__AREA_CLEAR__()');
    }

    // ── §27 性能 ────────────────────────────────────────────────────
    for (const s of PERF_SITES) {
      const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2000);
      await page.evaluate(JS.camera(w.x, w.z, s.r));
      await settle(page);
      const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ id: s.id, mode: 'ward', ...r });
      console.log('[k-qa] perf', s.id.padEnd(12), 'fps', r.fpsAverage, 'p95', r.frameMsP95 + 'ms',
        'ラベル', r.labelsVisible, 'texture', r.textures, 'sprite', r.sprites);
    }
    // §27 35K そのものの費用は **同一セッション・同一カメラ** の ON/OFF で測る。
    //   35I の baseline（梅田・draw call 285）は読み込まれていたタイルが違うので、
    //   その数字と直接引き算すると 35K と無関係な差まで混ざる（35H の City Mode と同じ罠）。
    try {
      const w = worldOf(PERF_SITES[0]);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2000);
      await page.evaluate(JS.camera(w.x, w.z, PERF_SITES[0].r));
      await settle(page);
      const on = [], off = [];
      for (let i = 0; i < 2; i++) {                      // ON/OFF を交互に。ドリフトを打ち消す
        await page.evaluate("(() => { CityLabelLayer.setTypeVisible('station', true); return 1; })()");
        await sleep(600);
        on.push(await page.evaluate(JS.bench(PERF_AB_SECONDS), { timeoutMs: 120000 }));
        await page.evaluate("(() => { CityLabelLayer.setTypeVisible('station', false); return 1; })()");
        await sleep(600);
        off.push(await page.evaluate(JS.bench(PERF_AB_SECONDS), { timeoutMs: 120000 }));
      }
      await page.evaluate("(() => { CityLabelLayer.setTypeVisible('station', true); return 1; })()");
      const avg = (a, k) => +(a.reduce((x, y) => x + y[k], 0) / a.length).toFixed(1);
      const fOn = avg(on, 'fpsAverage'), fOff = avg(off, 'fpsAverage');
      out.perfAb = { id: PERF_SITES[0].id, seconds: PERF_AB_SECONDS, rounds: on.length,
        stationsOn: { fps: fOn, calls: Math.round(avg(on, 'drawCallsAvg')), labels: Math.round(avg(on, 'labelsVisible')) },
        stationsOff: { fps: fOff, calls: Math.round(avg(off, 'drawCallsAvg')), labels: Math.round(avg(off, 'labelsVisible')) },
        fpsDropPct: +(((fOff - fOn) / fOff) * 100).toFixed(1),
        samples: { on: on.map((r) => r.fpsAverage), off: off.map((r) => r.fpsAverage) } };
      console.log('[k-qa] A/B 梅田 駅ラベル ON', fOn, 'fps / OFF', fOff, 'fps → 低下', out.perfAb.fpsDropPct + '%');
    } catch (e) { out.perfAbError = String(e && e.message || e).slice(0, 200); }

    try {
      await page.evaluate('(() => { CityModeManager.enter(); return 1; })()');
      await settle(page, 4000, 150000);
      await page.evaluate(HIDE_DEV_UI); await sleep(1000);
      const r = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ id: 'city-mode', mode: 'city', ...r });
      out.cityModeShot = await shot(page, 'city-mode');
      console.log('[k-qa] perf city-mode    fps', r.fpsAverage, 'ラベル', r.labelsVisible);
      await page.evaluate('(() => { CityModeManager.exit("kita"); return 1; })()');
      await sleep(3000);
    } catch (e) { out.cityModeError = String(e && e.message || e).slice(0, 200); }

    // ── §28 回帰 ────────────────────────────────────────────────────
    {
      const s = STATION_SITES[0], w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2200);
      await page.evaluate(JS.camera(w.x, w.z, 700));
      await settle(page);
      out.regression = await page.evaluate(JS.regression, { timeoutMs: 120000 });
      console.log('[k-qa] regression', JSON.stringify(out.regression));
    }
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }

  // ── まとめ ──────────────────────────────────────────────────────────
  const r = out.regression || {};
  const allOps = [...new Set(out.stationSites.flatMap((s) => s.operators))];
  const north = out.stationSites.find((s) => s.id === 'shin-osaka');
  const kita = out.stationSites.find((s) => s.id === 'kita-osaka');
  out.summary = {
    area: out.boot.area.counts, townWards: out.boot.area.townWards,
    stationsLoaded: out.stationSites.length ? out.stationSites[0].stations : null,
    // §23 期待した駅が出ているか
    stationSitesOk: out.stationSites.every((s) => s.missing.length === 0),
    stationMissing: out.stationSites.flatMap((s) => s.missing),
    operatorsSeen: allOps,
    multiOperatorSites: out.stationSites.filter((s) => s.operators.length >= 2).map((s) => s.id),
    // §25 北部の駅
    northStationsOk: !!(north && north.missing.length === 0 && kita && kita.missing.length === 0),
    // §24 町クリック
    townSitesClicked: out.townSites.filter((s) => s.clicked && s.clicked.clicked).length,
    townSitesTotal: out.townSites.length,
    // §11 粒度は **既存 source の粒度** をそのまま名乗る。町丁目のデータがある区は
    //   chochome（1 丁目だけ）か chochome-union（「東粉浜」= 東粉浜 1〜3 丁目の束ね）のどちらか。
    //   無い区は ward（N03 正式区界）へ落ちる。推測した町界は作らない（§12）。
    townGranularityOk: out.townSites.every((s) => !s.selected || (s.expectGranularity === 'chochome'
      ? (s.selected.granularity === 'chochome' || s.selected.granularity === 'chochome-union')
      : s.selected.granularity === s.expectGranularity)),
    townGranularities: Object.fromEntries(out.townSites.map((s) => [s.id,
      s.selected ? s.selected.granularity : null])),
    townSelectionShown: out.townSites.every((s) => !s.clicked || !s.clicked.clicked || s.outlineMeshes > 0),
    townZoomApplied: out.townSites.every((s) => !s.clicked || !s.clicked.clicked || (s.lastFitR > 0)),
    townClearOk: out.townSites.every((s) => s.clearedSelected === null && s.clearedOutline === 0),
    // §9 駅クリック
    stationClickOk: !!(out.stationClick && out.stationClick.clicked),
    // §20/§21
    clickConflictOk: !!(out.clickConflict && out.clickConflict.tested && out.clickConflict.cardOpened === false),
    dragNoClickOk: !!(out.dragNoClick && out.dragNoClick.allows === false),
    // §27 性能
    perf: Object.fromEntries(out.performance.map((p) => [p.id, { fps: p.fpsAverage, p95: p.frameMsP95,
      calls: p.drawCallsAvg, labels: p.labelsVisible, textures: p.textures, sprites: p.sprites }])),
    perfAb: out.perfAb || null,
    // §28 回帰
    regressionOk: !!(r.roadMode === 'ROAD_V3' && r.buildingsVersion === 'V4' && r.selfCheck === 0
      && r.highLod && r.labels === 'ok' && r.search && r.hover && r.pick && r.card && r.cardHasWard
      && r.hasRail && r.hasWater && r.hasParks && r.hasRoad && r.hasBuildings),
    regression: r,
    jsErrors: out.errors.length,
    elapsedMs: Date.now() - t0,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { console.log('[k-qa] summary', JSON.stringify(o.summary, null, 1).slice(0, 2600)); console.log('[k-qa] out', OUT); })
    .catch((e) => { console.error(e); process.exit(1); });
}
