// tools/experiments/mission36a_bridge_diag.mjs
// [Mission 36A 調査] 橋の所で「道路が水面に隠れている」のか「道路 geometry that が無い」のかを切り分ける。
//   3 枚撮る: 通常 / 水面だけ非表示 / 水面を大きく下げる。さらに水面ポリゴンの上に乗る道路 mesh を数える。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION36A_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const OUT_DIR = 'data/reports/mission36a-road-visibility-water-order/diag';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPOTS = [
  { file: 'juso', lat: 34.7135, lon: 135.4876, r: 1100, ph: 40 },
  { file: 'nakanoshima', lat: 34.6930, lon: 135.4985, r: 900, ph: 42 },
];

const goTo = (lat, lon, r, phDeg) => `(() => {
  if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
  const p = geoToThree(${lat}, ${lon});
  cs.tgt.x = p.x; cs.tgt.z = p.z; cs.tgt.y = 0;
  cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0.6; camUpd();
  return 1; })()`;

const HIDE_UI = `(() => { for (const el of document.querySelectorAll('div,button')) {
  const id = el.id || ''; if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|^pl$|^pr$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery|mission35s-focus|town-click|^panel|^layer/.test(id)) el.style.display = 'none'; }
  const p = document.getElementById('side'); if (p) p.style.display = 'none';
  return 1; })()`;

const setWater = (v) => `(() => { let n = 0;
  scene.traverse((o) => { if (o.name === 'CR_water') { o.visible = ${v}; n++; } });
  renderer.render(scene, camera); return n; })()`;

/**
 * 真上から ray を落として、道路 / 水面 / 地面の y を読む。
 * 川の中心線に沿って等間隔に点を取り、そこに道路 mesh があるかを調べる。
 */
const PROBE = `(() => {
  const isVis = (o) => { let p = o; while (p) { if (p.visible === false) return false; p = p.parent; } return true; };
  const roadRe = /^(RoadBucket_|RoadV3_|RoadDetail)/;
  const roads = [], waters = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (roadRe.test(o.name || '')) { roads.push(o); return; }
    let p = o.parent; while (p) { if (p.name === 'CR_water') { waters.push(o); break; } p = p.parent; }
  });
  const down = new THREE.Vector3(0, -1, 0);
  const rc = new THREE.Raycaster();
  rc.far = 100000;
  // 画面中央付近を格子状にサンプルし、水面が当たる点だけ集める
  const W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight;
  const ndc = new THREE.Vector2();
  const camRc = new THREE.Raycaster();
  const samples = [];
  for (let sy = 0.1; sy <= 0.9; sy += 0.05) {
    for (let sx = 0.05; sx <= 0.78; sx += 0.03) {
      ndc.set(sx * 2 - 1, -(sy * 2 - 1));
      camRc.setFromCamera(ndc, camera);
      const hw = camRc.intersectObjects(waters, false);
      if (!hw.length) continue;
      samples.push([hw[0].point.x, hw[0].point.z, hw[0].point.y]);
    }
  }
  let overWaterRoad = 0, roadYs = [];
  const byName = {};
  for (const [x, z, wy] of samples) {
    rc.set(new THREE.Vector3(x, 500, z), down);
    const hits = rc.intersectObjects(roads, false);
    if (hits.length) {
      overWaterRoad++;
      for (const h of hits) {
        const n = (h.object.name || '').replace(/_[-0-9]+_[-0-9]+$/, '');
        byName[n] = (byName[n] || 0) + 1;
        roadYs.push(+h.point.y.toFixed(3));
      }
    }
  }
  return JSON.stringify({
    waterSamples: samples.length, samplesWithRoadAbove: overWaterRoad,
    roadMeshCount: roads.length, waterMeshCount: waters.length,
    roadHitNames: byName,
    roadYMin: roadYs.length ? Math.min.apply(null, roadYs) : null,
    roadYMax: roadYs.length ? Math.max.apply(null, roadYs) : null,
    waterY: samples.length ? +samples[0][2].toFixed(3) : null,
  });
})()`;

const bro = await launchBrowser({ width: 1440, height: 900 });
const page = bro.page;
const out = [];
try {
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const ok = await page.evaluate("(typeof geoToThree === 'function' && !!window.__CANONICAL_RUNTIME__)", { timeoutMs: 30000 }).catch(() => false);
    if (ok === true) break;
  }
  await sleep(6000);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const sp of SPOTS) {
    await page.evaluate(goTo(sp.lat, sp.lon, sp.r, sp.ph));
    await sleep(14000);
    await page.evaluate(HIDE_UI);
    const probe = JSON.parse(await page.evaluate(PROBE, { timeoutMs: 180000 }) || 'null');
    let shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
    fs.writeFileSync(path.join(OUT_DIR, sp.file + '-1-normal.jpg'), Buffer.from(shot.data, 'base64'));
    await page.evaluate(setWater(false));
    await sleep(800);
    shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
    fs.writeFileSync(path.join(OUT_DIR, sp.file + '-2-nowater.jpg'), Buffer.from(shot.data, 'base64'));
    await page.evaluate(setWater(true));
    out.push({ spot: sp.file, probe });
    console.log(sp.file, JSON.stringify(probe));
  }
} finally { try { await bro.close(); } catch (e) { /* noop */ } }
fs.writeFileSync(path.join(OUT_DIR, 'diag.json'), JSON.stringify(out, null, 2));
console.log('[36A-diag] out', OUT_DIR);
