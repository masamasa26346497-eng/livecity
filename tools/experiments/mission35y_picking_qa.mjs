// tools/experiments/mission35y_picking_qa.mjs
// [Mission 35Y §16/§17/§20] 建物 hover / click の正確さを実機で測る。
//   建物 footprint の「中央」「端」「壁」を画面座標へ投影し、そこを pick して
//   期待した建物が返るかを数える。巨大 hitbox で誤魔化していないことも同時に見る。
//   MISSION35Y_PHASE=before|after で前後を測る。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION35Y_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const PHASE = process.env.MISSION35Y_PHASE || 'after';
const OUT_DIR = 'data/reports/mission35y-precise-building-picking';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** §16 の地点。高層密集・商業・住宅密集・タイル境界をひととおり。 */
export const SPOTS = [
  { id: 'umeda-dense', name: '梅田(高層密集)', lat: 34.7025, lon: 135.4959, r: 420, phDeg: 45 },
  { id: 'honmachi', name: '本町', lat: 34.6823, lon: 135.5024, r: 380, phDeg: 42 },
  { id: 'namba', name: '難波', lat: 34.6627, lon: 135.5013, r: 380, phDeg: 44 },
  { id: 'tennoji', name: '天王寺', lat: 34.6457, lon: 135.5135, r: 400, phDeg: 42 },
  { id: 'housing', name: '住宅密集地(平野)', lat: 34.6398, lon: 135.5474, r: 320, phDeg: 48 },
  { id: 'niitaka', name: '新高', lat: 34.7280, lon: 135.4703, r: 340, phDeg: 46 },
  // タイル境界（2000m グリッドの角）。§12 の重複が出やすい所。
  { id: 'tile-boundary', name: 'タイル境界', lat: 34.6942, lon: 135.5090, r: 360, phDeg: 44 },
];

// 建物タイルは **区ごと** に読むので、カメラを動かすだけでは新しい場所の建物が出てこない
//   （35S でも同じ所で詰まっている）。行き先の区へ切り替えてから寄せる。
const goTo = (lat, lon, r, phDeg) => `(() => {
  if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
  const p = geoToThree(${lat}, ${lon});
  cs.tgt.x = p.x; cs.tgt.z = p.z; cs.tgt.y = 0;
  cs.r = ${r}; cs.ph = (90 - ${phDeg}) * Math.PI / 180; cs.th = 0.6; camUpd();
  let ward = null;
  try {
    ward = WardModeManager.detectWardAt(p.x, p.z);
    const cur = WardModeManager.getCurrentWard && WardModeManager.getCurrentWard();
    if (ward && (!cur || cur.id !== ward)) WardModeManager.switchWard(ward);
  } catch (e) { /* noop */ }
  return JSON.stringify({ x: p.x, z: p.z, ward: ward });
})()`;

/**
 * その視点で見えている建物から標本を選び、footprint の
 *   center（重心）/ edge（重心と頂点の中間）/ wall（壁面の少し下）
 * を画面へ投影して pick する。期待は「その footprint の canonicalId」。
 */
