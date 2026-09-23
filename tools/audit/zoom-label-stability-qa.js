#!/usr/bin/env node
// tools/audit/zoom-label-stability-qa.js
// [Mission 33D §17/§18/§19/§20/§22] ホイールズームの効きとラベルの安定度を実ブラウザで測る。
//   --phase before : 現 production（33B = 加算式ズーム・選定キャッシュなし）
//   --phase after  : development（33D）
//   前提: `npm run preview`。出力: data/reports/zoom-label-stability-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URLS = {
  before: process.env.LIVECITY_PROD_URL || 'http://localhost:8000/osaka_3d_buildings.html',
  after: process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html',
};
const OUT = P('data', 'reports', 'zoom-label-stability-qa.json');
const SHOTS = P('data', 'reports', 'zoom-label-stability-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// §18/§19 の確認地点
export const SITES = [
  { id: 'umeda', name: '梅田', x: -2668, z: -10942 },
  { id: 'namba', name: '難波', x: -2173, z: -6511 },
  { id: 'sumiyoshi', name: '住吉', x: -2952, z: -812 },
  { id: 'honmachi', name: '本町', x: -2073, z: -8693 },
];
export const PERF_SITES = ['umeda', 'namba'];
// §1 「1 ノッチでどれだけ距離が変わるか」を測る距離（近景〜City Mode）
export const ZOOM_PROBE_R = [300, 900, 2000, 5300, 12000];
const VIEW = { r: 900, ph: Math.PI / 3.4 };

// §20 チラつきは「基準に戻れるか」ではなく「連続した小さな操作の 1 手ごとに表示が入れ替わるか」なので、
//   camera を少しずつ動かす経路（walk）を作り、隣り合うサンプル間の Jaccard を測る。
//   - pan   : ゆっくり向きを変えながら少しずつ平行移動（微小 pan）
//   - rotate: 少しずつ回す（微小 rotate）
//   - jitter: 同じ場所を行ったり来たりする（境界にいるラベルが往復でチラつく典型例）
//   - zoom  : ホイール 1 ノッチ相当で寄って戻る（§19 の「1〜2ノッチ zoom in/out を繰り返す」）
export function walkSteps(base) {
  const f = base.r, out = [];
  let x = 0, z = 0, th = 0, ph = 0, rk = 1;
  for (let i = 0; i < 14; i++) {          // 微小 pan（1 歩 = 距離の 0.4%）
    const a = i * 0.08;          // ほぼ直線に少しずつ寄る（円を描いて元へ戻らないように）
    x += Math.cos(a) * f * 0.004; z += Math.sin(a) * f * 0.004;
    out.push({ tier: 'pan', label: 'pan' + i, dx: x, dz: z, dth: th, dph: ph, rk });
  }
  for (let i = 0; i < 10; i++) {          // 微小 rotate（1 歩 0.012rad ≒ 0.7°）
    th += 0.012; ph += (i % 2 ? -0.004 : 0.004);
    out.push({ tier: 'rotate', label: 'rot' + i, dx: x, dz: z, dth: th, dph: ph, rk });
  }
  for (let i = 0; i < 10; i++) {          // 往復（境界のチラつきを最も出しやすい動き）
    const s = (i % 2) ? 1 : -1;
    out.push({ tier: 'jitter', label: 'jit' + i, dx: x + s * f * 0.006, dz: z, dth: th + s * 0.008, dph: ph, rk: s > 0 ? 1.02 : 1 / 1.02 });
  }
  const NOTCH = 1.246;                    // 33D の 1 ノッチ（= exp(0.22)）
  for (let i = 0; i < 8; i++) {           // 1 ノッチずつ寄る → 戻る
    rk = (i < 4) ? rk / NOTCH : rk * NOTCH;
    out.push({ tier: 'zoom', label: 'zoom' + i, dx: x, dz: z, dth: th, dph: ph, rk });
  }
  return out;   // 42 サンプル（§20 の 20〜50 の範囲）
}
export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const v of A) if (B.has(v)) inter++;
  return +(inter / (A.size + B.size - inter)).toFixed(4);
}

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, th, ph) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = ${th}; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  // 表示中ラベルの識別子。world 座標から作るので production(33B) / dev(33D) どちらでも同じ基準で比較できる。
  probe: `(() => {
    const keys = [], rects = [];
    try {
      camera.updateMatrixWorld();
      const v = new THREE.Vector3(), wp = new THREE.Vector3();
      const tanHalf = Math.tan((camera.fov || 60) * Math.PI / 360);
      const aspect = innerWidth / innerHeight;
      for (const ch of scene.children) {
        if (ch.name !== 'CityLabelLayer') continue;
        ch.traverse((o) => {
          if (!o.isSprite || !o.visible) return;
          o.getWorldPosition(wp); v.copy(wp).project(camera);
          if (v.z > 1) return;
          const kind = (o.name || '').replace('CityLabel_', '');
          keys.push(kind + '@' + Math.round(wp.x) + ',' + Math.round(wp.z));
          const dist = camera.position.distanceTo(wp);
          const hh = (o.scale.y / 2) / (tanHalf * Math.max(1, dist));
          const hw = ((o.scale.x / 2) / (tanHalf * Math.max(1, dist))) / aspect;
          rects.push({ sx: v.x, sy: v.y, hw, hh, px: hh * innerHeight });
        });
      }
    } catch (e) { /* 計測用 */ }
    let overlaps = 0, severe = 0;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const dx = Math.abs(a.sx - b.sx), dy = Math.abs(a.sy - b.sy);
      if (dx < (a.hw + b.hw) * 0.9 && dy < (a.hh + b.hh) * 0.9) {
        overlaps++;
        if (dx < Math.min(a.hw, b.hw) * 0.5 && dy < Math.min(a.hh, b.hh) * 0.5) severe++;
      }
    }
    const d = (typeof window.__CITY_LABEL_DEBUG__ === 'function') ? window.__CITY_LABEL_DEBUG__() : null;
    const px = rects.map((r) => +r.px.toFixed(1)).sort((a, b) => a - b);
    return { keys, count: rects.length, overlapPairs: overlaps, severeOverlaps: severe,
      duplicates: keys.length - new Set(keys).size,
      minPx: px[0] ?? null,
      ids: d && d.visibleIds ? d.visibleIds : null, majorIds: d && d.visibleMajorIds ? d.visibleMajorIds : null,
      stability: d && d.stability ? d.stability : null,
      byType: d ? { place: d.visiblePlaces, station: d.visibleStations, landmark: d.visibleLandmarks, river: d.visibleRivers, ward: d.visibleWards, park: d.visibleParks } : null };
  })()`,
  // §1/§2/§3 実際に wheel イベントを流して 1 ノッチの距離変化を測る
  zoom: (rs) => `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const fire = (deltaY, deltaMode) => {
      const ev = new WheelEvent('wheel', { deltaY, deltaMode: deltaMode || 0, clientX: innerWidth / 2, clientY: innerHeight / 2, bubbles: true, cancelable: true });
      (document.querySelector('canvas')).dispatchEvent(ev);
    };
    const set = (r) => { cs.r = r; camUpd(); };
    const out = { notch: [], multi: [], trackpad: null, range: null, config: (typeof window.__ZOOM_DEBUG__ === 'function') ? (() => { const z = window.__ZOOM_DEBUG__(); return { k: z.k, notchPx: z.notchPx, maxNotch: z.maxNotch, minStepM: z.minStepM, trackpadScale: z.trackpadScale }; })() : null };
    for (const r of ${JSON.stringify(rs)}) {
      if (r > cs.maxR || r < cs.minR) continue;
      set(r); await wait(60);
      const inR = cs.r; fire(-100); await wait(60); const afterIn = cs.r;
      set(r); await wait(60);
      const outR = cs.r; fire(100); await wait(60); const afterOut = cs.r;
      out.notch.push({ r, zoomInStepM: +(inR - afterIn).toFixed(1), zoomInRatio: +(afterIn / inR).toFixed(4),
        zoomOutStepM: +(afterOut - outR).toFixed(1), zoomOutRatio: +(afterOut / outR).toFixed(4) });
    }
    // 2〜4 ノッチでどれだけ段階が変わるか（§18）
    for (const n of [2, 3, 4]) {
      set(3000); await wait(60);
      for (let i = 0; i < n; i++) { fire(-100); await wait(40); }
      out.multi.push({ notches: n, from: 3000, to: +cs.r.toFixed(1), ratio: +(3000 / cs.r).toFixed(3) });
    }
    // §3 トラックパッド（小さい delta の連続）で暴走しないか
    set(3000); await wait(60);
    const tpBefore = cs.r;
    for (let i = 0; i < 12; i++) { fire(-8); await wait(20); }
    out.trackpad = { events: 12, deltaYEach: -8, from: tpBefore, to: +cs.r.toFixed(1), ratio: +(tpBefore / cs.r).toFixed(3),
      detected: (typeof window.__ZOOM_DEBUG__ === 'function') ? window.__ZOOM_DEBUG__().trackpad : null };
    // §5 ズーム range が狭まっていないこと
    set(3000); await wait(60);
    for (let i = 0; i < 80; i++) { fire(-100); }
    await wait(120); const reachedMin = +cs.r.toFixed(1);
    for (let i = 0; i < 120; i++) { fire(100); }
    await wait(120); const reachedMax = +cs.r.toFixed(1);
    out.range = { minR: cs.minR, maxR: cs.maxR, reachedMin, reachedMax,
      minOk: reachedMin <= cs.minR + 1, maxOk: reachedMax >= cs.maxR - 1 };
    return out;
  })()`,
  // moving=true のときは、ゆっくり回しながら測る（ラベルの再選定が実際に走る条件での負荷を見る §17）
  bench: (sec, moving) => `new Promise((resolve) => {
    const ts = [], calls = [];
    const dbg = () => (typeof window.__CITY_LABEL_DEBUG__ === 'function') ? window.__CITY_LABEL_DEBUG__() : null;
    const d0 = dbg(); const s0 = d0 && d0.stability ? d0.stability : null;
    const t0 = performance.now();
    const th0 = cs.th, tx0 = cs.tgt.x, tz0 = cs.tgt.z;
    function f(t) { ts.push(t); if (renderer && renderer.info) calls.push(renderer.info.render.calls);
      if (${moving ? 'true' : 'false'}) {
        const u = (performance.now() - t0) / 1000;
        cs.th = th0 + u * 0.12; cs.tgt.x = tx0 + Math.sin(u * 0.5) * cs.r * 0.12; cs.tgt.z = tz0 + Math.cos(u * 0.5) * cs.r * 0.06;
        camUpd();
      }
      if (performance.now() - t0 < ${sec * 1000}) requestAnimationFrame(f); else done(); }
    function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }
    function done() {
      const dt = []; for (let i = 1; i < ts.length; i++) dt.push(ts[i] - ts[i - 1]);
      const dur = (ts[ts.length - 1] - ts[0]) / 1000;
      const d1 = dbg(); const s1 = d1 && d1.stability ? d1.stability : null;
      const mem = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
      resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1), fpsP5: +pct(dt.map((x) => 1000 / x), 0.05).toFixed(1),
        frameMsP95: +pct(dt, 0.95).toFixed(1), drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
        jsHeapMB: mem == null ? null : +mem.toFixed(1), visibleLabels: d1 ? d1.visible : null,
        relayoutPerSec: (s0 && s1) ? +((s1.relayouts - s0.relayouts) / dur).toFixed(2) : null,
        labelUpdatePerSec: (s0 && s1) ? +(((s1.relayouts + s1.transformRefreshes) - (s0.relayouts + s0.transformRefreshes)) / dur).toFixed(2) : null });
    }
    requestAnimationFrame(f);
  })`,
  // §22 回帰（hover / click / card / search / toggle）
  regression: `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cv = document.querySelector('canvas');
    const cx = Math.round(innerWidth / 2), cy = Math.round(innerHeight * 0.58);
    const mk = (type, x, y) => cv.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 }));
    mk('mousemove', cx, cy); await wait(500);
    const tip = document.getElementById('tip');
    const hover = tip ? getComputedStyle(tip).display : 'none';
    mk('mousedown', cx, cy); mk('mouseup', cx, cy); mk('click', cx, cy); await wait(800);
    const card = document.getElementById('prop-card');
    const cardDisplay = card ? getComputedStyle(card).display : 'none';
    const toggles = {};
    for (const key of ['placeLabels', 'landmarkLabels', 'riverLabels']) {
      const row = document.querySelector('[data-layer-key="' + key + '"]');
      if (!row) { toggles[key] = 'row-absent'; continue; }
      const cb = row.querySelector('input');
      const n0 = window.__CITY_LABEL_DEBUG__().visible;
      cb.click(); await wait(700);
      const n1 = window.__CITY_LABEL_DEBUG__().visible;
      cb.click(); await wait(700);
      toggles[key] = { before: n0, off: n1, on: window.__CITY_LABEL_DEBUG__().visible };
    }
    let search = null;
    try {
      searchInput.value = '難波'; doSearch();
      await wait(2500);
      const spot = findSpot('難波'); const g = geoToThree(spot.lat, spot.lon);
      search = { msgShown: searchMsg.style.display === 'block', distanceM: Math.round(Math.hypot(cs.tgt.x - g.x, cs.tgt.z - g.z)) };
    } catch (e) { search = { error: String(e).slice(0, 120) }; }
    return { hover, cardDisplay, toggles, search };
  })()`,
};

