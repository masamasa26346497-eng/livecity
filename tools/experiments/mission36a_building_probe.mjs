// tools/experiments/mission36a_building_probe.mjs
// [Mission 36A 調査] 近景で建物を描いているのがどの group かを確かめる（QA 条件4 の計測が空振りしていたため）。
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION36A_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const goTo = (lat, lon, r, phDeg) => `(() => {
  if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
  const p = geoToThree(${lat}, ${lon});
  cs.tgt.x = p.x; cs.tgt.z = p.z; cs.tgt.y = 0;
  cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0.6; camUpd();
  return 1; })()`;

const PROBE = `(() => {
  const isVis = (o) => { let p = o; while (p) { if (p.visible === false) return false; p = p.parent; } return true; };
  // 画面中央から ray を撃って、最初に当たる mesh の系統を見る
  const rc = new THREE.Raycaster();
  const hitNames = {};
  const all = [];
  scene.traverse((o) => { if (o.isMesh && isVis(o)) all.push(o); });
  for (let sx = -0.5; sx <= 0.4; sx += 0.05) {
    for (let sy = -0.4; sy <= 0.4; sy += 0.05) {
      rc.setFromCamera(new THREE.Vector2(sx, sy), camera);
      const h = rc.intersectObjects(all, false)[0];
      if (!h) continue;
      let o = h.object, chain = [];
      while (o) { if (o.name) chain.push(o.name); o = o.parent; }
      const key = chain.slice(0, 3).join(' < ');
      hitNames[key] = (hitNames[key] || 0) + 1;
    }
  }
  // 「CR_buildings 配下の可視 mesh 数」も数える
  let crb = 0, crbVis = 0;
  scene.traverse((o) => {
    if (o.name !== 'CR_buildings') return;
    o.traverse((c) => { if (c.isMesh) { crb++; if (isVis(c)) crbVis++; } });
  });
  return JSON.stringify({ crBuildingMeshes: crb, crBuildingVisible: crbVis, rayHits: hitNames });
})()`;

const bro = await launchBrowser({ width: 1440, height: 900 });
const page = bro.page;
try {
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const ok = await page.evaluate("(typeof geoToThree === 'function' && !!window.__CANONICAL_RUNTIME__)", { timeoutMs: 30000 }).catch(() => false);
    if (ok === true) break;
  }
  await sleep(6000);
  for (const sp of [{ n: 'umeda-close', lat: 34.7025, lon: 135.4959, r: 420, ph: 30 },
    { n: 'honmachi-close', lat: 34.6823, lon: 135.5024, r: 380, ph: 34 }]) {
    await page.evaluate(goTo(sp.lat, sp.lon, sp.r, sp.ph));
    await sleep(16000);
    const p = JSON.parse(await page.evaluate(PROBE, { timeoutMs: 180000 }));
    console.log('==', sp.n, 'CR_buildings mesh', p.crBuildingMeshes, 'visible', p.crBuildingVisible);
    for (const [k, v] of Object.entries(p.rayHits).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log('   ', String(v).padStart(4), k);
  }
} finally { try { await bro.close(); } catch (e) { /* noop */ } }
