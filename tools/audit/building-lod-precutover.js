#!/usr/bin/env node
// tools/audit/building-lod-precutover.js
// [Mission 34A cutover 前確認] 実ブラウザで次の 2 点を確かめる。
//   §2 建物の総数は 600,764 のまま。高 LOD は「別の建物を足す」のではなく
//      同じ canonicalId の representation を差し替えているだけであること。
//        タイル単位で  LOD1 描画数 + 高 LOD 描画数 == canonical の棟数  を照合する。
//   §3 主要 5 地点で LOD 境界（2,500m）を往復し、
//        位置の跳び / 二重 / 一時的な消失 / canonicalId の変化 が無いこと。
//   前提: `npm run preview`。出力: data/reports/building-lod-precutover.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const OUT = P('data', 'reports', 'building-lod-precutover.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SITES = [
  { id: 'honmachi', name: '本町', x: -2073, z: -8693 },
  { id: 'umeda', name: '梅田', x: -2668, z: -10942 },
  { id: 'nakanoshima', name: '中之島', x: -2620, z: -9942 },
  { id: 'osakacastle', name: '大阪城', x: 76, z: -9258 },
  { id: 'shinosaka', name: '新大阪', x: -2110, z: -14380 },
];
// §3 LOD 境界（2,500m）をまたいで往復する距離の並び
export const ROUND_TRIP = [700, 1500, 2400, 2600, 3200, 2600, 2400, 1500, 700];

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, ph) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  lod: `(() => window.__BUILDING_LOD_DEBUG__())()`,
  // §2 タイル単位の会計: canonical の棟数 = LOD1 で描いた数 + 高 LOD で描いた数 + 抑制(placement) 数
  accounting: `(async () => {
    const d = window.__BUILDING_LOD_DEBUG__();
    const cr = window.__CANONICAL_RUNTIME_DEBUG__ ? window.__CANONICAL_RUNTIME_DEBUG__() : null;
    // 表示中の高 LOD の canonicalId 一覧
    const highIds = new Set();
    scene.traverse((o) => {
      if (!o.isMesh || !o.userData || !o.userData.lodHigh || !o.visible) return;
      let p = o, vis = true; while (p) { if (p.visible === false) { vis = false; break; } p = p.parent; }
      if (!vis) return;
      for (const r of (o.userData.lodHigh.ranges || [])) highIds.add(r.canonicalId);
    });
    // 表示中の buildings タイルから、LOD1 として mesh に入っている棟の footprint 数を数える
    //   （CanonicalRuntime は footprints[] に mesh へ入れた棟だけを積む）
    const perf = CanonicalRuntime.getPerf ? CanonicalRuntime.getPerf() : null;
    return {
      manifestTotal: (cr && cr.buildings && cr.buildings.count) || null,
      highVisibleIds: highIds.size,
      debugVisibleLod2: d.visibleLod2, debugVisibleLod3: d.visibleLod3,
      suppressedLod1: d.suppressedLod1,
      band: d.band, cameraR: d.cameraR,
      tiles: perf ? perf.tiles : null,
    };
  })()`,
  // §3 同じ棟が「どこに・何で」描かれているかを記録する（往復で比較する）
  sample: (n) => `(() => {
    const out = { band: null, items: [] };
    const d = window.__BUILDING_LOD_DEBUG__();
    out.band = d.band; out.visibleLod2 = d.visibleLod2; out.visibleLod3 = d.visibleLod3; out.suppressed = d.suppressedLod1;
    // 高 LOD で出ている棟のうち先頭 n 件について、bbox 中心と代表 y を取る
    const byId = new Map();
    scene.traverse((o) => {
      if (!o.isMesh || !o.userData || !o.userData.lodHigh || !o.visible) return;
      let p = o, vis = true; while (p) { if (p.visible === false) { vis = false; break; } p = p.parent; }
      if (!vis) return;
      const pos = o.geometry.getAttribute('position'), idx = o.geometry.index;
      for (const r of (o.userData.lodHigh.ranges || [])) {
        if (byId.size >= ${n} && !byId.has(r.canonicalId)) continue;
        let e = byId.get(r.canonicalId);
        if (!e) { e = { id: r.canonicalId, lod: r.lod, minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9, maxY: -1e9 }; byId.set(r.canonicalId, e); }
        for (let k = r.start; k < r.start + r.count; k++) {
          const i = idx.getX(k);
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          if (x < e.minX) e.minX = x; if (x > e.maxX) e.maxX = x;
          if (z < e.minZ) e.minZ = z; if (z > e.maxZ) e.maxZ = z;
          if (y > e.maxY) e.maxY = y;
        }
      }
    });
    for (const e of byId.values()) out.items.push({ id: e.id, lod: e.lod,
      cx: +((e.minX + e.maxX) / 2).toFixed(2), cz: +((e.minZ + e.maxZ) / 2).toFixed(2), top: +e.maxY.toFixed(2) });
    out.items.sort((a, b) => (a.id < b.id ? -1 : 1));
    return out;
  })()`,
  // 指定した canonicalId が「いま何で描かれているか」を真上からの ray で確かめる
  probeIds: (ids) => `(() => {
    const want = ${JSON.stringify(ids)};
    const res = [];
    const targets = [];
    scene.traverse((o) => { if (o.isMesh && o.visible) { let p = o, vis = true; while (p) { if (p.visible === false) { vis = false; break; } p = p.parent; } if (vis) targets.push(o); } });
    for (const w of want) {
      const d = CanonicalRuntime.buildingDataById(w.id);
      if (!d || !Array.isArray(d.fp) || !d.fp.length) { res.push({ id: w.id, found: false }); continue; }
      let cx = 0, cz = 0; for (const q of d.fp) { cx += q[0]; cz += q[1]; }
      cx /= d.fp.length; cz /= d.fp.length;
      const rc = new THREE.Raycaster(new THREE.Vector3(cx, 900, cz), new THREE.Vector3(0, -1, 0), 0.1, 2000);
      const hits = rc.intersectObjects(targets, false);
      const high = hits.filter((h) => h.object.userData && h.object.userData.lodHigh);
      const crB = hits.filter((h) => { let p = h.object; while (p) { if (p.name === 'CR_buildings') return true; p = p.parent; } return false; });
      // 「CR_buildings に当たった」だけでは二重表示の証拠にならない。密集地では真下に
      //   隣の棟の LOD1 が重なるため。canonical 側の pick で「同じ棟」と判定されたときだけ数える。
      let crSameId = false;
      try { const pr = CanonicalRuntime.pickBuilding(rc); crSameId = !!(pr && pr.d && pr.d.id === w.id); } catch (e) { /* noop */ }
      // 高 LOD がその棟を描いているか（ray が隣の高 LOD に当たっただけ、を除く）
      let highSameId = false;
      for (const h of high) {
        const rr = h.object.userData.lodHigh.ranges || [];
        const i3 = h.faceIndex * 3;
        for (const r of rr) if (i3 >= r.start && i3 < r.start + r.count) { if (r.canonicalId === w.id) highSameId = true; break; }
        if (highSameId) break;
      }
      res.push({ id: w.id, found: true, cardId: d.id, h: d.h,
        highHits: high.length, lod1Hits: crB.length, highSameId, crSameId,
        topY: hits.length ? +Math.max(...hits.map((x) => x.point.y)).toFixed(2) : null,
        drawnBy: highSameId ? 'highLod' : (crSameId ? 'lod1' : (high.length || crB.length ? 'neighbour' : 'none')) });
    }
    return res;
  })()`,
};