const PROBE = (n) => `(() => {
  const out = { samples: [], skipped: 0, ambiguous: 0 };
  const fps = CanonicalRuntime.visibleBuildingFootprints(60000) || [];
  camera.updateMatrixWorld();
  const v = new THREE.Vector3();
  const W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight;
  const toScreen = (x, y, z) => {
    v.set(x, y, z).project(camera);
    if (v.z > 1 || Math.abs(v.x) > 0.96 || Math.abs(v.y) > 0.96) return null;
    return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H, [x, y, z]];
  };
  // 画面中央に近い順に並べ、そこから等間隔で標本を取る（偏らせない）
  // 点が ring の中かどうか（重心が polygon の外に出る凹型があるため必須）
  const inRing = (px, pz, r) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
      if (((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) c = !c;
    }
    return c;
  };
  // **確実に footprint の内側にある点**を求める。重心が外に出る凹型 / L 字があるので、
  //   外なら三角形の重心を順に試す。ここを間違えると「隣を指しておいて不正解と数える」ことになる。
  const interior = (f) => {
    if (inRing(f.cx, f.cz, f.ring)) return [f.cx, f.cz];
    const r = f.ring;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length], c = r[(i + 2) % r.length];
      const px = (a[0] + b[0] + c[0]) / 3, pz = (a[1] + b[1] + c[1]) / 3;
      if (inRing(px, pz, r)) return [px, pz];
    }
    return null;
  };
  // その点を含む footprint が 2 つ以上あるなら、そこは本質的にどちらとも言えない（建物が重なっている）。
  //   picking の正誤では判定できないので標本から外す。
  const ambiguous = (px, pz, self) => {
    let n = 0;
    for (const g of fps) {
      if (!g.ring || g.ring.length < 3) continue;
      if (Math.abs(g.cx - px) > 300 || Math.abs(g.cz - pz) > 300) continue;
      if (inRing(px, pz, g.ring)) { n++; if (n > 1) return true; }
    }
    return false;
  };

  const cand = [];
  for (const f of fps) {
    if (!f.ring || f.ring.length < 3) continue;
    const ip = interior(f);
    if (!ip) { out.skipped++; continue; }
    if (ambiguous(ip[0], ip[1], f)) { out.ambiguous = (out.ambiguous || 0) + 1; continue; }
    const s = toScreen(ip[0], 0, ip[1]);
    if (!s) continue;
    cand.push({ f, ix: ip[0], iz: ip[1], sx: s[0], sy: s[1], d: Math.hypot(s[0] - W / 2, s[1] - H / 2) });
  }
  cand.sort((a, b) => a.d - b.d);
  const step = Math.max(1, Math.floor(cand.length / ${n}));
  const picked = [];
  for (let i = 0; i < cand.length && picked.length < ${n}; i += step) picked.push(cand[i]);

  // visibleBuildingFootprints は高さを返さないので、**真上から垂直に ray を落として**
  //   実際に描かれている屋根の高さを測る。これならどのバージョンでも同じ方法で測れる
  //   （API を変えると before/after の比較が公平でなくなる）。
  const down = new THREE.Vector3(0, -1, 0);
  // 建物 mesh の目印は userData.usageCategory（canonical の建物 mesh に必ず付く。
  //   before/after のどちらのバージョンにもある）。
  const bMeshes = [];
  scene.traverse((o) => {
    if (o.isMesh && o.visible && o.userData && o.userData.usageCategory
      && o.parent && o.parent.visible !== false) bMeshes.push(o);
  });
  const roofY = (x, z) => {
    if (!bMeshes.length) return null;
    const rc = new THREE.Raycaster(new THREE.Vector3(x, 4000, z), down);
    const hs = rc.intersectObjects(bMeshes, false);
    for (const h2 of hs) if (h2.point.y > 0.6) return h2.point.y;
    return null;
  };

  // ある画面座標を pick して canonicalId を返す（hover と同じ経路）。
  //   world は「その画面座標が指しているはずの 3D 点」。斜め視点では手前の高い建物に
  //   **隠れている**ことがあり、その場合 ray が別の建物に当たるのは正しい挙動なので、
  //   遮蔽されている標本は不正解ではなく occluded として除く。
  const pickAt = (px, py, world) => {
    const m = new THREE.Vector2((px / W) * 2 - 1, -(py / H) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(m, camera);
    const r2 = CanonicalRuntime.pickBuilding(rc);
    if (!r2 || !r2.d) return { id: null };
    const want = camera.position.distanceTo(new THREE.Vector3(world[0], world[1], world[2]));
    // 手前 1.5m 以上で何かに当たっている = その点は見えていない
    if (r2.distance != null && r2.distance < want - 1.5) return { id: r2.d.canonicalId || r2.d.id, occluded: true };
    return { id: r2.d.canonicalId || r2.d.id || null };
  };

  for (const c of picked) {
    const f = c.f;
    const ring = f.ring;
    // 面積（小さい建物かどうかの判定に使う）
    let A = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      A += a[0] * b[1] - b[0] * a[1];
    }
    A = Math.abs(A) / 2;
    const ix = c.ix, iz = c.iz;
    const h = roofY(ix, iz);
    if (h == null) { out.skipped++; continue; }     // そこに建物が描かれていない
    const probes = {};
    // center: footprint の内側の点の屋根面（実測した屋根の少し下）
    probes.center = toScreen(ix, h - 0.15, iz);
    // edge: 内側の点と外周頂点の中間。内側に留まるものだけ使う。
    const vtx = ring[Math.floor(ring.length / 3)];
    const ex = ix + (vtx[0] - ix) * 0.62, ez = iz + (vtx[1] - iz) * 0.62;
    const eOk = inRing(ex, ez, ring) && !ambiguous(ex, ez, f);
    const eh = eOk ? roofY(ex, ez) : null;
    probes.edge = (eh == null) ? null : toScreen(ex, eh - 0.15, ez);
    // wall: 外周の辺の中点を少しだけ内側へ寄せ、高さ 40% の壁面
    const a2 = ring[0], b2 = ring[1 % ring.length];
    const mx = (a2[0] + b2[0]) / 2, mz = (a2[1] + b2[1]) / 2;
    const wx = mx + (ix - mx) * 0.04, wz = mz + (iz - mz) * 0.04;
    probes.wall = toScreen(wx, h * 0.40, wz);

    // 切り分け用: **真上から**の ray で同じ点を pick する。
    //   カメラからの pick と真上からの pick が一致していれば picking は自己整合で、
    //   食い違うのは「その XY に描かれている建物」と「期待した footprint」がずれている場合。
    const vpick = (() => {
      const rc = new THREE.Raycaster(new THREE.Vector3(ix, 4000, iz), down);
      const r2 = CanonicalRuntime.pickBuilding(rc);
      return r2 && r2.d ? (r2.d.canonicalId || r2.d.id || null) : null;
    })();
    const res = { vertical: (vpick == null) ? 'nohit' : (vpick === f.canonicalId ? 'ok' : 'wrong') };
    for (const k of ['center', 'edge', 'wall']) {
      const p = probes[k];
      if (!p) { res[k] = 'offscreen'; continue; }
      const r3 = pickAt(p[0], p[1], p[2]);
      if (r3.id == null) { res[k] = 'nohit'; continue; }
      if (r3.id === f.canonicalId) { res[k] = 'ok'; continue; }
      res[k] = r3.occluded ? 'occluded' : ('wrong:' + r3.id);
    }
    out.samples.push({ id: f.canonicalId, areaM2: +A.toFixed(1), h: +h.toFixed(1), res });
  }
  out.pickDebug = CanonicalRuntime.getPickDebug ? CanonicalRuntime.getPickDebug() : null;
  out.visibleFootprints = fps.length;
  // §12 dedupe が効いているか（同じ canonicalId が 2 回出てこないか）
  const ids = new Set(); let dup = 0;
  for (const f of fps) { if (ids.has(f.canonicalId)) dup++; else ids.add(f.canonicalId); }
  out.duplicateFootprints = dup;
  return JSON.stringify(out);
})()`;

