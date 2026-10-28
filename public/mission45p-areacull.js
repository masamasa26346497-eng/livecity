/* Mission 45P: 公園・水面（面ポリゴン）のビューポート空間カリング（DOM / Cesium 非依存。Node でテスト可能）。
 * 目的: 区の面を全件 1 つの巨大 Primitive にせず、視野付近の「ユニット」だけを小さな Primitive として載せる。
 *   - 小さい面は 400m セルごとにまとめて 1 ユニット（ユニットの bbox = 含まれる面の bbox の和）。
 *   - 大きい面（bbox の一辺が bigSpan 以上。大きな池・河川面など）は単独ユニット。重複描画（半透明の二重塗り）は無い。
 *   - 選択は「ユニット bbox が視野矩形に触れるか」。面の重心ではなく bbox なので、視野内に一部でも入る面は消えない。
 *   - 構築は頂点予算つき（超過分は pending として次回）。破棄は hysteresis 倍の外に出たユニットだけ（端でのスラッシング防止）。
 * 座標は Live City 局所座標（x=東, z=南が正, m）。入力は変更しない。 */
(function (root) {
  'use strict';
  const DEFAULTS = { cell: 400, bigSpan: 600, hysteresis: 1.5, maxBuildVertices: 4000, maxResidentVertices: 150000, deferDropWhileMoving: false };

  function bboxOf(ring) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const q of ring) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < z0) z0 = q[1]; if (q[1] > z1) z1 = q[1]; }
    return { minX: x0, maxX: x1, minZ: z0, maxZ: z1 };
  }
  const union = (a, b) => (a ? { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ) } : { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
  const touches = (a, r) => a.minX <= r.maxX && a.maxX >= r.minX && a.minZ <= r.maxZ && a.maxZ >= r.minZ;

  /** features: [{p:[[x,z],...], kind:'area', ...}]。→ { units:[{key,bbox,feats,vertices}], stats } */
  function buildIndex(features, opt) {
    const o = Object.assign({}, DEFAULTS, opt || {});
    const cells = new Map(), units = [], st = { features: 0, big: 0, cells: 0, vertices: 0, skipped: 0 };
    for (const f of features || []) {
      if (!f || f.kind !== 'area' || !Array.isArray(f.p) || f.p.length < 3) { st.skipped++; continue; }
      const bb = bboxOf(f.p), nv = f.p.length;
      st.features++; st.vertices += nv;
      if (Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ) >= o.bigSpan) {
        units.push({ key: 'b' + units.length, bbox: bb, feats: [f], vertices: nv }); st.big++;
        continue;
      }
      const k = Math.floor((bb.minX + bb.maxX) / 2 / o.cell) + ',' + Math.floor((bb.minZ + bb.maxZ) / 2 / o.cell);
      let u = cells.get(k);
      if (!u) { u = { key: 'c' + k, bbox: null, feats: [], vertices: 0 }; cells.set(k, u); }
      u.feats.push(f); u.vertices += nv; u.bbox = union(u.bbox, bb);
    }
    for (const u of cells.values()) units.push(u);
    st.cells = cells.size;
    return { units, stats: st, opt: o };
  }

  /** rect {minX,maxX,minZ,maxZ,cx,cz}（45K の viewRect と同形）に触れるユニット。近い順。 */
  function selectUnits(index, rect) {
    const out = [];
    for (const u of index.units) {
      if (!touches(u.bbox, rect)) continue;
      const mx = Math.min(Math.max(rect.cx, u.bbox.minX), u.bbox.maxX), mz = Math.min(Math.max(rect.cz, u.bbox.minZ), u.bbox.maxZ);
      out.push({ unit: u, dist: Math.hypot(mx - rect.cx, mz - rect.cz) });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  /** 常駐管理。build(unit)→handle、destroy(handle)。1 回の構築は頂点予算まで（最低 1 ユニットは進める）。 */
  function makeResidency(index, build, destroy, opt) {
    const o = Object.assign({}, index.opt, opt || {});
    const res = new Map(); // key -> { handle, vertices, unit }
    const st = { builtTotal: 0, droppedTotal: 0, resident: 0, residentVertices: 0, syncs: 0, lastBuilt: 0, lastDropped: 0, deferred: 0 };
    const recount = () => { st.resident = res.size; let v = 0; for (const r of res.values()) v += r.vertices; st.residentVertices = v; };
    const drop = (k) => { const r = res.get(k); if (!r) return; try { destroy(r.handle); } catch (e) { /* noop */ } res.delete(k); st.droppedTotal++; st.lastDropped++; };
    function sync(rect, canBuild, budget) {
      st.syncs++; st.lastBuilt = 0; st.lastDropped = 0;
      const want = selectUnits(index, rect), wantKeys = new Set(want.map((w) => w.unit.key));
      const hr = { minX: rect.cx - rect.r * o.hysteresis, maxX: rect.cx + rect.r * o.hysteresis, minZ: rect.cz - rect.r * o.hysteresis, maxZ: rect.cz + rect.r * o.hysteresis };
      // A/B（?vcdefer=1）: 操作中（canBuild=false）は破棄も見送り、止まってから外す。既定は従来どおり。
      if (canBuild || !o.deferDropWhileMoving) for (const [k, r] of [...res.entries()]) if (!wantKeys.has(k) && !touches(r.unit.bbox, hr)) drop(k);
      let built = 0, bv = 0, pending = 0;
      if (canBuild) {
        const maxBV = (budget && budget.vertices) || o.maxBuildVertices;
        for (const w of want) {
          if (res.has(w.unit.key)) continue;
          if (built > 0 && bv + w.unit.vertices > maxBV) { pending++; continue; }
          res.set(w.unit.key, { handle: build(w.unit), vertices: w.unit.vertices, unit: w.unit });
          bv += w.unit.vertices; built++; st.builtTotal++;
        }
      } else pending = want.filter((w) => !res.has(w.unit.key)).length;
      recount();
      if (st.residentVertices > o.maxResidentVertices) {
        for (const [k] of [...res.entries()].filter(([k2]) => !wantKeys.has(k2))) { if (st.residentVertices <= o.maxResidentVertices) break; drop(k); recount(); }
      }
      st.lastBuilt = built; st.deferred = pending;
      return { built, pending, wanted: want.length };
    }
    function clear() { for (const k of [...res.keys()]) drop(k); recount(); }
    return { sync, clear, stats: st, has: (k) => res.has(k), size: () => res.size, handles: () => [...res.values()].map((r) => r.handle) };
  }

  const api = { DEFAULTS, buildIndex, selectUnits, makeResidency, bboxOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LC45P = api;
})(typeof window !== 'undefined' ? window : globalThis);
