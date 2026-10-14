// Mission 37K-2: POI の画面空間での間引き（ブラウザ / Node 共用の純粋ロジック）。
// 入力は画面座標つきの候補。出力は「点を出す候補」「ラベルを出す候補」の添字集合。
// 優先度: 選択中 > ランドマーク・駅（観光/交通）> 公共・医療・教育 > 一般施設。同優先度は近い順。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveCityPoiSelect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PRIORITY = { tourism: 1, transport: 1, public: 2, medical: 2, education: 2 };   // 無いものは 3
  const prioOf = (cat) => PRIORITY[cat] || 3;

  // カメラ高度 (m) による段階。点: 一般は 3500m 以下、ランドマーク/駅は 8000m 以下。
  // ラベル: ランドマーク/駅 2500m 以下 / 公共・医療・教育 900m 以下 / 一般 350m 以下。
  function pointMaxHeight(cat) { return prioOf(cat) === 1 ? 8000 : 3500; }
  function labelMaxHeight(cat) { const p = prioOf(cat); return p === 1 ? 2500 : p === 2 ? 900 : 350; }

  function budgets(viewW) {
    const mobile = viewW < 720;
    return { points: mobile ? 30 : 80, labels: mobile ? 6 : 14, cell: mobile ? 34 : 26 };
  }

  function labelRect(x, y, name) {
    const w = Math.min(220, (name || '').length * 12 + 10), h = 16;
    return { x0: x - w / 2, x1: x + w / 2, y0: y - 14 - h, y1: y - 14 };
  }
  const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

  // items: [{ x, y, d, cat, name, selected, labelOk }]  x,y は画面座標。画面外は呼び出し側で除外してもよい。
  // opts: { viewW, viewH, height, budget? }
  function select(items, opts) {
    const b = Object.assign(budgets(opts.viewW), opts.budget || {});
    const order = items.map((it, i) => i).sort((i, j) => {
      const a = items[i], c = items[j];
      return (c.selected ? 1 : 0) - (a.selected ? 1 : 0) || prioOf(a.cat) - prioOf(c.cat) || a.d - c.d;
    });
    const points = new Set(), labels = new Set(), cells = new Set(), rects = [];
    for (const i of order) {
      const it = items[i];
      if (it.selected) { points.add(i); if (it.name) { labels.add(i); rects.push(labelRect(it.x, it.y, it.name)); } continue; }
      if (opts.height > pointMaxHeight(it.cat)) continue;
      if (it.x < -10 || it.y < -10 || it.x > opts.viewW + 10 || it.y > opts.viewH + 10) continue;
      if (points.size >= b.points) continue;
      const key = Math.floor(it.x / b.cell) + ',' + Math.floor(it.y / b.cell);
      if (cells.has(key)) continue;
      cells.add(key); points.add(i);
      if (it.labelOk !== false && it.name && labels.size < b.labels && opts.height <= labelMaxHeight(it.cat)) {
        const r = labelRect(it.x, it.y, it.name);
        if (!rects.some((o) => overlap(o, r))) { rects.push(r); labels.add(i); }
      }
    }
    return { points, labels };
  }

  return { select, prioOf, pointMaxHeight, labelMaxHeight, budgets, labelRect };
});
