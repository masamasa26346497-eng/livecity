#!/usr/bin/env node
// tools/audit/high-lod-roof-structure-qa.js
// [Mission 34B §23-§27] 各地点の受入条件を数値で確かめる。
//   - 屋根が「平らな箱の上面」ではなく段差・塔屋を持っているか（屋根面の高さの段数）
//   - 屋根が canonical の footprint からはみ出していないか（新大阪の線路上への張り出し確認）
//   - 大阪城で LandmarkHD が高 LOD より優先されているか
//   前提: `npm run preview`。出力: data/reports/high-lod-roof-structure-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { SITES, VIEW } from './high-lod-visual-qa.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const OUT = P('data', 'reports', 'high-lod-roof-structure-qa.json');
const SHOTS = P('data', 'reports', 'high-lod-visual-qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 屋根面の「段数」を数える。上向き（|n·up| > 0.7）の三角形の高さを 1m 刻みで束ね、
//   面積が屋根全体の 3% 以上ある高さだけを「段」と数える（三角分割の誤差を拾わないため）。
const ROOF_STRUCTURE = `(() => {
  const up = new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const per = new Map();   // canonicalId -> { levels: Map(高さ→面積), area, minY, maxY, pts: [] }
  scene.traverse((o) => {
    if (!o.isMesh || !o.userData || !o.userData.lodHigh || !o.visible) return;
    let q = o, vis = true; while (q) { if (q.visible === false) { vis = false; break; } q = q.parent; }
    if (!vis || o.userData.lodHigh.kind !== 'roof') return;
    const pos = o.geometry.getAttribute('position'), idx = o.geometry.index;
    for (const r of (o.userData.lodHigh.ranges || [])) {
      let rec = per.get(r.canonicalId);
      if (!rec) { rec = { levels: new Map(), area: 0, minY: Infinity, maxY: -Infinity, pts: [], lod: r.lod }; per.set(r.canonicalId, rec); }
      for (let i = r.start; i + 2 < r.start + r.count; i += 3) {
        const i0 = idx.getX(i), i1 = idx.getX(i + 1), i2 = idx.getX(i + 2);
        a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
        b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
        c.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
        e1.subVectors(b, a); e2.subVectors(c, a); n.crossVectors(e1, e2);
        const area2 = n.length();
        if (area2 < 1e-9) continue;
        n.divideScalar(area2);
        if (Math.abs(n.dot(up)) < 0.7) continue;         // 傾いた面・壁は段の数え上げに入れない
        const area = area2 / 2;
        const y = (a.y + b.y + c.y) / 3;
        const k = Math.round(y);
        rec.levels.set(k, (rec.levels.get(k) || 0) + area);
        rec.area += area;
        if (y < rec.minY) rec.minY = y;
        if (y > rec.maxY) rec.maxY = y;
        if (rec.pts.length < 240) { rec.pts.push(a.x, a.z, b.x, b.z, c.x, c.z); }
      }
    }
  });
  let multi = 0, total = 0, spreadSum = 0, lvlSum = 0;
  const spreads = [];
  let overhangMax = 0, overhangOver2 = 0, overhangChecked = 0;
  const worst = [];
  for (const [id, rec] of per) {
    if (rec.area <= 0) continue;
    total++;
    const levels = [...rec.levels.entries()].filter(([, ar]) => ar >= rec.area * 0.03).length;
    lvlSum += levels;
    if (levels >= 2) multi++;
    const spread = rec.maxY - rec.minY;
    spreadSum += spread; spreads.push(spread);
    // 屋根が canonical footprint からはみ出していないか
    const d = CanonicalRuntime.buildingDataById(id);
    if (d && d.fp && d.fp.length >= 3 && rec.pts.length) {
      let cx = 0, cz = 0;
      for (const q of d.fp) { cx += q[0]; cz += q[1]; }
      cx /= d.fp.length; cz /= d.fp.length;
      let rMax = 0;
      for (const q of d.fp) rMax = Math.max(rMax, Math.hypot(q[0] - cx, q[1] - cz));
      let out = 0;
      for (let i = 0; i + 1 < rec.pts.length; i += 2) out = Math.max(out, Math.hypot(rec.pts[i] - cx, rec.pts[i + 1] - cz) - rMax);
      overhangChecked++;
      if (out > overhangMax) { overhangMax = out; }
      if (out > 2) { overhangOver2++; if (worst.length < 5) worst.push({ id: id.slice(-12), overhangM: +out.toFixed(2), fpRadiusM: +rMax.toFixed(1) }); }
    }
  }
  spreads.sort((x, y) => x - y);
  const pct = (q) => (spreads.length ? +spreads[Math.min(spreads.length - 1, Math.floor(spreads.length * q))].toFixed(2) : null);
  return {
    buildingsWithRoof: total,
    multiLevelRoofs: multi,
    multiLevelPct: total ? +(100 * multi / total).toFixed(1) : null,
    avgRoofLevels: total ? +(lvlSum / total).toFixed(2) : null,
    roofHeightSpreadM: { mean: total ? +(spreadSum / total).toFixed(2) : null, p50: pct(0.5), p90: pct(0.9), max: pct(0.999) },
    overhang: { checked: overhangChecked, maxM: +overhangMax.toFixed(2), over2m: overhangOver2, worst },
  };
})()`;

const LANDMARK = `(() => {
  const L = window.__LANDMARK_HD_LAYER__, B = window.__BUILDING_LOD_LAYER__;
  if (!L) return { available: false };
  const names = L.getNames ? L.getNames() : [];
  const active = L.getActiveNames ? L.getActiveNames() : [];
  // LandmarkHD が持っている棟を、高 LOD 側が描いていないこと
  let conflicts = 0;
  const ids = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.userData || !o.userData.lodHigh || !o.visible) return;
    for (const r of (o.userData.lodHigh.ranges || [])) if (!ids.includes(r.canonicalId)) ids.push(r.canonicalId);
  });
  for (const id of ids) if (L.isSuppressedBuilding(id)) conflicts++;
  return { available: true, enabled: L.isEnabled(), names, active, highLodBuildings: ids.length,
    landmarkOwnedDrawnByHighLod: conflicts, suppressedByLandmark: L.getSuppressedCount ? L.getSuppressedCount() : null,
    highLodSuppressedLod1: B ? B.getSuppressedCount() : null };
})()`;

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
};
// 見た目の比較に UI が写り込まないよう、パネル類を隠してから撮る
const HIDE_UI = `(() => {
  for (const el of document.querySelectorAll('div')) {
    const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|layer-toggle|prop-card|^tip$|search-box|^pl$|^pr$|^lc-panel|^lc-topbar|^controls$/.test(id)) el.style.display = 'none';
  }
  for (const sel of ['#lc-panel', '#lc-topbar', '#controls', '#pl', '#pr']) {
    const el = document.querySelector(sel); if (el) el.style.display = 'none';
  }
  return 1;
})()`;

