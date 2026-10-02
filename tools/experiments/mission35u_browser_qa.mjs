// tools/experiments/mission35u_browser_qa.mjs
// [Mission 35U §8] 3 視点（oblique / top-down / side）で raw(35S) と planar(35U) を見比べる。
//   前提: dev を http://localhost:8080 で配信していること。
//   出力: data/reports/mission35u-building-part-roof-planes/*.jpg + browser-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION35U_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const OUT_DIR = 'data/reports/mission35u-building-part-roof-planes';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** §8 の 3 視点。ph は俯角（度）。 */
export const VIEWS = [
  { id: 'oblique', label: '斜め', phDeg: 40, r: 170 },
  { id: 'top-down', label: '真上', phDeg: 88, r: 150 },
  // ph 6 / r 200 だとカメラ高さが約 21m にしかならず、60m 級の隣接建物の
  //   内側に入ってしまって何も写らなかった（実測）。棟を横から見つつ近隣を越える角度へ。
  { id: 'side', label: '真横', phDeg: 20, r: 300 },
];
export const MODES = ['RAW', 'PLANAR', 'BOTH'];

const DEBUG_U = 'JSON.stringify(window.__PLANAR_ROOF_DEBUG__())';
const DEBUG_S = 'JSON.stringify(window.__CUSTOM_LOD2_DEBUG__())';

const setView = (phDeg, r) => `(() => {
  if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
  cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0; camUpd(); return 1; })()`;

/** 両方のメッシュが画面に入っているか、三角形数はいくつか。 */
const MESH_STATE = `(() => {
  function info(name) {
    const o = scene.getObjectByName(name);
    if (!o) return null;
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    const bs = o.geometry.boundingSphere;
    const c = bs.center.clone(); o.updateMatrixWorld(); c.applyMatrix4(o.matrixWorld);
    const p = c.clone().project(camera);
    const idx = o.geometry.getIndex();
    return { visible: o.visible, parentVisible: !!(o.parent && o.parent.visible),
      triangles: idx ? idx.count / 3 : 0,
      ndc: [+p.x.toFixed(3), +p.y.toFixed(3)],
      inView: Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1 };
  }
  // 足元の canonical LOD1 が消えていないこと（§7）
  let lod1 = 0;
  try {
    const d = window.__CUSTOM_LOD2_DEBUG__();
    lod1 = d.lod1SuppressedCount || 0;
  } catch (e) { /* noop */ }
  return JSON.stringify({ raw35S: info('CR_customLod2_35S_mesh'), planar35U: info('CR_planarRoof_35U_mesh'),
    label35U: !!scene.getObjectByName('CR_planarRoof_35U_label'),
    lod1SuppressedCount: lod1, cameraR: cs.r });
})()`;

const HIDE_DEV_UI = `(() => {
  for (const el of document.querySelectorAll('div,button')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|layer-toggle|^tip$|^pl$|^pr$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery|stations-toggle|town-click|town-boundary/.test(id)) el.style.display = 'none'; }
  return 1; })()`;

/** §8 の目視用。canonical 建物を一時的に隠して屋根面だけを見る。
 *  これは §7 が禁じている「LOD1 suppression」ではなく、撮影のためにレイヤーの
 *  visible を落として必ず元へ戻す計測用の操作。lod1SuppressedCount は 0 のまま。 */
const SET_BLDG = (on) => `(() => { try { CanonicalRuntime.setLayerVisible('buildings', ${on}); } catch (e) { return 0; } return 1; })()`;

async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64'));
  return OUT_DIR + '/' + name + '.jpg';
}

