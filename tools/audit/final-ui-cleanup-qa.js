#!/usr/bin/env node
// tools/audit/final-ui-cleanup-qa.js
// [Mission 32R §4/§10/§14/§16] 実ブラウザ（Edge headless・実 GPU）での確認。
//   - 6 地点で建物をクリックし、property card が全文見えるか（card 内の点が開発用パネルに隠れていないかを elementFromPoint で確認）
//   - その card の最寄駅が、canonical 駅データ + 建物重心の world 距離で求めた期待値と一致するか
//   - 検索: 範囲内の地点で誤った「範囲外」表示が出ない / 範囲外の地点では新しい文言になる
//   - 回帰: hover / click / 区切替 / City Mode / Map Audit / Reference Alignment / 開発用 status / V1・V2 ボタン / residual 0
//   前提: `npm run preview`（http://localhost:8000）。出力: data/reports/final-ui-cleanup-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { readFileRetry } from '../lib/synced-dir-writer.js';
import { PROBE } from './legacy-residual-probe.js';
import { CARD_SITES } from './pre-production-cleanup-qa.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const OUT = P('data', 'reports', 'final-ui-cleanup-qa.json');
const SHOTS = P('data', 'reports', 'final-ui-cleanup-qa');
const BUILDINGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2');
const STATIONS = P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'stations.json');
const rj = (p) => JSON.parse(readFileRetry(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 地点ごとの妥当な駅（§10。名称は実データに従い、距離的に妥当かを見る）
export const STATION_EXPECT = {
  umeda: /^(大阪|大阪梅田|梅田|東梅田|西梅田|北新地)$/,
  honmachi: /本町/,
  namba: /なんば|難波/,
  tennoji: /天王寺|阿部野橋|あべの|天王寺駅前/,
};

function centroid(fp) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) { const k = fp[j][0] * fp[i][1] - fp[i][0] * fp[j][1]; a += k; cx += (fp[j][0] + fp[i][0]) * k; cz += (fp[j][1] + fp[i][1]) * k; }
  if (Math.abs(a) < 1e-9) return [fp.reduce((s, q) => s + q[0], 0) / fp.length, fp.reduce((s, q) => s + q[1], 0) / fp.length];
  return [cx / (3 * a), cz / (3 * a)];
}
/** 各地点の対象建物（地点中心に最も近い 400〜4000m² の PLATEAU 建物）と、独立に計算した最寄駅 */
function targets() {
  const stations = rj(STATIONS).stations;
  const out = [];
  for (const s of CARD_SITES) {
    let best = null;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const f = path.join(BUILDINGS, `tile_${Math.floor(s.x / 500) + dx}_${Math.floor(s.z / 500) + dz}.json`);
      if (!fs.existsSync(f)) continue;
      const t = rj(f); const a = rj(path.join(BUILDINGS, 'attributes', path.basename(f))).attributes;
      for (const ft of t.features) {
        const at = a[ft.canonicalId];
        const d = Math.hypot(ft.centroid[0] - s.x, ft.centroid[1] - s.z);
        if (at.source !== 'plateau-building' || ft.areaM2 < 400 || ft.areaM2 > 4000 || d > 250) continue;
        if (!best || d < best.d) best = { d, id: ft.canonicalId, ring: ft.coordinates[0], c: ft.centroid, wardId: at.wardId };
      }
    }
    const c = centroid(best.ring);
    // 駅データの北端（OSM 抽出の範囲 = osm-source-coverage.json の latCliff 34.74°）。範囲外の駅の方が近い可能性がある建物は判定保留が正解
    const cov = JSON.parse(readFileRetry(P('data', 'reports', 'osm-source-coverage.json'))).latCliff.cliffLat;
    const limitZ = -((cov - 34.604208) * 111320);
    const ranked = stations.map((st) => ({ name: st.name, stationId: st.stationId, d: Math.hypot(st.point[0] - c[0], st.point[1] - c[1]) })).sort((p, q) => p.d - q.d);
    const outsideCoverage = (c[1] - limitZ) < 0 || ranked[0].d > (c[1] - limitZ);
    out.push({ site: s.id, siteName: s.name, id: best.id, c: best.c, wardId: best.wardId, expectedStation: ranked[0], expectedOutsideCoverage: outsideCoverage, coverageNorthLimitLat: cov, nextStations: ranked.slice(1, 4).map((r) => ({ name: r.name, d: Math.round(r.d) })) });
  }
  return out;
}

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, ph) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  status: `(() => { const el = document.getElementById('canonical-runtime-status'); return el ? el.innerText.split(String.fromCharCode(10)) : null; })()`,
  // card の可視性: card の矩形内の格子点が card 自身に当たるか（他要素＝開発用パネル等に覆われていないか）
  cardVisibility: `(() => {
    const card = document.getElementById('prop-card');
    const panel = document.getElementById('canonical-runtime-status');
    const r = card.getBoundingClientRect();
    const pr = panel ? panel.getBoundingClientRect() : null;
    const pts = []; let hidden = 0, total = 0; const coveredBy = {};
    for (let fx = 0.06; fx < 1; fx += 0.22) for (let fy = 0.02; fy < 1; fy += 0.06) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      if (y > innerHeight - 1 || x > innerWidth - 1) continue;
      total++;
      const el = document.elementFromPoint(x, y);
      if (!el || !el.closest('#prop-card')) { hidden++; const k = el ? (el.closest('[id]') ? el.closest('[id]').id : el.tagName) : 'none'; coveredBy[k] = (coveredBy[k] || 0) + 1; }
    }
    const station = document.getElementById('pc-station'); const sr = station.getBoundingClientRect();
    const stEl = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);
    return {
      cardRect: [r.left, r.top, r.width, r.height].map(Math.round), viewport: [innerWidth, innerHeight],
      panelRect: pr ? [pr.left, pr.top, pr.width, pr.height].map(Math.round) : null,
      panelOverlapsCard: pr ? !(pr.right <= r.left || pr.left >= r.right || pr.bottom <= r.top || pr.top >= r.bottom) : false,
      panelVisible: !!panel && getComputedStyle(panel).display !== 'none',
      cardFullyInViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      cardScrollable: card.scrollHeight > card.clientHeight + 1,
      samplePoints: total, hiddenPoints: hidden, coveredBy,
      stationRowVisible: !!stEl && !!stEl.closest('#prop-card'),
      // 最下部までスクロールしたとき最後の行（注記）が card 内で見えるか（スクロール位置は戻す）
      lastRowReachable: (() => {
        const last = card.querySelector('.pc-body') ? card.querySelector('.pc-body').lastElementChild : null;
        if (!last) return null;
        const prev = card.scrollTop; card.scrollTop = card.scrollHeight;
        const lr = last.getBoundingClientRect();
        const el = document.elementFromPoint(lr.left + Math.min(20, lr.width / 2), Math.min(lr.top + 5, innerHeight - 2));
        const ok = lr.top < innerHeight && lr.top >= r.top && !!el && !!el.closest('#prop-card');
        card.scrollTop = prev; return ok;
      })(),
      bodyClassOpen: document.body.classList.contains('lc-prop-card-open'),
    };
  })()`,
  card: `(() => {
    const t = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : null; };
    const pick = window.__LAST_BUILDING_PICK__;
    return { pick: pick ? pick.id : null, cardDisplay: document.getElementById('prop-card').style.display, title: t('pc-title'), id: t('pc-id'), station: t('pc-station'), usage: t('pc-usage-full'), nearest: window.__NEAREST_STATION_DEBUG__() };
  })()`,
};
async function settle(page, min = 2500, max = 60000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return Date.now() - t0; await sleep(700); }
  return -1;
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 78 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/final-ui-cleanup-qa/' + name + '.jpg';
}
async function clickAt(page, x, y) {
  await page.evaluate(`(() => { window.__LAST_BUILDING_PICK__ = null; if (typeof closePropCard === 'function' && document.getElementById('prop-card').style.display === 'block') closePropCard(); return 1; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(300);
  const hover = await page.evaluate(`(() => tip.style.display)()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(900);
  // tooltip はマウス位置に出るので、card の見え方の判定前にマウスを card から離す
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 600 });
  await sleep(200);
  return hover;
}
const residualOf = async (page) => { const r = await page.evaluate(PROBE); return { residual: r.selfCheck.total, visibleLegacyObjects: r.visibleLegacyObjects }; };

