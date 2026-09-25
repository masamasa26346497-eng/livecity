// tools/experiments/mission35v_browser_qa.mjs
// [Mission 35V §9/§10] ネイビー地面・グレー道路・建物名ラベルを実機で確かめる。
//   地点ごとに「地面の色」「道路の色」「ラベルの内訳」を実際のピクセルと scene から測る。
//   前提: dev を http://localhost:8080 で配信していること。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION35V_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const OUT_DIR = 'data/reports/mission35v-dark-ground-road-visual';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** §9 の地点。lat/lon は dev の OSAKA_SPOTS / HYBRID_SAMPLE_SPOTS と同じ値。 */
export const SPOTS = [
  { id: '1-umeda-wide', name: '梅田', lat: 34.7025, lon: 135.4959, r: 1500, phDeg: 38 },
  { id: '2-nakatsu-river-road', name: '中津', lat: 34.7106, lon: 135.4962, r: 900, phDeg: 30 },
  { id: '3-honmachi', name: '本町', lat: 34.6823, lon: 135.5024, r: 900, phDeg: 40 },
  { id: '4-namba', name: '難波', lat: 34.6627, lon: 135.5013, r: 900, phDeg: 40 },
  { id: '5-building-labels', name: '梅田(近景)', lat: 34.7025, lon: 135.4959, r: 420, phDeg: 34 },
  { id: '6-juso', name: '十三', lat: 34.7203, lon: 135.4830, r: 1100, phDeg: 35 },
  { id: '7-tennoji', name: '天王寺', lat: 34.6457, lon: 135.5135, r: 1000, phDeg: 38 },
  { id: '8-niitaka-35s', name: '新高(35S 実験地点)', lat: 34.7280, lon: 135.4703, r: 700, phDeg: 40 },
];

/** 指定の緯度経度へカメラを置く（dev の geoToThree をそのまま使う＝座標規約に触らない）。 */
const goTo = (lat, lon, r, phDeg) => `(() => {
  if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
  const p = geoToThree(${lat}, ${lon});
  cs.tgt.x = p.x; cs.tgt.z = p.z; cs.tgt.y = 0;
  cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0.6; camUpd();
  return JSON.stringify({ x: p.x, z: p.z });
})()`;

/** §9-1/2/3/4/7 配色を「設定値」として読む。 */
const THEME_STATE = `(() => {
  const hx = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');
  const bg = new THREE.Color(); renderer.getClearColor(bg);
  // 道路の style は module 内に閉じているので、実際に scene にある road mesh の
  //   material 色を数えて「何色で描かれているか」を外から測る。
  const roadCols = new Map();
  scene.traverse((o) => {
    if (!o.isMesh || !o.material || !o.material.color) return;
    if (!/road/i.test(o.name || '')) return;
    const h = '#' + o.material.color.getHexString();
    roadCols.set(h, (roadCols.get(h) || 0) + 1);
  });
  const rs = [...roadCols.entries()].map(([hex, n]) => ({ hex, meshes: n }));
  return JSON.stringify({
    theme: (typeof CITY_THEME !== 'undefined') ? CITY_THEME.name : null,
    clearColor: '#' + bg.getHexString(),
    sceneBackground: scene.background && scene.background.isColor ? '#' + scene.background.getHexString() : null,
    fog: scene.fog ? '#' + scene.fog.color.getHexString() : null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    land: (() => { const g = scene.getObjectByName('LandSurfaceLayer');
      const m = g && g.children[0] && g.children[0].material;
      return m && m.color ? '#' + m.color.getHexString() : null; })(),
    roadStyles: rs,
  });
})()`;

/** §9-5/6 ラベルの内訳を CityLabelLayer の統計から。 */
const LABEL_STATE = `(() => {
  const s = CityLabelLayer.getDebug ? CityLabelLayer.getDebug() : null;
  if (!s) return JSON.stringify({ error: 'no stats' });
  // 画面に出ている sprite を kind 別に数える（stats だけでは建物名が分からないため）
  const g = scene.getObjectByName('CityLabelLayer');
  let shown = 0;
  const names = { building: [], station: [], landmark: [] };
  if (g) for (const o of g.children) if (o.isSprite && o.visible) shown++;
  return JSON.stringify({
    band: s.band, visible: s.visible, buildingNames: s.buildingNames || 0,
    visibleBuildings: s.visibleBuildings || 0, visibleStations: s.visibleStations,
    visibleLandmarks: s.visibleLandmarks, visiblePlaces: s.visiblePlaces,
    spritesShown: shown, sampleNames: (s.names || []).slice(0, 24), dataError: s.dataError,
  });
})()`;

/** §9-1/2 実際のピクセルを読む。地面の色は「道路も建物もない所」を探して測る。 */
const PIXEL_PROBE = `(() => {
  // preserveDrawingBuffer:false なので、表示済みのフレームを後から読むと全部 0 になる。
  //   同じ tick で描き直した直後に読む（これをしないと地面の色を測ったつもりで黒を測る）。
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // 画面下半分（地表がよく写る）から間引いてヒストグラムを取る
  const hist = new Map();
  let n = 0;
  for (let y = 0; y < Math.floor(h * 0.55); y += 4) {
    for (let x = 0; x < w; x += 4) {
      const i = (y * w + x) * 4;
      const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
      hist.set(key, (hist.get(key) || 0) + 1); n++;
    }
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => {
    const r = ((k >> 8) & 15) * 17, g2 = ((k >> 4) & 15) * 17, b = (k & 15) * 17;
    return { hex: '#' + [r, g2, b].map((q) => q.toString(16).padStart(2, '0')).join(''),
      share: +(v / n).toFixed(3), lum: +((0.2126 * r + 0.7152 * g2 + 0.0722 * b) / 255).toFixed(3),
      blueness: +((b - r) / 255).toFixed(3) };
  });
  return JSON.stringify({ sampled: n, top });
})()`;

