// tools/experiments/mission35z_photo_qa.mjs
// [Mission 35Z §13/§14] hover 写真の実機確認。
//   索引に入っている建物の画面座標を求め、実際に mousemove を投げて
//   dwell 後にカードが出るか / 別建物へ移ったら切り替わるか / 写真なしで壊れないかを見る。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION35Z_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const OUT_DIR = 'data/reports/mission35z-building-photo-preview';
const INDEX = 'public/map-data/osaka-city/derived/building-photo-index.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const idx = JSON.parse(fs.readFileSync(INDEX, 'utf-8'));
const targets = Object.entries(idx.byCanonicalId).map(([id, r]) => ({ id, name: r.buildingName, lat: r.lat, lon: r.lon }));

/** §13 の地点。
 *  **索引に入っている建物そのものへカメラを寄せる**（適当な地点を回ると標本 0 になり、
 *  every() が空集合で true になって「成功」に見えてしまう＝前回それを踏んだ）。
 *  加えて、写真が無い場所（新高）も対照として回す。 */
const SPOTS = [
  ...targets.filter((t) => t.lat != null).map((t) => ({
    id: 'photo-' + t.id.slice(-8), name: t.name, lat: t.lat, lon: t.lon, r: 340, ph: 44, expectPhoto: true,
  })),
  { id: 'niitaka-nophoto', name: '新高(写真なし例)', lat: 34.7280, lon: 135.4703, r: 320, ph: 46, expectPhoto: false },
  { id: 'honmachi-nophoto', name: '本町(写真なし例)', lat: 34.6823, lon: 135.5024, r: 320, ph: 44, expectPhoto: false },
];

const goTo = (lat, lon, r, phDeg) => `(() => {
  if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
  const p = geoToThree(${lat}, ${lon});
  cs.tgt.x = p.x; cs.tgt.z = p.z; cs.tgt.y = 0;
  cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0.6; camUpd();
  try { const w = WardModeManager.detectWardAt(p.x, p.z);
    const cur = WardModeManager.getCurrentWard && WardModeManager.getCurrentWard();
    if (w && (!cur || cur.id !== w)) WardModeManager.switchWard(w); } catch (e) { /* noop */ }
  return 1; })()`;

/** 画面内にある「索引つき建物」を探して screen 座標を返す。無ければ適当な建物を返す。 */
const FIND = (wantIds) => `(() => {
  const want = new Set(${JSON.stringify(wantIds)});
  const fps = CanonicalRuntime.visibleBuildingFootprints(60000) || [];
  camera.updateMatrixWorld();
  const W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight;
  const bMeshes = [];
  scene.traverse((o) => { if (o.isMesh && o.visible && o.userData && o.userData.usageCategory
    && o.parent && o.parent.visible !== false) bMeshes.push(o); });
  const down = new THREE.Vector3(0, -1, 0);
  const roofY = (x, z) => { const rc = new THREE.Raycaster(new THREE.Vector3(x, 4000, z), down);
    for (const h of rc.intersectObjects(bMeshes, false)) if (h.point.y > 0.6) return h.point.y; return null; };
  const v = new THREE.Vector3();
  const pick = (list) => {
    let best = null;
    for (const f of list) {
      const y = roofY(f.cx, f.cz); if (y == null) continue;
      v.set(f.cx, y - 0.2, f.cz).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 0.85 || Math.abs(v.y) > 0.85) continue;
      const sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H;
      const d = Math.hypot(sx - W / 2, sy - H / 2);
      if (!best || d < best.d) best = { id: f.canonicalId, name: f.name || null, sx: Math.round(sx), sy: Math.round(sy), d };
    }
    return best;
  };
  const withPhoto = pick(fps.filter((f) => want.has(f.canonicalId)));
  const any = pick(fps);
  return JSON.stringify({ withPhoto, any, visible: fps.length });
})()`;