async function settle(page, min = 2500, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function ensureCamera(page, x, z, r, th, ph) {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(JS.camera(x, z, r, th, ph));
    await sleep(900);
    if (await page.evaluate(`(() => Math.abs(cs.tgt.x - (${x})) < 5 && Math.abs(cs.tgt.z - (${z})) < 5 && Math.abs(cs.r - ${r}) < 5)()`)) return true;
  }
  return false;
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/zoom-label-stability-qa/' + name + '.jpg';
}

const avg = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(4) : null;

// 連続した小さな操作の「1 手ごとの入れ替わり」を測る（§19/§20）。
//   jaccardStep    : 隣り合うサンプル間の Jaccard（1.0 = 何も出入りしていない）
//   churnPerStep   : 1 手で出入りしたラベル数
//   majorJaccardStep: 主要ラベル（区・広域地名・主要駅・Tier S）だけの Jaccard（§15/§16）
async function walkMeasure(page, origin, steps) {
  const samples = [];
  let prev = null, prevMajor = null;
  for (const p of steps) {
    await page.evaluate(JS.camera(origin.x + p.dx, origin.z + p.dz, origin.r * p.rk, origin.th + p.dth, origin.ph + p.dph));
    await sleep(520);
    const s = await page.evaluate(JS.probe);
    const rec = { tier: p.tier, label: p.label, count: s.count,
      overlapPairs: s.overlapPairs, severeOverlaps: s.severeOverlaps, duplicates: s.duplicates, minPx: s.minPx };
    if (prev) {
      rec.jaccardStep = jaccard(prev, s.keys);
      const A = new Set(prev), B = new Set(s.keys);
      let ch = 0;
      for (const v of A) if (!B.has(v)) ch++;
      for (const v of B) if (!A.has(v)) ch++;
      rec.churn = ch;
      if (prevMajor && s.majorIds) rec.majorJaccardStep = jaccard(prevMajor, s.majorIds);
    }
    prev = s.keys; prevMajor = s.majorIds;
    samples.push(rec);
  }
  const withStep = samples.filter((s) => s.jaccardStep != null);
  const by = (t) => withStep.filter((s) => s.tier === t);
  const mj = withStep.map((s) => s.majorJaccardStep).filter((v) => v != null);
  return {
    steps: samples.length,
    jaccardStep: avg(withStep.map((s) => s.jaccardStep)),
    jaccardStepMin: withStep.length ? Math.min(...withStep.map((s) => s.jaccardStep)) : null,
    byTier: ['pan', 'rotate', 'jitter', 'zoom'].reduce((m, t) => {
      const a = by(t);
      return a.length ? { ...m, [t]: { jaccardStep: avg(a.map((s) => s.jaccardStep)), churn: avg(a.map((s) => s.churn)), min: Math.min(...a.map((s) => s.jaccardStep)) } } : m;
    }, {}),
    churnPerStep: avg(withStep.map((s) => s.churn)),
    churnMax: withStep.length ? Math.max(...withStep.map((s) => s.churn)) : null,
    majorJaccardStep: mj.length ? avg(mj) : null,
    majorJaccardStepMin: mj.length ? Math.min(...mj) : null,
    maxOverlapPairs: Math.max(...samples.map((s) => s.overlapPairs)),
    maxSevereOverlaps: Math.max(...samples.map((s) => s.severeOverlaps)),
    maxDuplicates: Math.max(...samples.map((s) => s.duplicates)),
    minPx: Math.min(...samples.map((s) => s.minPx).filter((v) => v != null)),
    countRange: [Math.min(...samples.map((s) => s.count)), Math.max(...samples.map((s) => s.count))],
    samples,
  };
}