/** §20 hover 中の FPS と pointer handler の所要時間。 */
const HOVER_PERF = `new Promise((res) => {
  const W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight;
  let n = 0, sum = 0, frames = 0;
  const t0 = performance.now();
  const tick = () => {
    frames++;
    // 画面中央付近を小さく動かして hover を起こす
    const a = (performance.now() - t0) / 220;
    const px = W / 2 + Math.cos(a) * 130, py = H / 2 + Math.sin(a) * 90;
    const t1 = performance.now();
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: px, clientY: py, bubbles: true }));
    sum += performance.now() - t1; n++;
    if (performance.now() - t0 < 2600) requestAnimationFrame(tick);
    else res(JSON.stringify({
      hoverFps: +(frames / ((performance.now() - t0) / 1000)).toFixed(1),
      pointerMs: +(sum / Math.max(1, n)).toFixed(3), moves: n,
    }));
  };
  requestAnimationFrame(tick);
})`;

const PERF = `(() => {
  renderer.info.reset(); renderer.render(scene, camera);
  const r = renderer.info.render, m = renderer.info.memory;
  return JSON.stringify({ drawCalls: r.calls, triangles: r.triangles,
    geometries: m.geometries, textures: m.textures });
})()`;

const HIDE_DEV_UI = `(() => {
  for (const el of document.querySelectorAll('div,button')) { const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|^pl$|^pr$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery|mission35s-focus|town-click/.test(id)) el.style.display = 'none'; }
  return 1; })()`;

