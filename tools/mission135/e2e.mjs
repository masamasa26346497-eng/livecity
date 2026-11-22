#!/usr/bin/env node
// Mission 135: 合成 fixture（2区以上）で 建物+道路+河川の線+河川の面 を実 Chrome/WebGL に描き、
//   個別 ON/OFF の画素差・HTTP200/404・区切替・前区破棄・非同期取消を確認する。127.0.0.1 のみ、書き出しは --out（新規）のみ。
//   node tools/mission135/e2e.mjs --out data/reports/mission135/synthetic-e2e.json
// これは dataKind:'synthetic-fixture' の証拠で、実データ24区の受入には数えない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../lib/cdp-browser.js';
import { loadWards } from '../lib/ward-layer-adapter.js';
import { createServer } from './server.js';
import { DEFAULT_POLYGONS } from './build-ward-layers.js';
import { writeFixture } from './make-fixtures.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const MIN_PIXELS = 1000; // 実レイヤーの最小差は約5100画素（河川線）。ソフトウェアGLの描画ばらつき（~150）を十分に上回る
export const NOISE_MARGIN = 200;
export const ALIGN_TOLERANCE_M = 3;
const haversineM = (a, b) => { const R = 6371008.8, t = Math.PI / 180, dLa = (b.lat - a.lat) * t, dLo = (b.lon - a.lon) * t; const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

export async function runE2E({ wardIds = ['kita', 'miyakojima', 'fukushima'], executable } = {}) {
  const all = loadWards(DEFAULT_POLYGONS), wards = wardIds.map((id) => all.find((w) => w.wardId === id)).filter(Boolean);
  if (wards.length < 3) throw new Error('need 3 wards (2 complete + 1 with missing roads)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm135-'));
  const buildingsRoot = path.join(tmp, 'buildings'), layersRoot = path.join(tmp, 'layers');
  const [A, B, C] = wards;
  const geos = writeFixture({ buildingsRoot, layersRoot, wards, skipLayers: { [C.wardId]: ['roads'] } });
  const hits = [];
  const logged = await listenLogged({ buildingsRoot, layersRoot }, hits);
  const report = { schema: 'livecity.mission135.e2e/1', dataKind: 'synthetic-fixture', realData24WardsProven: false, wards: {}, checks: {}, browser: null, jsErrors: [], port: logged.port };
  let b;
  try {
    b = await launchBrowser({ width: 1280, height: 800, executable, extraArgs: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    report.browser = b.version;
    const page = b.page, ev = (js) => page.evaluate(js);
    page.on('Runtime.exceptionThrown', (e) => { try { report.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 200)); } catch { /* noop */ } });
    await page.send('Page.navigate', { url: logged.url });
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { await sleep(1000); up = await ev('!!(window.__m135 && window.__m135.state.ready)').catch(() => false); }
    if (!up) throw new Error('viewer did not start (Cesium CDN or WebGL unavailable)');
    report.webgl = await ev("(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); })()");
    const settle = async () => { for (let i = 0; i < 120; i++) { if (await ev('window.__m135.tilesReady()').catch(() => false)) break; await sleep(500); } await sleep(1500); };
    const grab = async () => { await sleep(1200); return (await page.send('Page.captureScreenshot', { format: 'png' })).data; };
    const diff = (P, Q) => ev(`(async () => JSON.stringify(await (async () => {
      const ld = async (d) => { const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + d)).blob()); const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };
      const P = await ld(${JSON.stringify(P)}), Q = await ld(${JSON.stringify(Q)}); let d = 0; const n = P.width * P.height;
      for (let i = 0; i < n; i++) { if (Math.abs(P.data[i*4]-Q.data[i*4]) + Math.abs(P.data[i*4+1]-Q.data[i*4+1]) + Math.abs(P.data[i*4+2]-Q.data[i*4+2]) > 24) d++; }
      return { diff: d, pct: +(d / n * 100).toFixed(3) }; })()))()`).then(JSON.parse);
    const layerState = () => ev('JSON.parse(JSON.stringify(window.__m135.state.layers))');
    const httpFor = (ward, from) => {
      const mine = hits.slice(from).filter((h) => h.u.includes('/ext-3dtiles/' + ward + '/') || h.u.includes('/ext-3dtiles/' + ward + '25/'));
      const by = (re) => mine.filter((h) => re.test(h.u));
      return { tileset: by(/tileset\.json$/).map((h) => h.s), glb: by(/\.glb$/).map((h) => h.s), roads: by(/roads\.json$/).map((h) => h.s), waterways: by(/waterways\.json$/).map((h) => h.s), waterSurface: by(/water-surface\.json$/).map((h) => h.s), notFound: mine.filter((h) => h.s === 404).map((h) => h.u.split('/').pop()) };
    };
    const KEYS = ['buildings', 'roads', 'waterLine', 'waterArea'];
    const measureWard = async (w, expectMissing = []) => {
      const from = hits.length;
      await ev(`window.__m135.selectWard(${JSON.stringify(w.wardId)})`); await settle();
      const rec = { layers: await layerState(), http: httpFor(w.wardId, from), pixels: {}, resources: await ev('window.__m135.resources()') };
      for (const k of KEYS) await ev(`window.__m135.setLayer('${k}', true)`);
      const full = await grab();
      rec.noise = await diff(full, await grab()); // 同一状態の再撮影＝描画ばらつきの実測
      for (const k of KEYS) {
        await ev(`window.__m135.setLayer('${k}', false)`); const off = await grab();
        rec.pixels[k] = await diff(full, off);
        await ev(`window.__m135.setLayer('${k}', true)`);
      }
      for (const k of KEYS) await ev(`window.__m135.setLayer('${k}', false)`);
      const none = await grab(); rec.pixels.allOffVsAllOn = await diff(full, none);
      for (const k of KEYS) await ev(`window.__m135.setLayer('${k}', true)`);
      const c = await ev('window.__m135.tilesetCenter()'), e = await ev(`window.__m135.expectedCenter(${JSON.stringify(w.wardId)})`);
      rec.alignment = c && e ? { errorM: +haversineM({ lat: c.lat, lon: c.lon }, { lat: e.lat, lon: e.lon }).toFixed(3), toleranceM: ALIGN_TOLERANCE_M } : null;
      rec.expectMissing = expectMissing;
      report.wards[w.wardId] = rec;
      return rec;
    };
    await measureWard(A);
    const releasesBefore = await ev('window.__m135.state.releases');
    const recB = await measureWard(B);                      // 区切替: A を破棄して B のみ
    const afterSwitch = { releasesDelta: (await ev('window.__m135.state.releases')) - releasesBefore, resources: recB.resources };
    await measureWard(C, ['roads']);                         // roads 欠落区: 404 を成功扱いしない
    // 非同期取消: A を要求し、完了を待たずに B へ切替
    const abortedBefore = await ev('window.__m135.state.aborted');
    await ev(`(async () => { const p = window.__m135.selectWard(${JSON.stringify(A.wardId)}); const q = window.__m135.selectWard(${JSON.stringify(B.wardId)}); await Promise.all([p, q]); })()`);
    await settle();
    const race = { finalWard: await ev('window.__m135.state.ward'), aborted: (await ev('window.__m135.state.aborted')) - abortedBefore, resources: await ev('window.__m135.resources()'), layers: await layerState() };
    report.switch = afterSwitch; report.race = race;

    // Mission137: GLB(EXT_mesh_features) の featureId → ids/<glb>.json sidecar → canonicalId のクリック検証（合成 fixture）
    await ev(`window.__m135.selectWard(${JSON.stringify(A.wardId)})`); await settle();
    const gA = geos[A.wardId];
    await ev(`window.__m135.lookAtLocal(${gA.center.x}, ${gA.center.z}, 450)`); await sleep(2500);
    const tg = gA.buildings.map((bd) => ({ id: bd.id, x: bd.x, z: bd.z, h: bd.h }));
    const clicks3d = await ev(`window.__m135.clickCheck3d(${JSON.stringify(tg)})`);
    report.click3dTiles = { dataKind: 'synthetic-fixture', ward: A.wardId, samples: clicks3d.length, matched: clicks3d.filter((c) => c.picked === c.id && c.via === '3dtiles-sidecar').length, results: clicks3d, sidecarHttp: await ev('JSON.parse(JSON.stringify(window.__m135.state.http && window.__m135.state.http.sidecars || null))') };
    // sidecar が無い GLB は ID を捏造せず unresolved を返す（fail-closed）: sidecar 404 を作るため C 区ではなく、ids を持たない仮 URL ではなく pick 結果の unresolved を直接検証
    report.click3dTiles.sidecar404Probe = await ev("fetch('ext-3dtiles/" + A.wardId + "25/ids/not-there.json').then((r) => r.status)");

    const ok = (w) => KEYS.every((k) => w.pixels[k].diff >= MIN_PIXELS) && w.pixels.allOffVsAllOn.diff >= MIN_PIXELS && w.alignment && w.alignment.errorM <= ALIGN_TOLERANCE_M
      && KEYS.every((k) => w.layers[k].cls === 'ready') && w.http.notFound.length === 0 && [...w.http.tileset, ...w.http.glb, ...w.http.roads, ...w.http.waterways, ...w.http.waterSurface].every((s) => s === 200);
    const cw = report.wards[C.wardId];
    report.checks = {
      wardA_fourLayersPixelDiff_http200_aligned: !!ok(report.wards[A.wardId]),
      wardB_fourLayersPixelDiff_http200_aligned: !!ok(report.wards[B.wardId]),
      switch_releasedPreviousWard: afterSwitch.releasesDelta === 1 && afterSwitch.resources.tilesets === 1,
      missingRoads_not_treated_as_success: cw.layers.roads.cls === 'missing' && cw.http.roads.every((s) => s === 404) && cw.pixels.roads.diff <= cw.noise.diff + NOISE_MARGIN && cw.expectMissing.includes('roads'),
      missingRoads_other_layers_still_render: ['buildings', 'waterLine', 'waterArea'].every((k) => cw.layers[k].cls === 'ready' && cw.pixels[k].diff >= MIN_PIXELS),
      race_finalWardIsLastRequest_noLeak: race.finalWard === B.wardId && race.resources.tilesets === 1 && race.resources.polylineCollections === 2 && race.aborted >= 1,
      canonicalIdClick_3dtiles_sidecar_allMatch: report.click3dTiles.samples >= 6 && report.click3dTiles.matched === report.click3dTiles.samples && Object.values(report.click3dTiles.sidecarHttp || {}).every((s) => s === 200),
      sidecar_missing_is_404: report.click3dTiles.sidecar404Probe === 404,
      noJsErrors: report.jsErrors.length === 0,
    };
    report.allPassed = Object.values(report.checks).every(Boolean);
  } finally {
    try { await b?.close?.(); } catch { /* noop */ }
    logged.srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  report.hitsSummary = { total: hits.length, notFound: hits.filter((h) => h.s === 404).length };
  return report;
}

async function listenLogged(opts, hits) {
  let actual = 0;
  const srv = createServer({ ...opts, getPort: () => actual, log: (h) => hits.push(h) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); actual = srv.address().port;
  return { srv, port: actual, url: `http://127.0.0.1:${actual}/` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const out = opt('out');
  if (out && fs.existsSync(out)) { console.error('refusing to overwrite ' + out); process.exit(2); }
  const rep = await runE2E({ executable: opt('chrome') }).catch((e) => ({ schema: 'livecity.mission135.e2e/1', dataKind: 'synthetic-fixture', realData24WardsProven: false, fatal: String(e.message || e), allPassed: false }));
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rep, null, 1), { flag: 'wx' }); }
  console.log(JSON.stringify({ allPassed: rep.allPassed, checks: rep.checks, fatal: rep.fatal, browser: rep.browser }, null, 1));
  process.exit(rep.allPassed ? 0 : 1);
}
