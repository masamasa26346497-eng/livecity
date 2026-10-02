// tools/experiments/mission36a_road_water_qa.mjs
// [Mission 36A] 道路の視認性と「道路 > 水面」の重なり順を実機で測る。
//   MISSION36A_PHASE=before|after で撮り分け、同じ地点・同じカメラで比較する。
//   前提: dev を http://localhost:8080 で配信していること。
//
//   計測の考え方（配色に依存しない差分法）:
//     R_all            … 通常
//     R_noWater        … 水面 layer だけ隠す
//     R_noRoad         … 道路 layer だけ隠す
//     R_noRoadNoWater  … 両方隠す
//   roadPxWithoutWater = (R_noWater ≠ R_noRoadNoWater)  … 水が無ければ見える道路画素
//   roadPxWithWater    = (R_all     ≠ R_noRoad)         … 実際に見えている道路画素
//   occludedByWaterPx  = withoutWater ∧ ¬withWater      … 水面に隠された道路画素
//   roadInkRatio       = withWater / 全画素              … 道路網の「濃さ」
//   roadContrast       = withWater 画素の |ΔRGB| 平均    … 背景に対する道路のコントラスト
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION36A_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const PHASE = process.env.MISSION36A_PHASE || 'after';
const OUT_DIR = 'data/reports/mission36a-road-visibility-water-order';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SPOTS = [
  // §QA1 全域ズームアウト（道路網が読めるか）
  { file: 'citywide', name: '大阪市全域', lat: 34.6800, lon: 135.5050, r: 14000, ph: 62 },
  { file: 'citywide-north', name: '大阪市北部（引き）', lat: 34.7150, lon: 135.4950, r: 7000, ph: 60 },
  // §QA2 淀川を渡る橋
  { file: 'yodogawa-juso', name: '十三大橋（淀川）', lat: 34.7135, lon: 135.4876, r: 1100, ph: 40 },
  { file: 'yodogawa-shinmido', name: '新淀川大橋（新御堂筋）', lat: 34.7140, lon: 135.4995, r: 1100, ph: 40 },
  { file: 'yodogawa-r2', name: '淀川大橋（国道2号）', lat: 34.7055, lon: 135.4715, r: 1100, ph: 40 },
  // §QA3 中之島（河川と道路が密集）
  { file: 'nakanoshima', name: '中之島', lat: 34.6930, lon: 135.4985, r: 900, ph: 42 },
  { file: 'nakanoshima-wide', name: '中之島（引き）', lat: 34.6930, lon: 135.4985, r: 2600, ph: 50 },
  // §QA4 道路が建物を透過していないこと（高層が並ぶ近景）
  { file: 'umeda-close', name: '梅田（近景・建物透過の確認）', lat: 34.7025, lon: 135.4959, r: 420, ph: 30 },
  { file: 'honmachi-close', name: '本町（近景）', lat: 34.6823, lon: 135.5024, r: 380, ph: 34 },
];

const goTo = (lat, lon, r, phDeg) => `(() => {
  if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
  const p = geoToThree(${lat}, ${lon});
  cs.tgt.x = p.x; cs.tgt.z = p.z; cs.tgt.y = 0;
  cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0.6; camUpd();
  return 1; })()`;

const HIDE_DEV_UI = `(() => {
  for (const el of document.querySelectorAll('div,button')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|^pl$|^pr$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery|mission35s-focus|town-click/.test(id)) el.style.display = 'none'; }
  return 1; })()`;

