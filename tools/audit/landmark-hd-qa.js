#!/usr/bin/env node
// tools/audit/landmark-hd-qa.js
// [Mission 33E §7/§検証項目] Landmark HD Layer（PoC: 大阪城）の実ブラウザ確認。
//   - HD ON/OFF で見た目が変わること / 二重表示にならないこと
//   - クリック → property card が従来どおり出ること
//   - 切替距離（近景で HD / 遠景で従来）
//   - 性能（梅田・住吉・大阪城周辺 × HD ON/OFF）
//   前提: `npm run preview`。出力: data/reports/landmark-hd-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { PROBE } from './legacy-residual-probe.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const OUT = P('data', 'reports', 'landmark-hd-qa.json');
const SHOTS = P('data', 'reports', 'landmark-hd-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 大阪城の天守は landmark-models.json の anchor。他 2 地点は性能比較用（HD 対象外）。
export const CASTLE = { id: 'osakacastle', name: '大阪城', x: 76, z: -9258 };
export const PERF_SITES = [
  { id: 'umeda', name: '梅田', x: -2668, z: -10942 },
  { id: 'sumiyoshi', name: '住吉', x: -2952, z: -812 },
  CASTLE,
];
// §3 切替を確かめるカメラ距離（visibleDistanceM = 2600）
export const DISTANCE_STEPS = [300, 600, 900, 1800, 2400, 3200, 6000];

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, ph) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  hd: `(() => (typeof window.__LANDMARK_HD_DEBUG__ === 'function') ? window.__LANDMARK_HD_DEBUG__() : null)()`,
  setHd: (on) => `(() => window.__LANDMARK_HD_TOGGLE__(${on ? 'true' : 'false'}))()`,
  // §検証 二重表示していないか: 抑制対象 canonicalId が canonical 側の footprint に残っていないこと。
  //   あわせて、天守の真上から下向きに ray を撃って「何にぶつかるか」を見る。
  doubleCheck: `(() => {
    const hd = window.__LANDMARK_HD_DEBUG__();
    const lm = hd.landmarks[0];
    const ids = hd.suppressedBuildings || [];
    const dbg = window.__CANONICAL_RUNTIME_DEBUG__ ? window.__CANONICAL_RUNTIME_DEBUG__() : null;
    // canonical building mesh の中に、抑制対象の footprint が残っていないか
    let inCanonicalFootprints = null;
    try {
      const d = CanonicalRuntime.buildingDataById(lm.pickCanonicalId);
      inCanonicalFootprints = !!d;   // footprint 自体は card 用に保持しているので true でよい
    } catch (e) { inCanonicalFootprints = 'error'; }
    // 天守 anchor の真上から下向き ray。HD ON なら LandmarkHD の mesh、OFF なら CR_buildings に当たる
    const origin = new THREE.Vector3(lm.anchor.x, 400, lm.anchor.z);
    const rc = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0), 0.1, 2000);
    const targets = [];
    scene.traverse((o) => { if (o.isMesh && o.visible) { let p = o, vis = true; while (p) { if (p.visible === false) { vis = false; break; } p = p.parent; } if (vis) targets.push(o); } });
    const hits = rc.intersectObjects(targets, false).slice(0, 6).map((h) => ({
      name: h.object.name || '(no name)', y: +h.point.y.toFixed(1),
      root: (() => { let p = h.object; while (p && p.parent && p.parent.name !== 'Scene' && p.parent !== scene) p = p.parent; return p ? p.name : null; })(),
    }));
    return { suppressedIds: ids, cardDataAvailable: inCanonicalFootprints, topDownHits: hits,
      hdVisible: hd.visible, hdActive: hd.activeCount, hdTriangles: hd.triangles, hdDrawCalls: hd.drawCalls };
  })()`,
  // 画面内で天守がどれくらいの面積を占め、どれだけ色が分かれているか（高精細さの粗い指標）
  pixels: `(() => {
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const w = 320, h = Math.max(1, Math.round(w * src.height / src.width));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let lum = 0, n = 0; const colors = new Set();
    for (let i = 0; i < d.length; i += 4) {
      lum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; n++;
      colors.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3));
    }
    return { meanLuminance: +(lum / n).toFixed(4), distinctColors: colors.size, sampled: n };
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
        resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1), frameMsP95: +pct(dt, 0.95).toFixed(1),
          drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
          trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)),
          jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null });
      } }
    requestAnimationFrame(f);
  })`,
  // §6 天守の中心をクリックして card が出るか
  pickCastle: `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const hd = window.__LANDMARK_HD_DEBUG__();
    const lm = hd.landmarks[0];
    camera.updateMatrixWorld();
    const v = new THREE.Vector3(lm.anchor.x, (lm.heights ? lm.heights.totalM : 50) * 0.55, lm.anchor.z).project(camera);
    const sx = Math.round((v.x + 1) / 2 * innerWidth), sy = Math.round((1 - v.y) / 2 * innerHeight);
    if (!(sx > 0 && sx < innerWidth && sy > 0 && sy < innerHeight)) return { onScreen: false, sx, sy };
    const cv = document.querySelector('canvas');
    const mk = (type) => cv.dispatchEvent(new MouseEvent(type, { clientX: sx, clientY: sy, bubbles: true, cancelable: true, button: 0 }));
    mk('mousemove'); await wait(450);
    const tip = document.getElementById('tip');
    const hover = tip ? getComputedStyle(tip).display : 'none';
    mk('mousedown'); mk('mouseup'); mk('click'); await wait(900);
    const card = document.getElementById('prop-card');
    const title = document.getElementById('pc-title');
    const idEl = document.getElementById('pc-id');
    const body = card ? card.innerText : '';
    const FAKE = ['推定階数', '推定利回り', '想定賃料', '町丁目データなし', '仮の参考値'];
    return { onScreen: true, sx, sy, hover, cardDisplay: card ? getComputedStyle(card).display : 'none',
      title: title ? title.textContent : null, cardId: idEl ? idEl.textContent : null,
      matchesPickCanonicalId: !!(idEl && lm.pickCanonicalId && idEl.textContent.includes(lm.pickCanonicalId)),
      fakeValues: FAKE.filter((k) => body.includes(k)) };
  })()`,
};

