// tools/experiments/mission35s_match_diag.mjs
// [Mission 35S] 試作 LOD2 が canonical 建物と一致しない原因を実機で切り分ける。
//   出力は標準出力の JSON 1 行。
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION35S_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  const d = window.__CUSTOM_LOD2_DEBUG__();
  const out = { debug: { canonicalId: d.canonicalId, visible: d.visible, loaded: d.loaded,
    error: d.error, matched: d.matched, suppressActive: d.suppressActive } };
  out.ward = (typeof WardModeManager !== 'undefined' && WardModeManager.getCurrentWard)
    ? ((WardModeManager.getCurrentWard() || {}).id || null) : null;
  out.camera = { x: +cs.tgt.x.toFixed(1), z: +cs.tgt.z.toFixed(1), r: cs.r };
  out.detectWardAtTarget = (typeof WardModeManager !== 'undefined')
    ? WardModeManager.detectWardAt(-3968.47, -14803.99) : null;
  try {
    const fps = CanonicalRuntime.visibleBuildingFootprints() || [];
    out.footprintCount = fps.length;
    out.footprintKeys = fps.length ? Object.keys(fps[0]) : [];
    const near = fps.map((f) => {
      const ring = f.ring || f.fp || (f.coordinates && f.coordinates[0]);
      let cx = f.cx, cz = f.cz;
      if ((cx == null || cz == null) && Array.isArray(f.centroid)) { cx = f.centroid[0]; cz = f.centroid[1]; }
      if ((cx == null || cz == null) && ring) {
        let sx = 0, sz = 0; for (const p of ring) { sx += p[0]; sz += p[1]; }
        cx = sx / ring.length; cz = sz / ring.length;
      }
      return { id: f.canonicalId || f.id, d: Math.hypot(cx - (-3968.47), cz - (-14803.99)), hasRing: !!ring,
        ringLen: ring ? ring.length : 0 };
    }).sort((a, c) => a.d - c.d).slice(0, 6);
    out.nearest = near.map((n) => ({ id: n.id, distM: +n.d.toFixed(1), hasRing: n.hasRing, ringLen: n.ringLen }));
  } catch (e) { out.footprintError = String(e && e.message || e); }
  out.wantTile = Math.floor(-3968.47 / 500) + '_' + Math.floor(-14803.99 / 500);
  try {
    const keys = CanonicalRuntime.buildingTileKeys();
    out.tileCount = keys.size;
    out.hasWantTile = keys.has(out.wantTile);
  } catch (e) { out.tileError = String(e && e.message || e); }
  return JSON.stringify(out);
})()`;

const b = await launchBrowser({ width: 1440, height: 900 });
const page = b.page;
try {
  await page.send('Page.navigate', { url: URL_ });
  await sleep(22000);
  await page.evaluate(`(() => { const el = document.getElementById('mission35s-focus'); if (el) el.click(); return 1; })()`);
  await sleep(26000);
  console.log(await page.evaluate(PROBE, { timeoutMs: 120000 }));
} finally { try { await b.close(); } catch { /* noop */ } }
