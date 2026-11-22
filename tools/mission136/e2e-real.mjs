#!/usr/bin/env node
// Mission 136: 実建物データ（public/map-data/osaka-city/buildings/osaka-<ward>/）で Cesium ビューアを実 Chrome/WebGL 検証する。
//   node tools/mission136/e2e-real.mjs --ward sumiyoshi --out data/reports/mission136/real-buildings-e2e.json [--mixed-synthetic-layers]
// 段階:
//   stage1 real-buildings-only          : 実建物 + 道路/河川は未取得(404)。「建物だけの達成」。3レイヤー達成とは数えない。
//   stage2 real-buildings+synthetic-layers (--mixed-synthetic-layers): 実建物 + 合成の道路/河川。合成が混ざるので実データ達成には数えない。
// 127.0.0.1 のみ。書き出しは --out（新規）のみ。ネットワーク取得なし（Cesium ライブラリ本体の CDN 読込を除く）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../lib/cdp-browser.js';
import { loadWards } from '../lib/ward-layer-adapter.js';
import { createServer, footprintInfo } from '../mission135/server.js';
import { DEFAULT_POLYGONS } from '../mission135/build-ward-layers.js';
import { fixtureGeometry, writeLayers } from '../mission135/make-fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const MIN_PIXELS = 1000, NOISE_MARGIN = 200, MIN_CLICK_SAMPLES = 8, MIN_CLICK_RATE = 0.8, CLICK_CAM_H = 1200;

