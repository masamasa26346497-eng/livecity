#!/usr/bin/env node
// tools/audit/directional-balance-qa.js
// [Mission 35I §11/§12/§14] 同じ地点・同じズームでカメラの方位だけを変え、
//   画面がどれだけ明暗するかを 35H と 35I で比べる。
//
//   「見えている壁の平均明度」を推定で語らず、**実際に描かれた画素** を読む。
//   WebGL の描画直後に gl.readPixels で読み取れば、tone mapping も光も全部込みの値になる。
//
//   前提: `npm run preview`。対象は dev。production は触らない（§0）。
//   出力: data/reports/directional-balance-qa.json
//         data/reports/directional-balance-qa/<site>.<az>.<tuning>.jpg
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
export const OUT = P('data', 'reports', 'directional-balance-qa.json');
export const SHOTS = P('data', 'reports', 'directional-balance-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** §11 の必須地点。 */
export const SITES = [
  { id: 'umeda', label: '梅田', lat: 34.70250, lon: 135.49586 },
  { id: 'honmachi', label: '本町', lat: 34.68200, lon: 135.49900 },
  { id: 'namba', label: '難波', lat: 34.66600, lon: 135.50100 },
];
/** §11 6 方向（北 / 北東 / 東 / 南東 / 南 / 南西 / 西 / 北西 のうち主要 6 つ）。 */
export const AZIMUTHS = [0, 60, 120, 180, 240, 300];
export const VIEW = { r: 620, phDeg: 36, fov: 44 };
export const TUNINGS = ['35H', '35I'];
export const PERF_SECONDS = 12;
/** §12 方向別の平均輝度の「最大 / 最小」がこれ以下なら方向依存が十分小さい。 */
export const LUMA_RATIO_TARGET = 1.30;
/** §13 暗い方向でも下回ってはいけない画面平均輝度（0..1）。 */
export const MIN_SCENE_LUMA = 0.35;
/** §13 明るい方向で白飛びとみなす画素の割合の上限。 */
export const MAX_CLIPPED_FRACTION = 0.02;

export function worldOf(s) {
  const w = latLonToLiveCityWorld(s.lat, s.lon);
  return { x: Math.round(w.x), z: Math.round(w.z) };
}

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  /** 方位 az（北=0・東=90）を向くようにカメラを置く。距離・俯角・fov は固定。 */
  camera: (x, z, az) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    CAMERA_MODE_FOV[cameraMode] = ${VIEW.fov};
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${VIEW.r};
    cs.ph = (90 - ${VIEW.phDeg}) * Math.PI / 180;
    cs.th = ${(az * Math.PI / 180).toFixed(6)};
    camUpd(); return { th: cs.th, r: cs.r, ph: cs.ph }; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  depth: `JSON.stringify(window.__VISUAL_DEPTH_DEBUG__())`,
  setTuning: (t) => `JSON.stringify(window.__VISUAL_TUNING__('${t}'))`,
  /**
   * §12 画面の輝度。描いた直後に gl.readPixels で読む
   * （preserveDrawingBuffer なしでも同じ tick 内なら読める）。
   * 全画素は重いので 1/4 に間引く。UI の画素を拾わないよう、
   * 画面中央 80%（上下左右 10% を除く）だけを見る。
   */
  luma: `(() => {
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const W = renderer.domElement.width, H = renderer.domElement.height;
    const x0 = Math.floor(W * 0.10), y0 = Math.floor(H * 0.10);
    const w = Math.floor(W * 0.80), h = Math.floor(H * 0.80);
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0, n = 0, clipped = 0, dark = 0;
    let rs = 0, gs = 0, bs = 0;
    const hist = new Array(10).fill(0);
    for (let i = 0; i < buf.length; i += 16) {   // 4 画素に 1 つ
      const r = buf[i] / 255, g = buf[i + 1] / 255, b = buf[i + 2] / 255;
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += y; n++; rs += r; gs += g; bs += b;
      if (r > 0.98 && g > 0.98 && b > 0.98) clipped++;
      if (y < 0.25) dark++;
      hist[Math.min(9, Math.floor(y * 10))]++;
    }
    const mean = sum / n;
    // §10 画面全体の色味（暗い方向で青へ寄っていないか）
    const mr = rs / n, mg = gs / n, mb = bs / n;
    return { mean: +mean.toFixed(4), samples: n,
      clippedFraction: +(clipped / n).toFixed(4), darkFraction: +(dark / n).toFixed(4),
      rgb: { r: +mr.toFixed(4), g: +mg.toFixed(4), b: +mb.toFixed(4) },
      blueBias: +((mb - mr) / Math.max(1e-6, mean)).toFixed(4),
      hist };
  })()`,
  /**
   * §12 建物だけの輝度。建物 mesh 以外をいったん隠して測り、元へ戻す。
   * 画面輝度は地表や背景に薄められるので、建物そのものの沈み込みはこちらで見る。
   */
  buildingLuma: `(() => {
    const hidden = [];
    scene.traverse((o) => {
      if (!o.isMesh && !o.isLineSegments) return;
      if (!o.visible) return;
      if (o.userData && o.userData.usageCategory != null) return;   // 建物は残す
      let q = o, keep = false;
      while (q) { if (q.name === 'CR_buildingLodHigh' || q.name === 'LandmarkHDLayer') { keep = true; break; } q = q.parent; }
      if (keep) return;
      o.visible = false; hidden.push(o);
    });
    let out = null;
    try {
      renderer.render(scene, camera);
      const gl = renderer.getContext();
      const W = renderer.domElement.width, H = renderer.domElement.height;
      const x0 = Math.floor(W * 0.10), y0 = Math.floor(H * 0.10);
      const w = Math.floor(W * 0.80), h = Math.floor(H * 0.80);
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      // 背景（空・地表なし）の画素は除く。背景色はほぼ一定なので、
      //   クリア色と同じ画素を落とす。
      const cc = renderer.getClearColor(new THREE.Color());
      const cr = Math.round(cc.r * 255), cg = Math.round(cc.g * 255), cb = Math.round(cc.b * 255);
      let sum = 0, n = 0, min = 1, max = 0;
      for (let i = 0; i < buf.length; i += 16) {
        const R = buf[i], G = buf[i + 1], B = buf[i + 2];
        if (Math.abs(R - cr) < 4 && Math.abs(G - cg) < 4 && Math.abs(B - cb) < 4) continue;
        const y = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
        sum += y; n++; if (y < min) min = y; if (y > max) max = y;
      }
      out = n ? { mean: +(sum / n).toFixed(4), min: +min.toFixed(4), max: +max.toFixed(4), pixels: n }
        : { mean: null, min: null, max: null, pixels: 0 };
    } finally {
      for (const o of hidden) o.visible = true;
      renderer.render(scene, camera);
    }
    return out;
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
          trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)) });
      } }
    requestAnimationFrame(f); })`,
  /** §15 回帰。 */
  regression: `(() => {
    const r = {};
    try { r.roadMode = __SEMANTIC_DISPLAY_DEBUG__().normalViewRoadMode; } catch (e) { r.roadMode = 'ERR'; }
    try { r.buildingsVersion = CanonicalRuntime.getBuildingsVersionDebug().version; } catch (e) { r.buildingsVersion = 'ERR'; }
    try { r.selfCheck = __CANONICAL_SELF_CHECK__().total; } catch (e) { r.selfCheck = -1; }
    try { r.highLod = !!(window.__BUILDING_LOD_DEBUG__ && window.__BUILDING_LOD_DEBUG__()); } catch (e) { r.highLod = false; }
    try { r.labels = (typeof window.__CITY_LABEL_DEBUG__ === 'function' && window.__CITY_LABEL_DEBUG__()) ? 'ok' : 'missing'; } catch (e) { r.labels = 'ERR'; }
    try { r.labelsVisible = window.__CITY_LABEL_DEBUG__().visible; } catch (e) { r.labelsVisible = -1; }
    try { r.search = typeof findSpot === 'function'; } catch (e) { r.search = false; }
    try { r.hover = typeof pickHit === 'function'; } catch (e) { r.hover = false; }
    let hit = null;
    for (let gy = 0.35; gy <= 0.65 && !hit; gy += 0.05) {
      for (let gx = 0.3; gx <= 0.7 && !hit; gx += 0.05) {
        const h = pickHit({ clientX: Math.round(innerWidth * gx), clientY: Math.round(innerHeight * gy) });
        if (h && h.d && h.d.id) hit = h;
      }
    }
    r.pick = !!hit;
    if (hit) { try { selectBuilding({ clientX: innerWidth / 2, clientY: innerHeight / 2 }, hit); } catch (e) { r.cardError = String(e.message); }
      const el = document.getElementById('prop-card');
      r.card = !!(el && el.style.display !== 'none');
      r.cardHasWard = !!(el && /区/.test(el.innerText || '')); }
    const tags = new Set();
    scene.traverse((o) => { if (o.name) tags.add(o.name); const cp = o.userData && o.userData.creationPath; if (cp) tags.add(cp); });
    const has = (re) => [...tags].some((n) => re.test(n));
    r.hasRail = has(/rail/i); r.hasWater = has(/water|river/i);
    r.hasParks = has(/park/i); r.hasRoad = has(/road/i); r.hasBuildings = has(/BUILDING/i);
    return r;
  })()`,
};

