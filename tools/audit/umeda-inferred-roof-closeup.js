#!/usr/bin/env node
// tools/audit/umeda-inferred-roof-closeup.js
// [Mission 35A §29] 生成した推定屋根を「形が見える距離」で撮る。
//   qa.js の §29 は 200〜700m の俯瞰なので、7m の棟は点にしかならない。
//   LOD1 ONLY / REAL + INFERRED / QA 色 の 3 枚を同一 camera で撮って並べる。
//   前提: `npm run preview`。出力: data/reports/umeda-inferred-roof/closeup-*.jpg
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const SHOTS = P('data', 'reports', 'umeda-inferred-roof');
const ROOFS = P('data', 'processed', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json');
const OUT = P('data', 'reports', 'umeda-inferred-roof-closeup.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const CLOSEUP = { r: 55, phDeg: 38, fov: 38, headings: [-0.35, 1.2] };
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

const HIDE_UI = `(() => {
  for (const el of document.querySelectorAll('div')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|layer-toggle|prop-card|^tip$|search-box|^pl$|^pr$|^lc-panel|^lc-topbar|^controls$/.test(id)) el.style.display = 'none'; }
  return 1; })()`;
const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, th) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    CAMERA_MODE_FOV[cameraMode] = ${CLOSEUP.fov};
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${CLOSEUP.r}; cs.ph = (90 - ${CLOSEUP.phDeg}) * Math.PI / 180; cs.th = ${th}; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  mode: (m) => `(() => window.__UMEDA_ROOF_MODE__('${m}'))()`,
  qa: (on) => `(() => window.__INFERRED_ROOF_QA__(${on}))()`,
  inferred: `(() => window.__INFERRED_ROOF_DEBUG__())()`,
};

async function settle(page, min = 2500, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/umeda-inferred-roof/' + name + '.jpg';
}

export async function run() {
  const roofs = rj(ROOFS) || { buildings: [] };
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35A', view: CLOSEUP, shots: [] };
  const b = await launchBrowser({ width: 1400, height: 900 });
  const page = b.page;
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    for (const bld of (roofs.buildings || [])) {
      let cx = 0, cz = 0;
      for (const q of bld.fp) { cx += q[0]; cz += q[1]; }
      cx = Math.round(cx / bld.fp.length); cz = Math.round(cz / bld.fp.length);
      await page.evaluate(JS.ward(cx, cz)); await sleep(2500);
      for (const th of CLOSEUP.headings) {
        // §28 同一 camera で LOD1 / 推定あり / QA 色 の 3 枚
        for (const [m, qa, tag] of [['lod1', false, 'lod1'], ['real+inferred', false, 'inferred'], ['real+inferred', true, 'qa']]) {
          await page.evaluate(JS.mode(m)); await sleep(900);
          await page.evaluate(JS.qa(qa)); await sleep(600);
          await page.evaluate(JS.camera(cx, cz, th));
          await settle(page);
          await page.evaluate(HIDE_UI); await sleep(1500);
          const inf = await page.evaluate(JS.inferred);
          out.shots.push({ canonicalId: bld.canonicalId, roofType: bld.roofType, x: cx, z: cz,
            headingRad: th, mode: m, qaColor: qa, drawn: inf.drawn,
            file: await shot(page, 'closeup-' + tag + '-th' + String(th).replace(/[.-]/g, '') ) });
        }
      }
      await page.evaluate(JS.qa(false));
    }
  } finally { await b.close(); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { for (const s of o.shots) console.log('[closeup]', s.mode, s.qaColor ? 'QA' : '  ', 'drawn=' + s.drawn, s.file); })
    .catch((e) => { console.error(e); process.exit(1); });
}
