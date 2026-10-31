/* Mission 45K: 道路・鉄道・河川線のビューポート空間カリング（DOM / Cesium 非依存。Node でテスト可能）。
 * 目的: 区の全 feature を無条件に PolylineCollection へ載せない。視野付近のセルだけを GPU へ載せ、離れたセルは外す。
 * 座標は Live City 局所座標（x=東, z=南が正, m）。入力データは変更しない（読み取りのみ）。
 *
 * 索引: 各線分を「始点のセル」に 1 回だけ割り当てる（重複描画なし）。同じセルに連続する線分は 1 run にまとめ、
 *       run は終点まで含むので、隣接セルの run と端点を共有して途切れない。cell 境界をまたぐ線分は長さ分だけ
 *       セルの外へはみ出すため、選択矩形に余白（margin）を持たせて欠けを防ぐ。 */
(function (root) {
  'use strict';
  const DEFAULTS = { cell: 400, margin: 1.5, hysteresis: 1.5, minRadius: 1200, heightFactor: 1.8, maxBuildVertices: 6000, maxResidentVertices: 250000 };

  const keyOf = (cx, cz) => cx + ',' + cz;

  /** features: [{p:[[x,z],...], ...}], styleOf(f) → null | {…, maxDist}. → { cells:Map, cell, stats } */
  function buildIndex(features, styleOf, cell) {
    cell = cell || DEFAULTS.cell;
    const cells = new Map();
    const stats = { features: 0, segments: 0, runs: 0, vertices: 0 };
    for (const f of features || []) {
      const st = styleOf ? styleOf(f) : {};
      if (!st || !Array.isArray(f.p) || f.p.length < 2) continue;
      stats.features++;
      let cur = null, curKey = null;
      for (let i = 0; i < f.p.length - 1; i++) {
        const a = f.p[i], b = f.p[i + 1];
        const k = keyOf(Math.floor(a[0] / cell), Math.floor(a[1] / cell));
        stats.segments++;
        if (k !== curKey) {
          curKey = k;
          cur = { f, st, pts: [a] };
          let c = cells.get(k); if (!c) { c = { runs: [], vertices: 0, cx: Math.floor(a[0] / cell), cz: Math.floor(a[1] / cell) }; cells.set(k, c); }
          c.runs.push(cur); stats.runs++;
        }
        cur.pts.push(b);
      }
    }
    for (const c of cells.values()) { c.vertices = c.runs.reduce((s, r) => s + r.pts.length, 0); stats.vertices += c.vertices; }
    return { cells, cell, stats };
  }

  /** カメラ足元（地表注視点）と高度から、描画対象にする地表矩形。 */
  function viewRect(cx, cz, height, opt) {
    const o = Object.assign({}, DEFAULTS, opt || {});
    const r = Math.max(o.minRadius, (height || 0) * o.heightFactor) * o.margin;
    return { minX: cx - r, maxX: cx + r, minZ: cz - r, maxZ: cz + r, cx, cz, r };
  }

  /** 矩形に触れるセル（run の maxDist によるセル単位の距離カリング込み）。→ [{key, cell, dist, keepRuns}] 近い順。 */
  function selectCells(index, rect) {
    const cs = index.cell, out = [];
    const cx0 = Math.floor(rect.minX / cs), cx1 = Math.floor(rect.maxX / cs), cz0 = Math.floor(rect.minZ / cs), cz1 = Math.floor(rect.maxZ / cs);
    const nCells = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);
    const visit = (c, k) => {
      const mx = (c.cx + 0.5) * cs, mz = (c.cz + 0.5) * cs;
      const dist = Math.hypot(mx - rect.cx, mz - rect.cz);
      out.push({ key: k, cell: c, dist });
    };
    if (nCells > index.cells.size) {   // 矩形が索引より大きい: 索引側を走査（巨大矩形でも O(セル数)）
      for (const [k, c] of index.cells) if (c.cx >= cx0 && c.cx <= cx1 && c.cz >= cz0 && c.cz <= cz1) visit(c, k);
    } else {
      for (let x = cx0; x <= cx1; x++) for (let z = cz0; z <= cz1; z++) { const k = keyOf(x, z), c = index.cells.get(k); if (c) visit(c, k); }
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  /** 常駐管理。build(key, cell) → handle|null、destroy(handle)。GPU へ載せた cell を LRU + hysteresis で管理する。 */
  function makeResidency(index, build, destroy, opt) {
    const o = Object.assign({}, DEFAULTS, opt || {});
    const res = new Map();   // key -> { handle, vertices, last }
    const st = { builtTotal: 0, droppedTotal: 0, resident: 0, residentVertices: 0, syncs: 0, lastBuilt: 0, lastDropped: 0, deferred: 0 };
    let tick = 0;
    function recount() { st.resident = res.size; let v = 0; for (const r of res.values()) v += r.vertices; st.residentVertices = v; }
    function dropKey(k) { const r = res.get(k); if (!r) return; try { destroy(r.handle); } catch (e) { /* noop */ } res.delete(k); st.droppedTotal++; st.lastDropped++; }
    /** rect = 構築対象（margin 込み）。buildBudget 超過分は deferred（次回 sync）。canBuild=false なら構築せず破棄だけ行う。 */
    function sync(rect, canBuild, budget) {
      tick++; st.syncs++; st.lastBuilt = 0; st.lastDropped = 0;
      const want = selectCells(index, rect);
      const wantKeys = new Set(want.map((w) => w.key));
      // 破棄: 構築矩形を hysteresis 倍に広げた外にあるセルだけ（端でのスラッシング防止）
      const hr = { minX: rect.cx - rect.r * o.hysteresis, maxX: rect.cx + rect.r * o.hysteresis, minZ: rect.cz - rect.r * o.hysteresis, maxZ: rect.cz + rect.r * o.hysteresis };
      for (const k of [...res.keys()]) {
        if (wantKeys.has(k)) continue;
        const c = index.cells.get(k);
        const inside = c && c.cx * index.cell <= hr.maxX && (c.cx + 1) * index.cell >= hr.minX && c.cz * index.cell <= hr.maxZ && (c.cz + 1) * index.cell >= hr.minZ;
        if (!inside) dropKey(k);
      }
      for (const k of wantKeys) { const r = res.get(k); if (r) r.last = tick; }
      let built = 0, bv = 0, pending = 0;
      if (canBuild) {
        const maxBV = (budget && budget.vertices) || o.maxBuildVertices;
        for (const w of want) {
          if (res.has(w.key)) continue;
          if (bv >= maxBV) { pending++; continue; }   // 1 回の構築頂点数上限（残りは次の sync）
          const handle = build(w.key, w.cell);
          res.set(w.key, { handle, vertices: w.cell.vertices, last: tick });
          bv += w.cell.vertices; built++; st.builtTotal++;
        }
      } else pending = want.filter((w) => !res.has(w.key)).length;
      // 常駐頂点の上限: 視野（wantKeys）の外にあるセルから古い順に破棄
      recount();
      if (st.residentVertices > o.maxResidentVertices) {
        const victims = [...res.entries()].filter(([k]) => !wantKeys.has(k)).sort((a, b) => a[1].last - b[1].last);
        for (const [k] of victims) { if (st.residentVertices <= o.maxResidentVertices) break; dropKey(k); recount(); }
      }
      st.lastBuilt = built; st.deferred = pending; recount();
      return { built, pending, wanted: want.length };
    }
    function clear() { for (const k of [...res.keys()]) dropKey(k); recount(); }
    return { sync, clear, stats: st, has: (k) => res.has(k), size: () => res.size };
  }

  const api = { DEFAULTS, buildIndex, viewRect, selectCells, makeResidency };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LC45K = api;
})(typeof window !== 'undefined' ? window : globalThis);