async function settle(page, min = 2500, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function ensureCamera(page, x, z, r, ph) {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(JS.camera(x, z, r, ph));
    await sleep(900);
    if (await page.evaluate(`(() => Math.abs(cs.tgt.x - (${x})) < 5 && Math.abs(cs.tgt.z - (${z})) < 5 && Math.abs(cs.r - ${r}) < 5)()`)) return true;
  }
  return false;
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/landmark-hd-qa/' + name + '.jpg';
}

export async function run() {
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '33E', url: URL_, errors: [] };
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    await page.evaluate(JS.ward(CASTLE.x, CASTLE.z)); await sleep(2500);
    await ensureCamera(page, CASTLE.x, CASTLE.z, 600, Math.PI / 3.2);
    await settle(page);
    await ensureCamera(page, CASTLE.x, CASTLE.z, 600, Math.PI / 3.2);
    await sleep(2500);

    out.config = await page.evaluate(JS.hd);
    console.log('[landmark-hd] config', JSON.stringify({ loaded: out.config.loaded, err: out.config.dataError,
      under: out.config.underCanonicalRoot, lm: out.config.landmarks.map((l) => ({ id: l.landmarkId, tri: l.triangles, h: l.heights, swap: l.swapRadiusM, vis: l.visibleDistanceM })) }));

    // §3 切替距離
    out.distanceSwitch = [];
    for (const r of DISTANCE_STEPS) {
      await ensureCamera(page, CASTLE.x, CASTLE.z, r, Math.PI / 3.2);
      await sleep(1400);
      const d = await page.evaluate(JS.hd);
      out.distanceSwitch.push({ cameraR: r, hdVisible: d.visible, activeCount: d.activeCount,
        suppressed: d.suppressedBuildings.length });
    }
    console.log('[landmark-hd] 切替', JSON.stringify(out.distanceSwitch));

    // §検証 HD ON / OFF の比較（同一カメラ）
    await ensureCamera(page, CASTLE.x, CASTLE.z, 600, Math.PI / 3.2);
    await settle(page, 2000);
    await sleep(1500);
    out.on = { hd: await page.evaluate(JS.hd), double: await page.evaluate(JS.doubleCheck),
      pixels: await page.evaluate(JS.pixels), residual: (await page.evaluate(PROBE)).selfCheck.total,
      shot: await shot(page, 'castle-hd-on') };
    out.pick = await page.evaluate(JS.pickCastle, { timeoutMs: 60000 });
    console.log('[landmark-hd] pick', JSON.stringify(out.pick));

    await page.evaluate(JS.setHd(false));
    await sleep(2500); await settle(page, 1500); await sleep(1500);
    out.off = { hd: await page.evaluate(JS.hd), double: await page.evaluate(JS.doubleCheck),
      pixels: await page.evaluate(JS.pixels), residual: (await page.evaluate(PROBE)).selfCheck.total,
      shot: await shot(page, 'castle-hd-off') };
    await page.evaluate(JS.setHd(true));
    await sleep(2500); await settle(page, 1500); await sleep(1200);
    console.log('[landmark-hd] on/off', JSON.stringify({
      onHits: out.on.double.topDownHits.map((h) => h.name), offHits: out.off.double.topDownHits.map((h) => h.name),
      onColors: out.on.pixels.distinctColors, offColors: out.off.pixels.distinctColors }));

    // 近景・俯瞰の見た目（§4 silhouette）
    out.views = [];
    for (const v of [{ n: 'near', r: 320, ph: Math.PI / 3.0 }, { n: 'mid', r: 900, ph: Math.PI / 3.4 }, { n: 'far', r: 2400, ph: Math.PI / 3.6 }]) {
      await ensureCamera(page, CASTLE.x, CASTLE.z, v.r, v.ph);
      await settle(page, 1500); await sleep(1500);
      out.views.push({ view: v.n, cameraR: v.r, hd: await page.evaluate(JS.hd), shot: await shot(page, 'castle-' + v.n) });
    }

    // §7 性能（HD ON / OFF × 3 地点）
    out.performance = [];
    for (const on of [true, false]) {
      await page.evaluate(JS.setHd(on)); await sleep(1800);
      for (const s of PERF_SITES) {
        await page.evaluate(JS.ward(s.x, s.z)); await sleep(2000);
        await ensureCamera(page, s.x, s.z, 700, Math.PI / 4);
        await settle(page);
        const r = await page.evaluate(JS.bench(15), { timeoutMs: 90000 });
        out.performance.push({ site: s.id, siteName: s.name, hd: on, ...r });
        console.log('[landmark-hd] perf', s.id, 'hd=' + on, JSON.stringify(r));
      }
    }
    await page.evaluate(JS.setHd(true));
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((d) => { console.log('[landmark-hd] out', OUT, 'errors', d.errors.length); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