const hover = (x, y) => `(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y}, bubbles: true })); return 1; })()`;
// クリックは「押して離す」1 gesture として見られている（clickIntentAllows）。
//   click だけ投げても弾かれるので、mousedown → mouseup → click を同じ座標で出す。
const click = (x, y) => `(() => { const c = document.getElementById('c');
  const o = { clientX: ${x}, clientY: ${y}, bubbles: true, button: 0 };
  window.dispatchEvent(new MouseEvent('mousemove', o));
  c.dispatchEvent(new MouseEvent('mousedown', o));   // mousedown は canvas で拾っている
  window.dispatchEvent(new MouseEvent('mouseup', o));
  c.dispatchEvent(new MouseEvent('click', o));
  return JSON.stringify({ allowed: (typeof clickIntentAllows === 'function') ? clickIntentAllows() : null }); })()`;

const CARD_STATE = `(() => {
  const c = document.getElementById('bldg-photo-card');
  const st = c ? getComputedStyle(c) : null;
  const img = c ? c.querySelector('.bp-img') : null;
  const sec = document.getElementById('pc-photo-section');
  return JSON.stringify({
    hoverCardVisible: !!(st && st.display === 'block'),
    hoverTitle: c ? (c.querySelector('.bp-title') || {}).textContent || null : null,
    hoverHasImg: !!img,
    hoverImgSrc: img ? (img.getAttribute('src') || '').slice(0, 80) : null,
    hoverImgLoaded: img ? (img.complete && img.naturalWidth > 0) : null,
    hoverLicense: c ? ((c.querySelector('.bp-lic') || {}).textContent || null) : null,
    hoverNone: c ? !!c.querySelector('.bp-none') : false,
    cardSectionVisible: !!(sec && getComputedStyle(sec).display === 'block'),
    cardPhotos: sec ? sec.querySelectorAll('.pc-photo').length : 0,
    cardLinks: sec ? sec.querySelectorAll('.pc-photo-link').length : 0,
    cardNone: sec ? !!sec.querySelector('.pc-photo-none') : false,
    debug: window.__BUILDING_PHOTO_DEBUG__ ? window.__BUILDING_PHOTO_DEBUG__() : null,
  });
})()`;

const HIDE_DEV_UI = `(() => {
  for (const el of document.querySelectorAll('div,button')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|^pl$|^pr$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery|mission35s-focus|town-click/.test(id)) el.style.display = 'none'; }
  return 1; })()`;

async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64'));
}

