#!/usr/bin/env node
// tools/audit/city-label-palette-qa.js
// [Mission 33A] ラベル表示と配色改善の実ブラウザ確認。
//   before = production（cutover 済み・33A 前の配色／ラベルなし）、after = development（33A 適用）。
//   6 地点（梅田/本町/難波/天王寺/住吉/東淀川）＋ City Mode 俯瞰で同じ camera を使い、
//     - screenshot（見た目の比較）
//     - 画面の平均輝度・平均彩度（「明るく・鮮やかに」を数値でも確認）
//     - ラベルの表示数・衝突数・重なり実測（after のみ）
//     - 30 秒の FPS（ラベル追加で重くなっていないか）
//   を記録する。前提: `npm run preview`。出力: data/reports/city-label-palette-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { PROBE } from './legacy-residual-probe.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const OUT = P('data', 'reports', 'city-label-palette-qa.json');
const SHOTS = P('data', 'reports', 'city-label-palette-qa');
const URLS = {
  before: process.env.LIVECITY_PROD_URL || 'http://localhost:8000/osaka_3d_buildings.html',
  after: process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SITES = [
  { id: 'umeda', name: '梅田', x: -2668.18, z: -10941.87 },
  { id: 'honmachi', name: '本町', x: -2072.6, z: -8693.2 },
  { id: 'namba', name: '難波', x: -2173.39, z: -6511.33 },
  { id: 'tennoji', name: '天王寺', x: -1055.54, z: -4618.89 },
  { id: 'sumiyoshi', name: '住吉', x: -2952.22, z: -811.75 },
  { id: 'higashiyodogawa', name: '東淀川', x: 574, z: -15576 },
];
const VIEW = { r: 900, ph: Math.PI / 3.4 };

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, ph) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  // WebGL canvas を 2D へ縮小コピーして平均輝度・平均彩度を測る（見た目の「明るさ」を数値化）
  pixels: `(() => {
    // WebGL は preserveDrawingBuffer:false のため、同じ実行ターンで描き直してから読む
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const w = 240, h = Math.max(1, Math.round(w * src.height / src.width));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let lum = 0, sat = 0, n = 0, colored = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
      const s = (mx === mn) ? 0 : (l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn));
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * b; sat += s; n++;
      if (s > 0.18) colored++;
    }
    return { samples: n, meanLuminance: +(lum / n).toFixed(4), meanSaturation: +(sat / n).toFixed(4), coloredPixelRatio: +(colored / n).toFixed(4) };
  })()`,
  labels: `(() => {
    const city = (typeof window.__CITY_LABEL_DEBUG__ === 'function') ? window.__CITY_LABEL_DEBUG__() : null;
    const station = (typeof window.__STATION_LABEL_DEBUG__ === 'function') ? window.__STATION_LABEL_DEBUG__() : null;
    // 実際に画面に出ている sprite の NDC 矩形どうしが重なっていないかを独立に数える
    let overlaps = 0, rects = [], names = [];
    try {
      const v = new THREE.Vector3(), wp = new THREE.Vector3();
      const tanHalf = Math.tan((camera.fov || 60) * Math.PI / 360);
      const aspect = innerWidth / innerHeight;
      const collect = (g) => {
        if (!g) return;
        g.traverse((o) => {
          if (!o.isSprite || !o.visible) return;
          o.getWorldPosition(wp);
          v.copy(wp).project(camera);
          if (v.z > 1) return;
          // sprite は world サイズなので、カメラ距離から NDC の半幅・半高へ正しく換算する
          const dist = camera.position.distanceTo(wp);
          const hh = (o.scale.y / 2) / (tanHalf * Math.max(1, dist));
          const hw = ((o.scale.x / 2) / (tanHalf * Math.max(1, dist))) / aspect;
          rects.push({ sx: v.x, sy: v.y, hw, hh, name: o.name || '' });
        });
      };
      for (const ch of scene.children) if (ch.name === 'CityLabelLayer' || ch.name === 'StationLabelLayer') collect(ch);
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        if (Math.abs(a.sx - b.sx) < (a.hw + b.hw) * 0.9 && Math.abs(a.sy - b.sy) < (a.hh + b.hh) * 0.9) overlaps++;
      }
      names = (city && city.visibleNames) ? city.visibleNames.slice(0, 12) : [];
    } catch (e) { /* 比較用の概算なので失敗しても続行 */ }
    return { city, station, spriteRects: rects.length, overlapPairs: overlaps, sampleNames: names };
  })()`,
  bench: (sec) => `new Promise((resolve) => {
    const ts = []; const t0 = performance.now();
    function f(t) { ts.push(t); if (performance.now() - t0 < ${sec * 1000}) requestAnimationFrame(f); else {
      const dt = []; for (let i = 1; i < ts.length; i++) dt.push(ts[i] - ts[i - 1]);
      const dur = (ts[ts.length - 1] - ts[0]) / 1000;
      const sorted = [...dt].sort((a, b) => a - b);
      resolve({ fpsAverage: +((ts.length - 1) / dur).toFixed(1), frameMsP95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
        drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
    } }
    requestAnimationFrame(f);
  })`,
};

