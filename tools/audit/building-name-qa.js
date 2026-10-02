#!/usr/bin/env node
// tools/audit/building-name-qa.js
// [Mission 35O §14/§15/§17] 建物名ラベルを実ブラウザで確認する。
//   流れは「開く → 見る → 建物をクリック → スクショ」。Console 入力は要らない。
//   前提: `npm run preview`。対象は dev のみ。
//   出力: data/reports/building-name-qa.json / data/reports/building-name-qa/*.jpg
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
export const OUT = P('data', 'reports', 'building-name-qa.json');
export const SHOTS = P('data', 'reports', 'building-name-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** §14 代表 9 地点。名称が豊富な中之島・心斎橋・天王寺を含む。 */
export const SITES = [
  { id: 'umeda', label: '梅田', lat: 34.70250, lon: 135.49586, r: 900 },
  { id: 'honmachi', label: '本町', lat: 34.68200, lon: 135.49900, r: 900 },
  { id: 'namba', label: '難波', lat: 34.66600, lon: 135.50100, r: 900 },
  { id: 'awaji', label: '淡路', lat: 34.74640, lon: 135.53170, r: 900 },
  { id: 'higashimikuni', label: '東三国', lat: 34.74140, lon: 135.49890, r: 900 },
  { id: 'sumiyoshi', label: '住吉', lat: 34.61200, lon: 135.49300, r: 1100 },
  { id: 'nakanoshima', label: '中之島', lat: 34.69300, lon: 135.49300, r: 900 },
  { id: 'shinsaibashi', label: '心斎橋', lat: 34.67300, lon: 135.50100, r: 900 },
  { id: 'tennoji', label: '天王寺', lat: 34.64550, lon: 135.51400, r: 900 },
];
/** §9 ズームを変えてラベル数が増えることの確認に使う距離。 */
export const ZOOM_STEPS = [4200, 1800, 800];

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z});
    if (CityModeManager.isActive()) CityModeManager.exit(wid);
    if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, phDeg = 40) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  /** 画面に出ている建物名ラベルを拾う（クリック判定と同じ矩形から）。 */
  visibleBuildingLabels: `(() => {
    const found = [], all = [];
    for (let gy = 0.08; gy <= 0.92; gy += 0.018) {
      for (let gx = 0.08; gx <= 0.92; gx += 0.018) {
        const it = CityLabelLayer.pickLabel(gx * innerWidth, gy * innerHeight);
        if (!it) continue;
        if (!all.some((o) => o.id === it.id)) all.push({ id: it.id, kind: it.kind, name: it.name });
        if (it.kind === 'building' && !found.some((o) => o.id === it.id)) {
          found.push({ id: it.id, name: it.name, tier: it.tier, h: it.height, n: it.facilityCount });
        }
      }
    }
    const d = window.__CITY_LABEL_DEBUG__();
    return JSON.stringify({ buildings: found, allKinds: all.reduce((a, o) => { a[o.kind] = (a[o.kind] || 0) + 1; return a; }, {}),
      totalVisible: d.visible, names: all.map((o) => o.name) });
  })()`,
  /** §19 建物をクリックして card に名称が出るか。 */
  clickNamedBuilding: `(() => {
    // 画面に出ている建物名ラベルの建物を 1 つ選び、その canonicalId で card を開く
    let target = null;
    for (let gy = 0.15; gy <= 0.85 && !target; gy += 0.02) {
      for (let gx = 0.15; gx <= 0.85 && !target; gx += 0.02) {
        const it = CityLabelLayer.pickLabel(gx * innerWidth, gy * innerHeight);
        if (it && it.kind === 'building') target = it;
      }
    }
    if (!target) return JSON.stringify({ clicked: null });
    // §19 その建物の canonicalId で property card を開き、建物名・施設の行が出るか見る
    const cid = target.buildingId;
    try { showPropertyCard({ id: cid, canonicalId: cid, fp: [], usage: null }); } catch (e) { /* noop */ }
    const row = document.getElementById('pc-bldgname-row');
    const fac = document.getElementById('pc-facility-row');
    return JSON.stringify({
      clicked: target.name, buildingId: cid, facilityCount: target.facilityCount,
      cardOpened: (() => { const c = document.getElementById('prop-card'); return !!c && c.style.display === 'block'; })(),
      cardNameShown: !!row && row.style.display !== 'none',
      cardName: document.getElementById('pc-bldgname') ? document.getElementById('pc-bldgname').textContent : null,
      cardFacilityShown: !!fac && fac.style.display !== 'none',
      cardFacility: document.getElementById('pc-facility') ? document.getElementById('pc-facility').textContent : null,
    });
  })()`,
  /** 索引を読み込ませてから card を開き直す（遅延 fetch の完了を待つ用）。 */
  ensureStore: `(() => { BuildingNameStore.ensure(); return 1; })()`,
  reopenCard: (cid) => `(() => {
    try { showPropertyCard({ id: ${JSON.stringify(cid)}, canonicalId: ${JSON.stringify(cid)}, fp: [], usage: null }); } catch (e) { return JSON.stringify({ err: String(e) }); }
    const row = document.getElementById('pc-bldgname-row');
    const fac = document.getElementById('pc-facility-row');
    return JSON.stringify({
      cardNameShown: !!row && row.style.display !== 'none',
      cardName: document.getElementById('pc-bldgname').textContent,
      cardFacilityShown: !!fac && fac.style.display !== 'none',
      cardFacility: document.getElementById('pc-facility').textContent,
    });
  })()`,
  nameStore: `JSON.stringify(window.__BUILDING_NAME_DEBUG__())`,
  perf: `(() => { const i = renderer.info.render; const d = window.__CITY_LABEL_DEBUG__();
    return JSON.stringify({ drawCalls: i.calls, triangles: i.triangles, sprites: d.spriteCount, visible: d.visible }); })()`,
};