async function measureStability(page, site) {
  await ensureCamera(page, site.x, site.z, VIEW.r, 0, VIEW.ph);
  await sleep(1200);
  const base = await page.evaluate(JS.probe);
  const w = await walkMeasure(page, { x: site.x, z: site.z, r: VIEW.r, th: 0, ph: VIEW.ph }, walkSteps({ r: VIEW.r }));
  return { site: site.id, siteName: site.name, baseCount: base.count, baseOverlap: base.overlapPairs, ...w };
}

async function run(phase) {
  const url = URLS[phase];
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  const out = { phase, url, generatedAt: new Date().toISOString(), sites: [], errors: [] };
  try {
    await page.send('Page.navigate', { url });
    await sleep(42000);
    const first = SITES[0];
    await page.evaluate(JS.ward(first.x, first.z)); await sleep(2500);
    await ensureCamera(page, first.x, first.z, VIEW.r, 0, VIEW.ph);
    await settle(page);
    // §1/§2/§3/§5 ズーム計測
    out.zoom = await page.evaluate(JS.zoom(ZOOM_PROBE_R), { timeoutMs: 120000 });
    console.log(`[zoom-stab:${phase}] zoom`, JSON.stringify(out.zoom.notch));
    console.log(`[zoom-stab:${phase}] multi/trackpad/range`, JSON.stringify({ multi: out.zoom.multi, trackpad: out.zoom.trackpad, range: out.zoom.range }));

    // §19/§20 ラベル安定度
    for (const s of SITES) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(2200);
      await ensureCamera(page, s.x, s.z, VIEW.r, 0, VIEW.ph);
      await settle(page);
      const rec = await measureStability(page, s);
      rec.shot = await shot(page, `${s.id}-${phase}`);
      out.sites.push(rec);
      console.log(`[zoom-stab:${phase}]`, s.id, JSON.stringify({ base: rec.baseCount, step: rec.jaccardStep, churn: rec.churnPerStep,
        byTier: Object.fromEntries(Object.entries(rec.byTier).map(([k, v]) => [k, v.jaccardStep])),
        major: rec.majorJaccardStep, ovl: rec.maxOverlapPairs, sev: rec.maxSevereOverlaps, dup: rec.maxDuplicates }));
    }

    // City Mode でも同じ測定（引き画面の安定度）
    await page.evaluate(`(() => { CityModeManager.enter(); return 1; })()`);
    await sleep(9000); await settle(page, 2500); await sleep(5000);
    const cityBase = await page.evaluate(JS.probe);
    const cityR = await page.evaluate('(() => +cs.r.toFixed(1))()');
    const cityT = await page.evaluate('(() => [cs.tgt.x, cs.tgt.z, cs.th, cs.ph])()');
    const cw = await walkMeasure(page, { x: cityT[0], z: cityT[1], r: cityR, th: cityT[2], ph: cityT[3] }, walkSteps({ r: cityR }));
    out.cityMode = { r: cityR, baseCount: cityBase.count, byType: cityBase.byType, baseOverlap: cityBase.overlapPairs,
      ...cw, shot: await shot(page, `city-${phase}`) };
    console.log(`[zoom-stab:${phase}] cityMode`, JSON.stringify({ base: out.cityMode.baseCount, step: out.cityMode.jaccardStep,
      churn: out.cityMode.churnPerStep, byTier: Object.fromEntries(Object.entries(out.cityMode.byTier).map(([k, v]) => [k, v.jaccardStep])),
      major: out.cityMode.majorJaccardStep, ovl: out.cityMode.maxOverlapPairs }));

    // §17 性能（City Mode → 各地点）
    out.performance = [];
    out.performance.push({ site: 'cityMode', moving: false, ...(await page.evaluate(JS.bench(20, false), { timeoutMs: 120000 })) });
    out.performance.push({ site: 'cityMode', moving: true, ...(await page.evaluate(JS.bench(20, true), { timeoutMs: 120000 })) });
    await page.evaluate(`(() => { CityModeManager.exit('kita'); return 1; })()`); await sleep(1500);
    for (const id of PERF_SITES) {
      const s = SITES.find((q) => q.id === id);
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(2000);
      await ensureCamera(page, s.x, s.z, 700, 0, Math.PI / 4);
      await settle(page);
      out.performance.push({ site: id, moving: false, ...(await page.evaluate(JS.bench(20, false), { timeoutMs: 120000 })) });
      await ensureCamera(page, s.x, s.z, 700, 0, Math.PI / 4); await sleep(800);
      out.performance.push({ site: id, moving: true, ...(await page.evaluate(JS.bench(20, true), { timeoutMs: 120000 })) });
      console.log(`[zoom-stab:${phase}] perf`, id, JSON.stringify(out.performance.slice(-2)));
    }

    // §22 回帰
    const s0 = SITES[0];
    await page.evaluate(JS.ward(s0.x, s0.z)); await sleep(2000);
    await ensureCamera(page, s0.x, s0.z, 420, 0, Math.PI / 4);
    await settle(page);
    out.regression = await page.evaluate(JS.regression, { timeoutMs: 90000 });
    console.log(`[zoom-stab:${phase}] regression`, JSON.stringify(out.regression));
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }
  return out;
}

