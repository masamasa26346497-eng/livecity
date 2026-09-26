// tools/experiments/mission35y_picking_shots.mjs
// [Mission 35Y §18] hover / click の見た目を撮る。
//   実際に mousemove / click を投げて、その建物だけが光っていることを画で残す。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION35Y_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const OUT_DIR = 'data/reports/mission35y-precise-building-picking';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const goTo = (lat, lon, r, phDeg) => `(() => {
  if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
  const p = geoToThree(${lat}, ${lon});
  cs.tgt.x = p.x; cs.tgt.z = p.z; cs.tgt.y = 0;
  cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0.6; camUpd();
  try { const w = WardModeManager.detectWardAt(p.x, p.z);
    const cur = WardModeManager.getCurrentWard && WardModeManager.getCurrentWard();
    if (w && (!cur || cur.id !== w)) WardModeManager.switchWard(w); } catch (e) { /* noop */ }
  return 1; })()`;

/** 条件に合う建物を選び、その屋根の画面座標を返す。 */
const FIND = (mode) => `(() => {
  const fps = CanonicalRuntime.visibleBuildingFootprints(60000) || [];
  camera.updateMatrixWorld();
  const W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight;
  const v = new THREE.Vector3();
  const inRing = (px, pz, r) => { let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
      if (((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) c = !c; }
    return c; };
  const interior = (f) => { if (inRing(f.cx, f.cz, f.ring)) return [f.cx, f.cz];
    const r = f.ring;
    for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length], c2 = r[(i + 2) % r.length];
      const px = (a[0] + b[0] + c2[0]) / 3, pz = (a[1] + b[1] + c2[1]) / 3;
      if (inRing(px, pz, r)) return [px, pz]; } return null; };
  const bMeshes = [];
  scene.traverse((o) => { if (o.isMesh && o.visible && o.userData && o.userData.usageCategory
    && o.parent && o.parent.visible !== false) bMeshes.push(o); });
  const down = new THREE.Vector3(0, -1, 0);
  const roofY = (x, z) => { const rc = new THREE.Raycaster(new THREE.Vector3(x, 4000, z), down);
    for (const h of rc.intersectObjects(bMeshes, false)) if (h.point.y > 0.6) return h.point.y;
    return null; };
  const area = (r) => { let A = 0;
    for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; A += a[0] * b[1] - b[0] * a[1]; }
    return Math.abs(A) / 2; };
  // 凹み具合: 重心が polygon の外に出る = はっきり凹型
  const concave = (f) => !inRing(f.cx, f.cz, f.ring);

  let best = null;
  for (const f of fps) {
    if (!f.ring || f.ring.length < 3) continue;
    const ip = interior(f); if (!ip) continue;
    const A = area(f.ring);
    if ('${mode}' === 'small' && !(A > 12 && A < 90)) continue;
    if ('${mode}' === 'irregular' && !(f.ring.length >= 8 && A > 150)) continue;
    if ('${mode}' === 'normal' && !(A > 400 && A < 4000)) continue;
    const y = roofY(ip[0], ip[1]); if (y == null) continue;
    v.set(ip[0], y - 0.2, ip[1]).project(camera);
    if (v.z > 1 || Math.abs(v.x) > 0.55 || Math.abs(v.y) > 0.55) continue;   // 画面中央寄り
    const sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H;
    const d = Math.hypot(sx - W / 2, sy - H / 2);
    if (!best || d < best.d) best = { id: f.canonicalId, sx, sy, d, areaM2: +A.toFixed(1), verts: f.ring.length };
  }
  return JSON.stringify(best);
})()`;

const HIDE_DEV_UI = `(() => {
  for (const el of document.querySelectorAll('div,button')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|^pl$|^pr$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery|mission35s-focus|town-click/.test(id)) el.style.display = 'none'; }
  return 1; })()`;

const hoverAt = (x, y) => `(() => {
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y}, bubbles: true }));
  return 1; })()`;
const clickAt = (x, y) => `(() => {
  const c = document.getElementById('c');
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y}, bubbles: true }));
  c.dispatchEvent(new MouseEvent('click', { clientX: ${x}, clientY: ${y}, bubbles: true }));
  return 1; })()`;

const ONLY = process.env.MISSION35Y_ONLY || '';
const SPOTS = [
  { file: '1-single-building-hover', name: '本町', lat: 34.6823, lon: 135.5024, r: 300, ph: 42, mode: 'normal', click: false },
  { file: '2-adjacent-buildings', name: '住宅密集地', lat: 34.6398, lon: 135.5474, r: 240, ph: 46, mode: 'normal', click: false },
  { file: '3-dense-umeda', name: '梅田', lat: 34.7025, lon: 135.4959, r: 420, ph: 45, mode: 'normal', click: false },
  { file: '4-small-building', name: '住宅密集地(小)', lat: 34.6398, lon: 135.5474, r: 200, ph: 48, mode: 'small', click: false },
  { file: '5-irregular-footprint', name: '難波(凹型)', lat: 34.6627, lon: 135.5013, r: 300, ph: 44, mode: 'irregular', click: false },
  { file: '6-selected-building', name: '本町(選択)', lat: 34.6823, lon: 135.5024, r: 300, ph: 42, mode: 'normal', click: true },
];

const b = await launchBrowser({ width: 1440, height: 900 });
const page = b.page;
const out = [];
try {
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const ok = await page.evaluate("(typeof geoToThree === 'function' && typeof CanonicalRuntime !== 'undefined' && !!CanonicalRuntime.visibleBuildingFootprints)",
      { timeoutMs: 30000 }).catch(() => false);
    if (ok === true || ok === 'true') break;
  }
  await sleep(5000);
  for (const sp of SPOTS) {
    if (ONLY && sp.file !== ONLY) continue;
    await page.evaluate(goTo(sp.lat, sp.lon, sp.r, sp.ph));
    let prev = -1, stable = 0;
    for (let i = 0; i < 25; i++) {
      await sleep(2000);
      const n = Number(await page.evaluate('(CanonicalRuntime.visibleBuildingFootprints(60000) || []).length', { timeoutMs: 60000 }));
      if (n === prev && n > 0) { if (++stable >= 3) break; } else stable = 0;
      prev = n;
    }
    await page.evaluate(HIDE_DEV_UI);
    const found = JSON.parse(await page.evaluate(FIND(sp.mode), { timeoutMs: 120000 }) || 'null');
    if (!found) { console.log('skip (対象なし)', sp.file); continue; }
    await page.evaluate(sp.click ? clickAt(Math.round(found.sx), Math.round(found.sy))
      : hoverAt(Math.round(found.sx), Math.round(found.sy)));
    await sleep(1600);
    const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, sp.file + '.jpg'), Buffer.from(data, 'base64'));
    out.push({ ...sp, found });
    console.log(sp.file, 'id', String(found.id).slice(0, 26), 'area', found.areaM2, 'verts', found.verts);
  }
} finally { try { await b.close(); } catch { /* noop */ } }
fs.writeFileSync(path.join(OUT_DIR, ONLY ? 'shots-' + ONLY + '.json' : 'shots.json'), JSON.stringify(out, null, 2));
console.log('[35Y-shots] out', OUT_DIR);
