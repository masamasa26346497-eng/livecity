#!/usr/bin/env node
// tools/audit/missing-recovery-overlap-control.js
// [Mission 35D §9] 「V4 が二重表示を作っていないか」を **対照実験** で確かめる。
//
//   素朴に「回収した棟の真上から ray を撃って 2 つ以上 mesh に当たったら二重表示」と数えると、
//   V2N（35D 前）の既存建物でも同じだけ当たる。理由は 2 つ:
//     1. LOD band（near / mid）を移行中は両方が描かれている
//     2. 建物は usageCategory ごとに束ねた mesh になっており、隣の棟が別の束に入る
//   どちらも 35D とは関係ない。
//
//   そこで **同じ band の中で 2 つ以上の mesh に当たった割合** を、
//   同一地点・同一 camera で V2N と V4 について測って比べる。
//   V4 が V2N を上回らなければ、35D は二重表示を増やしていない。
//
//   前提: `npm run preview`。出力: data/reports/missing-recovery-overlap-control.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
export const OUT = P('data', 'reports', 'missing-recovery-overlap-control.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 回収数の多い区と、既存が密な区の両方を見る。 */
export const SITES = [
  { id: 'kita', label: '北区（梅田）', x: -2600, z: -10700 },
  { id: 'chuo', label: '中央区（本町）', x: -2238, z: -8660 },
  { id: 'higashiyodogawa', label: '東淀川区', x: 823, z: -14671 },
  { id: 'yodogawa', label: '淀川区（新大阪）', x: -2274, z: -14052 },
  { id: 'asahi', label: '旭区', x: 1500, z: -12500 },
];
export const VERSIONS = ['V2N', 'V4'];
export const PROBE = { halfM: 120, stepM: 6, cameraR: 260, pitchDeg: 50 };
/**
 * 建物に当たった probe がこれ未満なら、その地点の測定は無効とする。
 * tile がまだ読めていない状態で測ると「重なり 0%」と出て比較にならない
 * （実際に淀川区で V2N が hitProbes=0 になり、+85.7pt という誤った悪化が出た）。
 */
export const MIN_HIT_PROBES = 50;

/** 同じ band の中で 2 mesh 以上に当たった割合。 */
export function overlapRate(r) {
  return r && r.hitProbes ? +(r.overlapProbes / r.hitProbes).toFixed(4) : null;
}
/** 両方の版で十分な数の建物に当たっているか。 */
export function hasEnoughData(v2n, v4, min = MIN_HIT_PROBES) {
  return !!(v2n && v2n.hitProbes >= min && v4 && v4.hitProbes >= min);
}
/** V4 が V2N より悪化していないか。データが足りなければ null（判定不能）。 */
export function noNewOverlap(v2n, v4, tolerance = 0.005) {
  if (!hasEnoughData(v2n, v4)) return null;
  const a = overlapRate(v2n), b = overlapRate(v4);
  if (a == null || b == null) return null;
  return b <= a + tolerance;
}

const GRID = (cx, cz) => `(() => {
  const meshes = [];
  scene.traverse((o) => { if (o.isMesh && o.visible && o.userData && o.userData.usageCategory != null) {
    let q = o, v = true; while (q) { if (q.visible === false) { v = false; break; } q = q.parent; } if (v) meshes.push(o); } });
  const perBand = {}; let probes = 0, hitProbes = 0, overlapProbes = 0;
  for (let dx = -${PROBE.halfM}; dx <= ${PROBE.halfM}; dx += ${PROBE.stepM}) {
    for (let dz = -${PROBE.halfM}; dz <= ${PROBE.halfM}; dz += ${PROBE.stepM}) {
      const rc = new THREE.Raycaster(new THREE.Vector3(${cx} + dx, 900, ${cz} + dz), new THREE.Vector3(0, -1, 0), 0.1, 2000);
      const hits = rc.intersectObjects(meshes, false);
      probes++;
      if (!hits.length) continue;
      hitProbes++;
      const byBand = new Map();
      for (const h of hits) {
        const b = h.object.userData.crBuildingBand || '?';
        if (!byBand.has(b)) byBand.set(b, new Set());
        byBand.get(b).add(h.object.uuid);
      }
      let over = false;
      for (const [b, s] of byBand) {
        perBand[b] = perBand[b] || {};
        perBand[b][s.size] = (perBand[b][s.size] || 0) + 1;
        if (s.size > 1) over = true;
      }
      if (over) overlapProbes++;
    }
  }
  return { probes, hitProbes, overlapProbes, perBand };
})()`;
const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z) => `(() => { cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${PROBE.cameraR}; cs.ph = (90 - ${PROBE.pitchDeg}) * Math.PI / 180; cs.th = -0.35; camUpd(); return 1; })()`,
  setVersion: (v) => `(() => CanonicalRuntime.setBuildingsVersion(${JSON.stringify(v)}))()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
};

/** tile の読み込みが落ち着くまで待つ。固定待ちだと読めていないまま測ってしまう。 */
async function settle(page, min = 3000, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}

export async function run() {
  const t0 = Date.now();
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35D', url: URL_,
    method: '同じ地点・同じ camera で V2N と V4 の「同一 band 内 2 mesh 以上」の割合を比べる',
    probe: PROBE, sites: [] };
  const b = await launchBrowser({ width: 1200, height: 800 });
  const page = b.page;
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    for (const s of SITES) {
      const rec = { ...s };
      for (const v of VERSIONS) {
        await page.evaluate(JS.setVersion(v)); await sleep(2000);
        await page.evaluate(JS.ward(s.x, s.z)); await sleep(2200);
        await page.evaluate(JS.camera(s.x, s.z));
        await settle(page);
        await sleep(2500);
        rec[v] = await page.evaluate(GRID(s.x, s.z), { timeoutMs: 180000 });
        rec[v].overlapRate = overlapRate(rec[v]);
      }
      rec.enoughData = hasEnoughData(rec.V2N, rec.V4);
      rec.noNewOverlap = noNewOverlap(rec.V2N, rec.V4);
      rec.delta = rec.enoughData ? +((rec.V4.overlapRate || 0) - (rec.V2N.overlapRate || 0)).toFixed(4) : null;
      out.sites.push(rec);
      console.log('[ctrl]', s.id.padEnd(18),
        'hit', String(rec.V2N.hitProbes).padStart(4) + '/' + String(rec.V4.hitProbes).padStart(4),
        rec.enoughData
          ? ('V2N ' + ((rec.V2N.overlapRate || 0) * 100).toFixed(1) + '% → V4 '
            + ((rec.V4.overlapRate || 0) * 100).toFixed(1) + '% ('
            + (rec.delta >= 0 ? '+' : '') + (rec.delta * 100).toFixed(1) + 'pt) '
            + (rec.noNewOverlap ? 'OK' : '悪化'))
          : 'データ不足（tile が読めていない）→ 判定不能');
    }
  } finally { await b.close(); }
  const judged = out.sites.filter((s) => s.enoughData);
  out.summary = {
    sites: out.sites.length,
    judgedSites: judged.length,
    skippedForLackOfData: out.sites.filter((s) => !s.enoughData).map((s) => s.id),
    allNoNewOverlap: judged.length > 0 && judged.every((s) => s.noNewOverlap === true),
    worstDelta: judged.length ? Math.max(...judged.map((s) => s.delta)) : null,
    minHitProbes: MIN_HIT_PROBES,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => {
    console.log('[ctrl] 判定できた地点', o.summary.judgedSites, '/', o.summary.sites,
      o.summary.skippedForLackOfData.length ? ('（データ不足で除外: ' + o.summary.skippedForLackOfData.join(',') + '）') : '');
    console.log('[ctrl] すべての地点で悪化なし:', o.summary.allNoNewOverlap,
      '最悪の差', o.summary.worstDelta == null ? '-' : (o.summary.worstDelta * 100).toFixed(1) + 'pt');
    console.log('[ctrl] out', OUT);
  }).catch((e) => { console.error(e); process.exit(1); });
}