/** 道路 / 水面それぞれの「描画スタック」を読む（y・renderOrder・material 設定）。 */
const STACK = `(() => {
  const isVisible = (o) => { let p = o; while (p) { if (p.visible === false) return false; p = p.parent; } return true; };
  const roadRe = /^(RoadBucket_|RoadV3_|RoadDetail)/;
  const rows = [];
  scene.traverse((o) => {
    if (!o.isMesh || !isVisible(o)) return;
    const n = o.name || '';
    let kind = null;
    if (roadRe.test(n)) kind = 'road';
    else { let p = o.parent; while (p) { if (p.name === 'CR_water') { kind = 'water'; break; } p = p.parent; } }
    if (!kind) return;
    const g = o.geometry, pos = g && g.attributes && g.attributes.position;
    let y = null;
    if (pos && pos.count) { y = 0; const s = Math.max(1, Math.floor(pos.count / 200));
      let c = 0; for (let i = 0; i < pos.count; i += s) { y += pos.getY(i); c++; } y = +(y / c).toFixed(4); }
    const m = o.material;
    rows.push({ kind, name: kind === 'water' ? 'CR_water_mesh' : n.replace(/_[-0-9]+_[-0-9]+$/, ''),
      y, renderOrder: o.renderOrder, transparent: !!m.transparent, depthWrite: !!m.depthWrite,
      depthTest: m.depthTest !== false, opacity: m.opacity, color: '#' + m.color.getHexString() });
  });
  const by = new Map();
  for (const r of rows) {
    const k = r.kind + '|' + r.name + '|' + r.y + '|' + r.renderOrder + '|' + r.color + '|' + r.opacity;
    if (!by.has(k)) by.set(k, Object.assign({}, r, { meshes: 0 }));
    by.get(k).meshes++;
  }
  return JSON.stringify([...by.values()].sort((a, b) => (a.y ?? 0) - (b.y ?? 0)));
})()`;

/** 4 枚レンダリングして画素差で道路の可視/被覆を測る。 */
const PIXELS = `(() => {
  const gl = renderer.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, N = W * H;
  const roadGroups = [], waterGroups = [];
  scene.traverse((o) => {
    if (o.name === 'CR_roads' || o.name === 'RoadVisualV3Overlay' || o.name === 'RoadDetailLayer'
      || o.name === 'RoadLayer' || o.name === 'RoadVisualV2Overlay') roadGroups.push(o);
    if (o.name === 'CR_water' || o.name === 'WaterLayer' || o.name === 'WaterSurfaceLayer'
      || o.name === 'RiverLayerV2' || o.name === 'RiverLayerV2Group') waterGroups.push(o);
  });
  const grab = () => { renderer.render(scene, camera);
    const px = new Uint8Array(N * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
  const set = (arr, v) => { const p = arr.map((o) => o.visible); arr.forEach((o) => { o.visible = v; }); return p; };
  const res = (arr, p) => arr.forEach((o, i) => { o.visible = p[i]; });

  const A = grab();                                   // all
  const pw = set(waterGroups, false);
  const B = grab();                                   // no water
  const pr = set(roadGroups, false);
  const D = grab();                                   // no road, no water
  res(waterGroups, pw);
  const C = grab();                                   // no road (water on)
  res(roadGroups, pr);
  renderer.render(scene, camera);

  const TH = 6;
  const diff = (X, Y, i) => Math.abs(X[i] - Y[i]) + Math.abs(X[i + 1] - Y[i + 1]) + Math.abs(X[i + 2] - Y[i + 2]);
  let withWater = 0, withoutWater = 0, occluded = 0, contrastSum = 0, waterPx = 0;
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    const dW = diff(A, C, i);
    const dN = diff(B, D, i);
    const isW = dW > TH, isN = dN > TH;
    if (isW) { withWater++; contrastSum += dW; }
    if (isN) withoutWater++;
    if (isN && !isW) occluded++;
    if (diff(A, B, i) > TH) waterPx++;
  }
  return JSON.stringify({
    w: W, h: H, totalPx: N,
    roadPxWithWater: withWater, roadPxWithoutWater: withoutWater,
    occludedByWaterPx: occluded,
    occludedRatio: withoutWater ? +(occluded / withoutWater).toFixed(4) : 0,
    roadInkRatio: +(withWater / N).toFixed(5),
    roadContrast: withWater ? +(contrastSum / withWater / 3).toFixed(2) : 0,
    waterAffectedPx: waterPx,
  });
})()`;

