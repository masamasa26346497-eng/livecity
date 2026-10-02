#!/usr/bin/env node
// tools/audit/high-lod-visual-qa.js
// [Mission 34B §2/§28/§29] 高 LOD の見え方（屋根形状が分かるか）を実ブラウザで測る。
//   --phase before : 変更前の見え方を記録
//   --phase after  : 変更後を同じ camera で記録して比べる
//   各地点で LOD1 ONLY / HIGH LOD / LOD DIFF の 3 枚を撮り、
//   屋根面と壁面の明るさの差・面の向きの分布・性能を数値で残す。
//   前提: `npm run preview`。出力: data/reports/high-lod-visual-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const OUT = P('data', 'reports', 'high-lod-visual-qa.json');
const SHOTS = P('data', 'reports', 'high-lod-visual-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// §23-§27 の 5 地点。camera は屋根面と壁面を同時に見られる斜め視点（§13）。
export const SITES = [
  { id: 'honmachi', name: '本町', x: -2073, z: -8693 },
  { id: 'umeda', name: '梅田', x: -2668, z: -10942 },
  { id: 'nakanoshima', name: '中之島', x: -2620, z: -9942 },
  { id: 'osakacastle', name: '大阪城', x: 76, z: -9258 },
  { id: 'shinosaka', name: '新大阪', x: -2110, z: -14380 },
];
// cs.ph は天頂角（0 = 真上）。§13 の pitch 50°（水平からの見下ろし角）= ph 40°。
export const VIEW = { r: 900, ph: ((90 - 50) * Math.PI) / 180, th: (-35 * Math.PI) / 180, fov: 44 };
export const PERF_SITES = ['honmachi', 'umeda', 'nakanoshima', 'shinosaka'];

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  // camUpd() は毎フレーム CAMERA_MODE_FOV から fov を書き戻すので、fov はそちらへ入れる
  camera: (x, z, r, ph, th) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); CAMERA_MODE_FOV[cameraMode] = ${VIEW.fov}; cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = ${th}; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  lod: `(() => window.__BUILDING_LOD_DEBUG__())()`,
  setLod: (on) => `(() => window.__BUILDING_LOD_TOGGLE__(${on ? 'true' : 'false'}))()`,
  setMode: (m) => `(() => (typeof window.__BUILDING_LOD_MODE__ === 'function') ? window.__BUILDING_LOD_MODE__('${m}') : null)()`,
  lighting: `(() => { const d = sun.position.clone().sub(sun.target.position); return ({
    exposure: +renderer.toneMappingExposure.toFixed(3),
    hemi: { intensity: +hemiLight.intensity.toFixed(3), sky: '#' + hemiLight.color.getHexString(), ground: '#' + hemiLight.groundColor.getHexString() },
    sun: { intensity: +sun.intensity.toFixed(3), color: '#' + sun.color.getHexString(), visible: sun.visible,
      position: [Math.round(sun.position.x), Math.round(sun.position.y), Math.round(sun.position.z)],
      target: [Math.round(sun.target.position.x), Math.round(sun.target.position.y), Math.round(sun.target.position.z)],
      direction: [Math.round(d.x), Math.round(d.y), Math.round(d.z)],
      elevationDeg: +(Math.atan2(d.y, Math.hypot(d.x, d.z)) * 180 / Math.PI).toFixed(1),
      azimuthDeg: +(((Math.atan2(d.x, -d.z) * 180 / Math.PI) + 360) % 360).toFixed(1),
      shadowExtent: sun.shadow ? sun.shadow.camera.right : null, castShadow: sun.castShadow },
    fill: { intensity: +fillLight.intensity.toFixed(3), color: '#' + fillLight.color.getHexString(),
      position: [Math.round(fillLight.position.x), Math.round(fillLight.position.y), Math.round(fillLight.position.z)] },
    shadowEnabled: typeof shadowEnabled !== 'undefined' ? shadowEnabled : null,
  }); })()`,
  // §2/§3 屋根面と壁面の明るさの差を測る。
  //   高 LOD メッシュの三角形を法線の向きで「上向き(屋根)」「横向き(壁)」に分け、
  //   頂点カラー×ランバート項で受ける光を計算して平均を取る（描画と同じ式）。
  roofWall: `(() => {
    const out = { roofTris: 0, wallTris: 0, roofLum: 0, wallLum: 0, roofColorLum: 0, wallColorLum: 0, meshes: 0, material: null };
    // 光の向きは position ではなく (position − target)。34B で太陽が注視点へ追従するように
    //   なったため、position だけを正規化すると全く別の向きになる（target が原点のときだけ一致する）。
    const sunDir = sun.position.clone().sub(sun.target.position).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    scene.traverse((o) => {
      if (!o.isMesh || !o.userData || !o.userData.lodHigh || !o.visible) return;
      let q = o, vis = true; while (q) { if (q.visible === false) { vis = false; break; } q = q.parent; }
      if (!vis) return;
      out.meshes++;
      if (!out.material) out.material = o.material.type + (o.material.vertexColors ? '+vc' : '');
      const pos = o.geometry.getAttribute('position'), col = o.geometry.getAttribute('color'), idx = o.geometry.index;
      const step = Math.max(3, Math.floor(idx.count / 3 / 400) * 3);   // 間引いて 400 三角形程度
      for (let i = 0; i + 2 < idx.count; i += step) {
        const i0 = idx.getX(i), i1 = idx.getX(i + 1), i2 = idx.getX(i + 2);
        a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
        b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
        c.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
        e1.subVectors(b, a); e2.subVectors(c, a); n.crossVectors(e1, e2);
        if (n.lengthSq() < 1e-9) continue;
        n.normalize();
        const upness = Math.abs(n.dot(up));
        const cr = col ? (col.getX(i0) + col.getX(i1) + col.getX(i2)) / 3 : 1;
        const cg = col ? (col.getY(i0) + col.getY(i1) + col.getY(i2)) / 3 : 1;
        const cb = col ? (col.getZ(i0) + col.getZ(i1) + col.getZ(i2)) / 3 : 1;
        const colorLum = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
        const ndl = Math.max(0, Math.abs(n.dot(sunDir)));
        const lit = colorLum * (sun.intensity * ndl + hemiLight.intensity * (0.5 + 0.5 * n.y) + fillLight.intensity * 0.3);
        if (upness > 0.7) { out.roofTris++; out.roofLum += lit; out.roofColorLum += colorLum; }
        else if (upness < 0.35) { out.wallTris++; out.wallLum += lit; out.wallColorLum += colorLum; }
      }
    });
    if (out.roofTris) { out.roofLum /= out.roofTris; out.roofColorLum /= out.roofTris; }
    if (out.wallTris) { out.wallLum /= out.wallTris; out.wallColorLum /= out.wallTris; }
    out.litRatio = out.wallLum ? +(out.roofLum / out.wallLum).toFixed(3) : null;
    out.colorRatio = out.wallColorLum ? +(out.roofColorLum / out.wallColorLum).toFixed(3) : null;
    out.roofLum = +out.roofLum.toFixed(4); out.wallLum = +out.wallLum.toFixed(4);
    out.roofColorLum = +out.roofColorLum.toFixed(4); out.wallColorLum = +out.wallColorLum.toFixed(4);
    return out;
  })()`,
  // §1 geometry が変わっていないことの指紋。タイルごとに「頂点数 / 座標の合計 / bbox」を取る。
  //   material も色も指紋に入れないので、before / after で完全一致すれば
  //   「見た目だけ変えて形は 1mm も動かしていない」ことの直接の証拠になる。
  geomFp: `(() => {
    const out = {};
    scene.traverse((o) => {
      if (!o.isMesh || !o.userData || !o.userData.lodHigh) return;
      let g = o.parent; while (g && !/^CR_lodHigh_/.test(g.name || '')) g = g.parent;
      if (!g) return;
      const k = g.name + '|' + (o.userData.lodHigh.kind || '?');
      const pos = o.geometry.getAttribute('position');
      let sx = 0, sy = 0, sz = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        sx += x; sy += y; sz += z;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      out[k] = [pos.count, +sx.toFixed(2), +sy.toFixed(2), +sz.toFixed(2),
        +x0.toFixed(3), +x1.toFixed(3), +y0.toFixed(3), +y1.toFixed(3), +z0.toFixed(3), +z1.toFixed(3),
        (o.geometry.index ? o.geometry.index.count : 0), (o.userData.lodHigh.ranges || []).length].join(',');
    });
    return out;
  })()`,
  // 画面の統計（明るさ・色数・面の階調の豊かさ）
  pixels: `(() => {
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const w = 400, h = Math.max(1, Math.round(w * src.height / src.width));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let lum = 0, n = 0; const colors = new Set(); const hist = new Array(16).fill(0);
    let gradSum = 0, gradN = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const L = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      lum += L; n++;
      colors.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3));
      hist[Math.min(15, Math.floor(L * 16))]++;
      if (x + 1 < w) { const j = i + 4; const L2 = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255; gradSum += Math.abs(L2 - L); gradN++; }
    }
    return { meanLuminance: +(lum / n).toFixed(4), distinctColors: colors.size,
      localContrast: +(gradSum / Math.max(1, gradN)).toFixed(5),
      histogram: hist.map((v) => +(v / n).toFixed(4)) };
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
          visibleHighLod: d ? d.visibleLod2 + d.visibleLod3 : null });
      } }
    requestAnimationFrame(f);
  })`,
};