export async function runReal({ ward = 'sumiyoshi', footprintsRoot = path.join(ROOT, 'public/map-data/osaka-city/buildings'), mixed = false, executable } = {}) {
  const w = loadWards(DEFAULT_POLYGONS).find((x) => x.wardId === ward);
  if (!w) throw new Error('unknown ward ' + ward);
  const info = footprintInfo(footprintsRoot, ward);
  const report = { schema: 'livecity.mission136.real-e2e/1', ward, stage: mixed ? 'real-buildings+synthetic-layers' : 'real-buildings-only',
    dataKind: mixed ? 'real-buildings+synthetic-layers' : 'real-buildings-only', realBuildingsOnly: !mixed, threeLayersRealVerified: false, realData24WardsProven: false,
    declared: info, checks: {}, jsErrors: [] };
  if (!info) { report.fatal = 'no real footprint data for ' + ward + ' under ' + footprintsRoot + '（偽成功を返さない）'; report.allPassed = false; return report; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm136-'));
  const layersRoot = path.join(tmp, 'layers'); fs.mkdirSync(layersRoot, { recursive: true });
  const emptyBuildings = path.join(tmp, 'buildings'); fs.mkdirSync(emptyBuildings);
  if (mixed) writeLayers(layersRoot, w, fixtureGeometry(w.bbox));
  const hits = []; let actual = 0;
  const srv = createServer({ buildingsRoot: emptyBuildings, layersRoot, footprintsRoot, getPort: () => actual, log: (h) => hits.push(h) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); actual = srv.address().port;
  let b;
  try {
    b = await launchBrowser({ width: 1280, height: 800, executable, extraArgs: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    report.browser = b.version;
    const page = b.page, ev = (js) => page.evaluate(js);
    page.on('Runtime.exceptionThrown', (e) => { try { report.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 200)); } catch { /* noop */ } });
    await page.send('Page.navigate', { url: `http://127.0.0.1:${actual}/?ward=${ward}` });
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { await sleep(1000); up = await ev('!!(window.__m135 && window.__m135.state.ready)').catch(() => false); }
    if (!up) throw new Error('viewer did not start (Cesium CDN or WebGL unavailable)');
    report.webgl = await ev("(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); })()");
    const settle = async () => { for (let i = 0; i < 400; i++) { if (await ev('window.__m135.tilesReady()').catch(() => false)) break; await sleep(500); } await sleep(2500); };
    await settle();
    const grab = async () => { await sleep(1500); return (await page.send('Page.captureScreenshot', { format: 'png' })).data; };
    const diff = (P, Q) => ev(`(async () => JSON.stringify(await (async () => {
      const ld = async (d) => { const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + d)).blob()); const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };
      const P = await ld(${JSON.stringify(P)}), Q = await ld(${JSON.stringify(Q)}); let d = 0; const n = P.width * P.height;
      for (let i = 0; i < n; i++) { if (Math.abs(P.data[i*4]-Q.data[i*4]) + Math.abs(P.data[i*4+1]-Q.data[i*4+1]) + Math.abs(P.data[i*4+2]-Q.data[i*4+2]) > 24) d++; }
      return { diff: d, pct: +(d / n * 100).toFixed(3) }; })()))()`).then(JSON.parse);
    const KEYS = ['buildings', 'roads', 'waterLine', 'waterArea'];

    report.layers = await ev('JSON.parse(JSON.stringify(window.__m135.state.layers))');
    report.buildingSource = await ev('window.__m135.state.buildingSource');
    report.footprint = await ev('window.__m135.footprintStats()');
    report.errors = await ev('window.__m135.state.errors');

    // HTTP: マニフェスト + 全タイルが 200（404/欠落を成功扱いしない）
    const mine = hits.filter((h) => h.u.includes(`/ext-3dtiles/${ward}/footprints/`));
    const tiles = mine.filter((h) => /tile_/.test(h.u));
    report.http = { manifest: mine.filter((h) => /manifest\.json$/.test(h.u)).map((h) => h.s), tileCount: tiles.length, tileStatuses: [...new Set(tiles.map((h) => h.s))], tilesetProbe: hits.filter((h) => h.u.endsWith(`/${ward}25/tileset.json`)).map((h) => h.s),
      layerStatuses: Object.fromEntries(['roads', 'waterways', 'water-surface'].map((n) => [n, hits.filter((h) => h.u.endsWith(`/layers/${n}.json`)).map((h) => h.s)])) };

    // 位置整合: 宣言 bounds が区 bbox に収まり、カメラ中心の表示位置が公式投影の期待値と一致
    const bd = report.footprint && report.footprint.bounds, tol = 150;
    report.alignment = { boundsInsideWardBbox: !!bd && bd.minX >= w.bbox.minX - tol && bd.maxX <= w.bbox.maxX + tol && bd.minZ >= w.bbox.minZ - tol && bd.maxZ <= w.bbox.maxZ + tol, bounds: bd, wardBbox: w.bbox, northIsNegativeZ: true };

    // 建物 ON/OFF 画素差（区全体を俯瞰）+ 撮影ばらつき
    await ev(`window.__m135.lookAt(${JSON.stringify(ward)}, 5200)`); await sleep(1500);
    for (const k of KEYS) await ev(`window.__m135.setLayer('${k}', true)`);
    const full = await grab(); const noise = await diff(full, await grab());
    const pixels = { noise };
    for (const k of KEYS) { await ev(`window.__m135.setLayer('${k}', false)`); pixels[k] = await diff(full, await grab()); await ev(`window.__m135.setLayer('${k}', true)`); }
    report.pixels = pixels;

    // canonicalId クリック: 区中心を CLICK_CAM_H で見て、屋根中心を pick → 同じ id が返るか
    await ev(`window.__m135.lookAt(${JSON.stringify(ward)}, ${CLICK_CAM_H})`); await sleep(2500);
    const clicks = await ev('JSON.parse(JSON.stringify(window.__m135.clickCheck(25)))');
    const matched = clicks.filter((c) => c.picked === c.id);
    report.click = { cameraHeightM: CLICK_CAM_H, samples: clicks.length, matched: matched.length, rate: clicks.length ? +(matched.length / clicks.length).toFixed(3) : 0, examples: clicks.slice(0, 5), mismatches: clicks.filter((c) => c.picked !== c.id).slice(0, 5) };

    // Mission137: 不一致の切り分け。建物の真上にカメラを寄せて再 pick → 一致すれば「画面端の視差/隣接高層による遮蔽」であり ID 取り違えではない
    report.click.mismatchRecheck = [];
    for (const m of clicks.filter((c) => c.picked !== c.id).slice(0, 5)) report.click.mismatchRecheck.push(await ev(`window.__m135.recheckCentered(${JSON.stringify(m.id)}, 300)`));
    report.click.mismatchResolvedWhenCentered = report.click.mismatchRecheck.filter((r) => r && r.picked === r.id).length;

    if (mixed) { // 合成の道路/河川は区中心の約500m範囲のみ。近接視点で個別 ON/OFF を測る
      const closeFull = await grab(); const closeNoise = await diff(closeFull, await grab()); const close = { noise: closeNoise };
      for (const k of KEYS) { await ev(`window.__m135.setLayer('${k}', false)`); close[k] = await diff(closeFull, await grab()); await ev(`window.__m135.setLayer('${k}', true)`); }
      report.pixelsClose = close;
    }
    const f = report.footprint || {};
    const okHttp = report.http.manifest.every((s) => s === 200) && report.http.manifest.length >= 1 && tiles.length === info.tileCount && tiles.every((h) => h.s === 200);
    report.checks = {
      realFootprintsLoaded_matchDeclared: report.buildingSource === 'footprints' && f.loadedTiles === info.tileCount && f.failedTiles === 0 && f.buildings + f.skipped === info.totalBuildings,
      http200_manifest_and_all_tiles: okHttp,
      buildingsLayerReady: report.layers.buildings && report.layers.buildings.cls === 'ready',
      buildingsOnOffPixelDiff: pixels.buildings.diff >= MIN_PIXELS && pixels.buildings.diff > noise.diff + NOISE_MARGIN,
      alignment_boundsInsideWard: report.alignment.boundsInsideWardBbox,
      canonicalIdClick: clicks.length >= MIN_CLICK_SAMPLES && report.click.rate >= MIN_CLICK_RATE,
      noJsErrors: report.jsErrors.length === 0 && report.errors.length === 0,
    };
    if (mixed) {
      Object.assign(report.checks, {
        syntheticRoads200_and_pixels: report.http.layerStatuses.roads.every((s) => s === 200) && report.pixelsClose.roads.diff >= MIN_PIXELS,
        syntheticWaterLine: report.pixelsClose.waterLine.diff >= MIN_PIXELS,
        syntheticWaterArea: report.pixelsClose.waterArea.diff >= MIN_PIXELS,
      });
    } else {
      // 実道路/河川は未取得: 404 を成功扱いせず、missing 表示、画素差は撮影ばらつき以内
      Object.assign(report.checks, {
        missingLayers_reported_not_faked: ['roads', 'waterLine', 'waterArea'].every((k) => report.layers[k] && report.layers[k].cls === 'missing') && Object.values(report.http.layerStatuses).every((a) => a.length && a.every((s) => s === 404)),
        missingLayers_draw_nothing: ['roads', 'waterLine', 'waterArea'].every((k) => pixels[k].diff <= noise.diff + NOISE_MARGIN),
      });
    }
    report.allPassed = Object.values(report.checks).every(Boolean);
    report.realBuildingsVerified = !mixed && report.allPassed;
  } finally {
    try { await b?.close?.(); } catch { /* noop */ }
    srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const out = opt('out');
  if (out && fs.existsSync(out)) { console.error('refusing to overwrite ' + out); process.exit(2); }
  const rep = await runReal({ ward: opt('ward') || 'sumiyoshi', mixed: a.includes('--mixed-synthetic-layers'), executable: opt('chrome') })
    .catch((e) => ({ schema: 'livecity.mission136.real-e2e/1', fatal: String(e.message || e), allPassed: false, realBuildingsVerified: false, realData24WardsProven: false }));
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rep, null, 1), { flag: 'wx' }); }
  console.log(JSON.stringify({ allPassed: rep.allPassed, stage: rep.stage, checks: rep.checks, pixels: rep.pixels, click: rep.click && { samples: rep.click.samples, matched: rep.click.matched }, fatal: rep.fatal, browser: rep.browser }, null, 1));
  process.exit(rep.allPassed ? 0 : 1);
}