async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64'));
  return OUT_DIR + '/' + name + '.jpg';
}

const PER_SPOT = Number(process.env.MISSION35Y_N || 20);
const b = await launchBrowser({ width: 1440, height: 900 });
const page = b.page;
const out = { url: URL_, phase: PHASE, generatedAt: new Date().toISOString(), mission: '35Y', spots: [], jsErrors: [] };
page.on && page.on('Runtime.exceptionThrown', (e) => {
  try { out.jsErrors.push(String(e.exceptionDetails && e.exceptionDetails.text)); } catch { /* noop */ }
});
try {
  await page.send('Runtime.enable').catch(() => {});
  await page.send('Page.navigate', { url: URL_ });
  // 固定待ちだと混んでいるときに間に合わない（実際に geoToThree 未定義で落ちた）。
  //   必要な API が揃うまで待つ。
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const ok = await page.evaluate(
      "(typeof geoToThree === 'function' && typeof CanonicalRuntime !== 'undefined' "
      + "&& !!CanonicalRuntime.visibleBuildingFootprints && typeof WardModeManager !== 'undefined')",
      { timeoutMs: 30000 }).catch(() => false);
    if (ok === true || ok === 'true') break;
  }
  await sleep(6000);
  await page.evaluate(HIDE_DEV_UI);
  for (const sp of SPOTS) {
    const nav = JSON.parse(await page.evaluate(goTo(sp.lat, sp.lon, sp.r, sp.phDeg)));
    // 区切替 → 建物タイルの到着待ち。件数が増えなくなるまで待つ（最大 60 秒）。
    let prev = -1, stable = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const n = Number(await page.evaluate(
        '(CanonicalRuntime.visibleBuildingFootprints(60000) || []).length', { timeoutMs: 60000 }));
      if (n === prev && n > 0) { if (++stable >= 3) break; } else stable = 0;
      prev = n;
    }
    await page.evaluate(HIDE_DEV_UI);
    const perf = JSON.parse(await page.evaluate(PERF, { timeoutMs: 60000 }));
    const probe = JSON.parse(await page.evaluate(PROBE(PER_SPOT), { timeoutMs: 180000 }));
    const hover = JSON.parse(await page.evaluate(HOVER_PERF, { timeoutMs: 60000, awaitPromise: true }));
    const p = await shot(page, PHASE + '-' + sp.id);
    out.spots.push({ ...sp, ward: nav.ward, perf, hover, ...probe, shot: p });
    const tally = { ok: 0, wrong: 0, nohit: 0, off: 0, occ: 0 };
    for (const s of probe.samples) for (const k of ['center', 'edge', 'wall']) {
      const v = s.res[k];
      if (v === 'ok') tally.ok++; else if (v === 'nohit') tally.nohit++;
      else if (v === 'offscreen') tally.off++; else if (v === 'occluded') tally.occ = (tally.occ || 0) + 1;
      else tally.wrong++;
    }
    console.log(`[35Y-qa:${PHASE}] ${sp.id.padEnd(15)} samples=${probe.samples.length}`
      + ` ok=${tally.ok} wrong=${tally.wrong} nohit=${tally.nohit} occl=${tally.occ} off=${tally.off}`
      + ` dupFp=${probe.duplicateFootprints} hoverFps=${hover.hoverFps} ptrMs=${hover.pointerMs}`);
  }
} finally { try { await b.close(); } catch { /* noop */ } }

