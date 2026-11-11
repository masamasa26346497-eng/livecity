// Mission 52: GSI 水域面がタイル境界で分割・重複する問題の整理（ブラウザ / Node 共用の純粋ロジック）。
// 他の（残す）ポリゴンで「完全に覆われている」ポリゴンだけを落とす。座標は一切変更しない・新しい形も作らない。
// 判定: 面積の大きい順に残す → 候補の頂点と内部格子点（step m）がすべて既に残したポリゴン内（穴を除く）なら冗長。
//   サンプリング判定なので step 未満の細片は見逃し得る（その場合も落とすのは step 四方以下の面積のみ）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveCityWaterDedupe = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const inRing = (x, z, r) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };
  const inPoly = (x, z, p) => inRing(x, z, p.outer) && !(p.holes || []).some((h) => inRing(x, z, h));
  const bbox = (p) => {
    let a = 1e18, b = -1e18, c = 1e18, d = -1e18;
    for (const q of p.outer) { if (q[0] < a) a = q[0]; if (q[0] > b) b = q[0]; if (q[1] < c) c = q[1]; if (q[1] > d) d = q[1]; }
    return [a, b, c, d];
  };
  const ringArea = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(s) / 2; };
  const netArea = (p) => ringArea(p.outer) - (p.holes || []).reduce((t, h) => t + ringArea(h), 0);

  function dedupeWater(polys, opts) {
    const step = (opts && opts.step) || 2;
    const items = polys.map((p, i) => ({ p, i, bb: bbox(p), a: netArea(p) })).sort((x, y) => y.a - x.a);
    const kept = [], dropped = [];
    for (const it of items) {
      const [x0, x1, z0, z1] = it.bb;
      const others = kept.filter((k) => !(k.bb[1] < x0 || k.bb[0] > x1 || k.bb[3] < z0 || k.bb[2] > z1));
      let covered = others.length > 0, inside = 0;
      if (covered) {
        const covers = (x, z) => others.some((k) => inPoly(x, z, k.p));
        // 頂点は覆う側の境界と重なることが多いので、重心方向へ 0.5m 寄せた点で判定する（候補の内側に残る場合のみ）
        let cx = 0, cz = 0;
        for (const q of it.p.outer) { cx += q[0]; cz += q[1]; }
        cx /= it.p.outer.length; cz /= it.p.outer.length;
        for (const q of it.p.outer) {
          const L = Math.hypot(cx - q[0], cz - q[1]) || 1, k = Math.min(0.5, L * 0.5) / L;
          const px = q[0] + (cx - q[0]) * k, pz = q[1] + (cz - q[1]) * k;
          if (inPoly(px, pz, it.p) && !covers(px, pz)) { covered = false; break; }
        }
        for (let x = x0 + step / 2; covered && x < x1; x += step) {
          for (let z = z0 + step / 2; z < z1; z += step) {
            if (!inPoly(x, z, it.p)) continue;
            inside++;
            if (!covers(x, z)) { covered = false; break; }
          }
        }
      }
      (covered ? dropped : kept).push(it);
    }
    kept.sort((x, y) => x.i - y.i);
    return {
      polys: kept.map((k) => k.p),
      droppedIndexes: dropped.map((d) => d.i).sort((a, b) => a - b),
      droppedAreaM2: Math.round(dropped.reduce((t, d) => t + d.a, 0)),
    };
  }
  return { dedupeWater, inPoly, netArea };
});
