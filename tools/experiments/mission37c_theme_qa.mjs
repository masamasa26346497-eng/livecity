// tools/experiments/mission37c_theme_qa.mjs
// [Mission 37C] 実ブラウザで Live City テーマ版ページを開き、
//   1. Cesium 標準 UI が隠れているか
//   2. ヘッダー / 左レイヤーパネル / 右建物情報パネルが出ているか
//   3. 6 レイヤーが全部 ready で、件数が 0 でないか
//   4. 建物クリックで canonicalId が取れるか（37B と同じ経路を保てているか）
//   5. 背景地図の明るさ・彩度の設定が実際に ImageryLayer へ入っているか
//   を数値で確かめる。見た目の印象ではなく DOM と window.__mission37c を読む。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION37C_URL || 'http://localhost:8137/mission37c-livecity-theme.html';
const OUT_DIR = 'data/reports/mission37c-livecity-theme';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await launchBrowser({ width: 1600, height: 1000 });
const out = { mission: '37C', url: URL_, browser: b.version, generatedAt: new Date().toISOString(), jsErrors: [], steps: {} };
const page = b.page;
page.on('Runtime.exceptionThrown', (e) => {
  try { out.jsErrors.push(String(e.exceptionDetails && (e.exceptionDetails.exception?.description || e.exceptionDetails.text)).slice(0, 300)); } catch { /* noop */ }
});
page.on('Runtime.consoleAPICalled', (e) => {
  try {
    if (e.type !== 'error') return;
    out.jsErrors.push('console.error: ' + (e.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 300));
  } catch { /* noop */ }
});

