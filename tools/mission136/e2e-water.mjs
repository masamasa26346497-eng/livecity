#!/usr/bin/env node
// Mission 136: 実の海面（water-surface: 公開ポリゴンから決定的に再生成）を、沿岸区で実 Chrome/WebGL 検証する。
//   node tools/mission136/gen-water-surface.js --out <map>  →  node tools/mission135/build-ward-layers.js --map-root <map> --out <layers>
//   node tools/mission136/e2e-water.mjs --layers-root <layers> --ward konohana --out <report.json>
// この区の建物は未取得（private Release 側）なので、建物/道路/河川の線は「未取得(404)」のまま、河川(面)=海面だけが描かれることを確認する。
// dataKind は 'real-water-surface-only'。3レイヤー達成・24区達成には数えない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../lib/cdp-browser.js';
import { loadWards } from '../lib/ward-layer-adapter.js';
import { createServer } from '../mission135/server.js';
import { DEFAULT_POLYGONS } from '../mission135/build-ward-layers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function runWater({ ward, layersRoot, executable }) {
  const w = loadWards(DEFAULT_POLYGONS).find((x) => x.wardId === ward);
  if (!w) throw new Error('unknown ward ' + ward);
  const report = { schema: 'livecity.mission136.water-e2e/1', ward, dataKind: 'real-water-surface-only', threeLayersRealVerified: false, realData24WardsProven: false, checks: {}, jsErrors: [] };
  const wsFile = path.join(layersRoot, ward, 'layers', 'water-surface.json');
  if (!fs.existsSync(wsFile)) { report.fatal = 'no water-surface.json for ' + ward; report.allPassed = false; return report; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm136w-')), empty = path.join(tmp, 'b'), emptyFp = path.join(tmp, 'fp'); fs.mkdirSync(empty); fs.mkdirSync(emptyFp);
  const hits = []; let actual = 0;
  const srv = createServer({ buildingsRoot: empty, layersRoot, footprintsRoot: emptyFp, getPort: () => actual, log: (h) => hits.push(h) });
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
    if (!up) throw new Error('viewer did not start');
    for (let i = 0; i < 60; i++) { const l = await ev('JSON.stringify(window.__m135.state.layers)'); if (!/loading/.test(l)) break; await sleep(500); }
    await sleep(2500);
    const grab = async () => { await sleep(1500); return (await page.send('Page.captureScreenshot', { format: 'png' })).data; };
    const diff = (P, Q) => ev(`(async () => JSON.stringify(await (async () => {
      const ld = async (d) => { const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + d)).blob()); const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };
      const P = await ld(${JSON.stringify(P)}), Q = await ld(${JSON.stringify(Q)}); let d = 0; const n = P.width * P.height;
      for (let i = 0; i < n; i++) { if (Math.abs(P.data[i*4]-Q.data[i*4]) + Math.abs(P.data[i*4+1]-Q.data[i*4+1]) + Math.abs(P.data[i*4+2]-Q.data[i*4+2]) > 24) d++; }
      return { diff: d, pct: +(d / n * 100).toFixed(3) }; })()))()`).then(JSON.parse);
    report.layers = await ev('JSON.parse(JSON.stringify(window.__m135.state.layers))');
    await ev(`window.__m135.lookAt(${JSON.stringify(ward)}, 6000)`); await sleep(1500);
    const full = await grab(), noise = await diff(full, await grab());
    await ev("window.__m135.setLayer('waterArea', false)"); const off = await grab(); const water = await diff(full, off);
    await ev("window.__m135.setLayer('waterArea', true)");
    report.pixels = { noise, waterArea: water };
    const mine = hits.filter((h) => h.u.includes(`/ext-3dtiles/${ward}/layers/`));
    report.http = { waterSurface: mine.filter((h) => /water-surface\.json$/.test(h.u)).map((h) => h.s), roads: mine.filter((h) => /roads\.json$/.test(h.u)).map((h) => h.s) };
    report.checks = {
      waterAreaReady: report.layers.waterArea && report.layers.waterArea.cls === 'ready',
      waterSurfaceHttp200: report.http.waterSurface.length > 0 && report.http.waterSurface.every((s) => s === 200),
      waterAreaOnOffPixelDiff: water.diff >= 1000 && water.diff > noise.diff + 200,
      buildingsRoadsMissingNotFaked: report.layers.buildings.cls === 'missing' && report.layers.roads.cls === 'missing' && report.http.roads.every((s) => s === 404),
      noJsErrors: report.jsErrors.length === 0,
    };
    report.allPassed = Object.values(report.checks).every(Boolean);
  } finally { try { await b?.close?.(); } catch { /* noop */ } srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const out = opt('out');
  if (!opt('layers-root') || !opt('ward')) { console.error('usage: --layers-root <dir> --ward <id> [--out file]'); process.exit(2); }
  if (out && fs.existsSync(out)) { console.error('refusing to overwrite ' + out); process.exit(2); }
  const rep = await runWater({ ward: opt('ward'), layersRoot: path.resolve(opt('layers-root')) }).catch((e) => ({ fatal: String(e.message || e), allPassed: false }));
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rep, null, 1), { flag: 'wx' }); }
  console.log(JSON.stringify({ allPassed: rep.allPassed, checks: rep.checks, pixels: rep.pixels, layers: rep.layers && Object.fromEntries(Object.entries(rep.layers).map(([k, v]) => [k, v.cls])), fatal: rep.fatal }, null, 1));
  process.exit(rep.allPassed ? 0 : 1);
}
