// Mission 145: 町名・町丁目ラベルの出し分けと重なり回避（ブラウザ / Node 共用の純粋ロジック）。
// 閾値は 37D の住吉区実装（TOWN_TIER / TOWN_CAP）と同じ値。Cesium には依存しない。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveCityTowns145 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TIER = { ward: 14000, base: 1800 };   // カメラ高度 (m): ward 超 → 区名のみ / base 超 → 町名 / 以下 → 町丁目名
  const CAP = { base: 40, full: 48 };         // 同時表示ラベル数の上限
  const MAX_WARDS = 3;                        // 同時に保持する区（超えたら最も古い区を破棄）

  function tierOf(h) { return h > TIER.ward ? 'ward' : (h > TIER.base ? 'base' : 'full'); }

  /** 1 区の町丁目から、町名ラベル（町ごとに 1 件、最大面積の丁目の点）と町丁目ラベル（全件）を作る。 */
  function splitForWard(towns) {
    const full = towns.slice();
    const best = new Map();
    for (const t of towns) { const cur = best.get(t.b); if (!cur || t.a > cur.a) best.set(t.b, t); }
    const base = [...best.values()].map((t) => ({ n: t.b, x: t.x, z: t.z, a: t.a, k: t.k }));
    return { base, full };
  }

  /**
   * items: [{ x, y, text, pri }]（x,y は画面座標、画面外は呼び出し側で除外済み）。pri が大きいほど優先（同点は画面中心に近い順）。
   * 既に置いた矩形と重ならないものだけを cap 件まで採る。戻り値は採用した index の Set。
   */
  function declutter(items, cap, view) {
    const cx = view.w / 2, cy = view.h / 2;
    const order = items.map((it, i) => ({ it, i, d: (it.x - cx) * (it.x - cx) + (it.y - cy) * (it.y - cy) }))
      .sort((a, b) => (b.it.pri || 0) - (a.it.pri || 0) || a.d - b.d);
    // 151: view.blockers（表示中の駅ラベルなどの矩形 [x0,y0,x1,y1]）を最初から占有済みにする。町名は駅名に重ならない。
    const boxes = (view.blockers || []).slice(), keep = new Set();
    for (const o of order) {
      if (keep.size >= cap) break;
      const it = o.it, w = String(it.text).length * (it.fs || 13) + 12, h = (it.fs || 13) + 8;
      const x0 = it.x - w / 2, y0 = it.y - h, x1 = it.x + w / 2, y1 = it.y;
      if (x1 < 0 || y1 < 0 || x0 > view.w || y0 > view.h) continue;
      let ok = true;
      for (const b of boxes) if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) { ok = false; break; }
      if (!ok) continue;
      boxes.push([x0, y0, x1, y1]); keep.add(o.i);
    }
    return keep;
  }

  /** LRU: order（古い→新しい）に wardId を載せ、上限を超えた分（破棄すべき区）を返す。 */
  function touchWard(order, wardId, max) {
    const i = order.indexOf(wardId); if (i >= 0) order.splice(i, 1);
    order.push(wardId);
    return order.length > (max || MAX_WARDS) ? order.splice(0, order.length - (max || MAX_WARDS)) : [];
  }

  return { TIER, CAP, MAX_WARDS, tierOf, splitForWard, declutter, touchWard };
});
