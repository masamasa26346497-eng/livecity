// Mission 219B: 大阪24区の「地域グループ選択 → 選択範囲だけ詳細3D遅延ロード」の純ロジック。
// DOM / Cesium / ネットワークに依存しない(Node のテストと、37G HTML の ?wardgroups=1 の両方から使う)。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LC219B = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── グループ定義の検証: 24区が欠落・重複なく1グループに属し、各グループが実ポリゴン上で連結していること ──
  function ringsOf(w) { const o = []; for (const p of w.polygons || []) o.push(p.outer); return o; }
  function adjacent(a, b, tolM) {
    const tol2 = tolM * tolM;
    for (const ra of ringsOf(a)) for (const rb of ringsOf(b)) for (const p of ra) for (const q of rb) {
      const dx = p[0] - q[0], dz = p[1] - q[1];
      if (dx * dx + dz * dz < tol2) return true;
    }
    return false;
  }
  function validateGroups(def, wards, opt) {
    const skipAdj = !!(opt && opt.skipAdjacency);
    const tol = (opt && opt.tolM) || 60, problems = [];
    const byCode = new Map(wards.map((w) => [w.wardCode, w]));
    const seen = new Map();
    for (const g of def.groups) {
      for (const c of g.wards) {
        if (!byCode.has(c)) problems.push('未知の区コード ' + c + ' (' + g.id + ')');
        if (seen.has(c)) problems.push('重複: ' + c + ' が ' + seen.get(c) + ' と ' + g.id + ' に所属');
        seen.set(c, g.id);
      }
    }
    for (const w of wards) if (!seen.has(w.wardCode)) problems.push('欠落: ' + w.wardCode + ' ' + w.wardName + ' がどのグループにも属さない');
    const connectivity = {};
    if (!skipAdj) for (const g of def.groups) {
      const ws = g.wards.map((c) => byCode.get(c)).filter(Boolean);
      if (!ws.length) { problems.push(g.id + ': 区が空'); continue; }
      const reach = new Set([ws[0].wardCode]); let grew = true;
      while (grew) { grew = false; for (const a of ws) for (const b of ws) if (reach.has(a.wardCode) && !reach.has(b.wardCode) && adjacent(a, b, tol)) { reach.add(b.wardCode); grew = true; } }
      connectivity[g.id] = reach.size === ws.length;
      if (reach.size !== ws.length) problems.push(g.id + ': 地理的に連結していない');
    }
    return { ok: problems.length === 0, problems, connectivity, groupCount: def.groups.length, assigned: seen.size };
  }
  const groupOfCode = (def, code) => def.groups.find((g) => g.wards.indexOf(code) >= 0) || null;
  function unionBBox(wards, codes) {
    const set = new Set(codes);
    return wards.filter((w) => set.has(w.wardCode)).reduce((a, w) => ({ minX: Math.min(a.minX, w.bbox.minX), maxX: Math.max(a.maxX, w.bbox.maxX), minZ: Math.min(a.minZ, w.bbox.minZ), maxZ: Math.max(a.maxZ, w.bbox.maxZ) }),
      { minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9 });
  }

  // ── 選択状態(世代トークン)。select/clear のたびに token が進み、古い非同期結果は isStale で破棄される ──
  function createSelector(def) {
    let token = 0, selected = null, allowed = new Set();
    const log = { selects: 0, clears: 0, switches: 0 };
    return {
      get token() { return token; },
      get selected() { return selected; },
      get allowed() { return allowed; },
      log,
      allows(code) { return allowed.has(code); },
      select(id) {
        const g = def.groups.find((x) => x.id === id);
        if (!g) throw new Error('unknown group ' + id);
        if (selected && selected.id !== id) log.switches++;
        log.selects++; token++; selected = g; allowed = new Set(g.wards);
        return token;
      },
      clear() { log.clears++; token++; selected = null; allowed = new Set(); return token; },
      isStale(t) { return t !== token; },
    };
  }

  // ── ネットワーク要求の分類(診断・自動アサート用)。ward 詳細(LOD1/LOD2 建物)と軽量俯瞰(LOD0)とメタを分ける ──
  function classifyUrl(url) {
    let p; try { p = new URL(url, 'http://x/').pathname; } catch (e) { p = String(url); }
    if (/\/_lod0\/|citylod0|city-lod0|\/_city\//i.test(p)) return { kind: 'lod0', ward: null };
    if (/\/lod2-preview\//.test(p)) return { kind: /\.(glb|b3dm|cmpt|i3dm)$/i.test(p) ? 'lod2-glb' : /tileset\.json$/.test(p) ? 'lod2-tileset' : 'lod2-meta', ward: null };
    const m = /\/ext-3dtiles\/([a-z0-9-]+)\/(.*)$/.exec(p);
    if (!m || m[1].charAt(0) === '_') return { kind: 'other', ward: null };
    const rest = m[2];
    if (/^layers\//.test(rest)) return { kind: 'vec', ward: m[1] };
    if (/\.(glb|b3dm|cmpt|i3dm)$/i.test(rest)) return { kind: 'detail-glb', ward: m[1] };
    if (/(^|\/)tileset\.json$/.test(rest) || /^tiles\/.*\.json$/.test(rest)) return { kind: 'detail-tileset', ward: m[1] };
    if (/^(source|build-report|manifest)\.json$/.test(rest)) return { kind: 'detail-meta', ward: m[1] };
    return { kind: 'detail-other', ward: m[1] };
  }
  function summarizeNet(urls) {
    const o = { detailGlb: 0, detailTileset: 0, detailMeta: 0, lod0: 0, lod2Glb: 0, lod2Tileset: 0, vec: 0, wardsWithDetail: [] };
    const wards = new Set();
    for (const u of urls) {
      const c = classifyUrl(u);
      if (c.kind === 'detail-glb') { o.detailGlb++; wards.add(c.ward); }
      else if (c.kind === 'detail-tileset') { o.detailTileset++; wards.add(c.ward); }
      else if (c.kind === 'detail-meta') o.detailMeta++;
      else if (c.kind === 'lod0') o.lod0++;
      else if (c.kind === 'lod2-glb') o.lod2Glb++;
      else if (c.kind === 'lod2-tileset') o.lod2Tileset++;
      else if (c.kind === 'vec') { o.vec++; wards.add(c.ward); }
    }
    o.wardsWithDetail = [...wards].sort();
    return o;
  }
  // 起動直後の自動アサート: 詳細 GLB / tileset / LOD2 / 道路レイヤーが 0 件であること(LOD0 とメタ JSON は可)
  function assertNoInitialDetail(urls) {
    const s = summarizeNet(urls);
    const n = s.detailGlb + s.detailTileset + s.lod2Glb + s.lod2Tileset + s.vec;
    return { pass: n === 0, detailRequests: n, summary: s };
  }

  return { validateGroups, adjacent, groupOfCode, unionBBox, createSelector, classifyUrl, summarizeNet, assertNoInitialDetail };
});
