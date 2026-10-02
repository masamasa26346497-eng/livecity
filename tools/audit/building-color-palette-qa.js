#!/usr/bin/env node
// tools/audit/building-color-palette-qa.js
// [Mission 35N §7-§12/§14] 用途不明（灰色）だった建物の色分けを実ブラウザで確認する。
//   - 灰色 1 色ではなくなったか（頂点カラーの色みの種類）
//   - draw call を増やしていないか（tint を切った状態との A/B）
//   - 既存の用途色を壊していないか
//   前提: `npm run preview`。対象は dev。production は触らない。
//   出力: data/reports/building-color-palette-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
export const OUT = P('data', 'reports', 'building-color-palette-qa.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 高密度（梅田）で測る。用途色と用途不明が両方たくさん出る。 */
export const SITE = { id: 'umeda', lat: 34.70250, lon: 135.49586, r: 1200 };

const SCAN = `(() => {
  const byCat = {}; const mats = new Set(); let meshes = 0;
  scene.traverse((o) => {
    if (!o.isMesh || o.userData.usageCategory == null) return;
    meshes++;
    const k = o.userData.usageCategory;
    byCat[k] = byCat[k] || { n: 0, color: null };
    byCat[k].n++;
    byCat[k].color = '#' + o.material.color.getHex().toString(16).padStart(6, '0');
    mats.add(o.material.uuid);
  });
  // 用途不明の建物の頂点カラーの色み（最大値で正規化した比）を数える
  const hues = new Map();
  scene.traverse((o) => {
    if (!o.isMesh || o.userData.usageCategory !== 'other') return;
    const c = o.geometry.getAttribute('color'); if (!c) return;
    for (let i = 0; i < c.count; i += 97) {
      const r = c.array[i * 3], g = c.array[i * 3 + 1], b = c.array[i * 3 + 2];
      if (r === 0 && g === 0 && b === 0) continue;
      const mx = Math.max(r, g, b) || 1;
      hues.set([Math.round(r / mx * 10), Math.round(g / mx * 10), Math.round(b / mx * 10)].join(','), 1);
    }
  });
  const info = renderer.info.render;
  return JSON.stringify({ buildingMeshes: meshes, sharedMaterials: mats.size,
    drawCalls: info.calls, triangles: info.triangles,
    otherHueRatios: [...hues.keys()], byCat });
})()`;

export async function run() {
  const t0 = Date.now();
  const b = await launchBrowser({ width: 1440, height: 900 });
  const page = b.page;
  let out = null;
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(16000);
    const w = latLonToLiveCityWorld(SITE.lat, SITE.lon);
    await page.evaluate(`(() => { const wid = WardModeManager.detectWardAt(${w.x}, ${w.z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`);
    await sleep(9000);
    await page.evaluate(`(() => { cs.tgt.x=${w.x}; cs.tgt.z=${w.z}; cs.r=${SITE.r}; cs.ph=(90-40)*Math.PI/180; cs.th=0; camUpd(); return 1; })()`);
    await sleep(12000);
    const after = JSON.parse(await page.evaluate(SCAN, { timeoutMs: 180000 }));
    // A/B: 色みを切って（= 35N 以前と同じ 1 色）測り直し、draw call の差を見る
    await page.evaluate(`(() => { window.__CR_DISABLE_OTHER_TINT__ = true; CanonicalRuntime.invalidateBuildingTiles(); return 1; })()`);
    await sleep(12000);
    const before = JSON.parse(await page.evaluate(SCAN, { timeoutMs: 180000 }));
    out = {
      version: 1, generatedAt: new Date().toISOString(), missionId: '35N', site: SITE.id,
      buildingCount: 618749,
      buildingMeshes: after.buildingMeshes, sharedMaterials: after.sharedMaterials,
      drawCalls: after.drawCalls, triangles: after.triangles,
      drawCallsWithoutTint: before.drawCalls,
      drawCallsDelta: after.drawCalls - before.drawCalls,
      meshesDelta: after.buildingMeshes - before.buildingMeshes,
      otherHueRatios: after.otherHueRatios,
      usageColors: after.byCat,
      elapsedMs: Date.now() - t0,
    };
  } finally { try { await b.close(); } catch { /* noop */ } }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { console.log(JSON.stringify(o, null, 2)); console.log('[35N-qa] out', OUT); })
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
