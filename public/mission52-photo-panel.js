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
  const https = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);

  // ── URL 検証: 文字列の末尾一致ではなく URL として解析し、ホストとパスを確認する（偽 Commons を弾く）
  function parseHttps(u) {
    if (typeof u !== 'string') return null;
    let x; try { x = new URL(u); } catch (e) { return null; }
    if (x.protocol !== 'https:' || x.username || x.password || (x.port && x.port !== '443')) return null;
    return x;
  }
  // Commons ファイルページ: https://commons.wikimedia.org/wiki/File:<名前>（クエリ/ハッシュ付きは受理しない）。戻り値はファイル名（空白区切り）
  function commonsFile(u) {
    const x = parseHttps(u);
    if (!x || x.hostname !== 'commons.wikimedia.org' || x.search || x.hash) return null;
    const m = x.pathname.match(/^\/wiki\/File:([^/]+)$/);
    if (!m) return null;
    let n; try { n = decodeURIComponent(m[1]); } catch (e) { return null; }
    n = n.replace(/_/g, ' ').trim();
    return n && !/[\u0000-\u001f\u007f]/.test(n) ? n : null;
  }
  const THUMB_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org'];
  function commonsImage(u) {
    const x = parseHttps(u);
    return x && THUMB_HOSTS.indexOf(x.hostname) >= 0 && /^\/wikipedia\/commons\//.test(x.pathname) ? x.href : null;
  }
  // ライセンスURLは名称から推測しない。索引にある https の URL のうち、既知のライセンス公開ホストのものだけ
  const LICENSE_HOSTS = ['creativecommons.org', 'artlibre.org'];
  function licenseUrl(u) {
    const x = parseHttps(u);
    return x && LICENSE_HOSTS.indexOf(x.hostname) >= 0 ? x.href : null;
  }
  const fileHref = (file) => 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(file.replace(/ /g, '_'));

  // 外部メタデータ → 安全なプレーンテキスト（タグ除去・制御文字除去・長さ制限）。表示は textContent で行うため二重に防御。
  function plainText(s, max) {
    let t = String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    const lim = max || 200;
    return t.length > lim ? t.slice(0, lim - 1) + '…' : t;
  }
  // 作者表記。「I, 実名」「Photo taken by 実名」は実名を取り出す。名前の無い定型句（Own work 等）だけを「作者名なし」とする
  const NO_NAME_AUTHOR = /^(own work|self[- ]?photographed|unknown( author)*|(unknown author)+|no machine-readable author provided.*|anonymous|author unknown|i|me|myself|私)$/i;
  function authorText(a) {
    let t = plainText(a, 120);
    if (!t) return null;
    let m = t.match(/^I,\s*([^,、]+?)\s*(?:,|、|$)/);                 // "I, Taro Yamada, the copyright holder ..."
    if (m) t = m[1];
    else if ((m = t.match(/^(?:photo(?:graph)? taken by|taken by|photo(?:graph)? by|photographed by)\s+(.+)$/i))) t = m[1].trim();
    return !t || NO_NAME_AUTHOR.test(t) ? null : t;
  }

  // 写真1枚の「表示可否」。表示できない理由は保留理由として返す（索引からは削除しない）
  function photoEligibility(p) {
    if (!p) return { ok: false, reason: 'no-photo' };
    const file = commonsFile(p.sourcePageUrl);
    if (!file) return { ok: false, reason: 'invalid-source-url' };
    if (!commonsImage(p.thumbnailUrl)) return { ok: false, reason: 'invalid-thumbnail-url' };
    const lic = classifyLicense(p.license);
    if (!lic.ok) return { ok: false, reason: 'license-' + lic.kind };
    const author = authorText(p.author);
    if (lic.attribution) {
      if (!author) return { ok: false, reason: 'attribution-required-author-missing' };
      if (!licenseUrl(p.licenseUrl)) return { ok: false, reason: 'license-url-missing' };
    }
    return { ok: true, file, license: lic, author };
  }

  // PS = LiveCityPhotoSelect。opts: { okConfidence, exclude, dates, adds, maxAdditional }
  function buildModel(entry, opts, PS) {
    const o = opts || {};
    const model = { state: 'ok', reason: null, exteriorConfirmed: false, primary: null, additional: [], held: [], surroundings: [] };
    if (!PS) { model.state = 'unavailable'; model.reason = 'no-select-module'; return model; }
    const ranked = PS.rankPhotos(entry, o);
    if (!ranked.eligibleEntry) {
      model.state = ranked.reason === 'no-entry' ? 'no-entry' : 'low-confidence';
      model.reason = ranked.reason;
      return model;
    }
    const usable = [];
    const maxAdd = o.maxAdditional == null ? 4 : o.maxAdditional;
    ranked.photos.forEach((r) => {
      const el = photoEligibility(r.photo);
      if (!el.ok) { model.held.push({ file: commonsFile(r.photo && r.photo.sourcePageUrl) || PS.fileName(r.photo), reason: el.reason }); return; }
      const kind = KINDS[r.photo.kind] ? r.photo.kind : 'unclassified';
      usable.push({ photo: r.photo, date: r.date, license: el.license, file: PS.fileName(r.photo) || el.file, kind, author: el.author, exteriorConfirmed: kind === 'exterior' });
    });
    // 周辺の街並みは代表にしない（建物外観のカバー率と混ぜない）
    usable.filter((u) => u.kind === 'surroundings').forEach((u) => model.surroundings.push(u));
    const body = usable.filter((u) => u.kind !== 'surroundings');
    if (!body.length) {
      model.state = model.held.length ? 'license-hold' : 'no-eligible';
      model.reason = model.held.length ? model.held[0].reason : ranked.reason || 'no-eligible-photo';
      return model;
    }
    // 代表: 外観確認済みを最優先。未分類は外観確認済みに数えず、確認済みが無いときだけ代表候補にする（model.exteriorConfirmed=false）
    model.primary = body.find((u) => u.exteriorConfirmed) || body.find((u) => u.kind === 'unclassified') || null;
    if (!model.primary) { model.state = 'no-exterior'; model.reason = 'only-non-exterior'; model.additional = body.slice(0, maxAdd); return model; }
    model.exteriorConfirmed = model.primary.exteriorConfirmed;
    model.additional = body.filter((u) => u !== model.primary).slice(0, maxAdd);
    return model;
  }

  function creditLine(doc, u, opt) {
    const cap = doc.createElement('div');
    cap.className = 'cap';
    cap.setAttribute('data-photo-kind', u.kind);
    const p = u.photo;
    cap.appendChild(doc.createTextNode((opt && opt.kindLabel && KINDS[u.kind] ? '[' + KINDS[u.kind] + '] ' : '') + '作者: ' + (u.author || '索引に作者名の記載なし（Wikimedia Commons のファイルページを参照）') + ' / ライセンス: '));
    const lu = licenseUrl(p.licenseUrl);
    if (lu) { const l = doc.createElement('a'); l.href = lu; l.target = '_blank'; l.rel = 'noopener'; l.textContent = plainText(p.license, 40); cap.appendChild(l); }
    else cap.appendChild(doc.createTextNode(plainText(p.license, 40)));
    cap.appendChild(doc.createTextNode(' / '));
    const s = doc.createElement('a'); s.href = fileHref(u.file); s.target = '_blank'; s.rel = 'noopener'; s.textContent = 'Wikimedia Commons'; cap.appendChild(s);
    cap.appendChild(doc.createTextNode(' / 撮影: '));
    if (u.date && u.date.basis === 'verified' && https(u.date.evidenceUrl)) {
      const d = doc.createElement('a'); d.href = u.date.evidenceUrl; d.target = '_blank'; d.rel = 'noopener'; d.textContent = u.date.takenAt; d.setAttribute('data-photo-taken', u.date.takenAt); cap.appendChild(d);
    } else { const sp = doc.createElement('span'); sp.textContent = '未確認'; sp.setAttribute('data-photo-taken', 'unknown'); cap.appendChild(sp); }
    return cap;
  }

  // 画像の読込失敗時は、別の写真で埋めずに出典リンクだけを示す
  function imgWithFallback(doc, u, alt, holder) {
    const img = doc.createElement('img');
    img.src = commonsImage(u.photo.thumbnailUrl) || ''; img.alt = alt; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      if (!img.isConnected) return;
      const m = doc.createElement('div'); m.className = 'cap'; m.setAttribute('data-photo-error', '1');
      m.appendChild(doc.createTextNode('写真を読み込めませんでした（画像の取得に失敗）。出典: '));
      const a = doc.createElement('a'); a.href = fileHref(u.file); a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Wikimedia Commons'; m.appendChild(a);
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

  return { classifyLicense, plainText, authorText, commonsFile, commonsImage, licenseUrl, photoEligibility, buildModel, render, renderAdditional, KINDS };
});