const HIDE_DEV_UI = `(() => {
  for (const el of document.querySelectorAll('div,button')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|^tip$|^pl$|^pr$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery|mission35s-focus|town-click/.test(id)) el.style.display = 'none'; }
  return 1; })()`;

async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64'));
  return OUT_DIR + '/' + name + '.jpg';
}

const b = await launchBrowser({ width: 1440, height: 900 });
const page = b.page;
const out = { url: URL_, generatedAt: new Date().toISOString(), mission: '35V', spots: [], jsErrors: [] };
// §9-9 JS 例外を拾う
page.on && page.on('Runtime.exceptionThrown', (e) => {
  try { out.jsErrors.push(String(e.exceptionDetails && e.exceptionDetails.text)); } catch { /* noop */ }
});
try {
  await page.send('Runtime.enable').catch(() => {});
  await page.send('Page.navigate', { url: URL_ });
  await sleep(24000);
  await page.evaluate(HIDE_DEV_UI);
  out.theme = JSON.parse(await page.evaluate(THEME_STATE, { timeoutMs: 120000 }));

  for (const sp of SPOTS) {
    await page.evaluate(goTo(sp.lat, sp.lon, sp.r, sp.phDeg));
    await sleep(14000);                        // タイル fetch とラベル再選定を待つ
    await page.evaluate(HIDE_DEV_UI);
    const labels = JSON.parse(await page.evaluate(LABEL_STATE, { timeoutMs: 60000 }));
    const pixels = JSON.parse(await page.evaluate(PIXEL_PROBE, { timeoutMs: 60000 }));
    const p = await shot(page, sp.id);
    out.spots.push({ ...sp, labels, pixels, shot: p });
    console.log(`[35V-qa] ${sp.id.padEnd(22)} band=${labels.band} bldgLabels=${labels.visibleBuildings}`
      + ` stations=${labels.visibleStations} top=${pixels.top[0] && pixels.top[0].hex}`);
  }
} finally { try { await b.close(); } catch { /* noop */ } }

const dark = (h) => { const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), bl = parseInt(h.slice(5, 7), 16);
  return { lum: (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255, blue: (bl - r) / 255 }; };
// 「いちばん多い色 = 地面」は近景では成り立たない（建物の灰色が画面を埋めるため、
//   5-building-labels では #888899 が最多になった）。地面かどうかは色で決める:
//   暗くて青い cluster が画面のうち意味のある割合を占めているか、で見る。
const isNavy = (c) => c.lum < 0.42 && c.blueness > 0.08;
const groundish = out.spots.map((s) => s.pixels.top.find(isNavy) || s.pixels.top[0]).filter(Boolean);
out.summary = {
  theme: out.theme && out.theme.theme,
  clearColor: out.theme && out.theme.clearColor,
  bodyBg: out.theme && out.theme.bodyBg,
  // §9-1 地面がネイビー（暗くて青い）か
  // 各地点で「暗く青い地面」が画面に一定量あること
  groundIsNavy: out.spots.every((s) => s.pixels.top.some((c) => isNavy(c) && c.share >= 0.05)),
  groundNavyShare: out.spots.map((s) => {
    const c = s.pixels.top.find(isNavy);
    return { id: s.id, hex: c ? c.hex : null, share: c ? c.share : 0 };
  }),
  groundSamples: groundish.map((g) => ({ hex: g.hex, lum: g.lum, blueness: g.blueness })),
  // §9-5 建物名ラベルが出ているか
  buildingLabelsLoaded: out.spots.every((s) => (s.labels.buildingNames || 0) > 0),
  buildingLabelsVisibleSomewhere: out.spots.some((s) => (s.labels.visibleBuildings || 0) > 0),
  buildingLabelSpots: out.spots.map((s) => ({ id: s.id, visible: s.labels.visibleBuildings || 0 })),
  // §9-6 駅名も出ているか
  stationLabelsVisibleSomewhere: out.spots.some((s) => (s.labels.visibleStations || 0) > 0),
  // [Mission 35V 道路色の差し戻し] 実際に描かれている road mesh の色。
  //   35V で入れた 0xb7c0cd ではなく、35V 以前の 0x8b929e に戻っていること。
  roadMeshColors: out.theme && out.theme.roadStyles,
  roadColorRevertedTo8b929e: !!(out.theme && (out.theme.roadStyles || []).some((r) => r.hex === '#8b929e')),
  roadGreyB7c0cdGone: !!(out.theme && !(out.theme.roadStyles || []).some((r) => r.hex === '#b7c0cd')),
  labelDataErrors: out.spots.map((s) => s.labels.dataError).filter(Boolean),
  spots: SPOTS.map((s) => s.id),
  jsErrors: out.jsErrors.length,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'browser-qa.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log('[35V-qa] out', OUT_DIR);
