/* Mission 219B: 大阪24区の地域グループ選択 → 選択グループだけ詳細3Dをロードする制御（DOM / Cesium 非依存。Node でテスト可能）。
 * 有効化は ?wardgroups=1 のときだけ（既定の完全版は不変）。座標は Live City 局所座標（x=東, z=南が正, m）。座標系・canonicalId・権利表記は変更しない。
 * グループ分けの根拠: osaka-24-wards.json の実区ポリゴンから求めた隣接関係（頂点間 60m 以内）で、各グループが連結になるよう構成。 */
(function (root) {
  'use strict';
  const GROUPS = [
    { id: 'north', name: '大阪北部', note: '淀川以北', wardIds: ['yodogawa', 'higashiyodogawa', 'nishiyodogawa', 'asahi', 'miyakojima'] },
    { id: 'center', name: '都心', note: '梅田・中之島・ミナミ・天王寺', wardIds: ['kita', 'fukushima', 'chuo', 'nishi', 'naniwa', 'tennoji'] },
    { id: 'east', name: '大阪東部', note: '城東・鶴見・生野・平野', wardIds: ['joto', 'tsurumi', 'higashinari', 'ikuno', 'hirano'] },
    { id: 'bay', name: '湾岸', note: '大阪港・南港周辺', wardIds: ['konohana', 'minato', 'taisho', 'suminoe'] },
    { id: 'south', name: '大阪南部', note: '阿倍野・住吉・西成', wardIds: ['nishinari', 'abeno', 'sumiyoshi', 'higashisumiyoshi'] },
  ];
  const ADJ_M = 60;
  const groupOfWardId = (wid) => { const g = GROUPS.find((x) => x.wardIds.includes(wid)); return g || null; };
  const groupById = (id) => GROUPS.find((g) => g.id === id) || null;
  function codesOf(group, wards) { const s = new Set(group.wardIds); return wards.filter((w) => s.has(w.wardId)).map((w) => w.wardCode); }

  function ringPts(w) { const s = []; for (const p of w.polygons) for (const r of [p.outer].concat(p.holes || [])) for (const q of r) s.push(q); return s; }
  /* 区ポリゴン頂点の最近接距離 < ADJ_M を隣接とみなす。 */
  function adjacency(wards) {
    const pts = new Map(wards.map((w) => [w.wardId, ringPts(w)]));
    const adj = new Map(wards.map((w) => [w.wardId, new Set()]));
    for (let i = 0; i < wards.length; i++) for (let j = i + 1; j < wards.length; j++) {
      const a = pts.get(wards[i].wardId), b = pts.get(wards[j].wardId); let hit = false;
      outer: for (const p of a) for (const q of b) { const dx = p[0] - q[0], dz = p[1] - q[1]; if (dx * dx + dz * dz < ADJ_M * ADJ_M) { hit = true; break outer; } }
      if (hit) { adj.get(wards[i].wardId).add(wards[j].wardId); adj.get(wards[j].wardId).add(wards[i].wardId); }
    }
    return adj;
  }
  /* 24区が欠落・重複なくどこか1グループに属し、各グループが隣接関係で連結であることを検証する。 */
  function validate(wards, groups) {
    groups = groups || GROUPS;
    const errors = [], seen = new Map(), ids = new Set(wards.map((w) => w.wardId));
    for (const g of groups) for (const id of g.wardIds) {
      if (!ids.has(id)) errors.push('unknown ward ' + id + ' in ' + g.id);
      if (seen.has(id)) errors.push('duplicate ' + id + ' in ' + seen.get(id) + ' & ' + g.id); else seen.set(id, g.id);
    }
    for (const id of ids) if (!seen.has(id)) errors.push('missing ' + id);
    const adj = adjacency(wards);
    for (const g of groups) {
      const set = new Set(g.wardIds), start = g.wardIds[0], vis = new Set([start]), st = [start];
      while (st.length) { const c = st.pop(); for (const n of (adj.get(c) || [])) if (set.has(n) && !vis.has(n)) { vis.add(n); st.push(n); } }
      if (vis.size !== set.size) errors.push('group ' + g.id + ' not contiguous');
    }
    return { ok: errors.length === 0, errors, groups: groups.length, wards: wards.length, sizes: groups.map((g) => g.wardIds.length) };
  }
  function bboxOf(group, wards) {
    const s = new Set(group.wardIds); let b = null;
    for (const w of wards) if (s.has(w.wardId)) b = b ? { minX: Math.min(b.minX, w.bbox.minX), maxX: Math.max(b.maxX, w.bbox.maxX), minZ: Math.min(b.minZ, w.bbox.minZ), maxZ: Math.max(b.maxZ, w.bbox.maxZ) } : Object.assign({}, w.bbox);
    return b;
  }
  /* 点が属するグループ（区ポリゴンの内外判定は呼び出し側が wardAt で行い、wardId を渡す）。 */
  const groupIdOfWard = (wardId) => { const g = groupOfWardId(wardId); return g ? g.id : null; };

  /* 世代トークン付きの選択状態機械。select(id) は旧世代を無効化(AbortController.abort)し、新世代だけが状態を書き換えられる。
   * loaded は GPU 上に実在する詳細区の集合。maxWards を超えたら選択グループ外から先に破棄する（再選択時のキャッシュ上限）。 */
  function createController(opt) {
    opt = opt || {};
    const wards = opt.wards || [], maxWards = opt.maxWards || 6;
    const st = { gen: 0, groupId: null, state: 'idle', error: null, loaded: new Set(), target: [], abort: null, loadedTotal: 0, disposedTotal: 0, selects: 0, cancelled: 0, firstBuildingMs: null, t0: null };
    const listeners = [];
    const emit = () => { for (const f of listeners) { try { f(snapshot()); } catch (e) { /* noop */ } } };
    function snapshot() { return { gen: st.gen, groupId: st.groupId, state: st.state, error: st.error, loaded: [...st.loaded], target: st.target.slice(), loadedTotal: st.loadedTotal, disposedTotal: st.disposedTotal, selects: st.selects, cancelled: st.cancelled, firstBuildingMs: st.firstBuildingMs }; }
    function select(groupId, now) {
      const g = groupById(groupId); if (!g) return null;
      if (st.abort) { try { st.abort.abort(); } catch (e) { /* noop */ } st.cancelled++; }
      st.gen++; st.selects++; st.groupId = g.id; st.state = 'loading'; st.error = null; st.firstBuildingMs = null; st.t0 = now == null ? null : now;
      st.target = codesOf(g, wards); st.abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const gen = st.gen;
      emit();
      return { gen, signal: st.abort && st.abort.signal, codes: st.target.slice(), isStale: () => gen !== st.gen };
    }
    function clear() {
      if (st.abort) { try { st.abort.abort(); } catch (e) { /* noop */ } st.cancelled++; st.abort = null; }
      st.gen++; st.groupId = null; st.state = 'idle'; st.error = null; st.target = []; emit();
    }
    const allowed = (code) => st.groupId != null && st.target.includes(code);
    /* 古い世代からの完了通知は無視（旧リクエストが遅れて描画されて残る競合の防止）。 */
    function markLoaded(code, gen, now) {
      if (gen !== st.gen || !allowed(code)) return false;
      if (!st.loaded.has(code)) { st.loaded.add(code); st.loadedTotal++; }
      if (st.firstBuildingMs == null && st.t0 != null && now != null) st.firstBuildingMs = Math.round(now - st.t0);
      if (st.target.every((c) => st.loaded.has(c)) && st.state === 'loading') st.state = 'ready';
      emit(); return true;
    }
    function markFailed(gen, err) { if (gen !== st.gen) return false; st.state = 'error'; st.error = String(err && err.message || err); emit(); return true; }
    function retry(now) { return st.groupId ? select(st.groupId, now) : null; }
    /* GPU から外すべき区: 選択グループ外すべて。加えて maxWards 超過分（保険）。 */
    function toDispose() {
      const out = [...st.loaded].filter((c) => !allowed(c));
      const keep = [...st.loaded].filter((c) => allowed(c));
      while (keep.length > maxWards) out.push(keep.pop());
      return out;
    }
    function markDisposed(code) { if (st.loaded.delete(code)) st.disposedTotal++; emit(); }
    /* 詳細ロード候補: 未選択なら空（起動時は 0 区）。 */
    const filterCandidates = (list) => (st.groupId == null ? [] : list.filter((w) => st.target.includes(w.wardCode)));
    return { select, clear, markLoaded, markFailed, retry, toDispose, markDisposed, filterCandidates, snapshot, allowed, onChange: (f) => listeners.push(f), get gen() { return st.gen; }, get groupId() { return st.groupId; } };
  }
  /* ドラッグ/ズーム中は高コスト処理を保留し、操作停止(settleMs)後に1回だけ実行する。 */
  function createIdleScheduler(run, settleMs) {
    let t = null, moving = false, deferred = 0;
    return {
      moveStart() { moving = true; clearTimeout(t); },
      moveEnd() { moving = false; clearTimeout(t); t = setTimeout(() => { t = null; run(); }, settleMs || 250); },
      request() { if (moving) { deferred++; return false; } run(); return true; },
      get deferred() { return deferred; }, get moving() { return moving; },
    };
  }
  const api = { GROUPS, groupById, groupOfWardId, groupIdOfWard, codesOf, adjacency, validate, bboxOf, createController, createIdleScheduler, ADJ_M };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LC219B = api;
})(typeof window !== 'undefined' ? window : globalThis);
