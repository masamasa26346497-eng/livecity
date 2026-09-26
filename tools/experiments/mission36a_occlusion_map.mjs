// tools/experiments/mission36a_occlusion_map.mjs
// [Mission 36A 調査] 「水面に隠れた道路画素」がどこに出ているかを画で見る。
//   マスクを赤で重ねた画像を出す。MISSION36A_PHASE で before/after を撮り分ける。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION36A_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const PHASE = process.env.MISSION36A_PHASE || 'after';
const OUT_DIR = 'data/reports/mission36a-road-visibility-water-order/diag';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPOTS = [
  { file: 'nakanoshima-wide', lat: 34.6930, lon: 135.4985, r: 2600, ph: 50 },
  { file: 'nakanoshima', lat: 34.6930, lon: 135.4985, r: 900, ph: 42 },
];

const goTo = (lat, lon, r, phDeg) => `(() => {
  if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
  const p = geoToThree(${lat}, ${lon});
  cs.tgt.x = p.x; cs.tgt.z = p.z; cs.tgt.y = 0;
  cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0.6; camUpd();
  return 1; })()`;

const HIDE_UI = `(() => { for (const el of document.querySelectorAll('div,button')) {
  const id = el.id || ''; if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|^pl$|^pr$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery|mission35s-focus|town-click/.test(id)) el.style.display = 'none'; }
  const p = document.getElementById('side'); if (p) p.style.display = 'none';
  return 1; })()`;

const MASK = `(() => {
  const gl = renderer.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, N = W * H;
  const roadGroups = [], waterGroups = [];
  scene.traverse((o) => {
    if (o.name === 'CR_roads' || o.name === 'RoadVisualV3Overlay' || o.name === 'RoadDetailLayer') roadGroups.push(o);
    if (o.name === 'CR_water') waterGroups.push(o);
  });
  const grab = () => { renderer.render(scene, camera);
    const px = new Uint8Array(N * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
  const set = (a, v) => { const p = a.map((o) => o.visible); a.forEach((o) => { o.visible = v; }); return p; };
  const res = (a, p) => a.forEach((o, i) => { o.visible = p[i]; });
  const A = grab();
  const pw = set(waterGroups, false); const B = grab();
  const pr = set(roadGroups, false);  const D = grab();
  res(waterGroups, pw);               const C = grab();
  res(roadGroups, pr); renderer.render(scene, camera);
  const TH = 6;
  const df = (X, Y, i) => Math.abs(X[i] - Y[i]) + Math.abs(X[i + 1] - Y[i + 1]) + Math.abs(X[i + 2] - Y[i + 2]);
  // readPixels は下が原点。canvas は上が原点なので y を反転して描く。
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  cv.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:99999;pointer-events:none';
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = ((H - 1 - y) * W + x) * 4, dst = (y * W + x) * 4;
      const isW = df(A, C, src) > TH, isN = df(B, D, src) > TH;
      if (isN && !isW) { img.data[dst] = 255; img.data[dst + 3] = 255; n++; }
      else img.data[dst + 3] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  document.body.appendChild(cv);

  // 残った occluded 画素を何が作っているかを ray で調べる（最大 12 点）。
  const roadMeshes = [], waterMeshes = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const vis = (() => { let p = o; while (p) { if (p.visible === false) return false; p = p.parent; } return true; })();
    if (!vis) return;
    if (/^(RoadBucket_|RoadV3_|RoadDetail)/.test(o.name || '')) roadMeshes.push(o);
    else { let p = o.parent; while (p) { if (p.name === 'CR_water') { waterMeshes.push(o); break; } p = p.parent; } }
  });
  const rc = new THREE.Raycaster();
  const samples = [];
  const step = Math.max(1, Math.floor(n / 12));
  let seen = 0;
  for (let y = 0; y < H && samples.length < 12; y += 2) {
    for (let x = 0; x < W && samples.length < 12; x += 2) {
      const src = ((H - 1 - y) * W + x) * 4;
      if (!(df(B, D, src) > TH && !(df(A, C, src) > TH))) continue;
      if (seen++ % step) continue;
      rc.setFromCamera(new THREE.Vector2(x / W * 2 - 1, -(y / H * 2 - 1)), camera);
      const hr = rc.intersectObjects(roadMeshes, false).slice(0, 3)
        .map((h) => (h.object.name || '').replace(/_[-0-9]+_[-0-9]+$/, '') + '@y' + h.point.y.toFixed(3) + '/d' + h.distance.toFixed(0));
      const hw = rc.intersectObjects(waterMeshes, false).slice(0, 2)
        .map((h) => 'water@y' + h.point.y.toFixed(3) + '/d' + h.distance.toFixed(0));
      samples.push({ x, y, road: hr, water: hw });
    }
  }
  return JSON.stringify({ n, samples });
})()`;

const bro = await launchBrowser({ width: 1440, height: 900 });
const page = bro.page;
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
    await sleep(16000);
    await page.evaluate(HIDE_UI);
    const n = JSON.parse(await page.evaluate(MASK, { timeoutMs: 180000 }) || 'null');
    await sleep(600);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, PHASE + '-mask-' + sp.file + '.png'), Buffer.from(shot.data, 'base64'));
    console.log(sp.file, 'occludedPx', n.n); for (const s of n.samples) console.log('   ', s.x + ',' + s.y, 'road=' + JSON.stringify(s.road), 'water=' + JSON.stringify(s.water));
    await page.evaluate("(() => { const c = document.querySelectorAll('canvas'); c[c.length-1].remove(); return 1; })()");
  }
} finally { try { await bro.close(); } catch (e) { /* noop */ } }
console.log('[36A-mask] out', OUT_DIR);