async function main() {
  const i = process.argv.indexOf('--phase');
  const phase = (i >= 0 ? process.argv[i + 1] : 'after') === 'before' ? 'before' : 'after';
  const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch { return null; } })();
  const result = await run(phase);
  const doc = { version: 1, generatedAt: new Date().toISOString(), missionId: '33D', view: VIEW, urls: URLS,
    phases: { ...(prev && prev.phases ? prev.phases : {}), [phase]: result } };
  if (doc.phases.before && doc.phases.after) {
    const pick = (ph, id) => doc.phases[ph].sites.find((s) => s.site === id);
    doc.comparison = {
      zoom: ZOOM_PROBE_R.map((r) => {
        const a = doc.phases.before.zoom.notch.find((q) => q.r === r);
        const b2 = doc.phases.after.zoom.notch.find((q) => q.r === r);
        if (!a || !b2) return { r, missing: true };
        return { r, beforeStepM: a.zoomInStepM, afterStepM: b2.zoomInStepM,
          gain: +(b2.zoomInStepM / Math.max(0.01, a.zoomInStepM)).toFixed(2),
          beforeRatio: a.zoomInRatio, afterRatio: b2.zoomInRatio };
      }),
      stability: SITES.map((s) => {
        const a = pick('before', s.id), b2 = pick('after', s.id);
        if (!a || !b2) return { site: s.id, missing: true };
        const tier = (rec, t) => (rec.byTier && rec.byTier[t]) ? rec.byTier[t].jaccardStep : null;
        return { site: s.id, siteName: s.name,
          jaccardStep: { before: a.jaccardStep, after: b2.jaccardStep },
          churnPerStep: { before: a.churnPerStep, after: b2.churnPerStep },
          pan: { before: tier(a, 'pan'), after: tier(b2, 'pan') },
          rotate: { before: tier(a, 'rotate'), after: tier(b2, 'rotate') },
          jitter: { before: tier(a, 'jitter'), after: tier(b2, 'jitter') },
          zoom: { before: tier(a, 'zoom'), after: tier(b2, 'zoom') },
          baseCount: { before: a.baseCount, after: b2.baseCount } };
      }),
      cityMode: { jaccardStep: { before: doc.phases.before.cityMode.jaccardStep, after: doc.phases.after.cityMode.jaccardStep },
        churnPerStep: { before: doc.phases.before.cityMode.churnPerStep, after: doc.phases.after.cityMode.churnPerStep } },
      performance: (doc.phases.after.performance || []).map((p) => {
        const a = (doc.phases.before.performance || []).find((q) => q.site === p.site && q.moving === p.moving);
        return { site: p.site, moving: p.moving, fps: { before: a ? a.fpsAverage : null, after: p.fpsAverage },
          frameMsP95: { before: a ? a.frameMsP95 : null, after: p.frameMsP95 },
          relayoutPerSec: { before: a ? a.relayoutPerSec : null, after: p.relayoutPerSec },
          labelUpdatePerSec: { before: a ? a.labelUpdatePerSec : null, after: p.labelUpdatePerSec } };
      }),
    };
  }
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  return doc;
}

if (isMainModule(import.meta.url)) {
  main().then((d) => { console.log('[zoom-stab] out', OUT, JSON.stringify(Object.keys(d.phases))); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
