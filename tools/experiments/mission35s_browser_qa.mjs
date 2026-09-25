// tools/experiments/mission35s_browser_qa.mjs
// [Mission 35S §9/§10] 「35S 点群LOD2へ」を押した直後に、試作 1 棟が画面中央へ大きく出て
//   「35S CUSTOM LOD2」ラベルが見えること、元 LOD1 が抑制されていることを実機で確かめる。
//   前提: dev を http://localhost:8080 で配信していること。
//   出力: data/reports/mission35s-custom-lod2-qa/*.jpg + summary.json
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION35S_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const OUT_DIR = 'data/reports/mission35s-custom-lod2-qa';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEBUG = 'JSON.stringify(window.__CUSTOM_LOD2_DEBUG__())';

/** 画面内に試作メッシュとラベルが実際に映っているか（投影して確かめる）。 */
const ON_SCREEN = `(() => {
  const g = scene.getObjectByName('CR_customLod2_35S');
  if (!g) return JSON.stringify({ group: false });
  const mesh = scene.getObjectByName('CR_customLod2_35S_mesh');
  const label = scene.getObjectByName('CR_customLod2_35S_label');
  function frac(o) {
    if (!o || !o.geometry) return null;
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    const bs = o.geometry.boundingSphere;
    const c = bs.center.clone(); o.updateMatrixWorld(); c.applyMatrix4(o.matrixWorld);
    const p = c.clone().project(camera);
    // 半径の画面上の大きさ（縦を 1 とした割合）
    const edge = c.clone(); edge.x += bs.radius;
    const pe = edge.clone().project(camera);
    return { ndc: [+p.x.toFixed(3), +p.y.toFixed(3)], inView: Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1,
      screenRadius: +Math.abs(pe.x - p.x).toFixed(3) };
  }
  // label.position へ matrixWorld を掛けると位置とスケールが二重に効いて座標が壊れる。
  //   world 座標は getWorldPosition で取る。
  const lp = label ? (() => { label.updateMatrixWorld();
    const v = new THREE.Vector3(); label.getWorldPosition(v);
    const p = v.clone().project(camera);
    return { world: [+v.x.toFixed(1), +v.y.toFixed(1), +v.z.toFixed(1)],
      ndc: [+p.x.toFixed(3), +p.y.toFixed(3)], inView: Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1 }; })() : null;
  return JSON.stringify({ group: true, groupVisible: g.visible, mesh: frac(mesh), label: lp,
    labelVisible: !!(label && label.visible), cameraR: (typeof cs !== 'undefined' ? cs.r : null) });
})()`;

/** §6 元 LOD1 が同時に出ていないか。canonical 建物メッシュ側に対象 id が残っていないこと。 */
const SUPPRESSION = `(() => {
  const d = window.__CUSTOM_LOD2_DEBUG__();
  const id = d.canonicalId;
  const out = { canonicalId: id, suppressActive: d.suppressActive, visible: d.visible,
    officialOwnsCanonical: d.officialOwnsCanonical, landmarkOwnsCanonical: d.landmarkOwnsCanonical };
  // CanonicalRuntime が「この棟を抑制中」と答えるか
  try { out.layerSaysSuppressed = window.__CUSTOM_LOD2_LAYER__.isSuppressedBuilding(id); }
  catch (e) { out.layerSaysSuppressed = null; }
  // footprint 一覧は property card 用に残る仕様なので、同時表示の判定には使えない。
  //   canonical runtime が LOD1 の箱を積む直前に isSuppressedBuilding() を呼び、
  //   true なら continue する。その回数が「LOD1 を出さなかった回数」。
  out.lod1SuppressedCount = d.lod1SuppressedCount;
  try {
    const fps = CanonicalRuntime.visibleBuildingFootprints() || [];
    out.footprintCount = fps.length;
    out.footprintKeepsTargetForCard = fps.some((f) => (f.canonicalId || f.id) === id);
  } catch (e) { out.footprintCount = null; }
  return JSON.stringify(out);
})()`;

async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64'));
  return OUT_DIR + '/' + name + '.jpg';
}

const b = await launchBrowser({ width: 1440, height: 900 });
const page = b.page;
const out = { url: URL_, generatedAt: new Date().toISOString(), mission: '35S', steps: {} };
try {
  await page.send('Page.navigate', { url: URL_ });
  await sleep(22000);
  out.steps.beforeShot = await shot(page, '1-before-focus');

  // 「35S 点群LOD2へ」を実際に押す
  const clicked = await page.evaluate(`(() => {
    const el = document.getElementById('mission35s-focus');
    if (!el) return JSON.stringify({ found: false });
    el.click();
    return JSON.stringify({ found: true });
  })()`, { timeoutMs: 60000 });
  out.steps.buttonClick = JSON.parse(clicked);
  // 区切替 + 建物タイル読み込み + 突き合わせを待つ
  await sleep(26000);

  out.steps.debug = JSON.parse(await page.evaluate(DEBUG, { timeoutMs: 60000 }));
  out.steps.onScreen = JSON.parse(await page.evaluate(ON_SCREEN, { timeoutMs: 60000 }));
  out.steps.suppression = JSON.parse(await page.evaluate(SUPPRESSION, { timeoutMs: 60000 }));
  out.steps.afterShot = await shot(page, '2-after-focus');

  // 試作をクリックして QA カードを出す
  const card = await page.evaluate(`(() => {
    if (window.__MISSION35S_QA_CARD__) window.__MISSION35S_QA_CARD__();
    const el = document.getElementById('mission35s-qa-card');
    return JSON.stringify({ shown: !!el && el.style.display !== 'none',
      text: el ? el.innerText.replace(/\\s+/g, ' ').slice(0, 400) : null });
  })()`, { timeoutMs: 60000 });
  out.steps.qaCard = JSON.parse(card);
  await sleep(700);
  out.steps.cardShot = await shot(page, '3-qa-card');
} finally { try { await b.close(); } catch { /* noop */ } }

const d = out.steps.debug || {};
const os_ = out.steps.onScreen || {};
const sp = out.steps.suppression || {};
out.summary = {
  canonicalId: d.canonicalId,
  heightMedianM: d.heightMedianM,
  triangles: d.triangles,
  matchDistanceM: d.matchDistanceM,
  areaRatio: d.areaRatio,
  sourceFootprintAreaM2: d.sourceFootprintAreaM2,
  visible: d.visible,
  suppressActive: d.suppressActive,
  lod1SuppressedCount: sp.lod1SuppressedCount,
  footprintKeepsTargetForCard: sp.footprintKeepsTargetForCard,
  officialOwnsCanonical: d.officialOwnsCanonical,
  landmarkOwnsCanonical: d.landmarkOwnsCanonical,
  cameraR: os_.cameraR,
  meshInView: os_.mesh && os_.mesh.inView,
  meshScreenRadius: os_.mesh && os_.mesh.screenRadius,
  labelInView: os_.label && os_.label.inView,
  labelWorld: os_.label && os_.label.world,
  qaCardShown: out.steps.qaCard && out.steps.qaCard.shown,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log('[35S-qa] out', OUT_DIR);