async function cardAt(page, t, tag) {
  const vp = await page.evaluate(`[innerWidth, innerHeight]`);
  await page.evaluate(JS.ward(t.c[0], t.c[1])); await sleep(1200);
  await page.evaluate(JS.camera(t.c[0], t.c[1], 280, 0.05)); await settle(page);
  const hover = await clickAt(page, Math.round(vp[0] / 2), Math.round(vp[1] / 2));
  const card = await page.evaluate(JS.card);
  const vis = await page.evaluate(JS.cardVisibility);
  const q = card.nearest.lastQuery || {};
  const expected = t.expectedStation;
  const plausible = t.expectedOutsideCoverage
    ? (q.outsideCoverage === true && /駅データ未整備/.test(card.station || ''))
    : (STATION_EXPECT[t.site] ? STATION_EXPECT[t.site].test(q.station || '') : (q.distanceM != null && q.distanceM < 1500)) && q.outsideCoverage === false;
  return {
    site: t.site, siteName: t.siteName, viewport: vp, target: t.id, hover, ...card, visibility: vis,
    pickedExpected: card.pick === t.id,
    stationMatchesIndependentCalc: q.station === expected.name && Math.abs((q.distanceM ?? -1) - expected.d) <= 1 && q.outsideCoverage === t.expectedOutsideCoverage,
    stationPlausible: plausible,
    expectedStation: { name: expected.name, distanceM: Math.round(expected.d) }, nextStations: t.nextStations,
    walkingTimeShown: /徒歩/.test(card.station || ''),
    shot: await shot(page, `card-${t.site}${tag}`),
  };
}

