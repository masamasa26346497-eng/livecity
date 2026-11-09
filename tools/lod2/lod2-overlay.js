// Mission 161: Live City(37G) 用 LOD2 オーバーレイ・アダプタ(localhost 限定 opt-in)。
// 37G HTML が `?lod2=1`(localhost のみ)のとき /lod2-preview/overlay.js として読み込み、window.LC152.attach({Cesium, viewer}) を呼ぶ。
// 役割:
//   1. temp/lod2-preview の LOD2 3D Tiles(実PLATEAU大阪2025の LOD2 建物)を同一ビューアに追加する。
//   2. LOD2 建物の足跡(凸包)で、他の全 3D Tileset(=既存 LOD1)を ClippingPolygon で切り抜き、二重描画/z-fighting を防ぐ。
//      切り抜きが使えない Cesium では LOD2 を追加しない(二重描画を許容しない)。
//   3. tile 固有イベント(tileVisible/tileLoad/tileFailed)と状態を window.__lc152 に出す(tilesLoaded だけで成功としない)。
// 地名・駅・道路・河川・既存 LOD1 の描画コードには触れない。
(function () {
  'use strict';
  const BASE = (document.currentScript && document.currentScript.src ? document.currentScript.src.replace(/[^/]*$/, '') : '/lod2-preview/');
  const state = {
    status: 'init', exclusion: null, lod2Buildings: 0, footprints: 0, clippedTilesets: 0, error: null,
    tileVisible: 0, tileLoad: 0, tileFailed: 0, tilesetReady: false, bbox: null, report: null, textureRendered: false,
  };
  window.__lc152 = { state };
  // Mission 162: 失敗理由をページにも日本語で出す(秘密情報なし)。
  function showFailure(msg) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:#7a1f1f;color:#fff;font:13px/1.5 sans-serif;padding:8px 12px;border-radius:6px;max-width:400px';
    d.innerHTML = '<b>LOD2 を表示できません</b><br>' + String(msg).replace(/[<>&]/g, '') + '<br><a style="color:#9cf" href="/__lod2/diag.json" target="_blank">診断情報(diag.json)</a>';
    document.body.appendChild(d);
  }

  function polygonFor(Cesium, hull) {
    const pos = Cesium.Cartesian3.fromDegreesArray(hull.flatMap((p) => [p[0], p[1]]));
    return new Cesium.ClippingPolygon({ positions: pos });
  }

  async function attach({ Cesium, viewer }) {
    const scene = viewer.scene;
    try {
      if (!Cesium.ClippingPolygonCollection || !Cesium.ClippingPolygon) {
        state.status = 'refused'; state.exclusion = 'unsupported';
        state.error = 'Cesium ' + Cesium.VERSION + ' に ClippingPolygonCollection が無いため、LOD1 との二重描画を避けられず LOD2 を追加しません';
        showFailure(state.error);
        return;
      }
      const getJ = (n) => fetch(BASE + n).then((r) => { if (!r.ok) throw new Error(n + ' が HTTP ' + r.status + '(生成物がありません。生成工程が失敗した可能性)'); return r.json(); });
      const [report, fp] = await Promise.all([getJ('report.json'), getJ('footprints.json')]);
      state.report = { converted: report.converted, lod1Remaining: report.lod1Remaining, glbBytes: report.glbBytes, meshes: report.meshes, source: report.source };
      state.centroid = [fp.footprints.reduce((n, f) => n + f.hull[0][0], 0) / fp.footprints.length, fp.footprints.reduce((n, f) => n + f.hull[0][1], 0) / fp.footprints.length];
      state.bbox = report.bbox; state.lod2Buildings = fp.footprints.length; state.footprints = fp.footprints.length;
      const ts = await Cesium.Cesium3DTileset.fromUrl(BASE + 'tileset.json');
      ts.tileVisible.addEventListener(() => { state.tileVisible++; });
      ts.tileLoad.addEventListener(() => { state.tileLoad++; scene.requestRender(); });
      ts.tileFailed.addEventListener((e) => { state.tileFailed++; state.error = 'tileFailed: ' + (e && e.message); showFailure('タイル読み込み失敗: ' + (e && e.message)); });
      ts.allTilesLoaded.addEventListener(() => scene.requestRender());

      const polys = fp.footprints.map((f) => polygonFor(Cesium, f.hull));
      const clipped = new WeakSet();
      const applyClip = () => {
        const prims = scene.primitives;
        for (let i = 0; i < prims.length; i++) {
          const p = prims.get(i);
          if (p === ts || !(p instanceof Cesium.Cesium3DTileset) || clipped.has(p)) continue;
          p.clippingPolygons = new Cesium.ClippingPolygonCollection({ polygons: polys, inverse: false });
          clipped.add(p); state.clippedTilesets++;
        }
        scene.requestRender();
      };
      applyClip();
      scene.postRender.addEventListener(() => { if (scene.primitives.length !== (applyClip._n || 0)) { applyClip._n = scene.primitives.length; applyClip(); } });
      state.exclusion = 'clipping-polygon(足跡の凸包。LOD2 建物の LOD1 のみ除外。LOD2 化していない 3 棟等は残る)';
      scene.primitives.add(ts);
      state.tilesetReady = true; state.status = 'ready';

      // 凡例(限定表示であることを明示)
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:rgba(20,24,32,.88);color:#fff;font:12px/1.5 sans-serif;padding:6px 10px;border-radius:6px;max-width:340px';
      d.innerHTML = '<b>LOD2 プレビュー(限定)</b><br>実 PLATEAU 大阪2025 の LOD2 ' + fp.footprints.length + ' 棟のみ。他の建物は LOD1。色は頂点色のみ(テクスチャ未対応)。' +
        '<br><button id="lc152-fly" style="margin-top:4px">LOD2 建物へ移動</button> <label><input id="lc152-show" type="checkbox" checked> LOD2表示</label><br>出典: 国土交通省 PLATEAU(3D都市モデル 大阪市 2025)';
      document.body.appendChild(d);
      const fly = () => viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(state.bbox.west - 0.002, state.bbox.south - 0.002, state.bbox.east + 0.002, state.bbox.north + 0.002), duration: 1.5 });
      d.querySelector('#lc152-fly').onclick = fly;
      d.querySelector('#lc152-show').onchange = (e) => { ts.show = e.target.checked; scene.requestRender(); };
      Object.assign(window.__lc152, {
        tileset: ts, fly, setShow(v) { ts.show = !!v; scene.requestRender(); },
        // 実描画した LOD2 の一棟中心へカメラを置く(E2E 用・決定的)
        lookAtFirst(range = 330, pitchDeg = -38, at = null) {
          // LOD2 足跡の重心を注視点にする(bbox 中心は建物が疎な場所になりうる)。
          viewer.camera.cancelFlight();
          const dLat = (range * Math.cos(Cesium.Math.toRadians(-pitchDeg))) / 111000, h = range * Math.sin(Cesium.Math.toRadians(-pitchDeg)) + 10;
          viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees((at || state.centroid)[0], (at || state.centroid)[1] - dLat, h), orientation: { heading: 0, pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 } });
          scene.requestRender();
        },
        camera() { const c = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC); return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude), h: c.height, pitchDeg: Cesium.Math.toDegrees(viewer.camera.pitch) }; },
        stats() { const s = ts.statistics; return { numberOfTilesWithContentReady: s.numberOfTilesWithContentReady, numberOfTrianglesSelected: s.numberOfTrianglesSelected, geometryByteLength: s.geometryByteLength, selected: ts._selectedTiles ? ts._selectedTiles.length : null }; },
      });
      // Mission 169: 大阪全域俯瞰 + LOD2 の集中地点へのワンクリック移動 + データ接続状況(日本語)。
      // 地点名は「LOD2 地点 N」とし、駅名・町名・区名と混同させない(座標と棟数のみを示す)。
      const OSAKA = { west: 135.30, south: 34.55, east: 135.62, north: 34.82 }; // 大阪市24区を含む概略範囲(表示用)
      const overview = () => viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(OSAKA.west, OSAKA.south, OSAKA.east, OSAKA.north), duration: 1.5 });
      const cells = new Map();
      for (const f of fp.footprints) {
        const k = Math.floor(f.hull[0][0] / 0.01) + ',' + Math.floor(f.hull[0][1] / 0.01);
        const c = cells.get(k) || { n: 0, sx: 0, sy: 0 }; c.n++; c.sx += f.hull[0][0]; c.sy += f.hull[0][1]; cells.set(k, c);
      }
      const spots = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 10).map((c, i) => ({ no: i + 1, n: c.n, lon: c.sx / c.n, lat: c.sy / c.n }));
      state.spots = spots;
      const goSpot = (s) => window.__lc152.lookAtFirst(450, -40, [s.lon, s.lat]);
      const panel = document.createElement('div');
      panel.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;background:rgba(20,24,32,.9);color:#fff;font:12px/1.5 sans-serif;padding:8px 10px;border-radius:6px;max-width:330px;max-height:80vh;overflow:auto';
      panel.innerHTML = '<b>LOD2 ナビ</b><div style="margin:4px 0"><button id="lc152-ov">大阪24区を俯瞰</button></div>' +
        '<div style="opacity:.8">LOD2 のある場所(大阪2025 全 ' + fp.footprints.length + ' 棟。駅名・町名ではなく座標の集中地点です)</div>' +
        spots.map((s) => '<div><button data-s="' + s.no + '">LOD2 地点' + s.no + '</button> ' + s.n + '棟 (' + s.lon.toFixed(3) + ', ' + s.lat.toFixed(3) + ')</div>').join('') +
        '<hr style="opacity:.3"><b>表示の状態</b><div id="lc152-data">確認中…</div>' +
        '<div style="opacity:.75;margin-top:4px">凡例: LOD2=屋根・壁つき実形状(このプレビューで追加)/ LOD1=箱型(24区データ接続時のみ)/ 未接続=下の ✕ の項目</div>';
      document.body.appendChild(panel);
      panel.querySelector('#lc152-ov').onclick = overview;
      panel.querySelectorAll('button[data-s]').forEach((b) => { b.onclick = () => goSpot(spots[Number(b.dataset.s) - 1]); });
      fetch('/__lod2/diag.json', { cache: 'no-store' }).then((r) => r.json()).then((dg) => {
        const rows = [['24区 LOD1', dg.data.lod1Wards], ['駅', dg.data.stations], ['路線・運営会社', dg.data.railOperators], ['地名', dg.data.towns], ['道路', dg.data.roads], ['河川', dg.data.rivers]];
        state.data = dg.data; state.extCandidates = dg.extCandidates; state.extAttach = dg.extAttach;
        let h = rows.map(([n, v]) => '<div>' + (v.ok ? '✓ ' : '✕ ') + '<b>' + n + '</b>: ' + String(v.msg).replace(/[<>&]/g, '') + '</div>').join('');
        const cand = (dg.extCandidates || []).filter((c) => c.hasIndexJson || c.is45dRoot);
        if (!dg.data.lod1Wards.ok && cand.length) h += '<div style="color:#fc8">24区 LOD1 の候補を検出: ' + cand.map((c) => c.dir).join(', ') + '(--ext-root で指定)</div>';
        document.getElementById('lc152-data').innerHTML = h;
      }).catch(() => { document.getElementById('lc152-data').textContent = '診断情報(diag.json)を取得できません'; });
      // Mission 170: 上部の「建物 / 表示タイル」は 37G の旧タイルだけを数え、このオーバーレイの LOD2 は含まない。ここに別枠で実数を出す。
      const live = document.createElement('div');
      live.style.cssText = 'margin:4px 0;padding:4px 6px;background:rgba(255,255,255,.08);border-radius:4px';
      panel.insertBefore(live, panel.children[1]);
      const lod1Info = () => {
        const ea = state.extAttach; const c = ea && ea.chosen;
        return c ? 'LOD1(24区): ' + c.wards + '区接続 [' + c.kind + (c.verified ? '' : '・未検証') + ']' + (c.buildingsKnown ? ' ' + c.buildings + '棟' : '') : 'LOD1(24区): 未接続';
      };
      const refreshLive = () => {
        const s = ts.statistics; const cam = window.__lc152.camera();
        live.innerHTML = '<b>このプレビューの実数</b> (画面上部の「建物/表示タイル」は37G旧タイル専用)<br>' +
          'LOD2: 全 ' + fp.footprints.length + ' 棟のうち、今のカメラで選択中のタイル ' + (ts._selectedTiles ? ts._selectedTiles.length : 0) + ' 枚 / 三角形 ' + s.numberOfTrianglesSelected +
          '<br>' + lod1Info() + '<br>カメラ高度 ' + Math.round(cam.h) + 'm' +
          (cam.h > 25000 ? '<br><span style="color:#fc8">高度が高すぎて LOD2 は描かれません。「LOD2 地点」ボタンで近づいてください</span>' : '');
      };
      state.live = refreshLive;
      setInterval(refreshLive, 1000);
      Object.assign(window.__lc152, { overview, goSpot });
      const qp = new URLSearchParams(location.search);
      if (qp.get('lod2fly') === '1') fly();
      else if (qp.get('lod2ov') === '1') overview();
    } catch (e) { state.status = 'error'; state.error = String(e && e.message || e); showFailure(state.error); }
  }
  window.LC152 = { attach };
})();