async function settle(page, min = 2500, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
async function ensureCamera(page, x, z, r, ph) {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(JS.camera(x, z, r, ph));
    await sleep(900);
    if (await page.evaluate(`(() => Math.abs(cs.tgt.x - (${x})) < 5 && Math.abs(cs.tgt.z - (${z})) < 5 && Math.abs(cs.r - ${r}) < 5)()`)) return true;
  }
  return false;
}

export async function run() {
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34A-precutover', url: URL_, sites: [], errors: [] };
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    for (const s of SITES) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(2500);
      await ensureCamera(page, s.x, s.z, 700, Math.PI / 3.3);
      await settle(page);
      await sleep(2000);
      const acc = await page.evaluate(JS.accounting);
      // 往復の基準サンプル（高 LOD で出ている棟 40 件）
      const base = await page.evaluate(JS.sample(40));
      const ids = base.items.map((i) => ({ id: i.id }));
      const steps = [];
      for (const r of ROUND_TRIP) {
        await ensureCamera(page, s.x, s.z, r, Math.PI / 3.3);
        // band をまたぐと buildings tile が捨てられて読み直しになる。
        //   読み込み中に測ると「消えた」ように見えるので、必ず queue が空くまで待つ。
        await settle(page, 1500, 45000);
        await sleep(1200);
        const snap = await page.evaluate(JS.sample(40));
        const probe = ids.length ? await page.evaluate(JS.probeIds(ids.slice(0, 12))) : [];
        steps.push({ r, band: snap.band, visibleLod2: snap.visibleLod2, visibleLod3: snap.visibleLod3,
          suppressed: snap.suppressed, items: snap.items, probe });
      }
      // 比較: 基準と最終（同じ 700m）で位置・LOD・id が変わっていないか
      const first = steps[0], last = steps[steps.length - 1];
      const mapOf = (st) => new Map(st.items.map((i) => [i.id, i]));
      const m0 = mapOf(first), m1 = mapOf(last);
      let posPop = 0, lodChange = 0, idMissing = 0, maxDelta = 0, topDelta = 0;
      for (const [id, a] of m0) {
        const c = m1.get(id);
        if (!c) { idMissing++; continue; }
        const dd = Math.hypot(a.cx - c.cx, a.cz - c.cz);
        if (dd > maxDelta) maxDelta = dd;
        if (dd > 0.5) posPop++;
        const td = Math.abs(a.top - c.top);
        if (td > topDelta) topDelta = td;
        if (a.lod !== c.lod) lodChange++;
      }
      // 一時的な消失: 2,500m 以下のステップで、基準に居た棟が高 LOD からも LOD1 からも消えた回数
      // 指標は分けて数える（「引けなかった」と「別の ID になった」は別物）
      let temporaryDisappearance = 0, duplicate = 0, canonicalIdChange = 0, cardLookupMissing = 0, probes = 0;
      for (const st of steps) {
        for (const p of st.probe) {
          probes++;
          if (!p.found) { cardLookupMissing++; continue; }
          if (p.cardId !== p.id) canonicalIdChange++;
          if (p.highSameId && p.crSameId) duplicate++;          // 同じ棟を高 LOD と LOD1 の両方で描いている
          if (!p.highSameId && !p.crSameId) temporaryDisappearance++;
        }
      }
      // 対照: 高 LOD を切って同じ往復をしたときにも同じことが起きるか
      await page.evaluate(`(() => window.__BUILDING_LOD_TOGGLE__(false))()`);
      await sleep(1500);
      const control = [];
      for (const r of [700, 2600, 3200, 700]) {
        await ensureCamera(page, s.x, s.z, r, Math.PI / 3.3);
        await settle(page, 1500, 45000);
        await sleep(1200);
        const probe = ids.length ? await page.evaluate(JS.probeIds(ids.slice(0, 12))) : [];
        control.push({ r, drawnBy: probe.reduce((m, p) => ({ ...m, [p.drawnBy || 'missing']: (m[p.drawnBy || 'missing'] || 0) + 1 }), {}),
          none: probe.filter((p) => p.drawnBy === 'none').length, notFound: probe.filter((p) => !p.found).length });
      }
      await page.evaluate(`(() => window.__BUILDING_LOD_TOGGLE__(true))()`);
      await sleep(1500);

      const rec = { site: s.id, siteName: s.name, accounting: acc, controlHighLodOff: control,
        baseCount: base.items.length, steps: steps.map((st) => ({ r: st.r, band: st.band, visibleLod2: st.visibleLod2,
          visibleLod3: st.visibleLod3, suppressed: st.suppressed, sampled: st.items.length,
          probeDrawnBy: st.probe.reduce((m, p) => ({ ...m, [p.drawnBy || 'missing']: (m[p.drawnBy || 'missing'] || 0) + 1 }), {}) })),
        roundTrip: { probes, posPop, maxPositionDeltaM: +maxDelta.toFixed(3), maxTopDeltaM: +topDelta.toFixed(3),
          lodChange, sampleSetDelta: idMissing, temporaryDisappearance, duplicate, canonicalIdChange, cardLookupMissing } };
      out.sites.push(rec);
      console.log('[precutover]', s.id, JSON.stringify({ acc: { high: acc.highVisibleIds, sup: acc.suppressedLod1, band: acc.band },
        rt: rec.roundTrip }));
      // 次の地点のために戻す
      await ensureCamera(page, s.x, s.z, 700, Math.PI / 3.3);
    }
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((d) => {
    const bad = d.sites.filter((s) => s.roundTrip.posPop || s.roundTrip.duplicate || s.roundTrip.temporaryDisappearance || s.roundTrip.canonicalIdChange);
    console.log('[precutover] 問題のある地点:', bad.length, 'errors', d.errors.length);
    console.log('[precutover] out', OUT);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