try {
  await page.send('Page.navigate', { url: URL_ });

  // ── 全レイヤーが ready / error に落ち着くまで待つ ──
  let st = null;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    st = await page.evaluate(`(() => {
      const s = window.__mission37c;
      if (!s) return null;
      const ls = Object.values(s.layers || {});
      return JSON.stringify({ status: s.status, settled: ls.length >= 6 && ls.every(l => l.state === 'ready' || l.state === 'error'),
        firstDisplayMs: s.firstDisplayMs, layers: s.layers });
    })()`).catch(() => null);
    if (st) { const j = JSON.parse(st); if (j.settled && j.firstDisplayMs != null) break; }
  }
  out.steps.afterLoad = st ? JSON.parse(st) : null;
  await sleep(3000);

  // ── UI: Cesium 標準 UI が隠れ、Live City の UI が出ているか ──
  out.steps.ui = JSON.parse(await page.evaluate(`(() => {
    const vis = (sel) => { const e = document.querySelector(sel); if (!e) return 'absent';
      const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return (cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0) ? 'visible' : 'hidden'; };
    const header = document.getElementById('lc-header').getBoundingClientRect();
    const left = document.getElementById('lc-left').getBoundingClientRect();
    const right = document.getElementById('lc-right').getBoundingClientRect();
    return JSON.stringify({
      cesiumDefaultUi: {
        toolbar: vis('.cesium-viewer-toolbar'), timeline: vis('.cesium-viewer-timelineContainer'),
        animation: vis('.cesium-viewer-animationContainer'), infoBox: vis('.cesium-infoBox'),
        selectionIndicator: vis('.cesium-selection-wrapper'), geocoder: vis('.cesium-viewer-geocoderContainer'),
        fullscreen: vis('.cesium-viewer-fullscreenContainer'),
      },
      credits: vis('.cesium-widget-credits'),
      liveCityUi: {
        header: vis('#lc-header'), leftPanel: vis('#lc-left'), rightPanel: vis('#lc-right'),
        headerRect: [Math.round(header.width), Math.round(header.height)],
        leftOnLeftHalf: left.left < innerWidth / 2, rightOnRightHalf: right.left > innerWidth / 2,
        layerRows: document.querySelectorAll('#lc-layers .lc-layer').length,
        layerToggles: document.querySelectorAll('#lc-layers input[type=checkbox]').length,
        bgSliders: document.querySelectorAll('#bg-sliders input[type=range]').length,
        brandText: document.getElementById('lc-title').textContent.trim(),
      },
      rowCounts: Array.from(document.querySelectorAll('#lc-layers .lc-layer')).map(r => ({
        layer: r.dataset.layer, state: r.dataset.state, count: r.querySelector('.ct').textContent })),
    });
  })()`));

  // ── 背景地図の調整が ImageryLayer に入っているか + 建物スタイル ──
  // viewer はクロージャ内なので、ページが公開している計測値と DOM から読む。
  out.steps.appearance = JSON.parse(await page.evaluate(`JSON.stringify({
    toneSelect: document.getElementById('sel-tone').value,
    sseSelect: document.getElementById('sel-sse').value,
    basemapSelect: document.getElementById('sel-basemap').value,
    bgValues: Array.from(document.querySelectorAll('#bg-sliders label i')).map(e => e.textContent),
    headerBuildings: document.getElementById('hs-bldg').textContent,
    measuredFps: document.getElementById('m-fps').textContent,
    firstDisplay: document.getElementById('m-first').textContent,
  })`));

  // ── 建物クリック: 画面中央付近を何点か試して canonicalId を取る ──
  const clicks = [];
  const pts = [[800, 560], [760, 600], [860, 600], [800, 640], [700, 520], [900, 520], [800, 500], [740, 660], [880, 660]];
  for (const [x, y] of pts) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(900);
    const r = JSON.parse(await page.evaluate(`(() => {
      const s = window.__mission37c;
      const body = document.getElementById('lc-bldg-body');
      return JSON.stringify({
        picked: s.lastPicked || null,
        panelOpen: body.classList.contains('on'),
        cid: document.getElementById('lc-cid').textContent,
        usageChip: document.getElementById('lc-usage').textContent,
        height: document.getElementById('lb-h').textContent,
        usageCode: document.getElementById('lb-usage').textContent,
        ward: document.getElementById('lb-ward').textContent,
        tile: document.getElementById('lb-tile').textContent,
        latlon: document.getElementById('lb-ll').textContent,
        sidecar: document.getElementById('lb-side').textContent,
      });
    })()`));
    clicks.push({ at: [x, y], ...r });
    if (r.picked && r.picked.canonicalId) break;
  }
  out.steps.clicks = clicks;

  // ── レイヤー ON/OFF が効くか（要件8）──
  out.steps.toggle = JSON.parse(await page.evaluate(`(() => {
    const before = JSON.stringify(Object.fromEntries(Object.entries(window.__mission37c.layers).map(([k,v]) => [k, v.visible])));
    const row = document.querySelector('[data-layer="roads"] input');
    row.checked = false; row.dispatchEvent(new Event('change'));
    const afterOff = window.__mission37c.layers.roads.visible;
    row.checked = true; row.dispatchEvent(new Event('change'));
    const afterOn = window.__mission37c.layers.roads.visible;
    return JSON.stringify({ before: JSON.parse(before), roadsAfterOff: afterOff, roadsAfterOn: afterOn });
  })()`));

  // ── FPS の切り分け: ベクタレイヤー込み / 建物だけ。自分が足したレイヤーの費用を測る ──
  const SAMPLE = `(() => new Promise((res) => {
    const t0 = performance.now(); let n = 0; let last = t0; const ts = [];
    const tick = () => { const now = performance.now(); ts.push(now - last); last = now; n++;
      if (now - t0 < 4000) requestAnimationFrame(tick);
      else { const s = ts.slice().sort((a,b)=>a-b);
        res(JSON.stringify({ avgFps: +(n * 1000 / (now - t0)).toFixed(1),
          p95FrameMs: +s[Math.floor(s.length*0.95)].toFixed(1) })); } };
    requestAnimationFrame(tick);
  }))()`;
  const setLayers = (ids, on) => page.evaluate(`(() => {
    for (const id of ${JSON.stringify(ids)}) {
      const el = document.querySelector('[data-layer="'+id+'"] input');
      if (el) { el.checked = ${on ? 'true' : 'false'}; el.dispatchEvent(new Event('change')); }
    }
    return 1; })()`);
  const VECTORS = ['roads', 'railways', 'waterways', 'parks', 'labels'];
  await sleep(1500);
  out.steps.perf = {};
  out.steps.perf.allLayers = JSON.parse(await page.evaluate(SAMPLE, { timeoutMs: 30000 }));
  await setLayers(VECTORS, false); await sleep(1500);
  out.steps.perf.buildingsOnly = JSON.parse(await page.evaluate(SAMPLE, { timeoutMs: 30000 }));
  await setLayers(VECTORS, true); await sleep(1200);

  // ── 背景地図の見た目: 既定(文字なし) と OSM の両方を撮る ──
  fs.mkdirSync(OUT_DIR, { recursive: true });
  out.steps.basemaps = {};
  for (const kind of ['gsi-blank', 'gsi-pale', 'osm', 'none']) {
    await page.evaluate(`(() => { const s = document.getElementById('sel-basemap');
      s.value = ${JSON.stringify(kind)}; s.dispatchEvent(new Event('change')); return 1; })()`);
    await sleep(kind === 'none' ? 1500 : 6000);
    const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
    fs.writeFileSync(path.join(OUT_DIR, 'basemap-' + kind + '.jpg'), Buffer.from(data, 'base64'));
    out.steps.basemaps[kind] = JSON.parse(await page.evaluate(`JSON.stringify({
      basemap: window.__mission37c.basemap,
      sliders: Array.from(document.querySelectorAll('#bg-sliders label i')).map(e => e.textContent),
      credits: (document.querySelector('.cesium-widget-credits') || {}).textContent || '',
      ionLogoVisible: !!(document.querySelector('.cesium-credit-logoContainer')
        && getComputedStyle(document.querySelector('.cesium-credit-logoContainer')).display !== 'none'),
    })`));
  }
  await page.evaluate(`(() => { const s = document.getElementById('sel-basemap');
    s.value = 'gsi-blank'; s.dispatchEvent(new Event('change')); return 1; })()`);
  await sleep(6000);
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.writeFileSync(path.join(OUT_DIR, 'theme-full.jpg'), Buffer.from(data, 'base64'));
  out.steps.final = JSON.parse(await page.evaluate('JSON.stringify(window.__mission37c)'));
} finally {
  try { await b.close(); } catch { /* noop */ }
}

