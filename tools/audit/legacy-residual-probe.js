#!/usr/bin/env node
// tools/audit/legacy-residual-probe.js
// [Mission 32Q §1-§5] 実ブラウザで Legacy residual の正体を特定する。
//   - self-check が数える residual（CanonicalRuntime.getResidualDetail）
//   - canonical / debug / ui root 以外で「実際に見えている」描画 object の全件（頂点数 300 以下も含む）
//   - 各 object の名前・親の連鎖・runtimeOwner・datasetId・geometry / material・視錐台内か・実際に描画されたか
//   - 旧埋め込みレイヤーの統計（ParkingLayer / CemeteryLayer / TempleLayer / SchoolLayer / WaterLayer）
//   前提: `npm run preview`（http://localhost:8000）。
//   実行: node tools/audit/legacy-residual-probe.js --label=before|after
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PROBE = `(async () => {
  const roots = window.__SCENE_ROOTS__;
  const skipRoots = new Set([roots.canonicalRoot, roots.debugRoot, roots.uiRoot]);
  const under = (o, set) => { let p = o; while (p) { if (set.has(p)) return true; p = p.parent; } return false; };
  const trulyVisible = (o) => { let p = o; while (p) { if (p.visible === false) return false; p = p.parent; } return true; };
  const chain = (o) => { const a = []; let p = o.parent; while (p) { a.push(p.name || ('<' + p.type + '>')); p = p.parent; } return a; };
  const owner = (o) => { let p = o; while (p) { if (p.userData && p.userData.runtimeOwner) return p.userData.runtimeOwner; p = p.parent; } return null; };
  const COEXIST = /^(CR_|GroundVisual|Ground|WaterSurface|Sea|Ward|WardBoundary|WardArea|WardLabel|Land|LandSurface|Label|Facility|Station|Boundary|Compass|Sky|Tree|Foliage|Landmark|Highlight|Hover|Select|Town)/i;
  const coexist = (o) => { let p = o; while (p) { if (p.name && COEXIST.test(p.name)) return true; p = p.parent; } return false; };
  camera.updateMatrixWorld(); const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const list = [];
  window.__SCENE__.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isLineSegments || o.isPoints || o.isSprite)) return;
    if (under(o, skipRoots)) return;
    if (!trulyVisible(o)) return;
    const pos = o.geometry && o.geometry.getAttribute ? o.geometry.getAttribute('position') : null;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    let inFrustum = null; try { inFrustum = o.frustumCulled === false ? 'not-culled' : frustum.intersectsObject(o); } catch (e) { inFrustum = 'n/a'; }
    let bbox = null; try { o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); bbox = [b.min.x, b.min.z, b.max.x, b.max.z].map(Math.round); } catch (e) { /* */ }
    list.push({ o, rec: {
      uuid: o.uuid, name: o.name || '', type: o.type, parentChain: chain(o),
      underLegacyRoot: under(o, new Set([roots.legacyRoot])), directSceneChild: o.parent && o.parent.parent === window.__SCENE__ && !o.parent.name,
      runtimeOwner: owner(o), datasetId: (o.userData && o.userData.datasetId) || (o.parent && o.parent.userData && o.parent.userData.datasetId) || null,
      coexistByName: coexist(o), positions: pos ? pos.count : null, geometryType: o.geometry ? o.geometry.type : null,
      materialType: mat ? mat.type : null, color: mat && mat.color ? '#' + mat.color.getHexString() : null,
      opacity: mat ? mat.opacity : null, transparent: mat ? !!mat.transparent : null, vertexColors: mat ? !!mat.vertexColors : null,
      frustumCulled: o.frustumCulled, inFrustum, bbox, drawn: false,
    } });
  });
  // 実際に描画されたか: onAfterRender を一時的に仕込んで 2 frame 待つ
  const drawn = new Set();
  const saved = list.map(({ o }) => { const f = o.onAfterRender; o.onAfterRender = function () { drawn.add(o.uuid); if (f) f.apply(this, arguments); }; return [o, f]; });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
  for (const [o, f] of saved) o.onAfterRender = f;
  for (const it of list) it.rec.drawn = drawn.has(it.o.uuid);
  const recs = list.map((x) => x.rec);
  let detail = null; try { detail = CanonicalRuntime.getResidualDetail(); } catch (e) { detail = { error: String(e) }; }
  const residualIds = new Set(((detail && detail.details) || []).map((d) => d.uuid));
  for (const r of recs) r.countedAsResidual = residualIds.has(r.uuid);
  const stat = (n) => { try { const L = window[n] || eval(n); return L && L.getStats ? L.getStats() : null; } catch (e) { return null; } };
  const layerStats = {};
  for (const n of ['ParkingLayer', 'CemeteryLayer', 'TempleLayer', 'SchoolLayer', 'WaterLayer']) {
    const s = stat(n);
    layerStats[n] = s ? { rendered: s.rendered ?? s.embedded ?? null, vertices: s.vertices ?? null, triangles: s.triangles ?? null, drawCalls: s.drawCalls ?? null } : null;
  }
  const nonCoexist = recs.filter((r) => !r.coexistByName && r.runtimeOwner !== 'DEBUG');
  return {
    canonicalEnabled: !!window.__CANONICAL_OWNS_BASE__,
    selfCheck: window.__CANONICAL_SELF_CHECK__(),
    status: (document.getElementById('canonical-runtime-status') || {}).innerText ? document.getElementById('canonical-runtime-status').innerText.split('\\n').slice(0, 12) : null,
    residualDetail: detail ? { total: detail.total, unknown: detail.unknown, details: (detail.details || []).map((d) => ({ uuid: d.uuid, type: d.type, positionCount: d.positionCount, bucket: d.bucket, scenePath: d.scenePath })) } : null,
    visibleOutsideCanonical: recs.length,
    visibleLegacyObjects: nonCoexist.length,
    visibleLegacyList: nonCoexist,
    coexistVisibleCount: recs.length - nonCoexist.length,
    coexistSample: recs.filter((r) => r.coexistByName).slice(0, 12).map((r) => ({ chain: r.parentChain.slice(0, 3), type: r.type, positions: r.positions })),
    layerStats,
  };
})()`;

