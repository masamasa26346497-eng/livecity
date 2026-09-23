#!/usr/bin/env node
// tools/audit/missing-recovery-runtime-qa.js
// [Mission 35D §7/§9/§10] 実ブラウザで V4 を確認する。
//   - V2N / V4 を同一 camera で比較し、建物が増えていること
//   - 追加した棟を hover / click して property card が出ること
//   - ward 名が出ること・実測高さが無ければ高さ行を出さないこと
//   - 二重表示が起きていないこと
//   前提: `npm run preview`。出力: data/reports/missing-recovery-runtime-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
export const OUT = P('data', 'reports', 'missing-recovery-runtime-qa.json');
export const SHOTS = P('data', 'reports', 'missing-recovery-qa');
export const RECOVERED_INDEX = P('public', 'map-data', 'osaka-city', 'derived-v4-final', 'recovered-index.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const VIEW = { r: 700, phDeg: 50, th: -0.35, fov: 44 };
/** §4 の代表地点（緯度経度。world への変換は runtime 側の正本に任せない＝ここで渡す）。 */
export const SITES = [
  { id: 'brillia-tower-dojima', label: 'ブリリアタワー堂島', x: -2993, z: -10069 },
  { id: 'grand-green-osaka', label: 'グラングリーン大阪', x: -3053, z: -11142 },
  { id: 'osaka-station', label: '大阪駅', x: -2672, z: -10946 },
  { id: 'nakanoshima', label: '中之島', x: -3071, z: -9929 },
  { id: 'honmachi', label: '本町', x: -2238, z: -8660 },
  { id: 'namba', label: '難波', x: -2109, z: -6433 },
  { id: 'tennoji', label: '天王寺', x: -1010, z: -4652 },
  { id: 'sumiyoshi', label: '住吉', x: -2842, z: -979 },
  { id: 'higashiyodogawa', label: '東淀川', x: 823, z: -14671 },
];
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

const HIDE_UI = `(() => {
  for (const el of document.querySelectorAll('div')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|layer-toggle|^tip$|search-box|^pl$|^pr$|^lc-panel|^lc-topbar|^controls$/.test(id)) el.style.display = 'none'; }
  return 1; })()`;
const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    CAMERA_MODE_FOV[cameraMode] = ${VIEW.fov};
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = (90 - ${VIEW.phDeg}) * Math.PI / 180; cs.th = ${VIEW.th}; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  setVersion: (v) => `(() => CanonicalRuntime.setBuildingsVersion(${JSON.stringify(v)}))()`,
  crDebug: `(() => { const d = CanonicalRuntime.getDebug(); return { visibleBuildings: d.visibleBuildings, version: d.version, base: d.base }; })()`,
  diffLayer: (on) => `(() => window.__MISSING_RECOVERY__(${on}))()`,
  diffDebug: `(() => window.__MISSING_RECOVERY_DEBUG__())()`,
  // §7 回収した棟の card を引く
  cardFor: (id) => `(() => {
    const d = CanonicalRuntime.buildingDataById(${JSON.stringify(id)});
    if (!d) return { found: false };
    let card = null;
    try { selectBuilding({ clientX: innerWidth / 2, clientY: innerHeight / 2 }, { d }); } catch (e) { return { found: true, error: String(e && e.message || e) }; }
    const el = document.getElementById('prop-card');
    const txt = el ? (el.innerText || '') : '';
    return { found: true, cardVisible: !!(el && el.style.display !== 'none'),
      hasWard: /区/.test(txt), hasHeight: /高さ|m\\b/.test(txt),
      textHead: txt.replace(/\\s+/g, ' ').slice(0, 200),
      attrs: { wardId: d.wardId, usageCategory: d.usageCategory, usageLabel: d.usageLabel,
        heightM: d.h, heightUnknown: d.heightUnknown, heightSource: d.heightSource,
        source: d.source, placement: d.placement } };
  })()`,
  // §9 同じ位置に 2 棟出ていないか（回収した棟の真上から ray を撃ち、重なっている建物 mesh を数える）
  doubleCheck: (ids) => `(() => {
    const out = [];
    for (const id of ${JSON.stringify(ids)}) {
      const d = CanonicalRuntime.buildingDataById(id);
      if (!d || !d.fp || !d.fp.length) { out.push({ id, found: false }); continue; }
      let cx = 0, cz = 0; for (const q of d.fp) { cx += q[0]; cz += q[1]; }
      cx /= d.fp.length; cz /= d.fp.length;
      const rc = new THREE.Raycaster(new THREE.Vector3(cx, 900, cz), new THREE.Vector3(0, -1, 0), 0.1, 2000);
      const meshes = [];
      scene.traverse((o) => { if (o.isMesh && o.visible && o.userData && o.userData.usageCategory != null) {
        let q = o, v = true; while (q) { if (q.visible === false) { v = false; break; } q = q.parent; } if (v) meshes.push(o); } });
      const hits = rc.intersectObjects(meshes, false);
      // 同じ mesh の表裏は 1 棟。別 mesh のヒット数を数える。
      const distinct = new Set(hits.map((h) => h.object.uuid));
      out.push({ id, found: true, meshHits: distinct.size });
    }
    return out; })()`,
};

async function settle(page, min = 2500, max = 120000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/missing-recovery-qa/' + name + '.jpg';
}