async function settle(page, min = 2500, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function ensureCamera(page, x, z, r, ph, th) {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(JS.camera(x, z, r, ph, th));
    await sleep(900);
    if (await page.evaluate(`(() => Math.abs(cs.tgt.x - (${x})) < 5 && Math.abs(cs.tgt.z - (${z})) < 5 && Math.abs(cs.r - ${r}) < 5)()`)) return true;
  }
  return false;
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/high-lod-visual-qa/' + name + '.jpg';
}
// dev パネルを隠してから撮る（見た目の比較にパネルが入らないように）
const HIDE_UI = `(() => { for (const el of document.querySelectorAll('div')) { const id = el.id || ''; if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|layer-toggle|prop-card|^tip$|search-box|^pl$|^pr$/.test(id)) el.style.display = 'none'; } return 1; })()`;

export async function run(phase, only) {
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  const out = { phase, url: URL_, generatedAt: new Date().toISOString(),
    view: { r: VIEW.r, pitchDeg: 50, zenithRad: +VIEW.ph.toFixed(4), headingDeg: -35, fov: VIEW.fov }, sites: [], errors: [] };
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    await page.evaluate(HIDE_UI);
    out.lighting = await page.evaluate(JS.lighting);
    console.log(`[hilod-vis:${phase}] lighting`, JSON.stringify(out.lighting));

    for (const s of (only === 'perf' ? [] : SITES)) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(2500);
      await ensureCamera(page, s.x, s.z, VIEW.r, VIEW.ph, VIEW.th);
      await settle(page);
      await page.evaluate(HIDE_UI);
      await sleep(2500);
      const rec = { site: s.id, siteName: s.name, lighting: await page.evaluate(JS.lighting) };
      // HIGH LOD
      await page.evaluate(JS.setLod(true));
      await page.evaluate(JS.setMode('high'));
      await sleep(2500);
      rec.high = { lod: await page.evaluate(JS.lod), roofWall: await page.evaluate(JS.roofWall),
        geomFp: await page.evaluate(JS.geomFp), pixels: await page.evaluate(JS.pixels),
        shot: await shot(page, `${s.id}-high-${phase}`) };
      // LOD1 ONLY
      await page.evaluate(JS.setMode('lod1'));
      await page.evaluate(JS.setLod(false));
      await sleep(3000); await settle(page, 1500); await sleep(1500);
      rec.lod1 = { pixels: await page.evaluate(JS.pixels), shot: await shot(page, `${s.id}-lod1-${phase}`) };
      // LOD DIFF（QA）
      await page.evaluate(JS.setLod(true));
      await page.evaluate(JS.setMode('diff'));
      await sleep(3000); await settle(page, 1500); await sleep(1500);
      rec.diff = { pixels: await page.evaluate(JS.pixels), shot: await shot(page, `${s.id}-diff-${phase}`) };
      await page.evaluate(JS.setMode('high'));
      await sleep(1500);
      out.sites.push(rec);
      console.log(`[hilod-vis:${phase}]`, s.id, JSON.stringify({
        high: rec.high.lod ? rec.high.lod.visibleLod2 + rec.high.lod.visibleLod3 : null,
        roofWallLit: rec.high.roofWall.litRatio, roofWallColor: rec.high.roofWall.colorRatio,
        roofTris: rec.high.roofWall.roofTris, wallTris: rec.high.roofWall.wallTris,
        lumHigh: rec.high.pixels.meanLuminance, lumLod1: rec.lod1.pixels.meanLuminance,
        contrastHigh: rec.high.pixels.localContrast, contrastLod1: rec.lod1.pixels.localContrast,
      }));
    }

    // §28 性能（LOD1 ONLY / HIGH LOD）
    out.performance = [];
    for (const on of [true, false]) {
      await page.evaluate(JS.setLod(on)); await sleep(1800);
      for (const id of PERF_SITES) {
        const s = SITES.find((q) => q.id === id);
        await page.evaluate(JS.ward(s.x, s.z)); await sleep(2000);
        await ensureCamera(page, s.x, s.z, VIEW.r, VIEW.ph, VIEW.th);
        await settle(page);
        const r = await page.evaluate(JS.bench(30), { timeoutMs: 120000 });
        out.performance.push({ site: id, highLod: on, ...r });
        console.log(`[hilod-vis:${phase}] perf`, id, 'high=' + on, JSON.stringify({ fps: r.fpsAverage, p5: r.fpsP5, tri: r.trianglesAvg, draw: r.drawCallsAvg }));
      }
    }
    await page.evaluate(JS.setLod(true));
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }
  return out;
}