async function main() {
  const label = (process.argv.find((a) => a.startsWith('--label=')) || '--label=probe').slice(8);
  const b = await launchBrowser({});
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '32Q', label, url: URL_ };
  try {
    await b.page.send('Page.navigate', { url: URL_ });
    // self-check は startup cleanup を最大 3 回（3s/8s/15s）再試行するので、それが終わるまで待つ
    await sleep(40000);
    out.startup = await b.page.evaluate(PROBE);
    // 地点を変えても同じか（梅田・区モード / City Mode）
    await b.page.evaluate(`(() => { WardModeManager.switchWard('kita'); cs.tgt.x = -2668; cs.tgt.z = -10941; cs.r = 650; cs.ph = 0.85; camUpd(); return 1; })()`);
    await sleep(12000);
    await b.page.evaluate(`(() => { window.__CANONICAL_SELF_CHECK__ && CanonicalRuntime.getResidualDetail; return 1; })()`);
    out.umedaWard = await b.page.evaluate(PROBE);
    await b.page.evaluate(`(() => { CityModeManager.enter(); return 1; })()`);
    await sleep(12000);
    out.cityMode = await b.page.evaluate(PROBE);
    // Legacy 表示へ戻したとき（canonical OFF）に旧レイヤーが戻るか（破壊していないこと）
    out.legacyToggle = await b.page.evaluate(`(async () => {
      if (!window.__SET_CANONICAL_RUNTIME__) return { skipped: true };
      await window.__SET_CANONICAL_RUNTIME__(false);
      await new Promise((r) => setTimeout(r, 1500));
      const roots = window.__SCENE_ROOTS__;
      const legacyVisible = roots.legacyRoot.visible;
      let parkingInLegacy = false;
      roots.legacyRoot.traverse((o) => { if (o.name === 'ParkingLayer' || o.name === 'CemeteryLayer') parkingInLegacy = true; });
      await window.__SET_CANONICAL_RUNTIME__(true);
      await new Promise((r) => setTimeout(r, 1500));
      return { legacyRootVisibleWhenLegacy: legacyVisible, parkingOrSacredUnderLegacyRoot: parkingInLegacy, backToCanonical: !!window.__CANONICAL_OWNS_BASE__, legacyRootVisibleNow: roots.legacyRoot.visible };
    })()`);
  } finally {
    await b.close();
  }
  const p = P('data', 'reports', `legacy-residual-probe-${label}.json`);
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  main().then((o) => {
    for (const k of ['startup', 'umedaWard', 'cityMode']) {
      const s = o[k];
      console.log(`[probe] ${k}: residual ${s.selfCheck.total} / visibleLegacyObjects ${s.visibleLegacyObjects} / coexist ${s.coexistVisibleCount}`);
      for (const r of s.visibleLegacyList) console.log('   ', JSON.stringify({ chain: r.parentChain, type: r.type, pos: r.positions, color: r.color, op: r.opacity, owner: r.runtimeOwner, inFrustum: r.inFrustum, drawn: r.drawn, residual: r.countedAsResidual, bbox: r.bbox }));
    }
    console.log('[probe] layers', JSON.stringify(o.startup.layerStats));
    console.log('[probe] legacyToggle', JSON.stringify(o.legacyToggle));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
