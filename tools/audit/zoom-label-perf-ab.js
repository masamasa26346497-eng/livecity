#!/usr/bin/env node
// tools/audit/zoom-label-perf-ab.js
// [Mission 33D §17] production(33B) と development(33D) を「交互に」測る。
//   このマシンの FPS は同一設定でも 25〜46 と大きく振れる（他プロセス・GPU 状態の影響）ため、
//   1 回ずつ測って比べると偽の差が出る。交互に複数ラウンド測って平均で比べる。
//   あわせて place()（ラベル再選定）1 回の実時間も測る。
//   前提: `npm run preview`。出力: data/reports/zoom-label-perf-ab.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const OUT = P('data', 'reports', 'zoom-label-perf-ab.json');
const URLS = {
  before: process.env.LIVECITY_PROD_URL || 'http://localhost:8000/osaka_3d_buildings.html',
  after: process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// City Mode をゆっくり回しながら測る（ラベルの再選定が実際に走る条件）
const BENCH = (sec) => `new Promise((resolve) => {
  const ts = [], calls = [];
  const dbg = () => (typeof window.__CITY_LABEL_DEBUG__ === 'function') ? window.__CITY_LABEL_DEBUG__() : null;
  const d0 = dbg(); const s0 = d0 && d0.stability ? d0.stability : null;
  const t0 = performance.now(); const th0 = cs.th, tx0 = cs.tgt.x, tz0 = cs.tgt.z;
  function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }
  function f(t) { ts.push(t); if (renderer && renderer.info) calls.push(renderer.info.render.calls);
    const u = (performance.now() - t0) / 1000;
    cs.th = th0 + u * 0.12; cs.tgt.x = tx0 + Math.sin(u * 0.5) * cs.r * 0.12; cs.tgt.z = tz0 + Math.cos(u * 0.5) * cs.r * 0.06; camUpd();
    if (performance.now() - t0 < ${sec * 1000}) requestAnimationFrame(f); else {
      const dt = []; for (let i = 1; i < ts.length; i++) dt.push(ts[i] - ts[i - 1]);
      const dur = (ts[ts.length - 1] - ts[0]) / 1000;
      const d1 = dbg(); const s1 = d1 && d1.stability ? d1.stability : null;
      resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1), frameMsP95: +pct(dt, 0.95).toFixed(1),
        drawCallsAvg: Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length)),
        relayoutPerSec: (s0 && s1) ? +((s1.relayouts - s0.relayouts) / dur).toFixed(2) : null,
        labelUpdatePerSec: (s0 && s1) ? +(((s1.relayouts + s1.transformRefreshes) - (s0.relayouts + s0.transformRefreshes)) / dur).toFixed(2) : null,
        visibleLabels: d1 ? d1.visible : null });
    } }
  requestAnimationFrame(f);
})`;
// ラベル再選定 1 回の実時間（安定化機構を足して重くなっていないかを直接見る）
const PLACE_COST = `(() => {
  if (typeof CityLabelLayer === 'undefined' || !CityLabelLayer.markDirty) return null;
  const t = [];
  for (let i = 0; i < 12; i++) {
    CityLabelLayer.markDirty();
    const a = performance.now();
    cs.tgt.x += 1; camUpd();
    CityLabelLayer.update();
    t.push(performance.now() - a);
  }
  t.sort((x, y) => x - y);
  return { medianMs: +t[Math.floor(t.length / 2)].toFixed(2), maxMs: +t[t.length - 1].toFixed(2), samples: t.length };
})()`;

// tile の読み込みが終わるまで待つ。未整定のまま測ると draw call が少なく FPS が高く出て、
//   before/after の比較が成立しない（実際に 290 vs 387 draw call で 30.8 vs 25.4 FPS になった）。
const SETTLED = `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`;
async function settle(page, min = 4000, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(SETTLED); z = q === 0 ? z + 1 : 0; if (z >= 4) return; await sleep(800); }
}

async function measure(url, sec) {
  const b = await launchBrowser({ width: 1600, height: 1000 });
  try {
    await b.page.send('Page.navigate', { url });
    await sleep(40000);
    await b.page.evaluate(`(() => { CityModeManager.enter(); return 1; })()`);
    await sleep(10000);
    await settle(b.page);
    const place = await b.page.evaluate(PLACE_COST);
    const bench = await b.page.evaluate(BENCH(sec), { timeoutMs: 90000 });
    return { ...bench, placeCost: place };
  } finally { await b.close(); }
}

export async function run({ rounds = 2, sec = 20 } = {}) {
  const runs = [];
  for (let i = 0; i < rounds; i++) {
    for (const phase of ['before', 'after']) {
      const r = await measure(URLS[phase], sec);
      runs.push({ round: i, phase, ...r });
      console.log('[perf-ab]', JSON.stringify(runs[runs.length - 1]));
    }
  }
  const mean = (a) => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
  const summary = ['before', 'after'].reduce((m, p) => {
    const a = runs.filter((r) => r.phase === p);
    return { ...m, [p]: { fps: a.map((r) => r.fpsAverage), fpsMean: mean(a.map((r) => r.fpsAverage)),
      frameMsP95Mean: mean(a.map((r) => r.frameMsP95)), drawCallsAvg: Math.round(mean(a.map((r) => r.drawCallsAvg))),
      placeMedianMs: mean(a.map((r) => (r.placeCost ? r.placeCost.medianMs : 0))),
      placeMaxMs: Math.max(...a.map((r) => (r.placeCost ? r.placeCost.maxMs : 0))),
      relayoutPerSec: a[0].relayoutPerSec, visibleLabels: a[0].visibleLabels } };
  }, {});
  summary.fpsDeltaPct = +(((summary.after.fpsMean - summary.before.fpsMean) / summary.before.fpsMean) * 100).toFixed(1);
  const doc = { version: 1, generatedAt: new Date().toISOString(), missionId: '33D', condition: 'City Mode / camera moving', urls: URLS, rounds, sec, runs, summary };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  return doc;
}

if (isMainModule(import.meta.url)) {
  const ri = process.argv.indexOf('--rounds');
  run({ rounds: ri >= 0 ? Number(process.argv[ri + 1]) : 2 })
    .then((d) => { console.log('[perf-ab] out', OUT, JSON.stringify(d.summary)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
