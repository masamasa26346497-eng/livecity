// Mission 135: Cesium 24区ビューア（建物 3D Tiles + 道路 + 河川の線/面）。127.0.0.1 専用のローカル確認用。
// 方針:
//  - 座標は Live City 公式投影 (config/areas/osaka-city.json の projection) の逆変換だけ。オフセット/回転/高さ補正は持たない
//    （tests/mission135-viewer.test.js が定数を config と突き合わせる）。道路・河川は PR #24 の mission37g と同じ LAYER_H。
//  - 区を選んだ時だけ、その区のデータを読む。切替で前区の primitive/tileset を破棄し、進行中の fetch は AbortController で取り消す。
//  - HTTP 404 は「未取得」と表示し、成功扱い・偽の地物の描画はしない。
(function () {
  'use strict';
  const PROJ = { clat: 34.604208, clon: 135.52502, mpd: 111320 };
  const COS_CLAT = Math.cos(PROJ.clat * Math.PI / 180);
  const toLon = (x) => PROJ.clon + x / (COS_CLAT * PROJ.mpd);
  const toLat = (z) => PROJ.clat - z / PROJ.mpd;
  const toCart = (x, z, h) => Cesium.Cartesian3.fromDegrees(toLon(x), toLat(z), h || 0);
  const LAYER_H = { waterways: 0.5, roads: 1.4 };     // mission37g-osaka-24ward-mvp.html と同値
  const C = { roadMajor: '#9fb4c9', roadMid: '#aabdce', roadLocal: '#bac8d7', waterLine: '#4f9fd6', waterArea: '#8dc3e8', ground: '#101826' };
  const KEYS = ['buildings', 'roads', 'waterLine', 'waterArea'];
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);

  const viewer = new Cesium.Viewer('cesiumContainer', {
    baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
    animation: false, timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false, requestRenderMode: false,
  });
  const scene = viewer.scene;
  scene.globe.baseColor = Cesium.Color.fromCssColorString(C.ground);
  scene.globe.enableLighting = false; scene.skyAtmosphere.show = false; scene.fog.enabled = false;
  scene.backgroundColor = Cesium.Color.fromCssColorString('#050a18');
  viewer.cesiumWidget.creditContainer.style.display = 'none';

  const visible = { buildings: true, roads: true, waterLine: true, waterArea: true };
  const S = {
    ready: false, wards: [], ward: null, gen: 0, aborted: 0, staleDiscards: 0, loads: 0,
    layers: {}, errors: [], releases: 0,
  };
  let cur = null; // { wardId, ctrl, groups:{key:[primitive]}, tileset }

  function setStatus(key, cls, text) {
    S.layers[key] = { cls, text };
    const el = $('s-' + key); if (el) { el.className = 'st ' + cls; el.textContent = ' ' + text; }
  }
  function notice() {
    const miss = KEYS.filter((k) => S.layers[k] && (S.layers[k].cls === 'missing' || S.layers[k].cls === 'error'));
    $('notice').textContent = miss.length ? '表示できないレイヤー: ' + miss.map((k) => k + '=' + S.layers[k].text).join(' / ') + '\n（欠落データは描かず、偽の地物は出しません）' : '';
  }
  function applyShow(group, on) { for (const p of group || []) if (p && !p.isDestroyed()) p.show = !!on; }

  function unload() {
    if (!cur) return;
    cur.ctrl.abort(); S.aborted++;
    for (const k of KEYS) for (const p of cur.groups[k]) { try { scene.primitives.remove(p); } catch (e) { /* noop */ } }
    cur.groups = null; cur = null; S.releases++;
  }

  async function getJson(url, signal) {
    const r = await fetch(url, { signal, cache: 'no-store' });
    if (r.status === 404) return { status: 404 };
    if (!r.ok) return { status: r.status };
    return { status: r.status, json: await r.json() };
  }

  const polyMat = (css, a) => Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString(css).withAlpha(a) });
  function addLines(coll, feats, styleOf, h) {
    let n = 0;
    for (const f of feats) {
      const st = styleOf(f); if (!st || !Array.isArray(f.p) || f.p.length < 2) continue;
      coll.add({ positions: f.p.map((pt) => toCart(pt[0], pt[1], h)), width: st.width, material: st.material });
      n++;
    }
    return n;
  }
  function areaPrimitive(feats, css, alpha, h) {
    const inst = feats.filter((f) => Array.isArray(f.p) && f.p.length >= 3).map((f) => new Cesium.GeometryInstance({
      geometry: new Cesium.PolygonGeometry({ polygonHierarchy: new Cesium.PolygonHierarchy(f.p.map((pt) => toCart(pt[0], pt[1], 0))), height: h, perPositionHeight: false, vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT }),
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(css).withAlpha(alpha)) },
    }));
    if (!inst.length) return { prim: null, count: 0 };
    return { prim: new Cesium.Primitive({ geometryInstances: inst, appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }), asynchronous: false }), count: inst.length };
  }

  async function loadWard(wardId) {
    unload();
    const my = ++S.gen; S.loads++;
    const ctrl = new AbortController();
    const rec = { wardId, ctrl, groups: { buildings: [], roads: [], waterLine: [], waterArea: [] }, tileset: null };
    cur = rec; S.ward = wardId; S.layers = {};
    for (const k of KEYS) setStatus(k, 'loading', '読み込み中');
    notice();
    const stale = () => my !== S.gen || ctrl.signal.aborted;
    const base = 'ext-3dtiles/' + wardId;
    const add = (key, p) => { scene.primitives.add(p); p.show = visible[key]; rec.groups[key].push(p); };
    const http = {};
    const guard = async (key, fn) => {
      try { await fn(); } catch (e) {
        if (e && e.name === 'AbortError') return;
        if (stale()) return;
        S.errors.push(key + ': ' + (e && e.message || e)); setStatus(key, 'error', 'エラー: ' + String(e && e.message || e).slice(0, 80));
      }
    };
    const buildings = guard('buildings', async () => {
      const url = base + '25/tileset.json';
      const head = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      http.tileset = head.status;
      if (head.status === 404) { if (!stale()) setStatus('buildings', 'missing', '未取得（tileset HTTP 404）'); return; }
      if (!head.ok) throw new Error('tileset HTTP ' + head.status);
      const ts = await Cesium.Cesium3DTileset.fromUrl(url, { maximumScreenSpaceError: 8 });
      if (stale()) { ts.destroy(); S.staleDiscards++; return; }
      scene.primitives.add(ts); ts.show = visible.buildings; rec.groups.buildings.push(ts); rec.tileset = ts;
      setStatus('buildings', 'ready', '表示中（3D Tiles）');
    });
    const roads = guard('roads', async () => {
      const r = await getJson(base + '/layers/roads.json', ctrl.signal); http.roads = r.status;
      if (stale()) { S.staleDiscards++; return; }
      if (r.status === 404) { setStatus('roads', 'missing', '未取得（HTTP 404）'); return; }
      if (!r.json) throw new Error('roads HTTP ' + r.status);
      const coll = new Cesium.PolylineCollection();
      const styleOf = (f) => (f.kind && f.kind !== 'line' ? null : { width: f.tier === 'major' ? 4.5 : f.tier === 'mid' ? 3 : 1.8, material: polyMat(f.tier === 'major' ? C.roadMajor : f.tier === 'mid' ? C.roadMid : C.roadLocal, 0.9) });
      const n = addLines(coll, r.json.features || [], styleOf, LAYER_H.roads);
      add('roads', coll); setStatus('roads', n ? 'ready' : 'missing', n ? '表示中（' + n + '本）' : '地物0件');
    });
    const water = guard('waterLine', async () => {
      const w = await getJson(base + '/layers/waterways.json', ctrl.signal); http.waterways = w.status;
      const s = await getJson(base + '/layers/water-surface.json', ctrl.signal); http['water-surface'] = s.status;
      if (stale()) { S.staleDiscards++; return; }
      const wf = (w.json && w.json.features) || [], sf = (s.json && s.json.features) || [];
      if (w.status === 404) setStatus('waterLine', 'missing', '未取得（waterways HTTP 404）');
      else if (!w.json) throw new Error('waterways HTTP ' + w.status);
      else {
        const coll = new Cesium.PolylineCollection();
        const n = addLines(coll, wf.filter((f) => f.kind === 'line'), (f) => ({ width: f.waterClass === 'canal' ? 6 : 4.5, material: polyMat(C.waterLine, 1) }), LAYER_H.waterways);
        add('waterLine', coll); setStatus('waterLine', n ? 'ready' : 'missing', n ? '表示中（' + n + '本）' : '線0件');
      }
      const areas = [];
      if (w.json) areas.push(...wf.filter((f) => f.kind === 'area'));
      areas.push(...sf.filter((f) => f.kind === 'area'));
      if (!areas.length) { setStatus('waterArea', 'missing', (w.status === 404 && s.status === 404) ? '未取得（HTTP 404）' : '面0件'); return; }
      const { prim, count } = areaPrimitive(areas, C.waterArea, 0.95, LAYER_H.waterways);
      if (prim) add('waterArea', prim);
      setStatus('waterArea', count ? 'ready' : 'missing', count ? '表示中（' + count + '面）' : '面0件');
    });
    await Promise.all([buildings, roads, water]);
    if (!stale()) { rec.http = http; S.http = http; notice(); scene.requestRender(); }
  }

  function bboxOf(wardId) { const w = S.wards.find((x) => x.wardId === wardId); return w && w.bbox; }
  /** 真上から区 bbox 中心を見る（カメラのみ。データには一切触れない）。 */
  function lookAt(wardId, height) {
    const b = bboxOf(wardId); if (!b) return false;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(toLon(cx), toLat(cz), height || 650), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 } });
    return true;
  }
  function count(type) { let n = 0; for (let i = 0; i < scene.primitives.length; i++) if (scene.primitives.get(i) instanceof type) n++; return n; }

  async function selectWard(id) { await loadWard(id); lookAt(id, 650); return S.layers; }
  function setLayer(key, on) {
    if (!KEYS.includes(key)) return false;
    visible[key] = !!on; if ($('t-' + key)) $('t-' + key).checked = !!on;
    if (cur) applyShow(cur.groups[key], on);
    scene.requestRender(); return true;
  }

  window.__m135 = {
    state: S, selectWard, setLayer, lookAt, KEYS,
    tilesReady() { const ts = cur && cur.tileset; return !!ts && ts.tilesLoaded && ts.ready; },
    resources() { return { tilesets: count(Cesium.Cesium3DTileset), polylineCollections: count(Cesium.PolylineCollection), areaPrimitives: count(Cesium.Primitive), total: scene.primitives.length }; },
    shown(key) { return !!cur && cur.groups[key].some((p) => !p.isDestroyed() && p.show); },
    tilesetCenter() {
      const ts = cur && cur.tileset; if (!ts) return null;
      const c = Cesium.Cartographic.fromCartesian(ts.boundingSphere.center);
      return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude), h: c.height };
    },
    expectedCenter(wardId) { const b = bboxOf(wardId); if (!b) return null; return { lon: toLon((b.minX + b.maxX) / 2), lat: toLat((b.minZ + b.maxZ) / 2) }; },
    proj: PROJ,
  };

  (async () => {
    try {
      const idx = await (await fetch('index.json', { cache: 'no-store' })).json();
      S.wards = idx.wards;
      const sel = $('ward');
      for (const w of S.wards) {
        const o = document.createElement('option'); o.value = w.wardId;
        const have = Object.entries(w.available).filter(([, v]) => v).map(([k]) => k).join('+') || '未取得';
        o.textContent = w.wardName + '（' + have + '）'; sel.appendChild(o);
      }
      sel.addEventListener('change', () => selectWard(sel.value));
      for (const k of KEYS) $('t-' + k).addEventListener('change', (e) => setLayer(k, e.target.checked));
      S.ready = true;
      const first = q.get('ward') || (S.wards.find((w) => w.available.buildings) || S.wards[0] || {}).wardId;
      if (first) { sel.value = first; await selectWard(first); }
    } catch (e) { S.errors.push('init: ' + (e && e.message || e)); $('notice').textContent = '初期化エラー: ' + (e && e.message || e); }
  })();
})();
