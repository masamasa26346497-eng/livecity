// tools/experiments/mission138_integrated_qa.mjs
// [Mission 138] 既存の 24 区ページ (mission37g-osaka-24ward-mvp.html?fp=1) に、実フットプリント押出し建物（住吉区 52 tile / 35,031 棟）が描画されること、
//   実クリックで canonicalId が選択されること、区切替で破棄されること、レイヤー ON/OFF を、実 Chrome（headless・ローカルサーバー）で確認する。
//   道路・河川は実アセットが Git に無いため、--layers-root に「合成 fixture」（明示的に synthetic）を置き、接続機能だけを確認する（実データの描画ではない）。
//   headless はソフトウェア描画。時間・FPS は実機値ではない。使い方: node tools/experiments/mission138_integrated_qa.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchBrowser } from '../lib/cdp-browser.js';

const require = createRequire(import.meta.url);
const { listen } = require('../mission138-serve-local.cjs');
const OUT_DIR = 'data/reports/mission138';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE_HOSTS = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;

// 合成レイヤー（住吉区 bbox 内・既存の 9 tile 道路束の範囲外）。実データではない。
const layersRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm138-layers-'));
const ldir = path.join(layersRoot, 'sumiyoshi', 'layers');
fs.mkdirSync(ldir, { recursive: true });
const hdr = { version: 1, coordinateConvention: 'znorth-neg-v1', wardId: 'sumiyoshi', synthetic: true, source: 'mission138-qa-fixture', clipped: 'none' };
fs.writeFileSync(path.join(ldir, 'roads.json'), JSON.stringify({ ...hdr, layer: 'roads', features: [
  { id: 'r1', kind: 'line', tier: 'major', p: [[-900, 600], [-300, 600]] }, { id: 'r2', kind: 'line', tier: 'mid', p: [[-600, 400], [-600, 900]] }] }));
fs.writeFileSync(path.join(ldir, 'waterways.json'), JSON.stringify({ ...hdr, layer: 'waterways', features: [
  { id: 'w1', kind: 'line', waterClass: 'canal', p: [[-900, 800], [-300, 850]] }] }));
fs.writeFileSync(path.join(ldir, 'water-surface.json'), JSON.stringify({ ...hdr, layer: 'waterSurface', features: [
  { id: 'ws_0', kind: 'area', waterClass: 'sea-surface', p: [[-500, 1000], [-300, 1000], [-400, 1150]] }] }));
fs.writeFileSync(path.join(ldir, 'status.json'), JSON.stringify({ ...hdr, layers: { roads: { state: 'generated' } } }));

const srv = await listen({ publicDir: path.resolve('public'), footprintsRoot: path.resolve('public/map-data/osaka-city/buildings'), layersRoot }, 0);
const URL_ = srv.url + 'mission37g-osaka-24ward-mvp.html?qa=1&fp=1&fac=0&extra=0';

const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
const out = { mission: '138', url: URL_, browser: b.version, generatedAt: new Date().toISOString(), googleRequests: [], failedRequests: [], jsErrors: [], steps: [] };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE_HOSTS.test(new URL(e.request.url).hostname)) out.googleRequests.push(e.request.url); } catch { /* data: */ } });
// 想定内の 404（存在確認のプローブ。欠落は 404 で「未取得」と扱う設計）: ext index / layers-report / 合成 fixture に無い鉄道・公園 / フットプリントを持たない区の manifest
const EXPECTED_404 = /\/ext-3dtiles\/index\.json$|\/layers\/(layers-report|railways|parks)\.json$|\/ext-3dtiles\/(?!sumiyoshi)[a-z0-9-]+\/footprints\/manifest\.json$/;
out.expected404 = [];
page.on('Network.responseReceived', (e) => {
  if (e.response.status < 400 || /tile\.|cyberjapandata|favicon/.test(e.response.url)) return;
  (EXPECTED_404.test(new URL(e.response.url).pathname) ? out.expected404 : out.failedRequests).push(e.response.status + ' ' + e.response.url);
});
const ev = (js) => page.evaluate(js);
const J = (js) => ev(`JSON.stringify(${js})`).then(JSON.parse);
async function click(x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const shot = async (name) => {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 75 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64'));
};
const fpStats = () => J('window.__mission37g.fp');
async function waitFp(state, ms = 150000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await fpStats(); if (s.state === state) return s; await sleep(500); }
  return fpStats();
}
const step = (label, rec) => { out.steps.push({ label, ...rec }); return rec; };

