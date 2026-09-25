// tools/experiments/mission35t_browser_qa.mjs
// [Mission 35T §10] 照合の結果を実機で確かめる。
//   1-source-vs-canonical.jpg  … 赤(OSM source) と 青(best canonical) の対応
//   2-candidate-comparison.jpg … 黄(second) も含めた比較
//   3-final-match.jpg          … 最終判定の状態
//   前提: dev を http://localhost:8080 で配信していること。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION35T_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const OUT_DIR = 'data/reports/mission35t-custom-lod2-matching';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEBUG = 'JSON.stringify(window.__CUSTOM_LOD2_DEBUG__())';

/** overlay の 3 本の輪郭が実際に作られ、画面に入っているか。 */
const OVERLAY_STATE = `(() => {
  const g = scene.getObjectByName('CR_customLod2_35T_overlay');
  if (!g) return JSON.stringify({ group: false });
  let rings = 0, markers = 0, labels = 0;
  const colors = [];
  for (const o of g.children) {
    if (o.isSprite) { labels++; continue; }
    if (o.geometry && o.geometry.type === 'SphereGeometry') { markers++; continue; }
    rings++;
    if (o.material && o.material.color) colors.push('#' + o.material.color.getHex().toString(16).padStart(6, '0'));
  }
  // 試作メッシュが半透明になっているか
  const mesh = scene.getObjectByName('CR_customLod2_35S_mesh');
  const op = mesh ? (Array.isArray(mesh.material) ? mesh.material[0].opacity : mesh.material.opacity) : null;
  return JSON.stringify({ group: true, visible: g.visible, rings, markers, labels, colors,
    prototypeOpacity: op, cameraR: (typeof cs !== 'undefined' ? cs.r : null) });
})()`;

async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64'));
  return OUT_DIR + '/' + name + '.jpg';
}

const b = await launchBrowser({ width: 1440, height: 900 });
const page = b.page;
const out = { url: URL_, generatedAt: new Date().toISOString(), mission: '35T', steps: {}, jsErrors: [] };
try {
  await page.send('Page.navigate', { url: URL_ });
  await sleep(22000);
  // 「35S 点群LOD2へ」で対象へ移動（区切替 + r=150）
  await page.evaluate(`(() => { const el = document.getElementById('mission35s-focus'); if (el) el.click(); return 1; })()`);
  await sleep(26000);

  out.steps.debug = JSON.parse(await page.evaluate(DEBUG, { timeoutMs: 120000 }));

  // 1) source(赤) と best(青)
  await page.evaluate(`(() => { window.__CUSTOM_LOD2_OVERLAY__(true); return 1; })()`);
  await sleep(2500);
  out.steps.overlay = JSON.parse(await page.evaluate(OVERLAY_STATE, { timeoutMs: 60000 }));
  out.steps.shot1 = await shot(page, '1-source-vs-canonical');

  // 2) 少し引いて second まで入れる
  await page.evaluate(`(() => { cs.r = 320; camUpd(); return 1; })()`);
  await sleep(4000);
  out.steps.shot2 = await shot(page, '2-candidate-comparison');

  // 3) overlay を消した最終状態
  await page.evaluate(`(() => { window.__CUSTOM_LOD2_OVERLAY__(false); cs.r = 170; camUpd(); return 1; })()`);
  await sleep(4000);
  out.steps.final = JSON.parse(await page.evaluate(DEBUG, { timeoutMs: 60000 }));
  out.steps.shot3 = await shot(page, '3-final-match');
} finally { try { await b.close(); } catch { /* noop */ } }

const d = out.steps.debug || {};
const ov = out.steps.overlay || {};
out.summary = {
  matchConfidence: d.matchConfidence,
  canonicalId: d.canonicalId,
  bestCandidate: d.bestCandidate,
  secondCandidate: d.secondCandidate,
  iou: d.iou,
  centroidDistanceM: d.centroidDistanceM,
  areaRatio: d.areaRatio,
  sourceCoveredRatio: d.sourceCoveredRatio,
  candidateCoveredRatio: d.candidateCoveredRatio,
  candidateCount: d.candidateCount,
  heightDeltaM: d.heightDeltaM,
  ambiguousReason: d.ambiguousReason,
  matchReason: d.matchReason,
  lod1SuppressionAllowed: d.lod1SuppressionAllowed,
  lod1SuppressedCount: d.lod1SuppressedCount,
  suppressActive: d.suppressActive,
  visible: d.visible,
  overlayRings: ov.rings,
  overlayLabels: ov.labels,
  overlayColors: ov.colors,
  prototypeOpacityWithOverlay: ov.prototypeOpacity,
  jsErrors: out.jsErrors.length,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'browser-qa.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log('[35T-qa] out', OUT_DIR);
