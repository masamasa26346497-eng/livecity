#!/usr/bin/env node
// tools/audit/v2-runtime-browser-qa.js
// [Mission 32P §3/§15-§23/§19-§20] 実ブラウザ（Edge headless・実 GPU）で development runtime を確認する。
//   - default 起動: V2N だけを fetch（V1 / 旧 OSM namespace への fetch 0）
//   - 性能: 梅田・住吉で V1 と V2N を同一 camera で 30 秒ずつ静止計測（FPS 平均 / p5、frame ms p95、draw calls、
//     triangles、JS heap、読み込み中 tile）
//   - picking / hover / property card（実際に画面をクリック）
//   - 区切替・City Mode 後も V2N のまま
//   - 目視 fixture のスクリーンショット（9 地点 + 大川・淀川 + SUPPRESS 地点 + 梅田 A/B）
//   前提: `npm run preview`（http://localhost:8000）が起動していること。
//   出力: data/reports/v2-runtime-performance.json、data/reports/v2-visual-qa/*.jpg
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { readFileRetry } from '../lib/synced-dir-writer.js';
import { pointInRingXZ } from '../lib/osm-building-fallback.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  url: process.env.LIVECITY_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html',
  shots: P('data', 'reports', 'v2-visual-qa'),
  report: P('data', 'reports', 'v2-runtime-performance.json'),
  buildings: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  placement: P('data', 'reports', 'v2-placement-policy.json'),
};
const rj = (p) => JSON.parse(readFileRetry(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BENCH_SECONDS = Number(process.env.BENCH_SECONDS || 30);

export const FIXTURES = [
  { id: 'umeda', name: '梅田', x: -2668.18, z: -10941.87 },
  { id: 'higashiyodogawa', name: '東淀川', x: 574, z: -15576 },
  { id: 'honmachi', name: '本町', x: -2072.6, z: -8693.2 },
  { id: 'namba', name: '難波', x: -2173.39, z: -6511.33 },
  { id: 'tennoji', name: '天王寺', x: -1055.54, z: -4618.89 },
  { id: 'sumiyoshi', name: '住吉', x: -2952.22, z: -811.75 },
  { id: 'tsurumi', name: '鶴見（OSM 追加が多い区）', x: 5178.1, z: -10225.1 },
  { id: 'asahi', name: '旭（OSM 追加が多い区）', x: 2627.3, z: -13801.2 },
  { id: 'higashinari', name: '東成（OSM 追加が多い区）', x: 3295.7, z: -7253.2 },
];
export const RIVER_QA = [
  { id: 'okawa-kema', name: '大川（毛馬）', x: -734, z: -12996 },
  { id: 'okawa-tenmabashi', name: '大川（天満橋付近）', x: -850, z: -9690 },
  { id: 'nakanoshima', name: '中之島（堂島川・土佐堀川）', x: -2695.66, z: -9962.25 },
  { id: 'yodogawa-juso', name: '淀川（十三・新御堂筋付近）', x: -1003, z: -13251 },
];

// 在ページで実行する小さな関数群
const PAGE = {
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  camera: (x, z, r, ph, th = 0) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = ${th}; camUpd(); return [cs.tgt.x, cs.tgt.z, cs.r, cs.ph]; })()`,
  // 開発版は区モード（建物は選択区だけ描く）。地点の区へ切り替える。City Mode 中なら抜ける。
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  city: `(() => { if (!CityModeManager.isActive()) CityModeManager.enter(); return CityModeManager.isActive(); })()`,
  meshes: `(() => { try { const d = CanonicalRuntime.getDebug(); return d.canonicalMesh || (d.stats && d.stats.canonicalMesh) || null; } catch (e) { return String(e); } })()`,
  // legacy residual（canonical 以外の mesh）の中身: 位置・大きさ・色・親をそのまま記録する
  residual: `(() => {
    const total = window.__CANONICAL_SELF_CHECK__().total;
    let d = null; try { d = CanonicalRuntime.getResidualDetail(); } catch (e) { return { total, error: String(e) }; }
    const ids = new Set((d.details || []).map((x) => x.uuid));
    const probe = [];
    window.__SCENE__.traverse((o) => {
      if (!ids.has(o.uuid)) return;
      let bb = null; try { o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); bb = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => Math.round(v)); } catch (e) { /* */ }
      const chain = []; let n = o.parent; while (n && chain.length < 6) { chain.push((n.name || n.type) + (n.userData && Object.keys(n.userData).length ? '{' + Object.keys(n.userData).join(',') + '}' : '')); n = n.parent; }
      probe.push({ type: o.type, positions: o.geometry && o.geometry.attributes.position ? o.geometry.attributes.position.count : null, color: o.material && o.material.color ? '#' + o.material.color.getHexString() : null, opacity: o.material ? o.material.opacity : null, worldBBox: bb, parentChain: chain, siblings: o.parent ? o.parent.children.length : null });
    });
    return { total, byBucket: { unknown: d.unknown, total: d.total }, probe };
  })()`,
  debug: `(() => ({ ver: window.__BUILDINGS_VERSION_DEBUG__(), sem: window.__SEMANTIC_DISPLAY_DEBUG__(), self: window.__CANONICAL_SELF_CHECK__(), perf: CanonicalRuntime.getPerf() }))()`,
  bench: (sec) => `new Promise((resolve) => {
    const ts = [], calls = [], tris = []; let maxQ = 0;
    const t0 = performance.now();
    function f(t) {
      ts.push(t);
      if (renderer && renderer.info) { calls.push(renderer.info.render.calls); tris.push(renderer.info.render.triangles); }
      const p = CanonicalRuntime.getPerf(); const q = p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; if (q > maxQ) maxQ = q;
      if (performance.now() - t0 < ${sec * 1000}) requestAnimationFrame(f); else done();
    }
    function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }
    function done() {
      const dt = []; for (let i = 1; i < ts.length; i++) dt.push(ts[i] - ts[i - 1]);
      const dur = (ts[ts.length - 1] - ts[0]) / 1000;
      const fpsInst = dt.map((d) => 1000 / d);
      const p = CanonicalRuntime.getPerf();
      const mem = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
      resolve({
        seconds: +dur.toFixed(1), frames: ts.length,
        fpsAverage: +((ts.length - 1) / dur).toFixed(1), fpsP5: +pct(fpsInst, 0.05).toFixed(1),
        frameMsP95: +pct(dt, 0.95).toFixed(1), frameMsMax: +Math.max(...dt).toFixed(1),
        drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)), drawCallsMax: Math.max(...calls),
        trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)), trianglesMax: Math.max(...tris),
        jsHeapMB: mem == null ? null : +mem.toFixed(1),
        gpuMemory: renderer.info.memory ? { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures } : null,
        runtimeScene: p.scene,
        tiles: p.tiles, loadingTilesMaxDuringBench: maxQ,
      });
    }
    requestAnimationFrame(f);
  })`,
};

async function waitSettled(page, { minMs = 2500, maxMs = 90000 } = {}) {
  const t0 = Date.now();
  await sleep(minMs);
  let zeros = 0;
  while (Date.now() - t0 < maxMs) {
    const q = await page.evaluate(PAGE.settled);
    zeros = q === 0 ? zeros + 1 : 0;
    if (zeros >= 3) return { settledMs: Date.now() - t0, timedOut: false };
    await sleep(700);
  }
  return { settledMs: Date.now() - t0, timedOut: true };
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 78 });
  fs.mkdirSync(F.shots, { recursive: true });
  const p = path.join(F.shots, name + '.jpg');
  fs.writeFileSync(p, Buffer.from(data, 'base64'));
  return 'data/reports/v2-visual-qa/' + name + '.jpg';
}
async function setVersion(page, v) {
  const r = await page.evaluate(`window.__SET_BUILDINGS_VERSION__(${JSON.stringify(v)})`);
  return r;
}
async function click(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(300);
  const hover = await page.evaluate(`(() => ({ tip: tip.style.display, tipText: (tip.textContent || '').slice(0, 80), cursor: canvas.style.cursor }))()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(600);
  return hover;
}

