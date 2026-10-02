#!/usr/bin/env node
// tools/audit/building-lod-qa.js
// [Mission 34A §20/§21/§19/§16] 最高 LOD 表示の実ブラウザ確認。
//   - 距離 LOD の切替（遠景 LOD1 / 中景・近景で高 LOD）
//   - 二重表示なし（高 LOD を出している棟の LOD1 が消えている）
//   - LOD 切替で位置・高さが跳ばない（§16）
//   - picking（LOD1 / LOD2 どちらでも同じ canonicalId・同じ card）
//   - 性能（7 条件 × 高 LOD ON/OFF）
//   前提: `npm run preview`。出力: data/reports/building-lod-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { PROBE } from './legacy-residual-probe.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const OUT = P('data', 'reports', 'building-lod-qa.json');
const SHOTS = P('data', 'reports', 'building-lod-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// §20 性能計測の地点
export const PERF_SITES = [
  { id: 'umeda', name: '梅田', x: -2668, z: -10942 },
  { id: 'honmachi', name: '本町', x: -2073, z: -8693 },
  { id: 'namba', name: '難波', x: -2173, z: -6511 },
  { id: 'tennoji', name: '天王寺', x: -1056, z: -4619 },
  { id: 'osakacastle', name: '大阪城', x: 76, z: -9258 },
  { id: 'sumiyoshi', name: '住吉', x: -2952, z: -812 },
];
// §15 切替のしきい値を確認する距離
export const DISTANCE_STEPS = [300, 600, 800, 1200, 2000, 2500, 3000, 5000];

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, ph) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  lod: `(() => (typeof window.__BUILDING_LOD_DEBUG__ === 'function') ? window.__BUILDING_LOD_DEBUG__() : null)()`,
  setLod: (on) => `(() => window.__BUILDING_LOD_TOGGLE__(${on ? 'true' : 'false'}))()`,
  setQa: (on) => `(() => window.__BUILDING_LOD_QA__(${on ? 'true' : 'false'}))()`,
  // §21 高 LOD で描いている棟を真上から撃って、LOD1 と二重になっていないか / 浮き沈みが無いかを見る
  probe: (n) => `(() => {
    const d = window.__BUILDING_LOD_DEBUG__();
    const out = { band: d.band, visibleLod2: d.visibleLod2, visibleLod3: d.visibleLod3, suppressedLod1: d.suppressedLod1,
      triangles: d.triangles, drawCalls: d.drawCalls, samples: [], doubleHits: 0, floating: 0, sunken: 0 };
    const meshes = [];
    scene.traverse((o) => { if (o.isMesh && o.userData && o.userData.lodHigh) { let p = o, vis = true; while (p) { if (p.visible === false) { vis = false; break; } p = p.parent; } if (vis) meshes.push(o); } });
    if (!meshes.length) return out;
    // 高 LOD メッシュの頂点をいくつか選び、その真上から下向きに ray を撃つ
    const picked = [];
    for (const m of meshes) {
      const pos = m.geometry.getAttribute('position');
      const step = Math.max(1, Math.floor(pos.count / 12));
      for (let i = 0; i < pos.count && picked.length < ${n}; i += step) picked.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
      if (picked.length >= ${n}) break;
    }
    const targets = [];
    scene.traverse((o) => { if (o.isMesh && o.visible) { let p = o, vis = true; while (p) { if (p.visible === false) { vis = false; break; } p = p.parent; } if (vis) targets.push(o); } });
    for (const pt of picked) {
      const rc = new THREE.Raycaster(new THREE.Vector3(pt[0], 600, pt[2]), new THREE.Vector3(0, -1, 0), 0.1, 2000);
      const hits = rc.intersectObjects(targets, false).slice(0, 8);
      const names = hits.map((h) => ({ n: h.object.name || '(no name)', y: +h.point.y.toFixed(2), lodHigh: !!(h.object.userData && h.object.userData.lodHigh) }));
      const firstHigh = names.findIndex((h) => h.lodHigh);
      // 高 LOD の下/上に CR_buildings の面があれば二重表示の疑い。
      //   ただし隣接する別棟の LOD1 に当たっているだけのことがあるので、
      //   「その棟自身の高さ範囲に CR_buildings の面がある」ものだけを数える。
      const crBuild = hits.filter((h) => { let p = h.object; while (p) { if (p.name === 'CR_buildings') return true; p = p.parent; } return false; });
      const highYs = hits.filter((h) => h.object.userData && h.object.userData.lodHigh).map((h) => h.point.y);
      const hiTop = highYs.length ? Math.max(...highYs) : null;
      const overlapping = (hiTop != null) ? crBuild.filter((h) => h.point.y <= hiTop + 0.5) : crBuild;
      if (overlapping.length) out.doubleHits++;
      if (crBuild.length && !overlapping.length) out.adjacentLod1Hits = (out.adjacentLod1Hits || 0) + 1;
      out.samples.push({ x: +pt[0].toFixed(1), z: +pt[2].toFixed(1), vertexY: +pt[1].toFixed(2), firstHigh,
        highTopY: hiTop == null ? null : +hiTop.toFixed(2),
        crBuildY: crBuild.map((h) => +h.point.y.toFixed(2)).slice(0, 3), hits: names.slice(0, 4) });
    }
    return out;
  })()`,
  // §16 LOD 切替の前後で、同じ建物の位置と高さが変わらないか
  switchCheck: `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const sample = () => {
      const d = window.__BUILDING_LOD_DEBUG__();
      const box = new THREE.Box3();
      let has = false;
      scene.traverse((o) => { if (o.isMesh && o.userData && o.userData.lodHigh && o.visible) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox); has = true; } });
      return { band: d.band, visible: d.visibleLod2 + d.visibleLod3, suppressed: d.suppressedLod1,
        bbox: has ? { minX: +box.min.x.toFixed(1), maxX: +box.max.x.toFixed(1), minY: +box.min.y.toFixed(2), maxY: +box.max.y.toFixed(2) } : null };
    };
    const out = [];
    for (const r of [600, 900, 2000, 2400, 2600, 3200]) { cs.r = r; camUpd(); await wait(1600); out.push({ r, ...sample() }); }
    return out;
  })()`,
  // §19 同じ建物を LOD1 表示のときと高 LOD 表示のときでクリックして、card が一致するか
  pickCompare: `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cv = document.querySelector('canvas');
    const click = async (sx, sy) => {
      for (const t of ['mousemove', 'mousedown', 'mouseup', 'click']) cv.dispatchEvent(new MouseEvent(t, { clientX: sx, clientY: sy, bubbles: true, cancelable: true, button: 0 }));
      await wait(800);
      const card = document.getElementById('prop-card');
      const id = document.getElementById('pc-id');
      const title = document.getElementById('pc-title');
      const body = card ? card.innerText : '';
      const FAKE = ['推定階数', '推定利回り', '想定賃料', '町丁目データなし'];
      return { display: card ? getComputedStyle(card).display : 'none', id: id ? id.textContent : null,
        title: title ? title.textContent : null, height: (body.match(/([\\d.]+)\\s*m/) || [])[1] || null,
        fake: FAKE.filter((k) => body.includes(k)) };
    };
    // 高 LOD メッシュの頂点を画面へ投影してクリック位置を決める
    camera.updateMatrixWorld();
    // 画面中央にいちばん近い高 LOD の面を選ぶ（端の建物だと投影が画面外になる）
    let target = null, best = Infinity;
    const v = new THREE.Vector3();
    scene.traverse((o) => {
      if (!o.isMesh || !o.userData || !o.userData.lodHigh || !o.visible) return;
      if (o.userData.lodHigh.kind === 'ground') return;
      const pos = o.geometry.getAttribute('position');
      const idx = o.geometry.index;
      for (const r0 of (o.userData.lodHigh.ranges || [])) {
        // 角の頂点を狙うと 1px 未満のズレで建物の外側へ外れる。三角形の重心を狙う。
        const a = idx.getX(r0.start), b2 = idx.getX(r0.start + 1), c2 = idx.getX(r0.start + 2);
        v.set((pos.getX(a) + pos.getX(b2) + pos.getX(c2)) / 3,
              (pos.getY(a) + pos.getY(b2) + pos.getY(c2)) / 3,
              (pos.getZ(a) + pos.getZ(b2) + pos.getZ(c2)) / 3);
        const w = v.clone();
        v.project(camera);
        if (v.z > 1 || Math.abs(v.x) > 0.85 || Math.abs(v.y) > 0.85) continue;
        const d = v.x * v.x + v.y * v.y;
        if (d < best) { best = d; target = { canonicalId: r0.canonicalId, lod: r0.lod, p: w }; }
      }
    });
    if (!target) return { found: false };
    const pv = target.p.clone().project(camera);
    const sx = Math.round((pv.x + 1) / 2 * innerWidth), sy = Math.round((1 - pv.y) / 2 * innerHeight);
    if (!(sx > 0 && sx < innerWidth && sy > 0 && sy < innerHeight)) return { found: true, onScreen: false, canonicalId: target.canonicalId };
    const high = await click(sx, sy);
    // 高 LOD を切ってから、同じ建物の LOD1 の箱をクリックする。
    //   「同じ画素」を押し直すのは不可: 低い屋根の隣に高い建物があると、LOD1 に戻した瞬間
    //   その画素は別の棟に覆われる（実測でそうなった）。狙うのは画素ではなく同じ canonicalId の棟。
    window.__BUILDING_LOD_TOGGLE__(false);
    await wait(3000);
    const d1 = CanonicalRuntime.buildingDataById(high.id || target.canonicalId);
    let low = { display: 'none' }, lowVia = 'none';
    if (d1 && Array.isArray(d1.fp) && d1.fp.length) {
      let cx = 0, cz = 0;
      for (const q of d1.fp) { cx += q[0]; cz += q[1]; }
      cx /= d1.fp.length; cz /= d1.fp.length;
      camera.updateMatrixWorld();
      const t2 = new THREE.Vector3(cx, Math.max(1, d1.h) * 0.98, cz).project(camera);
      const lx = Math.round((t2.x + 1) / 2 * innerWidth), ly = Math.round((1 - t2.y) / 2 * innerHeight);
      if (t2.z <= 1 && lx > 0 && lx < innerWidth && ly > 0 && ly < innerHeight) { low = await click(lx, ly); lowVia = 'click-roof-center'; }
    }
    // 画面上で隠れているときは、真上からの ray で LOD1 の同定だけを確認する
    let lowById = null;
    try {
      const rc = new THREE.Raycaster(new THREE.Vector3(d1 ? d1.fp.reduce((a, q) => a + q[0], 0) / d1.fp.length : 0, 800,
        d1 ? d1.fp.reduce((a, q) => a + q[1], 0) / d1.fp.length : 0), new THREE.Vector3(0, -1, 0), 0.1, 2000);
      const r = CanonicalRuntime.pickBuilding(rc);
      lowById = r ? r.d.id : null;
    } catch (e) { /* noop */ }
    window.__BUILDING_LOD_TOGGLE__(true);
    await wait(2500);
    return { found: true, onScreen: true, canonicalId: target.canonicalId, lod: target.lod, high, low, lowVia, lowById,
      highIsTarget: high.id === target.canonicalId,
      sameId: (low.display === 'block' && low.id === high.id) || (lowById != null && lowById === high.id),
      sameTitle: low.display === 'block' ? high.title === low.title : null,
      sameHeight: low.display === 'block' ? high.height === low.height : null };
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
        const d = (typeof window.__BUILDING_LOD_DEBUG__ === 'function') ? window.__BUILDING_LOD_DEBUG__() : null;
        resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1), fpsP5: +pct(dt.map((x) => 1000 / x), 0.05).toFixed(1),
          frameMsP95: +pct(dt, 0.95).toFixed(1),
          drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
          trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)),
          jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
          visibleLod2: d ? d.visibleLod2 : null, visibleLod3: d ? d.visibleLod3 : null, suppressedLod1: d ? d.suppressedLod1 : null,
          band: d ? d.band : null });
      } }
    requestAnimationFrame(f);
  })`,
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
  return 'data/reports/building-lod-qa/' + name + '.jpg';
}

