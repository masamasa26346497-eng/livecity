/* livecity-ward-layer-status.js — Mission 116
 * 区を切り替えたとき、その区の「建物 / 河川・水域」データが配信されているかを確認し、
 * 欠落があれば画面左上に通知する（黙って何も描かれない状態を作らない）。
 *
 * - 読み取り専用。HEAD相当の確認のみ（GET + 本文破棄）。生成・書き込み・外部送信はしない。
 * - 座標・投影・高さには一切触れない。WardModeManager.currentWardId を読むだけ。
 * - 区が変わるたびに前回のチェックは AbortController で取消（古い結果で通知を上書きしない）。
 * - preview サーバーが dev HTML にのみ注入する（production HTML には影響しない）。
 * - window.LiveCityWardLayerStatus.check(wardId) で手動実行、.last で直近結果を参照できる。
 */
(function () {
  'use strict';
  var BASE = 'map-data/osaka-city';
  var banner = null, ctrl = null, lastWard = null, rootManifest = null;
  var api = { last: null, check: check, version: 1 };
  window.LiveCityWardLayerStatus = api;

  function head(url, signal) {
    return fetch(url, { signal: signal, cache: 'no-store' }).then(function (r) { return r.status; }, function (e) {
      if (e && e.name === 'AbortError') throw e;
      return 'ERR';
    });
  }
  function ensureBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'ward-layer-status';
    banner.style.cssText = 'position:fixed;top:12px;left:12px;z-index:99999;max-width:420px;padding:8px 12px;' +
      'border-radius:8px;font:12px/1.5 sans-serif;color:#fff;background:rgba(160,40,30,.92);display:none;white-space:pre-line';
    banner.setAttribute('role', 'status');
    document.body.appendChild(banner);
    return banner;
  }
  function show(text) { var b = ensureBanner(); if (!text) { b.style.display = 'none'; return; } b.textContent = text; b.style.display = 'block'; }

  function datasetFor(wardId) {
    var ds = (rootManifest && rootManifest.datasets) || [];
    for (var i = 0; i < ds.length; i++) if (ds[i].wardId === wardId || ds[i].id === wardId) return ds[i];
    return null;
  }

  function check(wardId) {
    if (ctrl) ctrl.abort();                 // 前の区のチェックを取消
    ctrl = new AbortController();
    var signal = ctrl.signal;
    var rootP = rootManifest ? Promise.resolve(rootManifest)
      : fetch(BASE + '/buildings/manifest.json', { signal: signal, cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('buildings/manifest.json HTTP ' + r.status);
        return r.json();
      }).then(function (m) { rootManifest = m; return m; });
    return rootP.then(function () {
      var ds = datasetFor(wardId);
      if (!ds) return { wardId: wardId, problems: ['この区の建物データ定義がありません'], ok: false };
      var probes = [
        ['建物', BASE + '/buildings/' + ds.id + '/manifest.json'],
        ['河川(waterways)', BASE + '/waterways/manifest.json'],
        ['河川(rivers-v2)', BASE + '/rivers-v2/rivers.json'],
        ['水面(water-surface)', BASE + '/water-surface/water-surface.json'],
      ];
      return Promise.all(probes.map(function (p) { return head(p[1], signal).then(function (s) { return { name: p[0], url: p[1], status: s }; }); }))
        .then(function (rs) {
          var problems = rs.filter(function (r) { return r.status !== 200; })
            .map(function (r) { return r.name + ': ' + (r.status === 404 ? 'データ未配置' : 'HTTP ' + r.status); });
          return { wardId: wardId, dataset: ds.id, probes: rs, problems: problems, ok: problems.length === 0 };
        });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return null;
      return { wardId: wardId, ok: false, problems: ['確認に失敗: ' + (e && e.message)] };
    }).then(function (res) {
      if (!res || signal.aborted) return res;   // 取消された結果は反映しない
      api.last = res;
      show(res.ok ? '' : '⚠ ' + (res.dataset || res.wardId) + ' の表示データが不足しています\n' + res.problems.join('\n') +
        '\n→ npm run preview -- --data-root <出力フォルダ> で配信してください');
      return res;
    });
  }

  function tick() {
    try {
      if (typeof WardModeManager === 'undefined') return;
      var id = WardModeManager.currentWardId;
      if (id && id !== lastWard) { lastWard = id; check(id); }
      else if (!id && lastWard) { lastWard = null; if (ctrl) ctrl.abort(); show(''); }
    } catch (e) { /* noop */ }
  }
  setInterval(tick, 1000);
})();
