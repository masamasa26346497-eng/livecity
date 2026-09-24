#!/usr/bin/env node
// tools/audit/official-town-boundaries-qa.js
// [Mission 35L §9] 24 区の公式町丁目境界を実ブラウザで確認する。
//   流れは「開く → 見る → 町名をクリック → スクリーンショット」。
//   Console 入力をユーザーへ求めない。対象は dev のみ（production は触らない）。
//   前提: `npm run preview`
//   出力: data/reports/official-town-boundaries-qa.json
//         data/reports/official-town-boundaries-qa/*.jpg
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
export const OUT = P('data', 'reports', 'official-town-boundaries-qa.json');
export const SHOTS = P('data', 'reports', 'official-town-boundaries-qa');
export const AREA_DOC = P('public', 'map-data', 'osaka-city', 'derived', 'area-boundaries.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * §9 代表地点。ミッション指定の 6 点に、24 区から広く取った地点を足す。
 * 35K では梅田・本町・淡路は区界へ落ちていた（町丁目データが無かった）。
 * 35L の公式境界が入れば、すべて chochome 粒度で選べるはず。
 */
export const SITES = [
  { id: 'umeda', label: '梅田', ward: '北区', lat: 34.70250, lon: 135.49586, r: 1200 },
  { id: 'honmachi', label: '本町', ward: '中央区', lat: 34.68200, lon: 135.49900, r: 1200 },
  { id: 'namba', label: '難波', ward: '中央区', lat: 34.66600, lon: 135.50100, r: 1200 },
  { id: 'awaji', label: '淡路', ward: '東淀川区', lat: 34.74640, lon: 135.53170, r: 1200 },
  { id: 'higashimikuni', label: '東三国', ward: '淀川区', lat: 34.74140, lon: 135.49890, r: 1200 },
  { id: 'sumiyoshi', label: '住吉', ward: '住吉区', lat: 34.61200, lon: 135.49300, r: 1400 },
  // 24 区から広く（南北・東西・埋立地を含める）
  { id: 'tennoji', label: '天王寺', ward: '天王寺区', lat: 34.64550, lon: 135.51400, r: 1200 },
  { id: 'kyobashi', label: '京橋', ward: '都島区', lat: 34.69700, lon: 135.53400, r: 1200 },
  { id: 'konohana', label: '此花', ward: '此花区', lat: 34.68300, lon: 135.44600, r: 1600 },
  { id: 'hirano', label: '平野', ward: '平野区', lat: 34.61800, lon: 135.55200, r: 1400 },
  { id: 'ikuno', label: '生野', ward: '生野区', lat: 34.65300, lon: 135.53600, r: 1200 },
  { id: 'suminoe', label: '住之江・南港', ward: '住之江区', lat: 34.61000, lon: 135.45500, r: 2000 },
];

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z});
    if (CityModeManager.isActive()) CityModeManager.exit(wid);
    if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  // 35K の QA と同じ操作（cs / camUpd はこの HTML の実装名）。独自の別名を作らない。
  camera: (x, z, r, phDeg = 40) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  /** カメラが実際にどこを向いているか（地点とズレていないかの確認用）。 */
  camAt: `JSON.stringify({ x: cs.tgt.x, z: cs.tgt.z, r: cs.r })`,
  areaDebug: `JSON.stringify(window.__AREA_SELECTION_DEBUG__())`,
  /** 画面を走査して町名ラベルを 1 つ選び、クリックと同じ経路で選択する。 */
  clickPlace: `(() => {
    const found = [];
    for (let gy = 0.15; gy <= 0.85; gy += 0.02) {
      for (let gx = 0.15; gx <= 0.85; gx += 0.02) {
        const it = CityLabelLayer.pickLabel(gx * innerWidth, gy * innerHeight);
        if (it && it.kind === 'place' && AreaSelectionLayer.hasAreaForLabel(it.id)
          && !found.some((f) => f.id === it.id)) found.push(it);
      }
    }
    if (!found.length) return JSON.stringify({ clicked: null, candidates: 0 });
    const pick = found[0];
    const sel = AreaSelectionLayer.selectFromLabel(pick);
    updateAreaSelectionUI();
    const lx = (pick.x != null) ? pick.x : (pick.worldX != null ? pick.worldX : null);
    const lz = (pick.z != null) ? pick.z : (pick.worldZ != null ? pick.worldZ : null);
    return JSON.stringify({ clicked: pick.name, id: pick.id, labelX: lx, labelZ: lz,
      selected: sel, candidates: found.length, names: found.slice(0, 8).map((f) => f.name) });
  })()`,
  /**
   * 選択した範囲の中に建物メッシュが実在するか（建物との位置関係が自然か）。
   * __AREA_SELECTION_DEBUG__().selected は bbox を持たないので、配信データ側の bbox を渡す。
   */
  buildingsInBbox: (bb) => `(() => {
    const b = ${JSON.stringify(bb)}; let inside = 0, total = 0;
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.userData || o.userData.usageCategory === undefined) return;   // canonical building のみ
      total++;
      if (!o.geometry.boundingSphere) { try { o.geometry.computeBoundingSphere(); } catch (e) { return; } }
      const bs = o.geometry.boundingSphere; if (!bs) return;
      const p = bs.center.clone(); o.updateMatrixWorld(); p.applyMatrix4(o.matrixWorld);
      if (p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ) inside++;
    });
    return JSON.stringify({ checked: true, buildingMeshesInBbox: inside, buildingMeshes: total });
  })()`,
};

