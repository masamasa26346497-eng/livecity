// tools/experiments/mission35w_browser_qa.mjs
// [Mission 35W §9/§10/§12] 地面を 35V 前へ戻し、道路をリアル化した結果を実機で確かめる。
//   MISSION35W_PHASE=before|after で before/after を撮り分け、同じ地点・同じカメラで比較する。
//   draw call / mesh / triangle / FPS も同じ場所で測る（§4 の前後比較用）。
//   前提: dev を http://localhost:8080 で配信していること。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION35W_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const PHASE = process.env.MISSION35W_PHASE || 'after';
const OUT_DIR = 'data/reports/mission35w-real-roads-original-ground';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** §9 の地点。lat/lon は dev の OSAKA_SPOTS / HYBRID_SAMPLE_SPOTS と同じ値。 */
export const SPOTS = [
  { id: 'umeda', name: '梅田', lat: 34.7025, lon: 135.4959, r: 1500, phDeg: 38 },
  { id: 'nakatsu', name: '中津', lat: 34.7106, lon: 135.4962, r: 900, phDeg: 30 },
  { id: 'juso', name: '十三', lat: 34.7203, lon: 135.4830, r: 1100, phDeg: 35 },
  { id: 'honmachi', name: '本町', lat: 34.6823, lon: 135.5024, r: 900, phDeg: 40 },
  { id: 'namba', name: '難波', lat: 34.6627, lon: 135.5013, r: 900, phDeg: 40 },
  { id: 'tennoji', name: '天王寺', lat: 34.6457, lon: 135.5135, r: 1000, phDeg: 38 },
  { id: 'niitaka', name: '新高(35S 実験地点)', lat: 34.7280, lon: 135.4703, r: 700, phDeg: 40 },
  // §10 の寄り画。交差点 / 主要道路 / 高架をそれぞれ見る
  { id: 'intersection-close', name: '本町交差点(近景)', lat: 34.6823, lon: 135.5024, r: 260, phDeg: 46 },
  { id: 'major-road', name: '御堂筋(中景)', lat: 34.6905, lon: 135.5006, r: 520, phDeg: 34 },
  { id: 'elevated-road', name: '阪神高速(高架)', lat: 34.6960, lon: 135.4990, r: 430, phDeg: 20 },
];

const goTo = (lat, lon, r, phDeg) => `(() => {
  if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
  const p = geoToThree(${lat}, ${lon});
  cs.tgt.x = p.x; cs.tgt.z = p.z; cs.tgt.y = 0;
  cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0.6; camUpd();
  return 1;
})()`;

/** §1 配色を設定値から読む。 */
const THEME_STATE = `(() => {
  const bg = new THREE.Color(); renderer.getClearColor(bg);
  const landG = scene.getObjectByName('LandSurfaceLayer');
  const landM = landG && landG.children[0] && landG.children[0].material;
  return JSON.stringify({
    theme: (typeof CITY_THEME !== 'undefined') ? CITY_THEME.name : null,
    clearColor: '#' + bg.getHexString(),
    fog: scene.fog ? '#' + scene.fog.color.getHexString() : null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    land: landM && landM.color ? '#' + landM.color.getHexString() : null,
  });
})()`;

/** §4 draw call / mesh / triangle / memory。render 直後に読む。 */
const PERF = `(() => {
  renderer.info.reset();
  renderer.render(scene, camera);
  const r = renderer.info.render, m = renderer.info.memory;
  let meshes = 0, lines = 0, sprites = 0, visibleMeshes = 0;
  scene.traverse((o) => {
    if (o.isMesh) { meshes++; if (o.visible) visibleMeshes++; }
    else if (o.isLine || o.isLineSegments) lines++;
    else if (o.isSprite) sprites++;
  });
  return JSON.stringify({ drawCalls: r.calls, triangles: r.triangles,
    geometries: m.geometries, textures: m.textures,
    meshes, lines, sprites, visibleMeshes });
})()`;

/** FPS を 2 秒ぶん測る。 */
const FPS = `new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
    else res(JSON.stringify({ fps: +(n / ((performance.now() - t0) / 1000)).toFixed(1), frames: n })); };
  requestAnimationFrame(tick);
})`;