async function main() {
  const i = process.argv.indexOf('--phase');
  const phase = (i >= 0 ? process.argv[i + 1] : 'after') === 'before' ? 'before' : 'after';
  const j = process.argv.indexOf('--only');
  const only = j >= 0 ? process.argv[j + 1] : null;      // 'perf' で性能だけ測り直す
  const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch { return null; } })();
  const result = await run(phase, only);
  const kept = (only === 'perf' && prev && prev.phases && prev.phases[phase]) ? prev.phases[phase] : null;
  const merged = kept ? { ...kept, performance: result.performance, performanceMeasuredAt: result.generatedAt,
    lightingAtPerf: result.lighting, errors: result.errors } : result;
  const doc = { version: 1, generatedAt: new Date().toISOString(), missionId: '34B', view: merged.view || result.view,
    phases: { ...(prev && prev.phases ? prev.phases : {}), [phase]: merged } };
  if (doc.phases.before && doc.phases.after) {
    doc.comparison = SITES.map((s) => {
      const a = doc.phases.before.sites.find((q) => q.site === s.id);
      const b2 = doc.phases.after.sites.find((q) => q.site === s.id);
      if (!a || !b2) return { site: s.id, missing: true };
      // §1 geometry 不変の照合（両方の phase に出ていたタイルだけを比べる）
      const fa = a.high.geomFp || {}, fb = b2.high.geomFp || {};
      const shared = Object.keys(fa).filter((k) => fb[k] != null);
      const changed = shared.filter((k) => fa[k] !== fb[k]);
      return { site: s.id, siteName: s.name,
        geometry: { comparedMeshes: shared.length, changedMeshes: changed.length, changedSample: changed.slice(0, 3),
          onlyBefore: Object.keys(fa).length - shared.length, onlyAfter: Object.keys(fb).length - shared.length },
        roofWallLitRatio: { before: a.high.roofWall.litRatio, after: b2.high.roofWall.litRatio },
        roofWallColorRatio: { before: a.high.roofWall.colorRatio, after: b2.high.roofWall.colorRatio },
        meanLuminance: { before: a.high.pixels.meanLuminance, after: b2.high.pixels.meanLuminance },
        localContrast: { before: a.high.pixels.localContrast, after: b2.high.pixels.localContrast },
        contrastVsLod1: { before: +(a.high.pixels.localContrast - a.lod1.pixels.localContrast).toFixed(5),
          after: +(b2.high.pixels.localContrast - b2.lod1.pixels.localContrast).toFixed(5) } };
    });
    doc.lighting = { before: doc.phases.before.lighting, after: doc.phases.after.lighting };
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  return doc;
}

if (isMainModule(import.meta.url)) {
  main().then((d) => { console.log('[hilod-vis] out', OUT, JSON.stringify(Object.keys(d.phases))); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