const HIDE_DEV_UI = `(() => {
  for (const el of document.querySelectorAll('div,button')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|layer-toggle|^tip$|^pl$|^pr$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery|stations-toggle|town-click|town-boundary/.test(id)) el.style.display = 'none'; }
  return 1; })()`;

async function settle(page, min = 2500, max = 120000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) {
    const q = await page.evaluate(JS.settled);
    z = q === 0 ? z + 1 : 0;
    if (z >= 3) return;
    await sleep(700);
  }
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/official-town-boundaries-qa/' + name + '.jpg';
}
const worldOf = (s) => latLonToLiveCityWorld(s.lat, s.lon);

export async function run() {
  const t0 = Date.now();
  const doc = JSON.parse(fs.readFileSync(AREA_DOC, 'utf-8'));
  const areaById = new Map(doc.areas.map((a) => [a.id, a]));
  const wards = doc.areas.filter((a) => a.kind === 'ward');
  let MINX = Infinity, MAXX = -Infinity, MINZ = Infinity, MAXZ = -Infinity;
  for (const w of wards) {
    MINX = Math.min(MINX, w.bbox.minX); MAXX = Math.max(MAXX, w.bbox.maxX);
    MINZ = Math.min(MINZ, w.bbox.minZ); MAXZ = Math.max(MAXZ, w.bbox.maxZ);
  }

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35L', url: URL_, sites: [], errors: [] };
  const b = await launchBrowser({ width: 1440, height: 900 });
  const page = b.page;
  try {
    await page.send('Page.navigate', { url: URL_ });
    await settle(page, 6000, 240000);
    for (const s of SITES) {
      const w = worldOf(s);
      await page.evaluate(JS.ward(w.x, w.z)); await sleep(2200);
      await page.evaluate(JS.camera(w.x, w.z, s.r));
      await settle(page);
      await page.evaluate(HIDE_DEV_UI); await sleep(900);
      const beforeShot = await shot(page, s.id + '.before');
      const camBefore = JSON.parse(await page.evaluate(JS.camAt));
      const clicked = JSON.parse(await page.evaluate(JS.clickPlace, { timeoutMs: 180000 }));
      await sleep(400);
      const selectedShot = await shot(page, s.id + '.selected');
      await sleep(1500);                                 // bbox-fit のカメラ移動を待つ
      const zoomedShot = await shot(page, s.id + '.zoomed');
      const dbg = JSON.parse(await page.evaluate(JS.areaDebug));
      const selArea = dbg.selected ? areaById.get(dbg.selected.id) : null;
      const selBbox = selArea ? selArea.bbox : null;
      const bld = selBbox ? JSON.parse(await page.evaluate(JS.buildingsInBbox(selBbox))) : { checked: false };
      const camAt = JSON.parse(await page.evaluate(JS.camAt));
      // 判定
      const sel = dbg.selected || null;
      const area = sel ? areaById.get(sel.id) : null;
      const checks = {
        clicked: !!clicked.clicked,
        granularity: sel ? sel.granularity : null,
        official: !!(area && (area.boundarySource === 'estat-census-2020-official')),
        boundaryShown: dbg.outlineMeshes > 0,
        zoomApplied: dbg.lastFitR > 0,
        insideCity: !!(selBbox && selBbox.minX >= MINX - 500 && selBbox.maxX <= MAXX + 500
          && selBbox.minZ >= MINZ - 500 && selBbox.maxZ <= MAXZ + 500),
        // ラベルと選ばれた範囲が離れすぎていない（隣の町丁目を選んでいない）
        labelToAreaM: (clicked.labelX != null && selBbox)
          ? +Math.hypot(clicked.labelX - (selBbox.minX + selBbox.maxX) / 2,
            clicked.labelZ - (selBbox.minZ + selBbox.maxZ) / 2).toFixed(1) : null,
        buildingMeshesInBbox: bld.buildingMeshesInBbox ?? null,
      };
      const cleared = JSON.parse(await page.evaluate('JSON.stringify(window.__AREA_CLEAR__())') || 'null');
      const afterClear = JSON.parse(await page.evaluate(JS.areaDebug));
      checks.clearOk = afterClear.outlineMeshes === 0 && afterClear.selected === null;
      // クリック前のカメラが地点に寄っているか（QA の前提）
      checks.siteFramingOffM = +Math.hypot(camBefore.x - w.x, camBefore.z - w.z).toFixed(1);
      // クリック後は選んだ町へ寄る（bbox-fit）ので、町の中心との距離で見る
      checks.fitToTownOffM = selBbox
        ? +Math.hypot(camAt.x - (selBbox.minX + selBbox.maxX) / 2, camAt.z - (selBbox.minZ + selBbox.maxZ) / 2).toFixed(1)
        : null;
      out.sites.push({ ...s, world: w, camBefore, camAt, selBbox, clicked, selected: sel, checks,
        outlineMeshes: dbg.outlineMeshes, fillMeshes: dbg.fillMeshes, lastFitR: dbg.lastFitR,
        shots: { before: beforeShot, selected: selectedShot, zoomed: zoomedShot } });
      console.log('[35L-qa]', s.id.padEnd(15), (clicked.clicked || '★クリック不可').padEnd(12),
        '粒度', String(checks.granularity).padEnd(15), '公式', checks.official ? 'o' : 'x',
        '境界', dbg.outlineMeshes, 'fit', checks.zoomApplied ? Math.round(dbg.lastFitR) + 'm' : '-',
        'ラベル距離', checks.labelToAreaM != null ? checks.labelToAreaM + 'm' : '-',
        '建物', checks.buildingMeshesInBbox, '| fit中心まで', checks.fitToTownOffM);
    }
  } finally { try { await b.close(); } catch { /* noop */ } }

  const sites = out.sites;
  out.summary = {
    sitesTotal: sites.length,
    clickedOk: sites.every((s) => s.checks.clicked),
    allChochome: sites.every((s) => s.checks.granularity === 'chochome' || s.checks.granularity === 'chochome-union'),
    allOfficial: sites.every((s) => s.checks.official),
    boundaryShownOk: sites.every((s) => s.checks.boundaryShown),
    zoomOk: sites.every((s) => s.checks.zoomApplied),
    insideCityOk: sites.every((s) => s.checks.insideCity),
    clearOk: sites.every((s) => s.checks.clearOk),
    maxLabelToAreaM: Math.max(0, ...sites.map((s) => s.checks.labelToAreaM || 0)),
    maxSiteFramingOffM: Math.max(0, ...sites.map((s) => s.checks.siteFramingOffM || 0)),
    maxFitToTownOffM: Math.max(0, ...sites.map((s) => s.checks.fitToTownOffM || 0)),
    sitesWithBuildings: sites.filter((s) => (s.checks.buildingMeshesInBbox || 0) > 0).length,
    granularities: Object.fromEntries(sites.map((s) => [s.id, s.checks.granularity])),
    jsErrors: out.errors.length,
    elapsedMs: Date.now() - t0,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => {
    console.log(JSON.stringify(o.summary, null, 2));
    console.log('[35L-qa] out', OUT);
  }).catch((e) => { console.error(e); process.exitCode = 1; });
}