/** 道路が建物を貫通していないこと: 建物が写っている画素のうち道路も寄与している割合。 */
const THROUGH_BUILDING = `(() => {
  const gl = renderer.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, N = W * H;
  const roadGroups = [], bGroups = [];
  scene.traverse((o) => {
    if (o.name === 'CR_roads' || o.name === 'RoadVisualV3Overlay' || o.name === 'RoadDetailLayer') roadGroups.push(o);
    // 近景の建物は CR_buildings ではなく CR_buildingLodHigh（34A 高 LOD）が描いている。
    //   ランドマーク HD / 独自 LOD2 も含め、建物を描く group をすべて拾う。
    if (/^CR_building/.test(o.name || '') || o.name === 'LandmarkHDLayer' || o.name === 'LandmarkLayer') bGroups.push(o);
  });
  const grab = () => { renderer.render(scene, camera);
    const px = new Uint8Array(N * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
  const set = (arr, v) => { const p = arr.map((o) => o.visible); arr.forEach((o) => { o.visible = v; }); return p; };
  const res = (arr, p) => arr.forEach((o, i) => { o.visible = p[i]; });
  const A = grab();
  const pb = set(bGroups, false);
  const B = grab();
  res(bGroups, pb);
  const pr = set(roadGroups, false);
  const C = grab();
  res(roadGroups, pr);
  renderer.render(scene, camera);
  const TH = 6;
  const diff = (X, Y, i) => Math.abs(X[i] - Y[i]) + Math.abs(X[i + 1] - Y[i + 1]) + Math.abs(X[i + 2] - Y[i + 2]);
  let buildingPx = 0, roadOverBuildingPx = 0;
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    if (diff(A, B, i) > TH) { buildingPx++; if (diff(A, C, i) > TH) roadOverBuildingPx++; }
  }
  return JSON.stringify({ buildingPx, roadOverBuildingPx,
    ratio: buildingPx ? +(roadOverBuildingPx / buildingPx).toFixed(4) : 0 });
})()`;

const consoleErrors = [];
const bro = await launchBrowser({ width: 1440, height: 900 });
const page = bro.page;
const out = { phase: PHASE, url: URL_, at: new Date().toISOString(), display: null, spots: [], consoleErrors };
try {
  page.on('Runtime.consoleAPICalled', (e) => {
    if (e.type === 'error') consoleErrors.push((e.args || []).map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300));
  });
  page.on('Runtime.exceptionThrown', (e) => {
    const d = e.exceptionDetails || {};
    consoleErrors.push('EXCEPTION ' + String((d.exception && d.exception.description) || d.text || '').slice(0, 300));
  });
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const ok = await page.evaluate("(typeof geoToThree === 'function' && typeof CanonicalRuntime !== 'undefined' && !!window.__CANONICAL_RUNTIME__)",
      { timeoutMs: 30000 }).catch(() => false);
    if (ok === true) break;
  }
  await sleep(6000);
  await page.evaluate(HIDE_DEV_UI);
  out.display = JSON.parse(await page.evaluate('JSON.stringify(window.__SEMANTIC_DISPLAY_DEBUG__())') || 'null');

  const ONLY = process.env.MISSION36A_ONLY || '';
  for (const sp of SPOTS) {
    if (ONLY && sp.file !== ONLY) continue;
    await page.evaluate(goTo(sp.lat, sp.lon, sp.r, sp.ph));
    let prev = -1, stable = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(1800);
      const n = Number(await page.evaluate('(function(){let c=0;scene.traverse(function(o){if(o.isMesh)c++;});return c;})()', { timeoutMs: 60000 }));
      if (n === prev) { if (++stable >= 3) break; } else stable = 0;
      prev = n;
    }
    await page.evaluate(HIDE_DEV_UI);
    const stack = JSON.parse(await page.evaluate(STACK, { timeoutMs: 120000 }) || '[]');
    const pixels = JSON.parse(await page.evaluate(PIXELS, { timeoutMs: 180000 }) || 'null');
    const through = JSON.parse(await page.evaluate(THROUGH_BUILDING, { timeoutMs: 180000 }) || 'null');
    await sleep(600);
    const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, PHASE + '-' + sp.file + '.jpg'), Buffer.from(shot.data, 'base64'));
    out.spots.push(Object.assign({}, sp, { stack, pixels, through }));
    console.log(sp.file.padEnd(20), 'occluded', String(pixels.occludedByWaterPx).padStart(7),
      '(' + (pixels.occludedRatio * 100).toFixed(1) + '%)',
      'roadInk', (pixels.roadInkRatio * 100).toFixed(2) + '%',
      'contrast', pixels.roadContrast,
      'roadOverBldg', (through.ratio * 100).toFixed(2) + '%');
  }
} finally { try { await bro.close(); } catch (e) { /* noop */ } }
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, PHASE + '.json'), JSON.stringify(out, null, 2));
console.log('[36A-qa] phase=' + PHASE + ' out=' + OUT_DIR);