async function main() {
  const T = targets();
  console.log('[ui-qa] targets', JSON.stringify(T.map((t) => [t.site, t.expectedStation.name, Math.round(t.expectedStation.d)])));
  const report = { version: 1, generatedAt: new Date().toISOString(), missionId: '32R', url: URL_, targets: T };
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)));
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(40000);
    report.startup = { status: await page.evaluate(JS.status), nearest: await page.evaluate(`window.__NEAREST_STATION_DEBUG__()`), ...(await residualOf(page)), bodyClassOpen: await page.evaluate(`document.body.classList.contains('lc-prop-card-open')`) };
    console.log('[ui-qa] startup', JSON.stringify(report.startup).slice(0, 300));

    // ── §4/§10 6 地点（1600×1000） ──
    report.cards = [];
    for (const t of T) {
      const r = await cardAt(page, t, '');
      report.cards.push(r);
      console.log('[ui-qa] card', t.site, JSON.stringify({ title: r.title, station: r.station, pick: r.pickedExpected, hidden: r.visibility.hiddenPoints, overlap: r.visibility.panelOverlapsCard, stationOk: r.stationMatchesIndependentCalc, plausible: r.stationPlausible }));
    }
    // card を閉じるとパネルが元の位置へ戻る
    await page.evaluate(`closePropCard()`); await sleep(500);
    report.afterClose = await page.evaluate(`(() => { const p = document.getElementById('canonical-runtime-status').getBoundingClientRect(); return { bodyClassOpen: document.body.classList.contains('lc-prop-card-open'), panelRight: Math.round(innerWidth - p.right) }; })()`);

    // ── 狭めの画面（1280×720）と 狭い画面（700×900・card が下端シート） ──
    report.viewports = [];
    for (const [w, h] of [[1280, 720], [700, 900]]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(800);
      const r = await cardAt(page, T[0], `-${w}x${h}`);
      report.viewports.push({ viewport: [w, h], cardFullyInViewport: r.visibility.cardFullyInViewport, lastRowReachable: r.visibility.lastRowReachable, hiddenPoints: r.visibility.hiddenPoints, samplePoints: r.visibility.samplePoints, coveredBy: r.visibility.coveredBy, panelOverlapsCard: r.visibility.panelOverlapsCard, stationRowVisible: r.visibility.stationRowVisible, cardScrollable: r.visibility.cardScrollable, title: r.title, station: r.station, shot: r.shot });
      await page.evaluate(`closePropCard()`);
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(800);

    // ── §11/§12 検索 ──
    report.search = {};
    for (const q of ['梅田', '難波', '天王寺', '本町']) {
      const r = await page.evaluate(`(async () => {
        if (typeof searchMsg !== 'undefined') { searchMsg.textContent = ''; searchMsg.style.display = 'none'; }
        searchInput.value = ${JSON.stringify(q)}; doSearch();
        await new Promise((z) => setTimeout(z, 1600));
        const spot = findSpot(${JSON.stringify(q)}); const g = geoToThree(spot.lat, spot.lon);
        return { msgShown: searchMsg.style.display === 'block', msg: searchMsg.textContent, cameraToSpotM: Math.round(Math.hypot(cs.tgt.x - g.x, cs.tgt.z - g.z)), inside: isInside3dDataArea(g.x, g.z) };
      })()`);
      report.search[q] = r;
    }
    report.search.outOfRange = await page.evaluate(`(async () => {
      // QA のためだけに、大阪市外（神戸市中央区付近）の検索候補を一時的に足す（ページのコードは変更しない）
      OSAKA_SPOTS.push({ name: 'QA範囲外テスト地点', lat: 34.6901, lon: 135.1955 });
      searchInput.value = 'QA範囲外テスト地点'; doSearch();
      await new Promise((z) => setTimeout(z, 300));
      const out = { msgShown: searchMsg.style.display === 'block', msg: searchMsg.textContent };
      OSAKA_SPOTS.pop();
      return out;
    })()`);
    report.shots = { search: await shot(page, 'search-out-of-range-message') };
    console.log('[ui-qa] search', JSON.stringify(report.search));

    // ── §14 回帰 ──
    const reg = {};
    for (const v of ['V1', 'V2', 'V2N']) {
      await page.evaluate(`document.getElementById('buildings-version-${v}').click()`); await settle(page);
      reg['button-' + v] = { version: (await page.evaluate(`window.__BUILDINGS_VERSION_DEBUG__()`)).version, ...(await residualOf(page)) };
    }
    await page.evaluate(JS.ward(-2668.18, -10941.87)); await sleep(1200);
    await page.evaluate(JS.camera(-2668.18, -10941.87, 650, 0.85)); await settle(page);
    reg.ward = { ward: await page.evaluate(`WardModeManager.currentWardId`), ...(await residualOf(page)) };
    reg.mapAudit = await page.evaluate(`(async () => { await window.__SET_MAP_AUDIT_MODE__(true, 'umeda'); await new Promise((q) => setTimeout(q, 2500)); const on = window.__MAP_AUDIT_DEBUG__(); await window.__SET_MAP_AUDIT_MODE__(false); await new Promise((q) => setTimeout(q, 1200)); const off = window.__MAP_AUDIT_DEBUG__(); return { on: on && (on.enabled ?? on.active), off: off && (off.enabled ?? off.active) }; })()`);
    reg.refAlign = await page.evaluate(`(async () => { await window.__SET_REFERENCE_ALIGNMENT__(true, 'umeda'); await new Promise((q) => setTimeout(q, 3000)); const on = window.__REFERENCE_ALIGNMENT_DEBUG__(); await window.__SET_REFERENCE_ALIGNMENT__(false); await new Promise((q) => setTimeout(q, 2000)); const off = window.__REFERENCE_ALIGNMENT_DEBUG__(); return { on: on && (on.active ?? on.enabled), off: off && (off.active ?? off.enabled) }; })()`);
    reg.afterQaModes = await residualOf(page);
    await page.evaluate(`(() => { CityModeManager.enter(); return 1; })()`); await sleep(3000); await settle(page, 2000, 60000);
    reg.cityMode = { active: await page.evaluate(`CityModeManager.isActive()`), ...(await residualOf(page)) };
    reg.finalStatus = await page.evaluate(JS.status);
    reg.devPanelVisible = await page.evaluate(`getComputedStyle(document.getElementById('canonical-runtime-status')).display !== 'none'`);
    report.regression = reg;
    report.consoleErrors = errors.slice(0, 30);
  } finally {
    await b.close();
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  main().then((r) => {
    console.log('[ui-qa] viewports', JSON.stringify(r.viewports.map((v) => [v.viewport, v.hiddenPoints, v.samplePoints, v.coveredBy, v.stationRowVisible])));
    console.log('[ui-qa] afterClose', JSON.stringify(r.afterClose));
    console.log('[ui-qa] regression', JSON.stringify(r.regression).slice(0, 900));
    console.log('[ui-qa] errors', JSON.stringify(r.consoleErrors));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
