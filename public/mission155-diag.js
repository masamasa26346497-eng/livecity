/* Mission 155: 建物網羅性の画面診断（読み取り専用。Cesium の既存イベントを聞くだけで、描画・データ・配信は変えない）。
 *   LC155.track(tileset, info)  : 3D Tiles の tileLoad / tileUnload / tileFailed を集計（leaf = tiles/t_x_z.glb）
 *   LC155.snapshot()            : { wards:{...}, causes } を返す。tools/mission155-coverage-audit.cjs --rendered に渡せる形
 *   LC155.mountPanel(getCtx)    : ?diag=1 のとき左下に診断パネル（「JSONをコピー」付き）。通常表示には出ない
 * 数値と tile キーのみ。建物 ID・URL の中身（クエリ等）は保持しない。
 * 原因分類（画面表示用）: C1 真の空地 / C2 ソース欠落疑い / C3 変換で脱落 / C4 3D Tiles・GLB 欠落 / C5 HTTP・配信未接続 / C6 表示側（LOD・カリング・区切替）
 */
(function (root) {
  'use strict';
  var sets = {};   // base -> record
  var LEAF = /tiles\/(t_-?\d+_-?\d+)\.glb/;
  function leafOf(tile) {
    var u = '';
    try { u = (tile && tile.content && tile.content.url) || (tile && tile._contentResource && tile._contentResource.url) || ''; } catch (e) { u = ''; }
    var m = LEAF.exec(String(u));
    return m ? m[1] : null;
  }
  function declaredLeaf(report) {
    var d = {};
    var arr = (report && report.leaf) || [];
    for (var i = 0; i < arr.length; i++) d[arr[i].name] = arr[i].buildings | 0;
    return d;
  }
  function httpClass(msg) {
    var s = String(msg || '');
    var m = /\b(4\d\d|5\d\d)\b/.exec(s);
    if (m) return 'HTTP ' + m[1];
    if (/cors|cross-origin|blocked/i.test(s)) return 'CORS';
    if (/network|failed to fetch|load failed/i.test(s)) return 'network';
    return 'other';
  }
  function track(ts, info) {
    info = info || {};
    var rec = sets[info.base || info.id] = {
      id: info.id || null, base: info.base || null, wardId: info.wardId || null, wardCode: info.wardCode || null,
      declaredLeaf: declaredLeaf(info.report), declaredBuildings: (info.report && info.report.totals && info.report.totals.buildings) | 0,
      declaredTiles: (info.report && info.report.selectedTiles) | 0,
      resident: {}, everLoaded: {}, failed: [], destroyed: false
    };
    ts.tileLoad.addEventListener(function (tile) { var k = leafOf(tile); if (k) { rec.resident[k] = 1; rec.everLoaded[k] = 1; } });
    ts.tileUnload.addEventListener(function (tile) { var k = leafOf(tile); if (k) delete rec.resident[k]; });
    ts.tileFailed.addEventListener(function (err) {
      var k = null; try { var m = LEAF.exec(String((err && err.url) || '')); k = m ? m[1] : null; } catch (e) { k = null; }
      if (rec.failed.length < 200) rec.failed.push({ tile: k, kind: httpClass(err && err.message) });
    });
    return rec;
  }
  function reset() { Object.keys(sets).forEach(function (b) { delete sets[b]; }); }
  function drop(base) { if (sets[base]) sets[base].destroyed = true; }
  function sumLeaf(rec, keys) {
    var n = 0;
    for (var i = 0; i < keys.length; i++) n += rec.declaredLeaf[keys[i]] | 0;
    return n;
  }
  function snapshot() {
    var wards = {}, rows = [];
    Object.keys(sets).forEach(function (b) {
      var r = sets[b];
      if (r.destroyed) return;
      var res = Object.keys(r.resident), ever = Object.keys(r.everLoaded);
      var failedTiles = r.failed.map(function (f) { return f.tile; }).filter(Boolean);
      var kinds = {}; r.failed.forEach(function (f) { kinds[f.kind] = (kinds[f.kind] || 0) + 1; });
      var declTiles = Object.keys(r.declaredLeaf);
      var row = {
        id: r.id, wardId: r.wardId, wardCode: r.wardCode,
        declaredTiles: declTiles.length || r.declaredTiles, declaredBuildings: r.declaredBuildings,
        residentTiles: res.length, residentBuildings: sumLeaf(r, res),
        everLoadedTiles: ever.length, everLoadedBuildings: sumLeaf(r, ever),
        neverLoadedTiles: declTiles.filter(function (k) { return !r.everLoaded[k]; }).length,
        failedTiles: failedTiles.length, failedKinds: kinds
      };
      rows.push(row);
      var w = wards[r.wardId || r.wardCode || r.id] = wards[r.wardId || r.wardCode || r.id] || { leafLoaded: [], leafFailed: [], leafBuildings: 0 };
      res.forEach(function (k) { w.leafLoaded.push(k); });
      failedTiles.forEach(function (k) { w.leafFailed.push(k); });
      w.leafBuildings += row.residentBuildings;
    });
    return { schema: 'livecity.mission155.rendered/1', wards: wards, sets: rows };
  }
  // 画面向けの原因ヒント。視点に入っていない leaf は「未読込」であって欠落ではない（SSE・カメラ距離で読むため）。
  function hint(row) {
    if (row.failedTiles > 0) return 'C5: 読込失敗 ' + JSON.stringify(row.failedKinds) + '（配信 root・404・CORS を確認）';
    if (row.residentTiles < row.declaredTiles) return 'C6: 未読込 ' + (row.declaredTiles - row.residentTiles) + ' tile（視野外・LOD・カリング。カメラを寄せて再確認）';
    return '全 leaf 常駐（描画側の欠落なし）';
  }
  function mountPanel(getCtx) {
    if (typeof document === 'undefined') return null;
    var box = document.createElement('div');
    box.id = 'lc155-diag';
    box.setAttribute('role', 'region'); box.setAttribute('aria-label', '建物網羅性の診断');
    box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:60;max-width:360px;max-height:46vh;overflow:auto;background:rgba(14,24,48,.92);color:#e8eefc;font:11px/1.45 system-ui,sans-serif;padding:8px 10px;border-radius:8px;border:1px solid #3d6df2';
    document.body.appendChild(box);
    function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    function render() {
      var snap = snapshot(), ctx = (getCtx && getCtx()) || {};
      var h = '<b>建物網羅性の診断</b> <button id="lc155-copy" style="float:right">JSONをコピー</button><div>選択区: ' + esc(ctx.ward || '—') + ' / 状態: ' + esc(ctx.state || '—') + '</div>';
      if (!snap.sets.length) h += '<div>mount 済みの建物 tileset はありません（区を選ぶと表示）。' + (ctx.state === 'unavailable' ? ' → C5: この区は配信されていません（データ未接続）。' : '') + '</div>';
      snap.sets.forEach(function (r) {
        h += '<div style="margin-top:6px;border-top:1px solid #345"><b>' + esc(r.wardId || r.id) + '</b> 宣言 ' + r.declaredBuildings + ' 棟 / ' + r.declaredTiles + ' tile<br>' +
          '常駐 ' + r.residentBuildings + ' 棟 / ' + r.residentTiles + ' tile、累計読込 ' + r.everLoadedTiles + ' tile、失敗 ' + r.failedTiles + '<br>' + esc(hint(r)) + '</div>';
      });
      h += '<div style="margin-top:6px;opacity:.8">C1 空地 / C2 ソース欠落 / C3 変換脱落 / C4 GLB 欠落は画面では判定できません。<code>tools/mission155-coverage-audit.cjs --rendered</code> に上のJSONを渡すと tile 単位で分類します。</div>';
      box.innerHTML = h;
      var b = box.querySelector('#lc155-copy');
      if (b) b.onclick = function () { var t = JSON.stringify(snapshot()); if (navigator.clipboard) navigator.clipboard.writeText(t); else window.prompt('copy', t); };
    }
    render();
    var iv = setInterval(render, 2000);
    return { render: render, destroy: function () { clearInterval(iv); box.remove(); } };
  }
  root.LC155 = { track: track, drop: drop, reset: reset, snapshot: snapshot, mountPanel: mountPanel, httpClass: httpClass, leafOf: leafOf, _sets: sets };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.LC155;
})(typeof window !== 'undefined' ? window : globalThis);
