/* Mission 202: 24区の配信状況パネル + 区選択(クラウドPreview用)。window.LCCloudData(data-resolver.cjs)が必要。
 * - ext-3dtiles/index.json を読み、24区を全て列挙。未配信の区は「2025データ未配信・配信準備中」と表示し描画しない。
 * - 配信済みの区は manifest.json(vintage=2025/ward一致/出典/sha256)を検証してから「検証OK」と表示する。
 * - 失敗しても旧45D/組み込みデータへは fallback しない(エラー表示のみ)。
 * - ?dataBaseUrl=https://... は window.LC_CLOUD_ALLOWLIST(ホスト完全一致配列)がある場合のみ有効。無ければ同一originのまま。
 * - 既存の3区表示・LOD2近景ボタンには触れない(別要素を追加するだけ)。 */
(function () {
  'use strict';
  var R = window.LCCloudData;
  if (!R) { console.error('[lc202] LCCloudData 未読込'); return; }
  var q = new URLSearchParams(location.search);
  var res = R.resolveBase({ dataBaseUrl: q.get('dataBaseUrl'), allowlist: window.LC_CLOUD_ALLOWLIST || [] });
  var box = document.createElement('div');
  box.id = 'lc202-picker';
  box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:100000;background:rgba(14,18,26,.92);color:#fff;font:12px/1.5 sans-serif;padding:8px 10px;border-radius:6px;max-width:300px';
  document.body.appendChild(box);
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function render(html) { box.innerHTML = html; }
  if (!res.ok) { render('<b style="color:#f88">データ配信先を拒否</b><br>' + esc(res.code) + '<br>旧データへは切り替えません'); window.__lc202 = { state: 'rejected', code: res.code }; return; }
  var base = res.base;
  var state = { base: base, external: res.external, index: null, selected: null, status: 'loading' };
  window.__lc202 = state;
  function fetchJson(url) { return fetch(url, { credentials: 'omit', mode: 'cors' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url); return r.json(); }); }
  function msg(m) { var e = box.querySelector('#lc202-msg'); if (e) e.textContent = m; }
  function select(ward) {
    state.selected = ward;
    var d = R.describeSelection(state.index, ward);
    state.selection = d;
    if (d.state !== 'served') { msg(d.message); document.dispatchEvent(new CustomEvent('lc-ward-select', { detail: { ward: ward, state: d.state } })); return; }
    msg('manifest を検証中…');
    fetchJson(base + ward + '/manifest.json').then(function (m) {
      var v = R.validateWardManifest(m, ward);
      if (!v.ok) throw new Error(v.problems[0]);
      var ts = m.assets.filter(function (a) { return a.path === 'tileset.json'; })[0];
      return fetch(base + ward + '/tileset.json', { credentials: 'omit' }).then(function (r) { if (!r.ok) throw new Error('tileset HTTP ' + r.status); return r.arrayBuffer(); })
        .then(function (b) { return ts ? R.verifyAsset(new Uint8Array(b), ts) : { ok: false, code: 'no-tileset-asset' }; })
        .then(function (a) { if (!a.ok) throw new Error('整合性NG: ' + a.code); return m; });
    }).then(function (m) {
      // Mission 203: 検証成功後に、37G 既存の区ボタン(.lc-wardbtn[data-code])を押して既存の WardUI.select(w,true)
      //   (区ハイライト・setBuildingWard の mount・カメラ移動)を再利用する。3D は再実装しない。
      var btn = document.querySelector('.lc-wardbtn[data-code="' + String(m.wardCode).replace(/[^0-9]/g, '') + '"]');
      var linked = !!btn;
      if (btn) btn.click();
      state.linked = linked;
      msg('配信済み・検証OK(' + m.vintage + '年版, ' + m.fileCount + 'ファイル)' + (m.synthetic ? ' ※合成fixture' : '') +
        (linked ? '。既存の区選択へ移動しました(描画の目視確認は別途必要)。' : '。この画面には対応する区ボタンが無く、移動は未実装です(旧データへは切り替えません)。'));
      document.dispatchEvent(new CustomEvent('lc-ward-select', { detail: { ward: ward, state: 'served', manifest: m.contentVersion } }));
    }).catch(function (e) { msg('検証失敗(旧データへは切り替えません): ' + e.message); });
  }
  fetchJson(base + 'index.json').then(function (idx) {
    var v = R.validateIndex(idx);
    if (!v.ok) throw new Error(v.problems[0]);
    state.index = idx; state.status = 'ready';
    var opts = v.wards.map(function (w) { return '<option value="' + esc(w.ward) + '">' + esc(w.name) + (w.status === 'served' ? '(配信済み)' : '(未配信)') + '</option>'; }).join('');
    render('<b>PLATEAU 2025 区選択</b><br>配信済み ' + v.servedCount + ' / ' + v.totalWards + ' 区' +
      '<br><select id="lc202-ward"><option value="">区を選択…</option>' + opts + '</select>' +
      '<div id="lc202-msg" style="margin-top:4px"></div>' +
      '<div style="opacity:.7;margin-top:4px">配信済みの区数と、同時に描画できる区数(上限あり)は別です。未配信の区は描画されません。</div>');
    box.querySelector('#lc202-ward').addEventListener('change', function (e) { if (e.target.value) select(e.target.value); });
  }).catch(function (e) { state.status = 'error'; render('<b style="color:#f88">index.json を検証できません</b><br>' + esc(e.message) + '<br>旧データへは切り替えません'); });
})();