const HIDE_DEV_UI = `(() => {
  for (const el of document.querySelectorAll('div,button')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|layer-toggle|^tip$|^pl$|^pr$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery|stations-toggle|town-click|town-boundary/.test(id)) el.style.display = 'none'; }
  return 1; })()`;

async function settle(page, min = 2500, max = 120000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) {
    const q = await page.evaluate(JS.settled);
    z = q === 0 ? z + 1 : 0;
    if (z >= 3) return;
    await sleep(700);
  }
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/building-name-qa/' + name + '.jpg';
}
const worldOf = (s) => latLonToLiveCityWorld(s.lat, s.lon);

export async function run() {
  const t0 = Date.now();
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35O', url: URL_, sites: [], errors: [] };
  const b = await launchBrowser({ width: 1440, height: 900 });
  const page = b.page;
  try {
    await page.send('Page.navigate', { url: URL_ });
    await settle(page, 8000, 240000);
    for (const s of SITES) {
      const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2200);
      const zoom = [];
      for (const r of ZOOM_STEPS) {
        await page.evaluate(JS.camera(w.x, w.z, r));
        await settle(page);
        await page.evaluate(HIDE_DEV_UI); await sleep(800);
        const v = JSON.parse(await page.evaluate(JS.visibleBuildingLabels, { timeoutMs: 180000 }));
        zoom.push({ r, buildingLabels: v.buildings.length, kinds: v.allKinds, sample: v.buildings.slice(0, 10) });
      }
      // 近景でスクリーンショットとクリック
      await page.evaluate(JS.camera(w.x, w.z, s.r));
      await settle(page);
      await page.evaluate(HIDE_DEV_UI); await sleep(800);
      const shotPath = await shot(page, s.id);
      const v = JSON.parse(await page.evaluate(JS.visibleBuildingLabels, { timeoutMs: 180000 }));
      await page.evaluate(JS.ensureStore);
      let click = JSON.parse(await page.evaluate(JS.clickNamedBuilding, { timeoutMs: 120000 }));
      if (click.buildingId) {
        // 索引は遅延 fetch なので、届いてから開き直して確かめる
        await sleep(4000);
        const again = JSON.parse(await page.evaluate(JS.reopenCard(click.buildingId), { timeoutMs: 120000 }));
        click = { ...click, ...again };
      }
      const perf = JSON.parse(await page.evaluate(JS.perf));
      // 同じ名前が同じ画面に 2 回出ていないか（§15 二重表示）
      const names = v.buildings.map((x) => x.name);
      const dup = names.filter((n, i) => names.indexOf(n) !== i);
      out.sites.push({ ...s, world: w, zoom, visibleBuildingLabels: v.buildings.length,
        kinds: v.allKinds, duplicateNames: [...new Set(dup)], sample: v.buildings.slice(0, 12),
        click, perf, shot: shotPath });
      console.log('[35O-qa]', s.id.padEnd(14), '建物名ラベル', String(v.buildings.length).padStart(3),
        '| zoom', zoom.map((z) => z.buildingLabels).join('→'),
        '| 重複', dup.length, '| クリック', click.clicked || '-', '| card建物名', click.cardName || '-', '| draw', perf.drawCalls);
    }
    out.nameStore = JSON.parse(await page.evaluate(JS.nameStore));
  } finally { try { await b.close(); } catch { /* noop */ } }

  const sites = out.sites;
  out.summary = {
    sitesTotal: sites.length,
    sitesWithBuildingLabels: sites.filter((s) => s.visibleBuildingLabels > 0).length,
    duplicateNameSites: sites.filter((s) => s.duplicateNames.length).length,
    // §9 ズームインで増えること
    zoomIncreasesOk: sites.every((s) => {
      const c = s.zoom.map((z) => z.buildingLabels);
      return c[c.length - 1] >= c[0];
    }),
    // §15 ズームアウト時にラベルだらけにならない
    farNotCrowded: sites.every((s) => s.zoom[0].buildingLabels <= 40),
    clickOk: sites.filter((s) => s.click && s.click.clicked).length,
    cardNameShownOk: sites.filter((s) => s.click && s.click.cardNameShown).length,
    cardFacilityShown: sites.filter((s) => s.click && s.click.cardFacilityShown).length,
    maxDrawCalls: Math.max(...sites.map((s) => s.perf.drawCalls)),
    maxSprites: Math.max(...sites.map((s) => s.perf.sprites)),
    jsErrors: out.errors.length,
    elapsedMs: Date.now() - t0,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { console.log(JSON.stringify(o.summary, null, 2)); console.log('[35O-qa] out', OUT); })
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