/** §2 道路の見え方。描かれている road / lane mesh を数える。 */
const ROAD_STATE = `(() => {
  const byName = {};
  const colors = new Map();
  scene.traverse((o) => {
    if (!o.visible) return;
    const n = o.name || '';
    if (!/road|lane|Road|Lane|crosswalk|Crosswalk/i.test(n)) return;
    byName[n.replace(/_-?\\d+_-?\\d+$/, '_*')] = (byName[n.replace(/_-?\\d+_-?\\d+$/, '_*')] || 0) + 1;
    if (o.material && o.material.color) {
      const h = '#' + o.material.color.getHexString();
      colors.set(h, (colors.get(h) || 0) + 1);
    }
  });
  const rd = (typeof window.__ROAD_DETAIL_DEBUG__ === 'function') ? window.__ROAD_DETAIL_DEBUG__() : null;
  return JSON.stringify({ groups: byName, colors: [...colors.entries()].map(([hex, n]) => ({ hex, n })), roadDetail: rd });
})()`;

/** §8 ラベルが残っているか。 */
const LABEL_STATE = `(() => {
  const s = CityLabelLayer.getDebug ? CityLabelLayer.getDebug() : null;
  if (!s) return JSON.stringify({ error: 'no debug' });
  return JSON.stringify({ band: s.band, visible: s.visible, buildingNames: s.buildingNames,
    visibleBuildings: s.visibleBuildings, visibleStations: s.visibleStations,
    visiblePlaces: s.visiblePlaces, visibleRivers: s.visibleRivers, visibleLandmarks: s.visibleLandmarks,
    names: (s.visibleNames || []).slice(0, 30), dataError: s.dataError });
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
const out = { url: URL_, phase: PHASE, generatedAt: new Date().toISOString(), mission: '35W', spots: [], jsErrors: [] };
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
    await sleep(15000);                       // タイル fetch とラベル再選定を待つ
    await page.evaluate(HIDE_DEV_UI);
    const perf = JSON.parse(await page.evaluate(PERF, { timeoutMs: 60000 }));
    const fps = JSON.parse(await page.evaluate(FPS, { timeoutMs: 60000, awaitPromise: true }));
    const roads = JSON.parse(await page.evaluate(ROAD_STATE, { timeoutMs: 60000 }));
    const labels = JSON.parse(await page.evaluate(LABEL_STATE, { timeoutMs: 60000 }));
    const p = await shot(page, PHASE + '-' + sp.id);
    out.spots.push({ ...sp, perf, fps, roads, labels, shot: p });
    console.log(`[35W-qa:${PHASE}] ${sp.id.padEnd(18)} calls=${String(perf.drawCalls).padStart(4)}`
      + ` tri=${String(perf.triangles).padStart(8)} mesh=${String(perf.meshes).padStart(4)}`
      + ` fps=${String(fps.fps).padStart(5)} bldgLbl=${labels.visibleBuildings}`);
  }
} finally { try { await b.close(); } catch { /* noop */ } }

const avg = (f) => +(out.spots.reduce((s, x) => s + f(x), 0) / out.spots.length).toFixed(1);
out.summary = {
  phase: PHASE,
  theme: out.theme,
  drawCallsAvg: avg((s) => s.perf.drawCalls),
  trianglesAvg: Math.round(avg((s) => s.perf.triangles)),
  meshesAvg: avg((s) => s.perf.meshes),
  geometriesAvg: avg((s) => s.perf.geometries),
  fpsAvg: avg((s) => s.fps.fps),
  perSpot: out.spots.map((s) => ({ id: s.id, drawCalls: s.perf.drawCalls, triangles: s.perf.triangles,
    meshes: s.perf.meshes, geometries: s.perf.geometries, fps: s.fps.fps })),
  buildingLabelSpots: out.spots.map((s) => ({ id: s.id, visible: s.labels.visibleBuildings || 0 })),
  buildingLabelsEverywhere: out.spots.every((s) => (s.labels.visibleBuildings || 0) > 0),
  stationLabelsSomewhere: out.spots.some((s) => (s.labels.visibleStations || 0) > 0),
  riverLabelsSomewhere: out.spots.some((s) => (s.labels.visibleRivers || 0) > 0),
  labelDataErrors: out.spots.map((s) => s.labels.dataError).filter(Boolean),
  jsErrors: out.jsErrors.length,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `perf-${PHASE}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log('[35W-qa] out', OUT_DIR, PHASE);
