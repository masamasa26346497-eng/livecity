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
  const api = { DEFAULTS, LAYERS_BY_LEVEL, TIERS_BY_LEVEL, distToBBox, plan, tierAllows, layersFor, clipOutBox };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LC45I = api;
})(typeof window !== 'undefined' ? window : globalThis);