const b = await launchBrowser({ width: 1440, height: 900 });
const page = b.page;
const out = { url: URL_, generatedAt: new Date().toISOString(), mission: '35U', views: [], jsErrors: [] };
try {
  await page.send('Page.navigate', { url: URL_ });
  await sleep(22000);
  // 「35S 点群LOD2へ」で対象へ（区切替 + 寄り）
  await page.evaluate(`(() => { const el = document.getElementById('mission35s-focus'); if (el) el.click(); return 1; })()`);
  await sleep(26000);
  await page.evaluate(HIDE_DEV_UI);

  out.debug35U = JSON.parse(await page.evaluate(DEBUG_U, { timeoutMs: 120000 }));
  out.debug35S = JSON.parse(await page.evaluate(DEBUG_S, { timeoutMs: 120000 }));

  for (const v of VIEWS) {
    for (const mode of MODES) {
      await page.evaluate(`(() => { window.__PLANAR_ROOF_MODE__(${JSON.stringify(mode)}); return 1; })()`);
      await sleep(1200);
      await page.evaluate(setView(v.phDeg, v.r));
      await sleep(2600);
      await page.evaluate(HIDE_DEV_UI);
      const st = JSON.parse(await page.evaluate(MESH_STATE, { timeoutMs: 60000 }));
      const p = await shot(page, `${v.id}-${mode.toLowerCase()}`);
      // canonical 建物に隠れて見えないことがあるので、隠した絵も残す（撮ったら必ず戻す）
      let pBare = null;
      if (mode !== 'BOTH') {
        const okHide = await page.evaluate(SET_BLDG(false));
        await sleep(900);
        await page.evaluate(HIDE_DEV_UI);
        pBare = await shot(page, `${v.id}-${mode.toLowerCase()}-nobldg`);
        await page.evaluate(SET_BLDG(true));
        await sleep(600);
        const back = JSON.parse(await page.evaluate(MESH_STATE, { timeoutMs: 60000 }));
        out.restore = out.restore || [];
        out.restore.push({ view: v.id, mode, hidden: !!okHide, lod1AfterRestore: back.lod1SuppressedCount });
      }
      out.views.push({ view: v.id, label: v.label, mode, ...st, shot: p, shotNoBuildings: pBare });
      console.log(`[35U-qa] ${v.id.padEnd(9)} ${mode.padEnd(7)} raw=${st.raw35S ? (st.raw35S.visible && st.raw35S.parentVisible) : '-'}`
        + ` planar=${st.planar35U ? (st.planar35U.visible && st.planar35U.parentVisible) : '-'}`
        + ` lod1Suppressed=${st.lod1SuppressedCount}`);
    }
  }
} finally { try { await b.close(); } catch { /* noop */ } }

const shown = (x) => !!(x && x.visible && x.parentVisible);
const byMode = (m) => out.views.filter((v) => v.mode === m);
out.summary = {
  partVerdict: out.debug35U && out.debug35U.partVerdict,
  planeCount: out.debug35U && out.debug35U.planeCount,
  roofType: out.debug35U && out.debug35U.roofType,
  rawTriangles: out.debug35S && out.debug35S.triangles,
  planarTriangles: out.debug35U && out.debug35U.triangles,
  planarRoofTriangles: out.debug35U && out.debug35U.roofTriangles,
  planarWallTriangles: out.debug35U && out.debug35U.wallTriangles,
  roofCandidatePoints: out.debug35U && out.debug35U.roofCandidatePoints,
  containment: out.debug35U && out.debug35U.containment,
  // §6 モードが効いているか
  rawModeShowsRawOnly: byMode('RAW').every((v) => shown(v.raw35S) && !shown(v.planar35U)),
  planarModeShowsPlanarOnly: byMode('PLANAR').every((v) => shown(v.planar35U) && !shown(v.raw35S)),
  bothModeShowsBoth: byMode('BOTH').every((v) => shown(v.raw35S) && shown(v.planar35U)),
  // §7 canonical 全体の LOD1 を消していない
  lod1NeverSuppressed: out.views.every((v) => (v.lod1SuppressedCount || 0) === 0),
  planarInViewAllViews: byMode('PLANAR').every((v) => v.planar35U && v.planar35U.inView),
  views: VIEWS.map((v) => v.id),
  // 撮影のために隠した canonical 建物を毎回戻せているか
  buildingsRestored: (out.restore || []).every((r) => r.lod1AfterRestore === 0),
  jsErrors: out.jsErrors.length,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'browser-qa.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log('[35U-qa] out', OUT_DIR);
