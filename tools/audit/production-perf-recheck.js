#!/usr/bin/env node
// tools/audit/production-perf-recheck.js
// [Mission 32U §22] production の性能を、CDP の Network 記録を有効にしない状態で測り直す。
//   cutover QA 本体は fetch 監査のため Network domain を有効にしており、そのオーバーヘッドが
//   FPS に乗る可能性がある。32P（dev・Network 無効）と同じ camera / 同じ 30 秒で比較する。
//   前提: `npm run preview`。出力: data/reports/production-perf-recheck.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { SITES } from './production-cutover-qa.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const OUT = P('data', 'reports', 'production-perf-recheck.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URLS = {
  production: process.env.LIVECITY_PROD_URL || 'http://localhost:8000/osaka_3d_buildings.html',
  development: process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html',
};
const CAMERA = { r: 700, ph: Math.PI / 4 };   // 32P の benchmark と同じ

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, ph) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
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
      const mem = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
      resolve({
        seconds: +dur.toFixed(1), frames: ts.length,
        fpsAverage: +((ts.length - 1) / dur).toFixed(1), fpsP5: +pct(fpsInst, 0.05).toFixed(1),
        frameMsP95: +pct(dt, 0.95).toFixed(1),
        drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
        trianglesAvg: Math.round(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)),
        jsHeapMB: mem == null ? null : +mem.toFixed(1),
        loadingTilesMaxDuringBench: maxQ,
      });
    }
    requestAnimationFrame(f);
  })`,
};

async function settle(page, min = 2500, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}

async function measure(url, label) {
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const runs = [];
  try {
    await page.send('Page.navigate', { url });
    await sleep(40000);
    for (const s of [SITES[0], SITES[4]]) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(1500);
      await page.evaluate(JS.camera(s.x, s.z, CAMERA.r, CAMERA.ph)); await settle(page);
      const r = await page.evaluate(JS.bench(30), { timeoutMs: 120000 });
      runs.push({ build: label, site: s.id, siteName: s.name, ...r });
      console.log('[perf]', label, s.id, JSON.stringify({ fps: r.fpsAverage, p5: r.fpsP5, p95: r.frameMsP95, draws: r.drawCallsAvg, tris: r.trianglesAvg, heap: r.jsHeapMB }));
    }
  } finally { await b.close(); }
  return runs;
}

async function main() {
  const runs = [];
  // 順序の影響（1 回目が有利 / 不利）を消すため、production → development → development → production の順で 2 巡する
  const order = ['production', 'development', 'development', 'production'];
  for (const label of order) runs.push(...await measure(URLS[label], label));
  const report = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '32U',
    note: 'CDP Network domain を有効にしない状態での計測（cutover QA 本体は fetch 監査のため有効にしている）。camera は 32P benchmark と同じ。',
    camera: CAMERA, urls: URLS, runs,
    summary: Object.fromEntries(['production', 'development'].map((b2) => [b2, Object.fromEntries(['umeda', 'sumiyoshi'].map((site) => {
      const xs = runs.filter((r) => r.build === b2 && r.site === site);
      const f = xs.map((r) => r.fpsAverage).sort((a2, b3) => a2 - b3);
      return [site, { runs: xs.length, fpsAverage: f, fpsBest: f[f.length - 1] ?? null, frameMsP95: xs.map((r) => r.frameMsP95), drawCallsAvg: xs[0] ? xs[0].drawCallsAvg : null, trianglesAvg: xs[0] ? xs[0].trianglesAvg : null }];
    }))])),
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  main().then(() => { console.log('[perf] out', OUT); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