// ── 集計 ───────────────────────────────────────────────────────
const tally = { ok: 0, wrong: 0, nohit: 0, offscreen: 0, occluded: 0, total: 0 };
const vert = { ok: 0, wrong: 0, nohit: 0 };
const byKind = { center: { ok: 0, n: 0 }, edge: { ok: 0, n: 0 }, wall: { ok: 0, n: 0 } };
const small = { ok: 0, n: 0 };        // 面積 200m2 未満の小さい建物
const wrongList = [];
for (const sp of out.spots) {
  for (const s of sp.samples) {
    if (s.res.vertical) vert[s.res.vertical] = (vert[s.res.vertical] || 0) + 1;
    for (const k of ['center', 'edge', 'wall']) {
      const v = s.res[k];
      if (v === 'offscreen') { tally.offscreen++; continue; }
      // 遮蔽されていて見えない点は「選べなくて当然」なので分母から外す
      if (v === 'occluded') { tally.occluded++; continue; }
      tally.total++; byKind[k].n++;
      if (v === 'ok') { tally.ok++; byKind[k].ok++; if (s.areaM2 < 200) small.ok++; }
      else if (v === 'nohit') tally.nohit++;
      else { tally.wrong++; if (wrongList.length < 40) wrongList.push({ spot: sp.id, kind: k, expected: s.id, got: v.slice(6), areaM2: s.areaM2 }); }
      if (s.areaM2 < 200) small.n++;
    }
  }
}
const pct = (a, b2) => (b2 ? +(a / b2 * 100).toFixed(1) : 0);
const avg = (f) => +(out.spots.reduce((a, x) => a + f(x), 0) / out.spots.length).toFixed(2);
out.summary = {
  phase: PHASE,
  samples: tally.total,
  successRate: pct(tally.ok, tally.total),
  wrongNeighborRate: pct(tally.wrong, tally.total),
  noHitRate: pct(tally.nohit, tally.total),
  counts: tally,
  byKind: {
    center: pct(byKind.center.ok, byKind.center.n),
    edge: pct(byKind.edge.ok, byKind.edge.n),
    wall: pct(byKind.wall.ok, byKind.wall.n),
  },
  smallBuildings: { n: small.n, successRate: pct(small.ok, small.n) },
  // 真上からの pick と期待 footprint の一致率。これが低いなら、picking ではなく
  //   「その場所に描かれている建物」と footprint の対応がずれている。
  verticalAgreement: vert,
  duplicateFootprints: out.spots.reduce((a, x) => a + (x.duplicateFootprints || 0), 0),
  hoverFpsAvg: avg((x) => x.hover.hoverFps),
  pointerMsAvg: avg((x) => x.hover.pointerMs),
  drawCallsAvg: avg((x) => x.perf.drawCalls),
  candidateMeshesAvg: avg((x) => (x.pickDebug ? x.pickDebug.candidateMeshes : 0)),
  pickBy: out.spots.reduce((a, x) => {
    const d = x.pickDebug || {};
    a.byFace += d.byFace || 0; a.byPolygon += d.byPolygon || 0; a.miss += d.miss || 0;
    a.roofHits += d.roofHits || 0; a.wallHits += d.wallHits || 0;
    return a;
  }, { byFace: 0, byPolygon: 0, miss: 0, roofHits: 0, wallHits: 0 }),
  wrongSamples: wrongList,
  jsErrors: out.jsErrors.length,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `picking-${PHASE}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log('[35Y-qa] out', OUT_DIR, PHASE);
