/* Mission 45I: 区単位ベクタ（道路・河川・公園・鉄道）のストリーミング計画（DOM / Cesium 非依存。Node でテスト可能）。
 * 座標は Live City 局所座標（x=東, z=南が正, m）。ビューアが「どの区を・どの詳細度で」常駐させるかをここで決める。
 * 常駐は最大 maxWards 区。距離は視線中心から区 bbox まで。mount 済みは hysteresis 倍まで緩めて維持（ちらつき・再取得防止）。 */
(function (root) {
  'use strict';
  const DEFAULTS = {
    maxWards: 4,
    nearHeight: 9000, nearDist: 2500, nearMax: 2,       // 近景: 全 tier + 河川/公園
    midHeight: 28000, midDist: 12000, midMax: 3,        // 中景: major+mid の道路 + 河川 + 鉄道
    farHeight: 70000, farDist: 30000, farMax: 4,        // 遠景: major の道路 + 鉄道のみ
    hysteresis: 1.3,
  };
  const LAYERS_BY_LEVEL = { near: ['roads', 'waterways', 'parks', 'railways'], mid: ['roads', 'waterways', 'railways'], far: ['roads', 'railways'] };
  const TIERS_BY_LEVEL = { near: ['major', 'mid', 'local'], mid: ['major', 'mid'], far: ['major'] };
  const RANK = { near: 0, mid: 1, far: 2 };

  function distToBBox(b, x, z) {
    const dx = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0;
    const dz = z < b.minZ ? b.minZ - z : z > b.maxZ ? z - b.maxZ : 0;
    return Math.hypot(dx, dz);
  }
  function levelFor(height, dist, cfg, k) {
    if (height <= cfg.nearHeight * k && dist <= cfg.nearDist * k) return 'near';
    if (height <= cfg.midHeight * k && dist <= cfg.midDist * k) return 'mid';
    if (height <= cfg.farHeight * k && dist <= cfg.farDist * k) return 'far';
    return null;
  }
  /** cam {x,z,height}, wards [{wardCode,bbox}]（レイヤーのある区だけ渡す）, mounted {code: level}。 → { want:{code:level}, drop:[code], mount:[code], relevel:[code] } */
  function plan(cam, wards, mounted, opt) {
    const cfg = Object.assign({}, DEFAULTS, opt || {});
    const cand = [];
    for (const w of wards) {
      const d = distToBBox(w.bbox, cam.x, cam.z);
      const had = mounted && mounted[w.wardCode];
      const lv = levelFor(cam.height, d, cfg, had ? cfg.hysteresis : 1);
      if (lv) cand.push({ code: w.wardCode, level: lv, dist: d });
    }
    cand.sort((a, b) => (RANK[a.level] - RANK[b.level]) || (a.dist - b.dist));
    const cnt = { near: 0, mid: 0, far: 0 }, cap = { near: cfg.nearMax, mid: cfg.midMax, far: cfg.farMax };
    const want = {};
    let total = 0;
    for (const c of cand) {
      if (total >= cfg.maxWards) break;
      let lv = c.level;
      while (lv && cnt[lv] >= cap[lv]) lv = lv === 'near' ? 'mid' : lv === 'mid' ? 'far' : null;   // 枠が埋まったら一段粗くして残す
      if (!lv || cnt[lv] >= cap[lv]) continue;
      cnt[lv]++; total++; want[c.code] = lv;
    }
    const m = mounted || {};
    return {
      want,
      drop: Object.keys(m).filter((c) => !want[c]),
      mount: Object.keys(want).filter((c) => !m[c]),
      relevel: Object.keys(want).filter((c) => m[c] && m[c] !== want[c]),
    };
  }
  const tierAllows = (level, tier) => (TIERS_BY_LEVEL[level] || []).includes(tier || 'local');
  const layersFor = (level) => (LAYERS_BY_LEVEL[level] || []).slice();

  /** 住吉区の既存束（mission37c-layers）と二重線にならないよう、box 内の頂点を除いた連続区間を返す（box 内を通る線は分割）。 */
  function clipOutBox(pts, box) {
    if (!box) return [pts];
    const inside = (p) => p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minZ && p[1] <= box.maxZ;
    const runs = []; let cur = null, prevIn = null;
    for (const p of pts) {
      if (inside(p)) { if (cur) { cur.push(p); if (cur.length >= 2) runs.push(cur); cur = null; } prevIn = p; }
      else { if (!cur) cur = prevIn ? [prevIn] : []; cur.push(p); prevIn = null; }
    }
    if (cur && cur.length >= 2) runs.push(cur);
    // 箱を出入りする線は、箱内の隣接頂点 1 点まで残す（境界で線が途切れない。その 1 区間は束の下に隠れる）
    return runs;
  }
  // ── 45J: レイヤー単位キー。detail 切替は「作り直し」ではなく「不足分の追加 + show/hide」で行う ──
  const KEYS_BY_LEVEL = {
    near: ['roads:major', 'roads:mid', 'roads:local', 'waterways', 'parks', 'railways'],
    mid: ['roads:major', 'roads:mid', 'waterways', 'railways'],
    far: ['roads:major', 'railways'],
  };
  const keyLayer = (k) => String(k).split(':')[0];
  /** have: 構築済みキー配列。→ { add: 追加構築するキー, show: 表示するキー, hide: 隠すキー }（破棄はしない） */
  function planKeys(have, level) {
    const want = level ? (KEYS_BY_LEVEL[level] || []) : KEYS_BY_LEVEL.near;
    const h = new Set(have || []), w = new Set(want);
    return { add: want.filter((k) => !h.has(k)), show: want.slice(), hide: [...h].filter((k) => !w.has(k)) };
  }
  function pip(r, x, z) {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if (((r[i][1] > z) !== (r[j][1] > z)) && (x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) c = !c;
    }
    return c;
  }
  /** 区ポリゴン内判定の高速版（結果は厳密判定と同一）。セルを内/外/境界に前計算し、境界セルだけ厳密判定する。 */
  function makeInsideTester(polys, cell) {
    cell = cell || 64;
    const st = { exactCalls: 0, fastCalls: 0 };
    const exact = (x, z) => polys.some((p) => pip(p.outer, x, z) && !(p.holes || []).some((h) => pip(h, x, z)));
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const rings = []; for (const p of polys) { rings.push(p.outer); for (const h of p.holes || []) rings.push(h); }
    for (const r of rings) for (const q of r) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < z0) z0 = q[1]; if (q[1] > z1) z1 = q[1]; }
    if (!isFinite(x0)) { const e = () => false; e.stats = st; return e; }
    const nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 1), nz = Math.max(1, Math.ceil((z1 - z0) / cell) + 1);
    if (nx * nz > 4e6) { const e = (x, z) => exact(x, z); e.stats = st; return e; }
    const boundary = new Uint8Array(nx * nz);
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const ax = r[j][0], az = r[j][1], bx = r[i][0], bz = r[i][1];
        const cx0 = Math.floor((Math.min(ax, bx) - x0) / cell), cx1 = Math.floor((Math.max(ax, bx) - x0) / cell);
        const cz0 = Math.floor((Math.min(az, bz) - z0) / cell), cz1 = Math.floor((Math.max(az, bz) - z0) / cell);
        for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) boundary[cx * nz + cz] = 1;   // 辺の bbox が触れるセルは全て境界（保守的）
      }
    }
    const state = new Int8Array(nx * nz);   // 0 未計算 / 1 内 / 2 外
    const f = function (x, z) {
      if (x < x0 || x > x1 || z < z0 || z > z1) { st.fastCalls++; return false; }
      const cx = Math.floor((x - x0) / cell), cz = Math.floor((z - z0) / cell), k = cx * nz + cz;
      if (boundary[k]) { st.exactCalls++; return exact(x, z); }
      if (!state[k]) state[k] = exact(x0 + (cx + 0.5) * cell, z0 + (cz + 0.5) * cell) ? 1 : 2;
      st.fastCalls++; return state[k] === 1;
    };
    f.stats = st;
    return f;
  }
  /** inside(x,z) で線を「区内の頂点 + 隣接 1 点」の連続区間に切る（40M の makeWardClip と同じ規則）。 */
  function clipRuns(pts, inside) {
    const ins = pts.map((q) => inside(q[0], q[1]));
    const runs = []; let cur = null;
    for (let i = 0; i < pts.length; i++) {
      const near = ins[i] || (i > 0 && ins[i - 1]) || (i < pts.length - 1 && ins[i + 1]);
      if (near) { (cur = cur || []).push(pts[i]); } else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    return runs;
  }
  const api = { KEYS_BY_LEVEL, keyLayer, planKeys, makeInsideTester, clipRuns, DEFAULTS, LAYERS_BY_LEVEL, TIERS_BY_LEVEL, distToBBox, plan, tierAllows, layersFor, clipOutBox };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LC45I = api;
})(typeof window !== 'undefined' ? window : globalThis);
