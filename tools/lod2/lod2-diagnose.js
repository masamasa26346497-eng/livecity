// Mission 173: 一回の貼り付けで原因を確定するための診断スナップショット(ローカル限定・読み取り専用)。
// window.__lc152.diagnose() が JSON を返し、パネルの「診断をコピー」ボタンでクリップボードへ入れる。
// 含めるもの: URL クエリ、3D表示モード(select/選択肢の有効無効)、37G allMode(on/mounted/lastPlan/lastError/ticks)、extraMeta(区コード・棟数)、
//   37G errors、区ごとの tileset 状態(ready/tilesLoaded/選択タイル数)、カメラ高度、LOD2 clip、サーバ側 diag.json(区ごと HTTP 200/404、除外理由)。
// 含めないもの: 絶対パス・ユーザー名・トークン(sanitize で除去)。
(function (root) {
  'use strict';
  // ドライブ文字パス / UNC / ホーム配下 / トークン風文字列を伏せる。
  function sanitize(v) {
    if (typeof v === 'string') {
      return v.replace(/[A-Za-z]:[\\/][^\s"'<>|]*/g, '<path>').replace(/\\\\[^\s"'<>|]+/g, '<path>')
        .replace(/\/(home|Users)\/[^\s"'<>|]*/g, '<path>').replace(/(gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_]+/g, '<secret>').slice(0, 300);
    }
    if (Array.isArray(v)) return v.map(sanitize);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = sanitize(v[k]); return o; }
    return v;
  }
  function wardOf(b) { const m = /ext-3dtiles\/([a-z0-9-]+)\//.exec(b || ''); return m ? m[1] : null; }

  async function collect({ Cesium, viewer, state }) {
    const m = root.__mission37g || {};
    const sel = document.getElementById('sel-bldg-mode'), wardSel = document.getElementById('sel-bldg-ward');
    const prims = viewer.scene.primitives, tilesets = [];
    for (let i = 0; i < prims.length; i++) {
      const t = prims.get(i); if (!t || !(t instanceof Cesium.Cesium3DTileset)) continue;
      const s = t.statistics || {};
      tilesets.push({ ward: wardOf(t._lcBase) || (t._lcBase ? 'other' : 'lod2/unknown'), show: t.show, ready: t.ready !== false,
        contentReady: s.numberOfTilesWithContentReady, selected: t._selectedTiles ? t._selectedTiles.length : null, triangles: s.numberOfTrianglesSelected,
        clipping: !!(t.clippingPolygons && t.clippingPolygons.length) });
    }
    const c = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
    let server = null;
    try { server = await fetch('/__lod2/diag.json', { cache: 'no-store' }).then((r) => r.json()); } catch (e) { server = { error: 'diag.json 取得失敗: ' + (e && e.message) }; }
    const ea = server && server.extAttach && server.extAttach.chosen;
    const wardSt = state.wardSt || {};
    const wards = {};
    for (const w of ((ea && ea.wardList) || [])) {
      const sv = ((server.extServed || {}).byWard || {})[w.ward] || null, b = wardSt[w.ward] || null;
      wards[w.ward] = { buildings: w.buildings, served: sv, browser: b && { mounted: b.mounted, loads: b.loads, visible: b.visible, failed: b.failed, lastError: b.lastError } };
    }
    const am = m.allMode || {};
    const out = {
      schema: 'livecity.lod2.diagnose/1', at: new Date().toISOString(), query: location.search,
      mode: { selectValue: sel && sel.value, allOptionPresent: !!(sel && sel.querySelector('option[value="all"]')), allOptionDisabled: sel ? !!(sel.querySelector('option[value="all"]') || {}).disabled : null,
        wardSelectValue: wardSel && wardSel.value, auto3d: !!state.auto3d },
      allMode: { on: am.on, mounted: am.mounted, ticks: am.ticks, mountsTotal: am.mountsTotal, dropsTotal: am.dropsTotal, buildings: am.buildings, lastPlan: am.lastPlan, lastError: am.lastError, culledTotal: am.culledTotal },
      extraMeta: m.extraMeta || null, ext45: m.ext45 || null, errors37g: (m.errors || []).slice(-15),
      camera: { lon: +Cesium.Math.toDegrees(c.longitude).toFixed(4), lat: +Cesium.Math.toDegrees(c.latitude).toFixed(4), h: Math.round(c.height), pitchDeg: +Cesium.Math.toDegrees(viewer.camera.pitch).toFixed(1) },
      tilesets, wards,
      lod2: { status: state.status, clipMode: state.clipMode, clippedTilesets: state.clippedTilesets, tileVisible: state.tileVisible, tileLoad: state.tileLoad, tileFailed: state.tileFailed, error: state.error, buildings: state.lod2Buildings },
      server: server && { extAttach: server.extAttach && { chosen: ea && { kind: ea.kind, wards: ea.wards, verified: ea.verified, brokenWards: ea.brokenWards, missingWards: ea.missingWards }, reason: server.extAttach.reason },
        extServed: server.extServed, data: server.data, layers: server.layers },
      cesium: Cesium.VERSION, ua: navigator.userAgent.replace(/\(.*?\)/, '(…)').slice(0, 120),
    };
    // 判定ヒント(断定ではなく、次に見る場所)
    const hints = [];
    if (!out.mode.allOptionPresent || out.mode.allOptionDisabled) hints.push('「全域3D」の選択肢が無効: 37G が external の区を 1 つも登録していない(extraMeta が空。index.json/source.json/build-report.json の取得失敗)');
    else if (out.mode.selectValue !== 'all') hints.push('3D表示モードが「全域3D」ではない: 建物は出ません');
    else if (!am.on) hints.push('select は all だが 37G allMode.on=false: 切替ハンドラが走っていない');
    if (am.on && !(am.ticks > 0)) hints.push('allMode は on だが allTick が 0 回');
    if (am.on && am.lastPlan && !Object.keys(am.lastPlan).length) hints.push('allTick の計画が空: 視点が遠すぎる(高度 90km 超)/区の bbox から 30km 超/候補区が 0');
    if (am.lastError) hints.push('allMode.lastError: ' + am.lastError);
    if (am.on && am.mounted && !Object.keys(am.mounted).length) hints.push('mounted が空: 計画はあるが mount 前、または mount 失敗');
    if (out.camera.h > 90000) hints.push('カメラ高度が 90km 超: 全域3D の計画対象外');
    if (out.lod2.clipMode === 'on') hints.push('LOD2 の ClippingPolygon が ON(?lod2clip=1): 固まる/他区が消える原因になりうる');
    for (const [w, v] of Object.entries(wards)) if (v.served && v.served.glb && v.served.glb[1] > 0) hints.push(w + ': GLB の HTTP 404/400 が ' + v.served.glb[1] + ' 件');
    out.hints = hints;
    return sanitize(out);
  }

  function attachUi({ Cesium, viewer, state, panel }) {
    const box = document.createElement('div'); box.style.cssText = 'margin:6px 0';
    box.innerHTML = '<button id="lc152-diag">診断をコピー(1回貼り付け用)</button> <span id="lc152-diag-msg" style="opacity:.8"></span>';
    panel.insertBefore(box, panel.children[1]);
    const msg = box.querySelector('#lc152-diag-msg');
    box.querySelector('#lc152-diag').onclick = async () => {
      const j = JSON.stringify(await collect({ Cesium, viewer, state }), null, 1);
      try { await navigator.clipboard.writeText(j); msg.textContent = 'コピーしました(' + j.length + '文字・パスと秘密は除去済み)'; }
      catch (e) { const ta = document.createElement('textarea'); ta.value = j; ta.style.cssText = 'width:100%;height:120px'; box.appendChild(ta); ta.select(); msg.textContent = '自動コピー不可: 下を全選択してコピー'; }
    };
    root.__lc152.diagnose = () => collect({ Cesium, viewer, state });
  }
  root.LC152Diag = { collect, attachUi, sanitize };
  if (typeof module !== 'undefined') module.exports = { sanitize };
})(typeof window !== 'undefined' ? window : globalThis);
