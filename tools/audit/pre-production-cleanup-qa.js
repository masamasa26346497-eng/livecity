#!/usr/bin/env node
// tools/audit/pre-production-cleanup-qa.js
// [Mission 32Q §3/§5/§9/§10/§14/§15] 実ブラウザ（Edge headless・実 GPU）での確認。
//   - 起動直後 / 区切替 / City Mode / V1・V2 切替 / Map Audit / Reference Alignment / 100m ruler 後も
//     legacy residual 0・visibleLegacyObjects 0 か
//   - status: [CANONICAL OK] / Buildings / Road / Legacy residual: 0
//   - property card: 6 地点でクリックし、固定の「南港南エリア」が出ず、実データの区名が出るか
//   - SUPPRESS から REVIEW へ変えた 1 棟（尻無川）が表示・選択できるか / SUPPRESS 維持の 1 棟は非表示か
//   前提: `npm run preview`（http://localhost:8000）。出力: data/reports/pre-production-cleanup-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { readFileRetry } from '../lib/synced-dir-writer.js';
import { PROBE } from './legacy-residual-probe.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const OUT = P('data', 'reports', 'pre-production-cleanup-qa.json');
const SHOTS = P('data', 'reports', 'pre-production-cleanup-qa');
const BUILDINGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2');
const rj = (p) => JSON.parse(readFileRetry(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CARD_SITES = [
  { id: 'umeda', name: '梅田', x: -2668.18, z: -10941.87 },
  { id: 'honmachi', name: '本町', x: -2072.6, z: -8693.2 },
  { id: 'namba', name: '難波', x: -2173.39, z: -6511.33 },
  { id: 'tennoji', name: '天王寺', x: -1055.54, z: -4618.89 },
  { id: 'sumiyoshi', name: '住吉', x: -2952.22, z: -811.75 },
  { id: 'higashiyodogawa', name: '東淀川', x: 574, z: -15576 },
];
const WARD_NAME = {};
const A_ID = 'cg_bldg_bldg_a3de3906-64ec-427c-9293-6d780305bc87';
const B_ID = 'cg_bldg_bldg_a29b4ebd-4fbb-4bcf-ba75-2df56d3c94ba';

/** 各地点の中心に近い、ある程度大きな PLATEAU 建物（真上から中心をクリックして当たるもの） */
function cardTargets() {
  const out = [];
  const want = new Map([[A_ID, null], [B_ID, null]]);
  for (const s of CARD_SITES) {
    let best = null;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const f = path.join(BUILDINGS, `tile_${Math.floor(s.x / 500) + dx}_${Math.floor(s.z / 500) + dz}.json`);
      if (!fs.existsSync(f)) continue;
      const t = rj(f);
      const a = rj(path.join(BUILDINGS, 'attributes', path.basename(f))).attributes;
      for (const ft of t.features) {
        const at = a[ft.canonicalId];
        const d = Math.hypot(ft.centroid[0] - s.x, ft.centroid[1] - s.z);
        if (at.source !== 'plateau-building' || ft.areaM2 < 400 || ft.areaM2 > 4000 || d > 250) continue;
        if (!best || d < best.d) best = { d, id: ft.canonicalId, c: ft.centroid, wardId: at.wardId, usage: at.usageLabel };
      }
    }
    out.push({ site: s.id, siteName: s.name, ...best });
  }
  for (const f of fs.readdirSync(BUILDINGS)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    if (![...want.values()].some((v) => v === null)) break;
    const t = rj(path.join(BUILDINGS, f));
    for (const ft of t.features) if (want.has(ft.canonicalId)) want.set(ft.canonicalId, { c: ft.centroid, area: ft.areaM2 });
  }
  return { cards: out, A: want.get(A_ID), B: want.get(B_ID) };
}

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, ph) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  status: `(() => { const el = document.getElementById('canonical-runtime-status'); return el ? el.innerText.split('\\n') : null; })()`,
  wardNames: `(() => Object.fromEntries(WardModeManager.WARD_DEFS.map((w) => [w.id, w.name])))()`,
  card: `(() => {
    const pick = window.__LAST_BUILDING_PICK__;
    const txt = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : null; };
    const card = document.getElementById('prop-card');
    return { pick: pick ? { id: pick.id, source: pick.source, wardId: pick.wardId } : null, cardVisible: !!card && card.style.display === 'block', title: txt('pc-title'), id: txt('pc-id'), usage: txt('pc-usage-full'), town: txt('pc-town-name') };
  })()`,
  placementOf: (id) => `(() => { try { const d = window.__PLACEMENT_DEBUG__ ? window.__PLACEMENT_DEBUG__() : null; return d; } catch (e) { return String(e); } })()`,
};
async function settle(page, min = 2500, max = 60000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return Date.now() - t0; await sleep(700); }
  return -1;
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 78 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/pre-production-cleanup-qa/' + name + '.jpg';
}
async function clickCenter(page) {
  await page.evaluate(`(() => { window.__LAST_BUILDING_PICK__ = null; const c = document.getElementById('prop-card'); if (c) c.style.display = 'none'; return 1; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 800, y: 500 });
  await sleep(300);
  const hover = await page.evaluate(`(() => tip.style.display)()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 800, y: 500, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 800, y: 500, button: 'left', clickCount: 1 });
  await sleep(700);
  return hover;
}
const residualOf = async (page) => { const r = await page.evaluate(PROBE); return { residual: r.selfCheck.total, visibleLegacyObjects: r.visibleLegacyObjects, legacyList: r.visibleLegacyList.map((x) => ({ chain: x.parentChain, type: x.type, positions: x.positions })) }; };

