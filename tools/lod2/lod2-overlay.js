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
      // Mission 172: ClippingPolygon は既定 OFF。足跡が広域に散ると(41 件でも大阪全域に散らした fixture で)ページが固まり、他区の LOD1 が出なくなることを headless Chrome で確認した。?lod2clip=1 のときだけ ON。
      const CLIP = new URLSearchParams(location.search).get('lod2clip') === '1';
      state.clipMode = CLIP ? 'on' : 'off';
      if (CLIP && (!Cesium.ClippingPolygonCollection || !Cesium.ClippingPolygon)) {
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
      // Mission 177: lod2clip=near — カメラ近傍(高度<2.5km・半径1.2km・最大400件)の足跡だけを動的にクリップ。
      const NEAR = new URLSearchParams(location.search).get('lod2clip') === 'near';
      if (NEAR) {
        await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = BASE + 'clipnear.js'; sc.onload = res; sc.onerror = () => rej(new Error('clipnear.js')); document.head.appendChild(sc); });
        const CN = window.LC152ClipNear; let prev = []; const colls = new Map();
        state.clipMode = 'near'; state.nearClip = { polys: 0, updates: 0, lastMs: 0 };
        const update = () => {
          const c = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
          // 注視点(画面中心の地表)を基準にする。取れなければカメラ直下。
          let lon = Cesium.Math.toDegrees(c.longitude), lat = Cesium.Math.toDegrees(c.latitude);
          try { const hit = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2)); if (hit) { const g = Cesium.Cartographic.fromCartesian(hit); lon = Cesium.Math.toDegrees(g.longitude); lat = Cesium.Math.toDegrees(g.latitude); } } catch (e) { /* 直下で代用 */ }
          const qp = new URLSearchParams(location.search), num = (k) => (qp.get(k) ? Number(qp.get(k)) : undefined);
          const sel = CN.selectNearby(fp.footprints, { lon, lat, h: c.height }, { maxHeightM: num('lod2cliph'), radiusM: num('lod2clipr'), maxPolys: num('lod2clipmax') });
          if (!CN.needsUpdate(prev, sel)) return;
          const t0 = performance.now(); prev = sel;
          const prims = scene.primitives;
          for (let i = 0; i < prims.length; i++) {
            const p = prims.get(i);
            if (p === ts || !(p instanceof Cesium.Cesium3DTileset)) continue;
            let col = colls.get(p);
            if (!col) { col = new Cesium.ClippingPolygonCollection({ polygons: [], inverse: false }); colls.set(p, col); p.clippingPolygons = col; state.clippedTilesets++; }
            col.removeAll(); for (const k of sel) col.add(polys[k]);
          }
          state.nearClip.polys = sel.length; state.nearClip.updates++; state.nearClip.lastMs = Math.round(performance.now() - t0);
          scene.requestRender();
        };
        viewer.camera.moveEnd.addEventListener(update);
        scene.postRender.addEventListener(() => { if (scene.primitives.length !== (update._n || 0)) { update._n = scene.primitives.length; prev = []; update(); } });
      }
      // Mission 182B: 遠景(高度>lod2coarseh)では LOD1 区タイルが 1 枚も出ない。区 tileset の root は content 無し(ge=160)で、
      // SSE=ge*viewH/(2*d*tan(fov/2)) が maximumScreenSpaceError(粗い区は 32)を超える d≈3.5km 以内にならないと子(lod/*.glb, ge=40)が選ばれないため。
      // 遠景だけ他 tileset の maximumScreenSpaceError を下げ、粗い親タイルを出す(近づけば元の値に戻す)。?lod2coarsesse=0 で無効。
      {
        const qq = new URLSearchParams(location.search); const target = qq.has('lod2coarsesse') ? Number(qq.get('lod2coarsesse')) : 2; const HI = Number(qq.get('lod2coarseh') || 6000);
        state.coarseSse = { target, heightM: HI, lowered: 0 };
        if (target > 0) {
          const orig = new WeakMap(); let lastChk = 0;
          scene.postRender.addEventListener(() => {
            const now = performance.now(); if (now - lastChk < 500) return; lastChk = now;
            const h = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC).height; const far = h > HI; let n = 0, ch = false;
            const prims = scene.primitives;
            for (let i = 0; i < prims.length; i++) {
              const p = prims.get(i); if (p === ts || !(p instanceof Cesium.Cesium3DTileset)) continue;
              if (far) { if (p.maximumScreenSpaceError > target) { if (!orig.has(p)) orig.set(p, p.maximumScreenSpaceError); p.maximumScreenSpaceError = target; ch = true; } if (orig.has(p)) n++; }
              else if (orig.has(p)) { p.maximumScreenSpaceError = orig.get(p); orig.delete(p); ch = true; }
            }
            state.coarseSse.lowered = n; if (ch) scene.requestRender();
          });
        }
      }
      if (CLIP) applyClip();
      if (CLIP) scene.postRender.addEventListener(() => { if (scene.primitives.length !== (applyClip._n || 0)) { applyClip._n = scene.primitives.length; applyClip(); } });
      state.exclusion = NEAR ? 'clipping-polygon-near(カメラ近傍の足跡のみ動的クリップ。遠景では LOD1 と重なる)' : CLIP ?'clipping-polygon(足跡の凸包。LOD2 建物の LOD1 のみ除外。LOD2 化していない 3 棟等は残る)' : 'none(既定。LOD2 の建物は LOD1 と重なって描かれる場合があります。?lod2clip=1 で凸包クリップを試せますが、足跡が多いと固まります)';
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
      // Mission 173: 診断コピー(読み取り専用)。diagnose.js が読めなくても LOD2 表示は止めない。
      try {
        await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = BASE + 'diagnose.js'; sc.onload = res; sc.onerror = () => rej(new Error('diagnose.js')); document.head.appendChild(sc); });
        window.LC152Diag.attachUi({ Cesium, viewer, state, panel });
      } catch (e) { state.diagError = String(e && e.message || e); }
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
      // Mission 171: 区ごとの LOD1 状態。「接続した」ではなく、ブラウザで tileset が実際に読めたか(tileLoad)・描かれたか(tileVisible)・失敗したか(tileFailed)と、
      //   サーバ側の HTTP 結果(200/404)を並べる。GLB が 0 枚しか読めていない区は「接続済み」と書かない。
      const wardSt = {};   // wardId -> { loads, visible, failed, lastError, mounted }
      const wardOf = (b) => { const m = /ext-3dtiles\/([a-z0-9-]+)\//.exec(b || ''); return m ? m[1] : null; };
      const hook = () => {
        const prims = viewer.scene.primitives;
        for (let i = 0; i < prims.length; i++) {
          const t = prims.get(i); const w = t && t._lcBase ? wardOf(t._lcBase) : null;
          if (!w || t._lc171) continue;
          t._lc171 = true;
          const st = wardSt[w] || (wardSt[w] = { loads: 0, visible: 0, failed: 0, lastError: null, mounted: 0 });
          st.mounted++;
          t.tileLoad.addEventListener(() => { st.loads++; });
          t.tileVisible.addEventListener((tile) => { if (tile.hasRenderableContent !== false) st.visible++; });
          t.tileFailed.addEventListener((e) => { st.failed++; st.lastError = String((e && e.message) || e).slice(0, 120); });
        }
      };
      const sec = document.createElement('div');
      sec.style.cssText = 'margin:4px 0;padding:4px 6px;background:rgba(255,255,255,.06);border-radius:4px;max-height:200px;overflow:auto';
      panel.insertBefore(sec, panel.children[2]);
      const rowOf = (w, srv, ea) => {
        const b = wardSt[w.ward]; const sv = (srv || {})[w.ward];
        const glbOk = sv ? sv.glb[0] : 0, glbNg = sv ? sv.glb[1] + sv.tileset[1] + sv.meta[1] : 0;
        let mark, msg;
        if (glbNg > 0 || (b && b.failed > 0)) { mark = '<span style="color:#f88">NG</span>'; msg = '読込失敗(HTTP 404等 ' + glbNg + ' / tileFailed ' + (b ? b.failed : 0) + ')' + (b && b.lastError ? ' ' + b.lastError : ''); }
        else if (b && b.visible > 0) { mark = '<span style="color:#8f8">描画中</span>'; msg = 'tileVisible ' + b.visible + ' / GLB 200×' + glbOk; }
        else if (b && b.loads > 0) { mark = '<span style="color:#fd8">読込済</span>'; msg = 'GLB ' + b.loads + '枚読込。視野外/遠景のため未描画'; }
        else if (b) { mark = '<span style="color:#fd8">待機</span>'; msg = 'tileset は登録済み、GLB 未読込(区に近づく/区を選択)'; }
        else { mark = '<span style="color:#aaa">未要求</span>'; msg = 'この区の tileset はまだ要求されていません'; }
        return '<div>' + mark + ' <b>' + w.ward + '</b> ' + (w.buildings != null ? w.buildings + '棟 ' : '') + msg + '</div>';
      };
      const refreshWards = () => {
        hook();
        fetch('/__lod2/diag.json', { cache: 'no-store' }).then((r) => r.json()).then((dg) => {
          const ea = dg.extAttach; const c = ea && ea.chosen; const srv = dg.extServed && dg.extServed.byWard;
          state.extServed = dg.extServed; state.wardSt = wardSt;
          let h = '<b>区ごとの LOD1 状態</b> (HTTP200 だけでなく tileLoad / tileVisible で判定)<br>';
          if (!c) h += '<span style="color:#fc8">LOD1 未接続: 区ごとの建物は出ません</span>';
          else {
            h += c.wardList.map((w) => rowOf(w, srv, ea)).join('');
            for (const b of (c.brokenWards || [])) h += '<div><span style="color:#f88">NG</span> <b>' + b.ward + '</b> 出力はあるが 37G が読めない: ' + String((b.reasons[0] || {}).reason || '').replace(/[<>&]/g, '').slice(0, 140) + '</div>';
            if ((c.missingWards || []).length) h += '<div style="opacity:.8">出力なし: ' + c.missingWards.join(', ') + '</div>';
          }
          const ly = dg.layers; h += '<div style="margin-top:3px">道路・河川・公園: ' + (ly && ly.attached ? ly.wards.length + ' 区接続' : '<span style="color:#fc8">未接続(区境界のみ。--layers-root または LiveCity-MapLayers-Out-24 が必要)</span>') + '</div>';
          const mode = document.getElementById('sel-bldg-mode');
          if (c && mode && mode.value !== 'all') h += '<div style="color:#fc8">左パネル「3D表示モード」を「全域3D」にするか「3D建物の区」で区を選ぶと建物が出ます(既定は「建物を表示しない」)</div>';
          if (c && Object.keys(wardSt).length && !Object.values(wardSt).some((x) => x.visible > 0)) h += '<div style="color:#fc8">いまの視点では LOD1 が描かれていません。区に近づいてください(高度が高いと全域3Dは遠景扱いで建物を出しません)</div>';
          sec.innerHTML = h;
        }).catch(() => { sec.textContent = '診断情報(diag.json)を取得できません'; });
      };
      setInterval(refreshWards, 3000); refreshWards();
      // 既定では 37G は「建物を表示しない / 選択した1区のみ」。24区 LOD1 を接続できているときだけ、全域3Dを自動で有効化する(?lod2auto3d=0 で止める)。
      if (new URLSearchParams(location.search).get('lod2auto3d') !== '0') {
        let tries = 0;
        const iv = setInterval(() => {
          const mode = document.getElementById('sel-bldg-mode'); const all = mode && mode.querySelector('option[value="all"]');
          if (++tries > 40) clearInterval(iv);
          if (all && !all.disabled && mode.value !== 'all') { mode.value = 'all'; mode.dispatchEvent(new Event('change')); state.auto3d = true; clearInterval(iv); }
        }, 750);
      }
      Object.assign(window.__lc152, { overview, goSpot });
      const qp = new URLSearchParams(location.search);
      if (qp.get('lod2fly') === '1') fly();
      else if (qp.get('lod2ov') === '1') overview();
    } catch (e) { state.status = 'error'; state.error = String(e && e.message || e); showFailure(state.error); }
  }
  window.LC152 = { attach };
})();