async function settle(page, min = 2500, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/high-lod-visual-qa/' + name + '.jpg';
}

export async function run() {
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34B', url: URL_, sites: [], errors: [] };
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    await page.evaluate(HIDE_UI);
    for (const s of SITES) {
      await page.evaluate(JS.ward(s.x, s.z));
      await sleep(2000);
      // §13 の preset そのもので見る（QA と UI で同じ視点になる）
      await page.evaluate(`(() => window.__LOD_VIEW__('${s.id}'))()`);
      await settle(page);
      await page.evaluate(HIDE_UI);
      await sleep(2500);
      const rec = { site: s.id, siteName: s.name };
      rec.roof = await page.evaluate(ROOF_STRUCTURE, { timeoutMs: 120000 });
      if (s.id === 'osakacastle') rec.landmark = await page.evaluate(LANDMARK);
      rec.shot = await shot(page, `${s.id}-preset-after`);
      // ROOF QA（法線可視化）も 1 枚残す
      await page.evaluate(`(() => window.__BUILDING_LOD_MODE__('roof'))()`);
      await sleep(2500);
      rec.roofQaShot = await shot(page, `${s.id}-roofqa-after`);
      await page.evaluate(`(() => window.__BUILDING_LOD_MODE__('high'))()`);
      await sleep(1200);
      out.sites.push(rec);
      console.log('[roof-struct]', s.id, JSON.stringify({
        n: rec.roof.buildingsWithRoof, multiPct: rec.roof.multiLevelPct, levels: rec.roof.avgRoofLevels,
        spreadP90: rec.roof.roofHeightSpreadM.p90, overhangMax: rec.roof.overhang.maxM, over2m: rec.roof.overhang.over2m,
        landmark: rec.landmark ? rec.landmark.landmarkOwnedDrawnByHighLod : undefined,
      }));
    }
    await page.evaluate(`(() => window.__LOD_VIEW_EXIT__())()`);
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then(() => { console.log('[roof-struct] out', OUT); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
