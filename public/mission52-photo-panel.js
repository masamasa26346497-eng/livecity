// Issue #52: 写真パネルの独立モジュール（ブラウザ / Node 共用）。mission37f-photo-select.js の上に載る。
//   buildModel(entry, opts) : 索引1件 → 表示モデル（代表 / 追加 / 保留）。権利不明・低確度・移転除外は採用しない。
//   render(slot, model, doc): モデル → DOM。外部メタデータは textContent のみで挿入（HTML は解釈しない）。
// 方針: 欠損・404 のとき別の写真で埋めない。未確認の権利や同一建物を推測で補完しない。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveCityPhotoPanel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const LICENSES = [
    { re: /^CC0(?:\s*1\.0)?$/i, kind: 'cc0', attribution: false },
    { re: /^(public domain|パブリックドメイン)$/i, kind: 'public-domain', attribution: false },
    { re: /^CC BY(?:\s+[1-4]\.\d)?$/i, kind: 'cc-by', attribution: true },
    { re: /^CC BY-SA(?:\s+[1-4]\.\d)?$/i, kind: 'cc-by-sa', attribution: true }
  ];
  // tools/photos/lib/photo-license.mjs と同じ規則（テストで一致を検証）
  function classifyLicense(name) {
    const s = String(name == null ? '' : name).trim();
    if (!s) return { ok: false, kind: 'unknown', reason: 'no-license' };
    if (/(^|[\s-])(NC|ND)([\s-]|$)/i.test(s)) return { ok: false, kind: 'restricted', reason: 'non-commercial-or-no-derivatives' };
    for (let i = 0; i < LICENSES.length; i++) if (LICENSES[i].re.test(s)) return { ok: true, kind: LICENSES[i].kind, attribution: LICENSES[i].attribution };
    return { ok: false, kind: 'needs-review', reason: 'unrecognized-license-name' };
  }
  const KINDS = { exterior: '外観', entrance: '入口', interior: '内観', history: '歴史', surroundings: '周辺の街並み' };
  const GENERIC_AUTHOR = /^(own work|self[- ]?photographed|i, .+|photo taken by .+|taken by .+)$/i;
  const https = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);

  // 外部メタデータ → 安全なプレーンテキスト（タグ除去・制御文字除去・長さ制限）。表示は textContent で行うため二重に防御。
  function plainText(s, max) {
    let t = String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    const lim = max || 200;
    return t.length > lim ? t.slice(0, lim - 1) + '…' : t;
  }
  function authorText(a) {
    const t = plainText(a, 120);
    return !t || GENERIC_AUTHOR.test(t) ? null : t;
  }
  const fileOf = (p, PS) => (PS ? PS.fileName(p) : '');

  // PS = LiveCityPhotoSelect。opts: { okConfidence, exclude, dates, adds, maxAdditional }
  function buildModel(entry, opts, PS) {
    const o = opts || {};
    const model = { state: 'ok', reason: null, primary: null, additional: [], held: [], surroundings: [] };
    if (!PS) { model.state = 'unavailable'; model.reason = 'no-select-module'; return model; }
    const ranked = PS.rankPhotos(entry, o);
    if (!ranked.eligibleEntry) {
      model.state = ranked.reason === 'no-entry' ? 'no-entry' : 'low-confidence';
      model.reason = ranked.reason;
      return model;
    }
    const usable = [];
    ranked.photos.forEach((r) => {
      const lic = classifyLicense(r.photo.license);
      const f = fileOf(r.photo, PS);
      if (!lic.ok) { model.held.push({ file: f, reason: 'license-' + lic.kind }); return; }
      if (!https(r.photo.sourcePageUrl)) { model.held.push({ file: f, reason: 'no-source-page' }); return; }
      usable.push({ photo: r.photo, date: r.date, license: lic, file: f, kind: KINDS[r.photo.kind] ? r.photo.kind : 'unclassified' });
    });
    // 周辺の街並みは代表にしない（建物外観のカバー率と混ぜない）
    usable.filter((u) => u.kind === 'surroundings').forEach((u) => model.surroundings.push(u));
    const body = usable.filter((u) => u.kind !== 'surroundings');
    if (!body.length) {
      model.state = model.held.length ? 'license-hold' : 'no-eligible';
      model.reason = model.held.length ? model.held[0].reason : ranked.reason || 'no-eligible-photo';
      return model;
    }
    // 代表: 外観(未分類は索引の既存順位に従う)を優先。入口/内観/歴史は追加写真へ。
    const ext = body.filter((u) => u.kind === 'exterior' || u.kind === 'unclassified');
    model.primary = ext[0] || null;
    if (!model.primary) { model.state = 'no-exterior'; model.reason = 'only-non-exterior'; model.additional = body.slice(0, o.maxAdditional || 4); return model; }
    model.additional = body.filter((u) => u !== model.primary).slice(0, o.maxAdditional == null ? 4 : o.maxAdditional);
    return model;
  }

  function creditLine(doc, u, opt) {
    const cap = doc.createElement('div');
    cap.className = 'cap';
    cap.setAttribute('data-photo-kind', u.kind);
    const p = u.photo;
    const a = authorText(p.author);
    cap.appendChild(doc.createTextNode((opt && opt.kindLabel && KINDS[u.kind] ? '[' + KINDS[u.kind] + '] ' : '') + '作者: ' + (a || '索引に作者名の記載なし（Wikimedia Commons のファイルページを参照）') + ' / ライセンス: '));
    const lu = https(p.licenseUrl);
    if (lu) { const l = doc.createElement('a'); l.href = lu; l.target = '_blank'; l.rel = 'noopener'; l.textContent = plainText(p.license, 40); cap.appendChild(l); }
    else cap.appendChild(doc.createTextNode(plainText(p.license, 40)));
    cap.appendChild(doc.createTextNode(' / '));
    const s = doc.createElement('a'); s.href = https(p.sourcePageUrl); s.target = '_blank'; s.rel = 'noopener'; s.textContent = 'Wikimedia Commons'; cap.appendChild(s);
    cap.appendChild(doc.createTextNode(' / 撮影: '));
    if (u.date && u.date.basis === 'verified' && https(u.date.evidenceUrl)) {
      const d = doc.createElement('a'); d.href = u.date.evidenceUrl; d.target = '_blank'; d.rel = 'noopener'; d.textContent = u.date.takenAt; d.setAttribute('data-photo-taken', u.date.takenAt); cap.appendChild(d);
    } else { const sp = doc.createElement('span'); sp.textContent = '未確認'; sp.setAttribute('data-photo-taken', 'unknown'); cap.appendChild(sp); }
    return cap;
  }

  // 画像の読込失敗時は、別の写真で埋めずに出典リンクだけを示す
  function imgWithFallback(doc, u, alt, holder) {
    const img = doc.createElement('img');
    img.src = u.photo.thumbnailUrl; img.alt = alt; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      if (!img.isConnected) return;
      const m = doc.createElement('div'); m.className = 'cap'; m.setAttribute('data-photo-error', '1');
      m.appendChild(doc.createTextNode('写真を読み込めませんでした（画像の取得に失敗）。出典: '));
      const a = doc.createElement('a'); a.href = https(u.photo.sourcePageUrl); a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Wikimedia Commons'; m.appendChild(a);
      holder.replaceChild(m, img);
    });
    return img;
  }

  const MESSAGES = {
    'no-entry': '写真データなし（索引に、この建物と確認済みの写真はありません）',
    'low-confidence': '写真データなし（建物との対応づけが確定していないため表示しません）',
    'no-eligible': '写真データなし（表示できる条件を満たす写真がありません）',
    'license-hold': '写真は保留中です（ライセンスを個別に確認できていないため表示しません）',
    'no-exterior': '外観写真は未確認です（入口・内観などの写真のみ）',
    unavailable: '写真パネルを初期化できませんでした'
  };

  function render(slot, model, doc, name) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    slot.textContent = '';
    slot.setAttribute('aria-busy', 'false');
    slot.setAttribute('data-photo-state', model.state);
    const nm = plainText(name || '建物', 60);
    if (!model.primary) {
      slot.textContent = MESSAGES[model.state] || MESSAGES['no-eligible'];
    } else {
      slot.appendChild(imgWithFallback(d, model.primary, nm + 'の写真', slot));
      slot.appendChild(creditLine(d, model.primary));
    }
    renderAdditional(slot, model, d, nm);
    return model;
  }

  // 追加写真だけを slot の末尾へ追加（既存ページが代表写真を自前で描画している場合に使う）
  function renderAdditional(slot, model, doc, name) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!model.additional || !model.additional.length) return;
    const nm = plainText(name || '建物', 60);
    const box = d.createElement('div'); box.className = 'cap'; box.setAttribute('data-photo-additional', String(model.additional.length));
    box.appendChild(d.createTextNode('追加写真（' + model.additional.length + '）'));
    model.additional.forEach((u) => {
      const row = d.createElement('div');
      row.appendChild(imgWithFallback(d, u, nm + 'の追加写真', row));
      row.appendChild(creditLine(d, u, { kindLabel: true }));
      box.appendChild(row);
    });
    slot.appendChild(box);
  }

  return { classifyLicense, plainText, authorText, buildModel, render, renderAdditional, KINDS };
});