export async function runPickOnly() {
  const prev = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    const s0 = PERF_SITES.find((s) => s.id === 'honmachi');
    await page.evaluate(JS.ward(s0.x, s0.z)); await sleep(2500);
    await ensureCamera(page, s0.x, s0.z, 420, Math.PI / 3.6);
    await settle(page);
    await sleep(2000);
    prev.pick = await page.evaluate(JS.pickCompare, { timeoutMs: 90000 });
    prev.errors = (prev.errors || []).concat(errors.slice(0, 10));
    console.log('[bldg-lod] pick', JSON.stringify(prev.pick));
  } finally { await b.close(); }
  fs.writeFileSync(OUT, JSON.stringify(prev, null, 2));
  return prev;
}

export async function run() {
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34A', url: URL_, errors: [] };
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    const s0 = PERF_SITES.find((s) => s.id === 'honmachi');
    await page.evaluate(JS.ward(s0.x, s0.z)); await sleep(2500);
    await ensureCamera(page, s0.x, s0.z, 600, Math.PI / 3.3);
    await settle(page);
    out.config = await page.evaluate(JS.lod);
    console.log('[bldg-lod] config', JSON.stringify({ total: out.config.totalHighLodBuildings, lod2: out.config.totalLod2, lod3: out.config.totalLod3,
      tiles: out.config.availableTiles, under: out.config.underCanonicalRoot, bands: out.config.bands, err: out.config.dataError }));

    // §15 距離による切替
    out.distanceSwitch = [];
    for (const r of DISTANCE_STEPS) {
      await ensureCamera(page, s0.x, s0.z, r, Math.PI / 3.3);
      await sleep(1800);
      const d = await page.evaluate(JS.lod);
      out.distanceSwitch.push({ cameraR: r, band: d.band, visibleLod2: d.visibleLod2, visibleLod3: d.visibleLod3, suppressedLod1: d.suppressedLod1, triangles: d.triangles, drawCalls: d.drawCalls });
    }
    console.log('[bldg-lod] 切替', JSON.stringify(out.distanceSwitch));

    // §16 切替で位置・高さが跳ばない
    await ensureCamera(page, s0.x, s0.z, 600, Math.PI / 3.3);
    await settle(page, 1500);
    out.switchCheck = await page.evaluate(JS.switchCheck, { timeoutMs: 90000 });
    console.log('[bldg-lod] pop 確認', JSON.stringify(out.switchCheck));

    // §21 地点ごとの visual QA（高 LOD が多い地点を優先）
    out.sites = [];
    for (const s of PERF_SITES) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(2200);
      await ensureCamera(page, s.x, s.z, 600, Math.PI / 3.3);
      await settle(page);
      await sleep(1500);
      const probe = await page.evaluate(JS.probe(24));
      const rec = { site: s.id, siteName: s.name, ...probe, residual: (await page.evaluate(PROBE)).selfCheck.total, shot: await shot(page, s.id + '-high') };
      out.sites.push(rec);
      console.log('[bldg-lod]', s.id, JSON.stringify({ lod2: rec.visibleLod2, lod3: rec.visibleLod3, sup: rec.suppressedLod1, tri: rec.triangles, dbl: rec.doubleHits, residual: rec.residual }));
    }

    // §19 picking（高 LOD と LOD1 で同じ card）
    await page.evaluate(JS.ward(s0.x, s0.z)); await sleep(2000);
    await ensureCamera(page, s0.x, s0.z, 420, Math.PI / 3.6);
    await settle(page);
    out.pick = await page.evaluate(JS.pickCompare, { timeoutMs: 90000 });
    console.log('[bldg-lod] pick', JSON.stringify(out.pick));

    // §22 QA カバレッジ表示
    await page.evaluate(JS.setQa(true)); await sleep(1500);
    await page.evaluate(`(() => { CityModeManager.enter(); return 1; })()`);
    await sleep(9000); await settle(page, 2500); await sleep(4000);
    out.coverageShot = await shot(page, 'coverage-qa');
    out.coverageDebug = await page.evaluate(JS.lod);
    await page.evaluate(JS.setQa(false)); await sleep(1200);
    out.cityMode = { ...(await page.evaluate(JS.lod)), shot: await shot(page, 'city-mode') };
    out.cityPerf = await page.evaluate(JS.bench(15), { timeoutMs: 90000 });
    await page.evaluate(`(() => { CityModeManager.exit('chuo'); return 1; })()`); await sleep(1500);

    // §20 性能（高 LOD ON / OFF）
    out.performance = [];
    for (const on of [true, false]) {
      await page.evaluate(JS.setLod(on)); await sleep(1800);
      for (const s of PERF_SITES) {
        await page.evaluate(JS.ward(s.x, s.z)); await sleep(2000);
        await ensureCamera(page, s.x, s.z, 700, Math.PI / 4);
        await settle(page);
        const r = await page.evaluate(JS.bench(15), { timeoutMs: 90000 });
        out.performance.push({ site: s.id, siteName: s.name, highLod: on, ...r });
        console.log('[bldg-lod] perf', s.id, 'high=' + on, JSON.stringify({ fps: r.fpsAverage, tri: r.trianglesAvg, draw: r.drawCallsAvg, lod2: r.visibleLod2 }));
      }
    }
    await page.evaluate(JS.setLod(true));
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  (only === 'pick' ? runPickOnly() : run()).then((d) => { console.log('[bldg-lod] out', OUT, 'errors', (d.errors || []).length); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