const HIDE_UI = `(() => {
  for (const el of document.querySelectorAll('div,button')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|layer-toggle|^tip$|search-box|^pl$|^pr$|^lc-panel|^lc-topbar|^controls$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery/.test(id)) el.style.display = 'none'; }
  return 1; })()`;

async function settle(page, min = 2500, max = 120000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/directional-balance-qa/' + name + '.jpg';
}

/** 方向ごとの平均から、方向依存の指標を出す。 */
export function directionStats(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  const min = Math.min(...v), max = Math.max(...v);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { min: +min.toFixed(4), max: +max.toFixed(4), mean: +mean.toFixed(4),
    range: +(max - min).toFixed(4), ratio: +(max / Math.max(1e-6, min)).toFixed(4),
    sd: +sd.toFixed(4), cv: +(sd / Math.max(1e-6, mean)).toFixed(4) };
}

export async function run() {
  const t0 = Date.now();
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35I', url: URL_,
    view: VIEW, azimuths: AZIMUTHS, tunings: {}, performance: [], regression: null, errors: [] };
  const b = await launchBrowser({ width: 1400, height: 900 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    await page.evaluate(HIDE_UI);

    for (const tuning of TUNINGS) {
      await page.evaluate(JS.setTuning(tuning));
      await sleep(1500);
      const rec = { tuning, depth: null, sites: [] };
      for (const s of SITES) {
        const w = worldOf(s);
        await page.evaluate(JS.ward(w.x, w.z)); await sleep(2200);
        const dirs = [];
        for (const az of AZIMUTHS) {
          await page.evaluate(JS.camera(w.x, w.z, az));
          await settle(page);
          await page.evaluate(HIDE_UI); await sleep(700);
          const luma = await page.evaluate(JS.luma, { timeoutMs: 120000 });
          const bl = await page.evaluate(JS.buildingLuma, { timeoutMs: 120000 });
          dirs.push({ az, luma, building: bl, shot: await shot(page, `${s.id}.az${az}.${tuning}`) });
        }
        const sceneStats = directionStats(dirs.map((d) => d.luma.mean));
        const bldgStats = directionStats(dirs.map((d) => d.building.mean));
        rec.sites.push({ ...s, world: w, dirs, sceneStats, bldgStats });
        console.log('[dir]', tuning, s.id.padEnd(9),
          '画面', dirs.map((d) => d.luma.mean.toFixed(3)).join(' '),
          '| 幅', sceneStats.range.toFixed(3), '比', sceneStats.ratio.toFixed(3));
        console.log('[dir]', tuning, ''.padEnd(9),
          '建物', dirs.map((d) => (d.building.mean == null ? '  -  ' : d.building.mean.toFixed(3))).join(' '),
          '| 幅', bldgStats ? bldgStats.range.toFixed(3) : '-', '比', bldgStats ? bldgStats.ratio.toFixed(3) : '-');
      }
      // 状態と性能
      const w0 = worldOf(SITES[0]);
      await page.evaluate(JS.ward(w0.x, w0.z)); await sleep(2000);
      await page.evaluate(JS.camera(w0.x, w0.z, 0));
      await settle(page);
      rec.depth = JSON.parse(await page.evaluate(JS.depth));
      const perf = await page.evaluate(JS.bench(PERF_SECONDS), { timeoutMs: 120000 });
      out.performance.push({ tuning, id: 'umeda', ...perf });
      console.log('[dir] perf', tuning, 'fps', perf.fpsAverage, 'p95', perf.frameMsP95 + 'ms',
        'calls', perf.drawCallsAvg, 'tri', perf.trianglesAvg);
      out.tunings[tuning] = rec;
    }
    // §15 回帰（35I の状態で）
    await page.evaluate(JS.setTuning('35I'));
    await sleep(1500);
    const w0 = worldOf(SITES[0]);
    await page.evaluate(JS.ward(w0.x, w0.z)); await sleep(2200);
    await page.evaluate(JS.camera(w0.x, w0.z, 0));
    await settle(page);
    out.regression = await page.evaluate(JS.regression, { timeoutMs: 120000 });
    console.log('[dir] regression', JSON.stringify(out.regression));
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }

  // ── まとめ ──────────────────────────────────────────────────────────
  const agg = (tuning, key) => {
    const rec = out.tunings[tuning];
    if (!rec) return null;
    const stats = rec.sites.map((s) => s[key]).filter(Boolean);
    return { worstRatio: +Math.max(...stats.map((x) => x.ratio)).toFixed(4),
      worstRange: +Math.max(...stats.map((x) => x.range)).toFixed(4),
      minMean: +Math.min(...stats.map((x) => x.min)).toFixed(4),
      maxMean: +Math.max(...stats.map((x) => x.max)).toFixed(4),
      bySite: Object.fromEntries(rec.sites.map((s) => [s.id, s[key]])) };
  };
  const oldScene = agg('35H', 'sceneStats'), newScene = agg('35I', 'sceneStats');
  const oldBldg = agg('35H', 'bldgStats'), newBldg = agg('35I', 'bldgStats');
  const allDirs = (t) => out.tunings[t].sites.flatMap((s) => s.dirs);
  const perfOf = (t) => out.performance.find((p) => p.tuning === t);
  const pa = perfOf('35H'), pb = perfOf('35I');
  const r = out.regression || {};
  out.summary = {
    scene: { old: oldScene, new: newScene },
    building: { old: oldBldg, new: newBldg },
    // §17 方向依存が小さくなったか（建物の輝度で見る。画面は背景に薄まるため）
    directionDependentBrightnessReduced: !!(oldBldg && newBldg && newBldg.worstRatio < oldBldg.worstRatio),
    buildingRatioOldNew: oldBldg && newBldg ? [oldBldg.worstRatio, newBldg.worstRatio] : null,
    ratioWithinTarget: !!(newBldg && newBldg.worstRatio <= LUMA_RATIO_TARGET),
    // §13 暗い方向でも街が見える
    darkFacingViewStillReadable: !!(newScene && newScene.minMean >= MIN_SCENE_LUMA),
    darkestSceneLuma: { old: oldScene ? oldScene.minMean : null, new: newScene ? newScene.minMean : null },
    // §13 明るい方向で白飛びしない
    brightFacingViewNotWashedOut: allDirs('35I').every((d) => d.luma.clippedFraction <= MAX_CLIPPED_FRACTION),
    maxClippedFraction: { old: +Math.max(...allDirs('35H').map((d) => d.luma.clippedFraction)).toFixed(4),
      new: +Math.max(...allDirs('35I').map((d) => d.luma.clippedFraction)).toFixed(4) },
    // §10 暗い方向で青へ寄らない
    blueBias: { old: +Math.max(...allDirs('35H').map((d) => d.luma.blueBias)).toFixed(4),
      new: +Math.max(...allDirs('35I').map((d) => d.luma.blueBias)).toFixed(4) },
    // §7/§13 立体感（接地の陰と屋根/壁の差）が残っているか
    shades: { old: out.tunings['35H'].depth.shades, new: out.tunings['35I'].depth.shades },
    style: { old: out.tunings['35H'].depth.style, new: out.tunings['35I'].depth.style },
    wallShades: { old: out.tunings['35H'].depth.wallShades, new: out.tunings['35I'].depth.wallShades },
    // §14 性能
    perf: pa && pb ? { old: pa, new: pb,
      fpsDropPct: +(((pa.fpsAverage - pb.fpsAverage) / pa.fpsAverage) * 100).toFixed(1),
      drawCallsSame: pb.drawCallsAvg <= pa.drawCallsAvg * 1.02,
      trianglesSame: pb.trianglesAvg <= pa.trianglesAvg * 1.02 } : null,
    // §15 回帰
    regressionOk: !!(r.roadMode === 'ROAD_V3' && r.buildingsVersion === 'V4' && r.selfCheck === 0
      && r.highLod && r.labels === 'ok' && r.search && r.hover && r.pick && r.card && r.cardHasWard
      && r.hasRail && r.hasWater && r.hasParks && r.hasRoad && r.hasBuildings),
    regression: r,
    jsErrors: out.errors.length,
    elapsedMs: Date.now() - t0,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { console.log('[dir] summary', JSON.stringify(o.summary, null, 1).slice(0, 3000)); console.log('[dir] out', OUT); })
    .catch((e) => { console.error(e); process.exit(1); });
}