try {
  await page.send('Network.enable');
  const t0 = Date.now();
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 80; i++) {
    await sleep(1000);
    if (await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false) === true) break;
  }
  out.startupMs = Date.now() - t0;
  await sleep(1500);

  // 1) 住吉区: 実フットプリント 35,031 棟 / 52 tile
  const tMount = Date.now();
  await ev("window.__mission37dQA.setBuildingWard('27120')");
  const s1 = await waitFp('ready');
  for (let i = 0; i < 120; i++) { if (await ev('window.__mission37dQA.fpReady()')) break; await sleep(500); }
  const info1 = await J('window.__mission37dQA.fpInfo()');
  step('住吉区 footprints', { pass: s1.state === 'ready' && s1.buildings === 35031 && s1.tiles === 52 && s1.loadedTiles === 52 && s1.failedTiles === 0, fp: s1, info: info1, mountMs: Date.now() - tMount,
    buildingState: await ev('window.__mission37g.buildingState'), hsBldg: await ev("document.getElementById('hs-bldg').textContent"), note: await ev("document.getElementById('bldg-ward-note').textContent") });

  // 2) 実クリック（屋根中心を投影し、scene.pick が同じ ID を返す点だけを CDP の実マウスでクリック）
  await ev('window.__mission37dQA.lookAtLocal(-1700, -150, 0, 1100, -55, 0)');
  await sleep(2500);
  const cands = await J('window.__mission37dQA.fpCandidates(5, 8, 400)');
  const clicks = [];
  for (const c of cands.slice(0, 3)) {
    await click(c.x, c.y);
    for (let i = 0; i < 30; i++) { if ((await ev('window.__mission37g.selectedCanonicalId')) === c.id) break; await sleep(200); }
    clicks.push({ id: c.id, h: c.h, selected: (await ev('window.__mission37g.selectedCanonicalId')) === c.id, panelId: await ev("document.getElementById('lc-cid').textContent"),
      ward: await ev("document.getElementById('lb-ward').textContent"), height: await ev("document.getElementById('lb-h').textContent"), key: await ev('window.__mission37g.selectedKey'),
      photoSlot: (await ev("document.getElementById('lc-photo-slot').textContent")).slice(0, 60) });
  }
  await shot('01-sumiyoshi-footprints-click');
  step('実クリック', { pass: clicks.length >= 1 && clicks.every((c) => c.selected && c.panelId === c.id && /住吉/.test(c.ward)), candidates: cands.length, clicks });

  // 3) 建物レイヤー ON/OFF
  await ev("window.__mission37dQA.setLayer('buildings', false)"); await sleep(400);
  const off = await J('window.__mission37dQA.fpInfo()');
  await ev("window.__mission37dQA.setLayer('buildings', true)"); await sleep(400);
  const on = await J('window.__mission37dQA.fpInfo()');
  step('建物 ON/OFF', { pass: off.shown === 0 && on.shown === on.prims && on.prims > 0, off, on });

  // 4) 道路・河川（合成 fixture の接続確認。実データの描画ではない）
  for (let i = 0; i < 40; i++) { if ((await ev('window.__mission37g.wardVec.state')) !== 'loading') break; await sleep(500); }
  const wv = await J('window.__mission37g.wardVec');
  await ev('window.__mission37dQA.lookAtLocal(-600, 800, 0, 1400, -60, 0)'); await sleep(2500); await shot('02-synthetic-layers');
  step('区別 道路・河川（合成 fixture）', { pass: wv.state === 'ready' && (wv.layers.roads | 0) >= 1 && (wv.layers.waterways | 0) >= 1, synthetic: true, wardVec: wv });

  // 5) 区切替: 北区（フットプリント無し → 従来の部分 3D Tiles / 未整備に戻る）。住吉の primitive は残らない
  await ev("window.__mission37dQA.setBuildingWard('27127')"); await sleep(1500);
  const info5 = await J('window.__mission37dQA.fpInfo()');
  const fp5 = await fpStats();
  step('区切替 北区', { pass: info5.prims === 0 && fp5.state === 'none' && fp5.dropsTotal >= 1 && (await ev('window.__mission37g.buildingWard')) !== '27120', info: info5, fp: fp5,
    selectedAfterSwitch: await ev('window.__mission37g.selectedCanonicalId'), state: await ev('window.__mission37g.buildingState') });

  // 6) 競合: 住吉を選んだ直後に解除。古い fetch の結果が残らない
  await ev("(() => { const f = window.__mission37dQA.setBuildingWard; f('27120'); setTimeout(() => f(null), 400); })()");
  await sleep(6000);
  const info6 = await J('window.__mission37dQA.fpInfo()');
  step('競合（住吉→0.4 秒後に解除）', { pass: info6.prims === 0 && (await fpStats()).state === 'none', info: info6, scenePrims: info6.scenePrims });

  // 7) 再訪
  await ev("window.__mission37dQA.setBuildingWard('27120')");
  const s7 = await waitFp('ready');
  step('住吉区 再訪', { pass: s7.state === 'ready' && s7.buildings === 35031, fp: s7, mountsTotal: s7.mountsTotal });

  out.fps = await ev('window.__mission37g.fps');
  out.heapMB = await ev('performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null');
  out.jsErrorCount = out.jsErrors.length; out.googleRequestCount = out.googleRequests.length;
  out.pass = out.steps.every((s) => s.pass) && out.jsErrors.length === 0 && out.googleRequests.length === 0 && out.failedRequests.length === 0;
} catch (e) {
  out.fatal = String(e && e.stack || e);
} finally {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'integrated-qa.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ pass: out.pass, startupMs: out.startupMs, steps: out.steps.map((s) => ({ l: s.label, pass: s.pass })), jsErrors: out.jsErrorCount, google: out.googleRequestCount, failed: out.failedRequests, fatal: out.fatal || null }, null, 1));
  try { await b.close(); } catch { /* noop */ }
  srv.srv.close();
  fs.rmSync(layersRoot, { recursive: true, force: true });
  process.exit(0);
}
