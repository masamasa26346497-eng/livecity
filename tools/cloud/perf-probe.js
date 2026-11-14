/* Mission 212: 開発診断専用の読み込み計測 + 起動失敗の可視化。外部送信なし・個人追跡なし(結果は window.__lc212perf と console のみ)。
 * 計測値は「その端末のブラウザで実際に起きた値」だけを出す。取れなかった項目は null(捏造しない)。 */
(function () {
  'use strict';
  var t0 = 0; // performance.now() は navigationStart 起点
  var P = { firstTileLoadMs: null, firstBuildingReadyMs: null, uiReadyMs: null, wardSelects: [], errors: [], cesiumLoaded: null };
  window.__lc212perf = P;
  function stats() { return window.__mission37g || null; }
  function now() { return Math.round(performance.now() - t0); }
  function showFail(msg) {
    try {
      var d = document.getElementById('lc212-fail');
      if (!d) {
        d = document.createElement('div'); d.id = 'lc212-fail';
        d.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:100001;background:#7a1f1f;color:#fff;font:13px/1.5 sans-serif;padding:8px 12px;border-radius:6px;max-width:80vw';
        (document.body || document.documentElement).appendChild(d);
      }
      d.textContent = msg;
    } catch (e) { /* 表示できなくても本体は止めない */ }
  }
  // スクリプト/CSS の読み込み失敗(CDN 遮断など)は error イベントがバブルしないため capture で拾う
  window.addEventListener('error', function (ev) {
    var t = ev && ev.target;
    if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
      var u = t.src || t.href || '';
      P.errors.push('resource: ' + u); console.error('[lc212] 読み込み失敗', u);
      showFail('読み込みに失敗しました: ' + u.replace(/^https?:\/\//, '').slice(0, 80) + '(再読み込みしてください)');
    } else if (ev && ev.message) { P.errors.push(String(ev.message)); console.error('[lc212] error', ev.message); showFail('初期化エラー: ' + String(ev.message).slice(0, 120)); }
  }, true);
  window.addEventListener('unhandledrejection', function (ev) { P.errors.push('rejection: ' + String(ev && ev.reason && ev.reason.message || ev.reason)); console.error('[lc212] unhandledrejection', ev && ev.reason); });
  document.addEventListener('lc-ward-select', function (ev) { P.wardSelects.push({ ward: ev && ev.detail && ev.detail.ward, atMs: now(), firstBuildingMs: null }); });
  var started = performance.now(), lastLoaded = 0;
  var iv = setInterval(function () {
    var s = stats();
    P.cesiumLoaded = typeof window.Cesium !== 'undefined';
    if (P.uiReadyMs == null && document.getElementById('lc202-picker')) P.uiReadyMs = now();
    if (s) {
      var n = s.loadedTilesTotal || 0;
      if (P.firstTileLoadMs == null && n > 0) P.firstTileLoadMs = now();
      if (P.firstBuildingReadyMs == null && s.buildingState === 'ready') P.firstBuildingReadyMs = now();
      var w = P.wardSelects[P.wardSelects.length - 1];
      if (w && w.firstBuildingMs == null && n > lastLoaded) w.firstBuildingMs = now() - w.atMs;
      lastLoaded = n;
    }
    // 20 秒たっても Cesium/本体が起動していなければ「空白を完成扱いしない」ため明示する
    if (performance.now() - started > 20000 && (!P.cesiumLoaded || !s)) { showFail('3D ビューを起動できません(Cesium または本体スクリプトが未読込)。ネットワークを確認して再読み込みしてください。'); clearInterval(iv); }
    if (performance.now() - started > 120000) clearInterval(iv);
  }, 250);
  P.snapshot = function () {
    var res = performance.getEntriesByType('resource');
    var by = { js: 0, json: 0, glb: 0, other: 0 }, bytes = 0, known = 0;
    res.forEach(function (r) {
      var u = r.name.split('?')[0]; var k = /\.js$/.test(u) ? 'js' : /\.json$/.test(u) ? 'json' : /\.(glb|b3dm)$/.test(u) ? 'glb' : 'other'; by[k]++;
      if (r.transferSize > 0) { bytes += r.transferSize; known++; }
    });
    var nav = performance.getEntriesByType('navigation')[0];
    return { requests: res.length, byKind: by, transferBytes: bytes, transferKnownFor: known,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      firstTileLoadMs: P.firstTileLoadMs, firstBuildingReadyMs: P.firstBuildingReadyMs, uiReadyMs: P.uiReadyMs, wardSelects: P.wardSelects,
      jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, errors: P.errors };
  };
})();
