// Mission 138: 実フットプリント押出し建物レイヤー（37G 本線ページ用。?fp=1 かつ localhost / 127.0.0.1 のときだけ使われる）。
// 入力: <base>manifest.json と <base>tile_{tx}_{tz}.json（旧 Live City の建物タイル。id=gml:id 由来の canonicalId, fp=[[x,z]...], z0, h, repX/repZ）。
// 方針:
//  - 座標は呼び出し側が渡す toCart（37G の liveCityProjection と同一定数）だけで経緯度化する。オフセット/回転/高さ補正は持たない。
//  - manifest.coordinateConvention が 'znorth-neg-v1' 以外なら描かずに失敗にする。欠落タイルは failedTiles に数え、ready にしない。
//  - canonicalId は入力の id をそのまま GeometryInstance.id に使う（採番しない）。
//  - isStale() が真になった時点で fetch を止め、作った primitive は destroy() で scene から取り除く（区切替で残らない）。
(function (root) {
  'use strict';
  const CONVENTION = 'znorth-neg-v1';
  const FILE_RE = /^tile_-?\d+_-?\d+\.json$/;

  /** 連続重複点・閉じ点を除いた外周を返す。3 点未満は null。 */
  function cleanRing(fp) {
    if (!Array.isArray(fp)) return null;
    let r = fp.filter((p, i, a) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && (i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]));
    if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
    if (r.length < 3) return null;
    let ar = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; ar += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(ar) < 1 ? null : r;
  }
  /** 建物 1 棟 → 描画仕様。無効（id 無し・高さ無し・面積ほぼ 0）は null。 */
  function buildingSpec(b) {
    if (!b || typeof b.id !== 'string' || !/^bldg_/.test(b.id) || !(b.h > 0)) return null;
    const ring = cleanRing(b.fp); if (!ring) return null;
    const z0 = Number.isFinite(b.z0) ? b.z0 : 0;
    return { id: b.id, ring, z0, h: b.h, top: z0 + Math.max(b.h, 1), repX: b.repX, repZ: b.repZ, usage: b.usage == null ? null : b.usage };
  }
  const isSentinelHeight = (h) => h === 29997 || h === 29999 || h === 30000;
  function tone(h) { return h > 30 ? '#dfe8f3' : '#c3cfdd'; }

  async function getJson(url, signal, fetchImpl) {
    const r = await fetchImpl(url, { signal, cache: 'no-store' });
    if (r.status === 404) return { status: 404 };
    if (!r.ok) return { status: r.status };
    return { status: r.status, json: await r.json() };
  }

  /**
   * @param {{Cesium:object, scene:object, toCart:function, base:string, isStale:function, signal?:AbortSignal, fetchImpl?:function,
   *          concurrency?:number, accent?:string, onProgress?:function}} o
   */
  function create(o) {
    const Cesium = o.Cesium, scene = o.scene, fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch.bind(root) : null);
    const stale = () => (o.isStale ? !!o.isStale() : false) || !!(o.signal && o.signal.aborted);
    const S = { state: 'idle', declared: null, tiles: 0, loadedTiles: 0, failedTiles: 0, buildings: 0, skipped: 0, sentinelHeights: 0, ward: null, wardCode: null, bounds: null, http: {}, error: null };
    const prims = [], byId = new Map(), primOf = new Map();
    let selected = null, destroyed = false;

    async function load() {
      S.state = 'loading';
      const m = await getJson(o.base + 'manifest.json', o.signal, fetchImpl); S.http.manifest = m.status;
      if (stale()) { S.state = 'stale'; return S; }
      if (m.status === 404) { S.state = 'missing'; return S; }
      if (!m.json) throw new Error('footprint manifest HTTP ' + m.status);
      if (m.json.coordinateConvention !== CONVENTION) throw new Error('footprint coordinateConvention mismatch: ' + m.json.coordinateConvention);
      const list = tileFiles(m.json);
      if (!list.length) throw new Error('footprint manifest has no tile list');
      S.declared = m.json.totalBuildings; S.tiles = list.length; S.ward = m.json.ward || null; S.wardCode = m.json.wardCode || null; S.bounds = m.json.bounds || null;
      let next = 0;
      const worker = async () => {
        while (next < list.length && !stale()) {
          const file = list[next++];
          let r; try { r = await getJson(o.base + file, o.signal, fetchImpl); } catch (e) { if (stale()) return; S.failedTiles++; continue; }
          if (stale()) return;
          if (!r.json) { S.failedTiles++; continue; }
          const inst = [];
          for (const b of r.json.buildings || []) {
            const sp = buildingSpec(b);
            if (!sp) { S.skipped++; continue; }
            if (byId.has(sp.id)) { S.skipped++; continue; }   // 同じ区内の重複 ID は 1 棟目だけ（二重表示を防ぐ）
            if (isSentinelHeight(sp.h)) S.sentinelHeights++;
            inst.push(new Cesium.GeometryInstance({
              id: sp.id,
              geometry: new Cesium.PolygonGeometry({ polygonHierarchy: new Cesium.PolygonHierarchy(sp.ring.map((p) => o.toCart(p[0], p[1], 0))), height: sp.z0, extrudedHeight: sp.top, vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT }),
              attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(tone(sp.h))) },
            }));
            byId.set(sp.id, sp);
          }
          S.loadedTiles++;
          if (inst.length) {
            const prim = new Cesium.Primitive({ geometryInstances: inst, appearance: new Cesium.PerInstanceColorAppearance({ flat: false, translucent: false }), asynchronous: true, allowPicking: true });
            for (const i of inst) primOf.set(i.id, prim);
            scene.primitives.add(prim); prims.push(prim); S.buildings += inst.length;
          }
          if (o.onProgress) o.onProgress(S);
        }
      };
      await Promise.all(Array.from({ length: o.concurrency || 4 }, worker));
      if (stale()) { S.state = 'stale'; return S; }
      if (S.failedTiles || S.loadedTiles !== S.tiles) { S.state = 'incomplete'; S.error = 'footprint tiles incomplete: ' + S.loadedTiles + '/' + S.tiles; return S; }
      S.state = 'ready';
      return S;
    }
    function tileFiles(man) {
      if (Array.isArray(man.tiles) && man.tiles.length) return man.tiles.map((t) => (typeof t === 'string' ? t : t && t.file)).filter((f) => typeof f === 'string' && FILE_RE.test(f));
      return [];
    }
    function ready() { return prims.length > 0 && prims.every((p) => p.isDestroyed() || p.ready); }
    function setShow(on) { for (const p of prims) if (!p.isDestroyed()) p.show = !!on; }
    function unselect() {
      if (selected) {
        const sp = byId.get(selected), p = primOf.get(selected);
        if (sp && p && !p.isDestroyed()) { try { const a = p.getGeometryInstanceAttributes(selected); if (a) a.color = Cesium.ColorGeometryInstanceAttribute.toValue(Cesium.Color.fromCssColorString(tone(sp.h))); } catch (e) { /* 未 ready */ } }
      }
      selected = null;
    }
    function select(id) {
      unselect();
      const p = primOf.get(id); if (!p || p.isDestroyed()) return false;
      try { const a = p.getGeometryInstanceAttributes(id); if (a) a.color = Cesium.ColorGeometryInstanceAttribute.toValue(Cesium.Color.fromCssColorString(o.accent || '#2f7bff')); } catch (e) { return false; }
      selected = id; return true;
    }
    /** scene.pick の結果が、この層の建物なら canonicalId を返す。 */
    function idOfPick(picked) {
      if (!picked || typeof picked.id !== 'string' || !/^bldg_/.test(picked.id)) return null;
      return primOf.has(picked.id) && (!picked.primitive || prims.includes(picked.primitive)) ? picked.id : null;
    }
    function destroy() {
      if (destroyed) return; destroyed = true;
      selected = null;
      for (const p of prims.splice(0)) { try { scene.primitives.remove(p); } catch (e) { /* noop */ } }
      byId.clear(); primOf.clear(); S.state = 'destroyed';
    }
    return { load, destroy, ready, setShow, select, unselect, idOfPick, byId, stats: S, get primitives() { return prims; } };
  }

  const api = { CONVENTION, cleanRing, buildingSpec, isSentinelHeight, tone, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LC138 = api;
})(typeof window !== 'undefined' ? window : globalThis);