async function settle(page, min = 2500, max = 60000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/city-label-palette-qa/' + name + '.jpg';
}

async function run(label, url) {
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  const out = { build: label, url, sites: [], errors: [] };
  try {
    await page.send('Page.navigate', { url });
    await sleep(40000);
    for (const s of SITES) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(1200);
      await page.evaluate(JS.camera(s.x, s.z, VIEW.r, VIEW.ph)); await settle(page);
      await sleep(1200);   // ラベル配置の throttle（200ms）を確実に跨ぐ
      const rec = {
        site: s.id, siteName: s.name,
        pixels: await page.evaluate(JS.pixels),
        labels: await page.evaluate(JS.labels),
        residual: (await page.evaluate(PROBE)).selfCheck.total,
        shot: await shot(page, `${s.id}-${label}`),
      };
      out.sites.push(rec);
      console.log(`[label-qa] ${label} ${s.id}`, JSON.stringify({ lum: rec.pixels.meanLuminance, sat: rec.pixels.meanSaturation, city: rec.labels.city && rec.labels.city.visible, station: rec.labels.station && rec.labels.station.visibleLabels, overlaps: rec.labels.overlapPairs }));
    }
    // City Mode 俯瞰（低ズームで地名中心になるか）
    await page.evaluate(`(() => { CityModeManager.enter(); return 1; })()`); await sleep(5000); await settle(page, 2500);
    await sleep(1200);
    out.cityMode = {
      pixels: await page.evaluate(JS.pixels),
      labels: await page.evaluate(JS.labels),
      shot: await shot(page, `city-${label}`),
    };
    console.log(`[label-qa] ${label} cityMode`, JSON.stringify({ lum: out.cityMode.pixels.meanLuminance, city: out.cityMode.labels.city && out.cityMode.labels.city.visible, band: out.cityMode.labels.city && out.cityMode.labels.city.band }));
    // 性能（梅田・通常ズーム）
    await page.evaluate(`(() => { CityModeManager.exit('kita'); return 1; })()`); await sleep(1200);
    await page.evaluate(JS.ward(SITES[0].x, SITES[0].z)); await sleep(1500);
    await page.evaluate(JS.camera(SITES[0].x, SITES[0].z, 700, Math.PI / 4)); await settle(page);
    out.performance = await page.evaluate(JS.bench(30), { timeoutMs: 120000 });
    console.log(`[label-qa] ${label} perf`, JSON.stringify(out.performance));
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }
  return out;
}

async function main() {
  // LIVECITY_QA_ONLY=after を付けると before（production・変更なし）を測り直さず、前回の結果を引き継ぐ
  const only = process.env.LIVECITY_QA_ONLY || null;
  const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch { return null; } })();
  const report = { version: 1, generatedAt: new Date().toISOString(), missionId: '33A', view: VIEW, urls: URLS, runs: {} };
  for (const [label, url] of Object.entries(URLS)) {
    if (only && label !== only && prev && prev.runs && prev.runs[label]) { report.runs[label] = prev.runs[label]; report.runs[label].reusedFrom = prev.generatedAt; continue; }
    report.runs[label] = await run(label, url);
  }
  // before / after の比較
  report.comparison = SITES.map((s) => {
    const a = report.runs.before.sites.find((x) => x.site === s.id);
    const b = report.runs.after.sites.find((x) => x.site === s.id);
    return {
      site: s.id, siteName: s.name,
      luminance: { before: a.pixels.meanLuminance, after: b.pixels.meanLuminance, delta: +(b.pixels.meanLuminance - a.pixels.meanLuminance).toFixed(4) },
      saturation: { before: a.pixels.meanSaturation, after: b.pixels.meanSaturation, delta: +(b.pixels.meanSaturation - a.pixels.meanSaturation).toFixed(4) },
      coloredPixelRatio: { before: a.pixels.coloredPixelRatio, after: b.pixels.coloredPixelRatio },
      labelsAfter: { city: b.labels.city ? b.labels.city.visible : null, station: b.labels.station ? b.labels.station.visibleLabels : null, overlapPairs: b.labels.overlapPairs, names: b.labels.sampleNames },
      labelsBefore: { city: a.labels.city ? a.labels.city.visible : null, station: a.labels.station ? a.labels.station.visibleLabels : null },
    };
  });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  main().then((r) => {
    console.log('[label-qa] comparison', JSON.stringify(r.comparison.map((c) => [c.site, c.luminance.before + '→' + c.luminance.after, c.saturation.before + '→' + c.saturation.after, c.labelsAfter.city, c.labelsAfter.station])));
    console.log('[label-qa] out', OUT);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