export async function run() {
  const t0 = Date.now();
  const idx = rj(RECOVERED_INDEX) || { buildings: [] };
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35D', url: URL_,
    recoveredCount: idx.count || (idx.buildings || []).length,
    sites: [], cards: [], doubleDisplay: [], diff: null, errors: [] };
  const b = await launchBrowser({ width: 1500, height: 950 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);

    for (const s of SITES) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(2200);
      const rec = { ...s };
      for (const v of ['V2N', 'V4']) {
        await page.evaluate(JS.setVersion(v)); await sleep(1200);
        await page.evaluate(JS.camera(s.x, s.z, VIEW.r));
        await settle(page);
        const d = await page.evaluate(JS.crDebug);
        rec[v] = { visibleBuildings: d.visibleBuildings, base: d.base };
        await page.evaluate(HIDE_UI); await sleep(1200);
        rec[v].shot = await shot(page, s.id + '-' + v);
      }
      rec.delta = (rec.V4.visibleBuildings || 0) - (rec.V2N.visibleBuildings || 0);
      out.sites.push(rec);
      console.log('[qa]', s.id.padEnd(24), 'V2N', rec.V2N.visibleBuildings, '→ V4', rec.V4.visibleBuildings, '(+' + rec.delta + ')');
    }

    // §7 回収した棟の card。代表地点の近くにある回収分から選ぶ。
    await page.evaluate(JS.setVersion('V4')); await sleep(1500);
    const picks = [];
    for (const s of SITES) {
      const near = (idx.buildings || []).filter((x) => {
        const c = x.ring.reduce((a, q) => [a[0] + q[0] / x.ring.length, a[1] + q[1] / x.ring.length], [0, 0]);
        return Math.hypot(c[0] - s.x, c[1] - s.z) < 700;
      });
      // 高さタグがある棟と無い棟を 1 つずつ（§7 高さ行の出し分けを見る）
      const withLv = near.find((x) => x.levels);
      const noLv = near.find((x) => !x.levels);
      for (const p of [withLv, noLv]) if (p && !picks.some((q) => q.canonicalId === p.canonicalId)) picks.push({ site: s.id, ...p });
    }
    for (const p of picks.slice(0, 12)) {
      await page.evaluate(JS.ward(p.ring[0][0], p.ring[0][1])); await sleep(1800);
      await page.evaluate(JS.camera(p.ring[0][0], p.ring[0][1], 300));
      await settle(page, 1800, 60000);
      const c = await page.evaluate(JS.cardFor(p.canonicalId));
      out.cards.push({ site: p.site, canonicalId: p.canonicalId, name: p.name, levels: p.levels || null, ...c });
      console.log('[qa] card', p.canonicalId, JSON.stringify({ found: c.found, visible: c.cardVisible, ward: c.hasWard, attrs: c.attrs }));
    }

    // §9 二重表示。tile が読めていない場所で ray を撃っても 0 ヒットになるだけで、
    //   「二重表示が無い」根拠にはならない。1 棟ずつ camera を寄せて tile を読ませてから測る。
    for (const p of picks.slice(0, 10)) {
      await page.evaluate(JS.ward(p.ring[0][0], p.ring[0][1])); await sleep(1600);
      await page.evaluate(JS.camera(p.ring[0][0], p.ring[0][1], 260));
      await settle(page, 1800, 60000);
      const r = await page.evaluate(JS.doubleCheck([p.canonicalId]), { timeoutMs: 120000 });
      out.doubleDisplay.push(...r);
    }

    // §10 DIFF レイヤー
    await page.evaluate(JS.diffLayer(true)); await sleep(2500);
    out.diff = await page.evaluate(JS.diffDebug);
    await page.evaluate(JS.camera(SITES[0].x, SITES[0].z, 900));
    await settle(page, 1800, 60000);
    await page.evaluate(HIDE_UI); await sleep(1500);
    out.diffShot = await shot(page, 'diff-missing-recovery');
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }

  const cardsOk = out.cards.length > 0 && out.cards.every((c) => c.found && c.cardVisible && c.hasWard);
  const heightRuleOk = out.cards.every((c) => !c.attrs || c.attrs.heightUnknown !== true || !/高さ/.test(c.textHead || ''));
  out.summary = {
    sites: out.sites.length,
    totalDelta: out.sites.reduce((a, s) => a + (s.delta || 0), 0),
    everySiteIncreased: out.sites.every((s) => s.delta >= 0),
    cardsChecked: out.cards.length, cardsOk, heightRuleOk,
    // 描かれているか（0 なら「そこに何も無い」ので判定材料にならない）。
    //   なお meshHits が 2 以上でも二重表示とは限らない。LOD band（near/mid）の同時描画と
    //   usageCategory ごとの束ね方で、**既存建物でも** 2 以上になる。
    //   二重表示の判定は tools/audit/missing-recovery-overlap-control.js の対照実験で行う。
    doubleDisplayRendered: out.doubleDisplay.filter((d) => d.found && d.meshHits > 0).length,
    doubleDisplayNotRendered: out.doubleDisplay.filter((d) => d.found && d.meshHits === 0).length,
    meshHitsMax: out.doubleDisplay.length ? Math.max(...out.doubleDisplay.filter((d) => d.found).map((d) => d.meshHits)) : null,
    meshHitsNote: 'この数だけでは二重表示を判定できない。missing-recovery-overlap-control.json を見ること。',
    diffDrawn: out.diff ? out.diff.drawn : null,
    jsErrors: out.errors.length,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => {
    console.log('[qa] summary', JSON.stringify(o.summary));
    console.log('[qa] out', OUT);
  }).catch((e) => { console.error(e); process.exit(1); });
}