async function main() {
  const targets = cardTargets();
  console.log('[cleanup-qa] targets', JSON.stringify(targets));
  const report = { version: 1, generatedAt: new Date().toISOString(), missionId: '32Q', url: URL_, targets };
  const b = await launchBrowser({});
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)));
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(40000);
    Object.assign(WARD_NAME, await page.evaluate(JS.wardNames));
    report.startup = { status: await page.evaluate(JS.status), ...(await residualOf(page)), buildings: await page.evaluate(`window.__BUILDINGS_VERSION_DEBUG__()`), semantic: await page.evaluate(`window.__SEMANTIC_DISPLAY_DEBUG__()`) };
    report.shots = { startup: await shot(page, '00-startup') };
    console.log('[cleanup-qa] startup', JSON.stringify(report.startup.status && report.startup.status.slice(0, 8)), report.startup.residual, report.startup.visibleLegacyObjects);

    // ── §9 property card × 6 地点 ──
    report.cards = [];
    for (const t of targets.cards) {
      await page.evaluate(JS.ward(t.c[0], t.c[1])); await sleep(1200);
      await page.evaluate(JS.camera(t.c[0], t.c[1], 280, 0.05)); await settle(page);
      const hover = await clickCenter(page);
      const c = await page.evaluate(JS.card);
      const expectedArea = t.wardId && WARD_NAME[t.wardId] ? '大阪市' + WARD_NAME[t.wardId] : null;
      report.cards.push({
        ...t, hover, ...c, expectedArea,
        pickedExpected: !!(c.pick && c.pick.id === t.id),
        hardcodedAreaShown: /南港南エリア/.test(c.title || ''),
        areaMatchesData: expectedArea ? (c.title || '').endsWith(' ／ ' + expectedArea) : !/／/.test(c.title || ''),
        shot: await shot(page, 'card-' + t.site),
      });
      console.log('[cleanup-qa] card', t.site, JSON.stringify({ title: c.title, pick: c.pick && c.pick.id === t.id, expectedArea }));
    }

    // ── §10-§12 SUPPRESS 2 棟 ──
    report.suppressReview = {};
    if (targets.A) {
      await page.evaluate(JS.ward(targets.A.c[0], targets.A.c[1])); await sleep(1200);
      await page.evaluate(JS.camera(targets.A.c[0], targets.A.c[1], 120, 0.05)); await settle(page);
      const hover = await clickCenter(page);
      const c = await page.evaluate(JS.card);
      report.suppressReview.A = { canonicalId: A_ID, expected: 'REVIEW（表示）', hover, ...c, visibleAndPickable: !!(c.pick && c.pick.id === A_ID), shot: await shot(page, 'suppress-A-now-review') };
    }
    if (targets.B) {
      await page.evaluate(JS.ward(targets.B.c[0], targets.B.c[1])); await sleep(1200);
      await page.evaluate(JS.camera(targets.B.c[0], targets.B.c[1], 120, 0.05)); await settle(page);
      await clickCenter(page);
      const c = await page.evaluate(JS.card);
      report.suppressReview.B = { canonicalId: B_ID, expected: 'SUPPRESS（非表示）', ...c, pickedB: !!(c.pick && c.pick.id === B_ID), shot: await shot(page, 'suppress-B-kept') };
    }
    console.log('[cleanup-qa] suppress', JSON.stringify(report.suppressReview));

    // ── §15 回帰 ──
    const reg = {};
    for (const v of ['V1', 'V2', 'V2N']) {
      await page.evaluate(`window.__SET_BUILDINGS_VERSION__('${v}')`); await settle(page);
      reg['version-' + v] = { version: (await page.evaluate(`window.__BUILDINGS_VERSION_DEBUG__()`)).version, ...(await residualOf(page)) };
    }
    await page.evaluate(JS.ward(-2668.18, -10941.87)); await sleep(1200);
    await page.evaluate(JS.camera(-2668.18, -10941.87, 650, 0.85)); await settle(page);
    reg.wardKita = { ward: await page.evaluate(`WardModeManager.currentWardId`), ...(await residualOf(page)), meshes: await page.evaluate(`CanonicalRuntime.getDebug().canonicalMesh`) };
    reg.umedaShot = await shot(page, 'umeda-ward');
    reg.mapAuditOn = await page.evaluate(`(async () => { const r = await window.__SET_MAP_AUDIT_MODE__(true, 'umeda'); await new Promise((q) => setTimeout(q, 3000)); const d = window.__MAP_AUDIT_DEBUG__(); return { ok: !!r || !!d, enabled: d && (d.enabled ?? d.active ?? null) }; })()`);
    reg.mapAuditOff = await page.evaluate(`(async () => { await window.__SET_MAP_AUDIT_MODE__(false); await new Promise((q) => setTimeout(q, 1500)); const d = window.__MAP_AUDIT_DEBUG__(); return { enabled: d && (d.enabled ?? d.active ?? null) }; })()`);
    reg.afterMapAudit = await residualOf(page);
    reg.refAlignOn = await page.evaluate(`(async () => { await window.__SET_REFERENCE_ALIGNMENT__(true, 'umeda'); await new Promise((q) => setTimeout(q, 4000)); const d = window.__REFERENCE_ALIGNMENT_DEBUG__(); return { active: d && (d.active ?? d.enabled ?? null) }; })()`);
    reg.refAlignShot = await shot(page, 'reference-alignment-on');
    reg.refAlignOff = await page.evaluate(`(async () => { await window.__SET_REFERENCE_ALIGNMENT__(false); await new Promise((q) => setTimeout(q, 2500)); const d = window.__REFERENCE_ALIGNMENT_DEBUG__(); return { active: d && (d.active ?? d.enabled ?? null) }; })()`);
    reg.afterReferenceAlignment = await residualOf(page);
    reg.ruler = await page.evaluate(`(() => { const on = window.__SET_SCALE_RULER__(true); const d1 = window.__SCALE_RULER_DEBUG__(); window.__SET_SCALE_RULER__(false); const d2 = window.__SCALE_RULER_DEBUG__(); return { on: d1 && (d1.enabled ?? d1.active ?? null), off: d2 && (d2.enabled ?? d2.active ?? null) }; })()`);
    reg.afterRuler = await residualOf(page);
    await page.evaluate(`(() => { CityModeManager.enter(); return 1; })()`); await sleep(3000); await settle(page, 2000, 60000);
    reg.cityMode = { active: await page.evaluate(`CityModeManager.isActive()`), ...(await residualOf(page)) };
    reg.cityShot = await shot(page, 'city-mode');
    reg.layers = await page.evaluate(`(() => ({ semantic: window.__SEMANTIC_DISPLAY_DEBUG__(), canonicalMesh: CanonicalRuntime.getDebug().canonicalMesh, roadV3: window.__ROAD_V3_DEBUG__ ? (() => { const d = window.__ROAD_V3_DEBUG__(); return { mode: d && d.mode, loadedTiles: d && (d.loadedTiles ?? d.tiles ?? null) }; })() : null }))()`);
    reg.finalStatus = await page.evaluate(JS.status);
    report.regression = reg;
    report.consoleErrors = errors.slice(0, 30);
  } finally {
    await b.close();
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  main().then((r) => {
    const reg = r.regression;
    for (const k of Object.keys(reg)) if (reg[k] && typeof reg[k] === 'object' && 'residual' in reg[k]) console.log('[cleanup-qa]', k, reg[k].residual, reg[k].visibleLegacyObjects);
    console.log('[cleanup-qa] mapAudit', JSON.stringify(reg.mapAuditOn), JSON.stringify(reg.mapAuditOff), 'refAlign', JSON.stringify(reg.refAlignOn), JSON.stringify(reg.refAlignOff), 'ruler', JSON.stringify(reg.ruler));
    console.log('[cleanup-qa] layers', JSON.stringify(reg.layers).slice(0, 400));
    console.log('[cleanup-qa] final status', JSON.stringify(reg.finalStatus && reg.finalStatus.slice(0, 8)));
    console.log('[cleanup-qa] errors', JSON.stringify(r.consoleErrors));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