const wantIds = targets.map((t) => t.id);
const b = await launchBrowser({ width: 1440, height: 900 });
const page = b.page;
const out = { url: URL_, generatedAt: new Date().toISOString(), mission: '35Z', spots: [], jsErrors: [] };
page.on && page.on('Runtime.exceptionThrown', (e) => {
  try { out.jsErrors.push(String(e.exceptionDetails && e.exceptionDetails.text)); } catch { /* noop */ }
});
try {
  await page.send('Runtime.enable').catch(() => {});
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const ok = await page.evaluate("(typeof geoToThree === 'function' && typeof CanonicalRuntime !== 'undefined' && !!CanonicalRuntime.visibleBuildingFootprints)",
      { timeoutMs: 30000 }).catch(() => false);
    if (ok === true || ok === 'true') break;
  }
  await sleep(5000);

  for (const sp of SPOTS) {
    await page.evaluate(goTo(sp.lat, sp.lon, sp.r, sp.ph));
    let prev = -1, stable = 0;
    for (let i = 0; i < 25; i++) {
      await sleep(2000);
      const n = Number(await page.evaluate('(CanonicalRuntime.visibleBuildingFootprints(60000) || []).length', { timeoutMs: 60000 }));
      if (n === prev && n > 0) { if (++stable >= 3) break; } else stable = 0;
      prev = n;
    }
    await page.evaluate(HIDE_DEV_UI);
    const found = JSON.parse(await page.evaluate(FIND(wantIds), { timeoutMs: 120000 }));
    const rec = { spot: sp.id, visible: found.visible, hasPhotoTarget: !!found.withPhoto };

    // 1) 写真つき建物（あれば）を hover
    const t = found.withPhoto || found.any;
    if (t) {
      await page.evaluate(hover(t.sx, t.sy));
      await sleep(250);
      rec.beforeDwell = JSON.parse(await page.evaluate(CARD_STATE, { timeoutMs: 60000 }));   // §4 dwell 前は出ない
      await sleep(1400);
      // 画像の取得を待つ（最初の 1 枚はネットから取るので時間がかかる）
      for (let i = 0; i < 12; i++) {
        const st = JSON.parse(await page.evaluate(CARD_STATE, { timeoutMs: 60000 }));
        if (!st.hoverHasImg || st.hoverImgLoaded) { rec.afterDwell = st; break; }
        rec.afterDwell = st;
        await sleep(1200);
      }
      rec.target = t;
      if (found.withPhoto) await shot(page, 'hover-' + sp.id);
      else await shot(page, 'nophoto-' + sp.id);

      // 2) 別の建物へ移すと切り替わる / 消える
      if (found.any && found.withPhoto && found.any.id !== found.withPhoto.id) {
        await page.evaluate(hover(found.any.sx, found.any.sy));
        await sleep(1400);
        rec.afterMove = JSON.parse(await page.evaluate(CARD_STATE, { timeoutMs: 60000 }));
        rec.movedTo = found.any.id;
      }

      // 3) click で property card の写真欄
      await page.evaluate(click(t.sx, t.sy));
      await sleep(1800);
      rec.afterClick = JSON.parse(await page.evaluate(CARD_STATE, { timeoutMs: 60000 }));
      if (found.withPhoto) await shot(page, 'click-' + sp.id);
    }
    out.spots.push(rec);
    const a = rec.afterDwell || {};
    console.log(`[35Z-qa] ${sp.id.padEnd(16)} target=${found.withPhoto ? 'photo' : 'no-photo'}`
      + ` card=${a.hoverCardVisible} img=${a.hoverHasImg} loaded=${a.hoverImgLoaded}`
      + ` none=${a.hoverNone} clickPhotos=${(rec.afterClick || {}).cardPhotos}`);
  }
} finally { try { await b.close(); } catch { /* noop */ } }

const withTarget = out.spots.filter((s) => s.hasPhotoTarget);
out.summary = {
  spots: out.spots.length,
  spotsWithPhotoTarget: withTarget.length,
  // §4 dwell 前には出さない
  noShowBeforeDwell: out.spots.every((s) => !s.beforeDwell || !s.beforeDwell.hoverCardVisible),
  // 写真つき建物では dwell 後にカードと画像が出る。
  //   標本が 0 なら every() は true になってしまうので、必ず件数も併記する。
  showsAfterDwell: withTarget.length > 0
    && withTarget.every((s) => s.afterDwell && s.afterDwell.hoverCardVisible && s.afterDwell.hoverHasImg),
  imagesActuallyLoaded: withTarget.length > 0
    && withTarget.every((s) => s.afterDwell && s.afterDwell.hoverImgLoaded === true),
  licenseShown: withTarget.length > 0
    && withTarget.every((s) => s.afterDwell && !!s.afterDwell.hoverLicense),
  // §11 写真なし建物では誤写真を出さない
  noWrongPhotoOnOthers: out.spots.every((s) => !s.afterMove || !s.afterMove.hoverCardVisible || s.afterMove.hoverNone),
  // §5 click で詳細欄
  clickSectionShown: withTarget.length > 0
    && withTarget.every((s) => s.afterClick && s.afterClick.cardSectionVisible),
  clickPhotoCounts: out.spots.map((s) => ({ spot: s.spot, photos: (s.afterClick || {}).cardPhotos || 0,
    none: !!(s.afterClick || {}).cardNone })),
  jsErrors: out.jsErrors.length,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'photo-qa.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log('[35Z-qa] out', OUT_DIR);