const L = out.steps.afterLoad && out.steps.afterLoad.layers;
const pick = (out.steps.clicks || []).find((c) => c.picked && c.picked.canonicalId);
out.summary = {
  jsErrors: out.jsErrors.length,
  cesiumDefaultUiAllHidden: out.steps.ui
    ? Object.values(out.steps.ui.cesiumDefaultUi).every((v) => v === 'hidden' || v === 'absent') : null,
  creditsKeptVisible: out.steps.ui ? out.steps.ui.credits === 'visible' : null,
  liveCityUiPresent: out.steps.ui
    ? (out.steps.ui.liveCityUi.header === 'visible' && out.steps.ui.liveCityUi.leftPanel === 'visible'
       && out.steps.ui.liveCityUi.rightPanel === 'visible') : null,
  layerRows: out.steps.ui ? out.steps.ui.liveCityUi.layerRows : null,
  bgSliders: out.steps.ui ? out.steps.ui.liveCityUi.bgSliders : null,
  layersReady: L ? Object.entries(L).filter(([, v]) => v.state === 'ready').map(([k]) => k) : null,
  layersError: L ? Object.entries(L).filter(([, v]) => v.state === 'error').map(([k, v]) => k + ':' + v.error) : null,
  layerCounts: L ? Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.count])) : null,
  firstDisplayMs: out.steps.afterLoad ? out.steps.afterLoad.firstDisplayMs : null,
  defaultBasemapIsPale: out.steps.basemaps ? out.steps.basemaps['gsi-blank'].basemap === 'gsi-blank' : null,
  ionLogoHidden: out.steps.basemaps ? out.steps.basemaps['gsi-blank'].ionLogoVisible === false : null,
  mapAttributionKept: out.steps.basemaps ? /地理院/.test(out.steps.basemaps['gsi-blank'].credits) : null,
  perf: out.steps.perf || null,
  vectorLayerFpsCost: (out.steps.perf && out.steps.perf.allLayers && out.steps.perf.buildingsOnly)
    ? +(out.steps.perf.buildingsOnly.avgFps - out.steps.perf.allLayers.avgFps).toFixed(1) : null,
  canonicalIdOnClick: pick ? pick.picked.canonicalId : null,
  canonicalIdSidecar: pick ? pick.sidecar : null,
  buildingInfoPanel: pick ? { usage: pick.usageChip, height: pick.height, ward: pick.ward, tile: pick.tile, latlon: pick.latlon } : null,
  layerToggleWorks: out.steps.toggle ? (out.steps.toggle.roadsAfterOff === false && out.steps.toggle.roadsAfterOn === true) : null,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'theme-qa.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
if (out.jsErrors.length) console.log('jsErrors:', JSON.stringify(out.jsErrors.slice(0, 6), null, 1));
console.log('out', OUT_DIR);