/** picking 用の対象建物（canonical から選ぶ） */
function pickTargets() {
  const want = [
    { id: 'umeda-plateau', site: FIXTURES[0], src: 'plateau-building', status: null },
    { id: 'umeda-new-osm', exact: 'cg_bldg_osm_162157849' },
    { id: 'sumiyoshi-plateau', site: FIXTURES[5], src: 'plateau-building', status: null },
    { id: 'tsurumi-new-osm', exact: 'cg_bldg_osm_601490203' },
    { id: 'asahi-new-osm', exact: 'cg_bldg_osm_320958204' },
    { id: 'suminoe-retained-osm', retainedNear: { x: -4652.97, z: -12.81 } },
  ];
  const all = [];
  const files = fs.readdirSync(F.buildings).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f));
  const needTiles = new Set();
  for (const w of want) {
    const c = w.site || w.retainedNear;
    if (c) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) needTiles.add(`tile_${Math.floor(c.x / 500) + dx}_${Math.floor(c.z / 500) + dz}.json`);
  }
  // exact ID のタイルは centroid が不明なので全タイルを走査（ID だけ見る）
  const byId = new Map();
  for (const f of files) {
    const t = rj(path.join(F.buildings, f));
    const a = rj(path.join(F.buildings, 'attributes', f)).attributes;
    for (const ft of t.features) {
      if (want.some((w) => w.exact === ft.canonicalId) || needTiles.has(f)) {
        const rec = { id: ft.canonicalId, ring: ft.coordinates[0], c: ft.centroid, area: ft.areaM2, attr: a[ft.canonicalId] };
        byId.set(ft.canonicalId, rec);
        if (needTiles.has(f)) all.push(rec);
      }
    }
  }
  const out = [];
  for (const w of want) {
    let rec = null;
    if (w.exact) rec = byId.get(w.exact);
    else if (w.site) rec = all.filter((b) => b.attr.source === w.src && Math.hypot(b.c[0] - w.site.x, b.c[1] - w.site.z) < 300 && b.area > 300 && b.area < 5000).sort((p, q) => q.area - p.area)[0];
    else if (w.retainedNear) rec = all.filter((b) => b.attr.fallbackV2Status === 'retained' && b.area > 60).sort((p, q) => Math.hypot(p.c[0] - w.retainedNear.x, p.c[1] - w.retainedNear.z) - Math.hypot(q.c[0] - w.retainedNear.x, q.c[1] - w.retainedNear.z))[0];
    if (!rec) { out.push({ id: w.id, missing: true }); continue; }
    // 重心で当たる footprint 数（duplicate pick の確認。near 範囲の全建物で数える）
    const hits = all.concat([...byId.values()]).filter((b, i, arr) => arr.findIndex((x) => x.id === b.id) === i).filter((b) => pointInRingXZ(rec.c[0], rec.c[1], b.ring)).length;
    out.push({ id: w.id, canonicalId: rec.id, center: rec.c, areaM2: rec.area, source: rec.attr.source, status: rec.attr.fallbackV2Status || null, footprintsAtCentroid: hits, centroidInside: pointInRingXZ(rec.c[0], rec.c[1], rec.ring) });
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const generatedAt = new Date().toISOString();
  const report = { version: 1, generatedAt, missionId: '32P', url: F.url };
  const targets = pickTargets();
  console.log('[browser-qa] pick targets', JSON.stringify(targets.map((t) => [t.id, t.canonicalId, t.footprintsAtCentroid])));
  const b = await launchBrowser({});
  const page = b.page;
  const consoleErrors = [];
  page.on('Runtime.exceptionThrown', (e) => consoleErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)));
  try {
    await page.send('Page.navigate', { url: F.url });
    await sleep(4000);
    const env = await page.evaluate(`(() => { const gl = renderer.getContext(); const e = gl.getExtension('WEBGL_debug_renderer_info'); return { gpu: e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), ua: navigator.userAgent, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio }; })()`);
    report.environment = { browser: b.version, executable: b.exe, headless: true, ...env };
    console.log('[browser-qa] env', JSON.stringify(report.environment));
    const startupSettle = await waitSettled(page, { minMs: 1000 });
    const startup = await page.evaluate(PAGE.debug);
    report.defaultStartup = {
      settle: startupSettle,
      buildingsVersion: startup.ver.version, label: startup.ver.label, base: startup.ver.base,
      buildingCount: startup.ver.buildingCount, placementVariant: startup.ver.placementVariant,
      fetchByNamespace: startup.ver.fetchByNamespace,
      roadMode: startup.sem.normalViewRoadMode, rawGsiEdge: startup.sem.normalViewRawGsiEdge,
      residual: startup.self.total, groupScale: startup.ver.buildingsGroupScale, groupRotation: startup.ver.buildingsGroupRotation,
      statusText: await page.evaluate(`(() => { const el = document.querySelector('#canonical-runtime-status') || [...document.querySelectorAll('div')].find((d) => /Buildings: /.test(d.textContent) && d.children.length < 40); return el ? el.innerText.slice(0, 600) : null; })()`),
    };
    report.shots = {};
    report.shots.startup = await shot(page, '00-startup-default');
    // ── 区切替 / City Mode / search 後も V2N のまま・V1 fetch 0 ──
    const reg = {};
    const fetch0 = (await page.evaluate(PAGE.debug)).ver.fetchByNamespace;
    reg.searchSpot = await page.evaluate(`(() => { const s = findSpot('梅田'); return s ? { name: s.name } : null; })()`);
    reg.wardSwitch = await page.evaluate(`(async () => { try { if (CityModeManager.isActive()) CityModeManager.exit('kita'); WardModeManager.switchWard('kita'); } catch (e) { return { error: String(e) }; } return { current: WardModeManager.currentWardId }; })()`);
    await waitSettled(page);
    reg.afterWard = (await page.evaluate(PAGE.debug)).ver;
    reg.cityMode = await page.evaluate(`(async () => { try { if (typeof CityModeManager !== 'undefined' && CityModeManager.enter) { await CityModeManager.enter(); return { active: CityModeManager.isActive() }; } return { skipped: true }; } catch (e) { return { error: String(e) }; } })()`);
    await waitSettled(page, { maxMs: 60000 });
    reg.afterCity = (await page.evaluate(PAGE.debug)).ver;
    reg.cityShot = await shot(page, 'city-mode-v2n');
    const fetch1 = reg.afterCity.fetchByNamespace;
    reg.fetchDelta = Object.fromEntries(Object.keys(fetch1).map((k) => [k, fetch1[k] - (fetch0[k] || 0)]));
    reg.note = '起動直後（建物版の切替前）に区切替 → City Mode を行い、その間の建物系 fetch を namespace 別に差分で数えた';
    report.regression = reg;
    // City Mode を抜けて区モードへ戻す
    await page.evaluate(PAGE.ward(-2668.18, -10941.87));


    console.log('[browser-qa] startup', JSON.stringify(report.defaultStartup));

    // ── fixture 目視（V2N） ──
    report.fixtures = {};
    for (const f of FIXTURES) {
      const ward = await page.evaluate(PAGE.ward(f.x, f.z));
      await sleep(1200);
      await page.evaluate(PAGE.camera(f.x, f.z, 650, 0.85));
      const s = await waitSettled(page);
      report.fixtures[f.id] = { name: f.name, ward, center: [f.x, f.z], settle: s, meshes: await page.evaluate(PAGE.meshes), shot: await shot(page, `fx-${f.id}-v2n`) };
    }
    // 梅田 A/B（同一 camera）
    await page.evaluate(PAGE.ward(FIXTURES[0].x, FIXTURES[0].z));
    await sleep(1200);
    await page.evaluate(PAGE.camera(FIXTURES[0].x, FIXTURES[0].z, 450, 0.85));
    for (const v of ['V2', 'V1', 'V2N']) { await setVersion(page, v); await waitSettled(page); report.shots['umeda-ab-' + v] = await shot(page, `ab-umeda-${v}`); }
    // 大川・淀川（真上・建物 / 水域 / 道路 / 鉄道を同時表示）
    report.riverQa = {};
    await page.evaluate(PAGE.city);
    await sleep(2500);
    for (const r of RIVER_QA) {
      await page.evaluate(PAGE.camera(r.x, r.z, 520, 0.05));
      const s = await waitSettled(page);
      const layers = (await page.evaluate(PAGE.debug)).sem.layers;
      report.riverQa[r.id] = { name: r.name, center: [r.x, r.z], layers, settle: s, shot: await shot(page, `river-${r.id}`) };
    }
    // SUPPRESS 地点（V2N placement）
    const pl = fs.existsSync(F.placement) ? rj(F.placement) : null;
    report.suppressQa = [];
    for (const s of (pl ? pl.samples.SUPPRESS : [])) {
      await page.evaluate(PAGE.ward(s.center[0], s.center[1]));
      await sleep(1200);
      await page.evaluate(PAGE.camera(s.center[0], s.center[1], 220, 0.05));
      await waitSettled(page);
      const hidden = await shot(page, `suppress-${s.canonicalId.slice(-12)}-v2n`);
      // 比較: 32N の暫定 placement（V2 + 旧 OSM）では表示されていたか
      await setVersion(page, 'V2'); await waitSettled(page);
      const before = await shot(page, `suppress-${s.canonicalId.slice(-12)}-v2old`);
      await setVersion(page, 'V2N'); await waitSettled(page);
      report.suppressQa.push({ canonicalId: s.canonicalId, center: s.center, label: s.label, waterName: s.waterName, depthM: s.depthM, shotV2N: hidden, shotV2Old: before });
    }

    // ── picking / hover / property card ──
    report.picking = [];
    for (const t of targets) {
      if (t.missing) { report.picking.push(t); continue; }
      await page.evaluate(PAGE.ward(t.center[0], t.center[1]));
      await sleep(1200);
      await page.evaluate(PAGE.camera(t.center[0], t.center[1], 300, 0.05));
      await waitSettled(page);
      await page.evaluate(`(() => { window.__LAST_BUILDING_PICK__ = null; const c = document.getElementById('property-card') || document.querySelector('.property-card'); return !!c; })()`);
      const hover = await click(page, 800, 500);
      const res = await page.evaluate(`(() => {
        const pick = window.__LAST_BUILDING_PICK__;
        const card = document.getElementById('pc-id') ? document.getElementById('pc-id').closest('[id]') : null;
        const txt = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim().slice(0, 80) : null; };
        return { pick, cardVisible: (() => { const el = document.getElementById('pc-title'); if (!el) return null; let n = el; while (n && n !== document.body) { const st = getComputedStyle(n); if (st.display === 'none' || st.visibility === 'hidden') return false; n = n.parentElement; } return true; })(),
          pcId: txt('pc-id'), pcTitle: txt('pc-title'), pcUsage: txt('pc-usage-full'), pcBadge: txt('pc-usage-badge'), pcHeight: txt('pc-height') };
      })()`);
      report.picking.push({ ...t, hover, ...res, pickedExpected: !!(res.pick && res.pick.id === t.canonicalId), shot: await shot(page, `pick-${t.id}`) });
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
    }
    console.log('[browser-qa] picking', JSON.stringify(report.picking.map((p) => [p.id, p.pickedExpected, p.pick && p.pick.id, p.hover && p.hover.tip, p.cardVisible, p.footprintsAtCentroid])));

    // ── 性能: 梅田・住吉 × V1 / V2N（同一 camera・30 秒静止） ──
    report.benchmark = { seconds: BENCH_SECONDS, camera: { r: 700, ph: Math.PI / 4, th: 0 }, runs: {} };
    // residual（legacy mesh）の内訳を版ごとに記録（版に依存するかの確認）
    report.residualByVersion = {};
    for (const v of ['V1', 'V2N']) { await setVersion(page, v); await waitSettled(page); report.residualByVersion[v] = await page.evaluate(PAGE.residual); }
    for (const site of [FIXTURES[0], FIXTURES[5]]) {
      for (const v of ['V1', 'V2N']) {
        await setVersion(page, v);
        const ward = await page.evaluate(PAGE.ward(site.x, site.z));
        await sleep(1200);
        await page.evaluate(PAGE.camera(site.x, site.z, 700, Math.PI / 4));
        const s = await waitSettled(page);
        await sleep(2000);
        const m = await page.evaluate(PAGE.bench(BENCH_SECONDS), { timeoutMs: (BENCH_SECONDS + 60) * 1000 });
        report.benchmark.runs[`${site.id}-${v}`] = { site: site.id, ward, version: v, settle: s, meshes: await page.evaluate(PAGE.meshes), ...m };
        report.shots[`bench-${site.id}-${v}`] = await shot(page, `bench-${site.id}-${v}`);
        console.log('[browser-qa] bench', site.id, v, JSON.stringify(m));
      }
    }
    await setVersion(page, 'V2N');
    report.finalState = (await page.evaluate(PAGE.debug)).ver;
    report.consoleErrors = consoleErrors.slice(0, 30);
  } finally {
    await b.close();
  }
  report.elapsedMs = Date.now() - t0;
  fs.writeFileSync(F.report, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  main().then(() => { console.log('[browser-qa] done'); process.exit(0); }).catch((e) => { console.error('[browser-qa] 失敗:', e && e.stack || e); process.exit(1); });
}
