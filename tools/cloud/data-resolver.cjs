'use strict';
// Mission 202: 2025 データ配信 URL 解決レイヤー(Node/ブラウザ両用の純関数。ネットワークは使わない)。
//  - 既定: 同一 origin の `ext-3dtiles/`(Vercel 静的配信)。
//  - opt-in: 明示 dataBaseUrl のみ。https + 完全一致ホスト allowlist + 資格情報/クエリ/ハッシュ/`..` 禁止。
//  - どの失敗でも旧 45D / 組み込みデータへ fallback しない(fail closed)。resolve は ok:false と理由コードを返すだけ。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LCCloudData = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WARD_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const SHA_RE = /^[0-9a-f]{64}$/;
  const DEFAULT_BASE = 'ext-3dtiles/';
  const fail = (code, detail) => ({ ok: false, code, detail: detail || '', fallback: 'none' });

  // 既定は同一 origin。dataBaseUrl があれば allowlist(ホスト完全一致)を必須とする。
  function resolveBase({ dataBaseUrl = null, allowlist = [] } = {}) {
    if (dataBaseUrl == null || dataBaseUrl === '') return { ok: true, base: DEFAULT_BASE, external: false, origin: 'same-origin' };
    let u;
    try { u = new URL(String(dataBaseUrl)); } catch (e) { return fail('bad-url', 'URL として解釈できない'); }
    if (u.protocol !== 'https:') return fail('not-https', u.protocol);
    if (u.username || u.password) return fail('credentials-in-url');
    if (u.search || u.hash) return fail('query-or-hash-in-url');
    if (!Array.isArray(allowlist) || !allowlist.length) return fail('allowlist-empty', 'allowlist 無しの外部 origin は拒否');
    const hosts = allowlist.map((h) => String(h).toLowerCase());
    if (hosts.some((h) => h.includes('*') || h.includes('/') || h.includes(':'))) return fail('allowlist-invalid', 'ホスト完全一致のみ(ワイルドカード/パス/ポート不可)');
    if (!hosts.includes(u.hostname.toLowerCase())) return fail('host-not-allowed', u.hostname);
    if (u.port) return fail('port-not-allowed', u.port);
    // URL パーサは ".." を正規化して消すので、生の文字列で dot-segment(%2e 含む)を検査する。
    if (/\/(\.|%2e){1,2}(\/|$)/i.test(String(dataBaseUrl).replace(/^https:\/\/[^/]*/i, ''))) return fail('path-traversal');
    const segs = decodeURIComponent(u.pathname).split('/');
    if (segs.includes('..') || segs.includes('.')) return fail('path-traversal');
    const base = u.origin + (u.pathname.endsWith('/') ? u.pathname : u.pathname + '/');
    return { ok: true, base, external: true, origin: u.origin };
  }

  function wardTilesetUrl(base, ward) {
    if (!WARD_RE.test(ward || '')) return fail('bad-ward-id', String(ward));
    return { ok: true, url: base + ward + '/tileset.json' };
  }

  // tileset 内 content.uri の検証: 相対・.glb/.json のみ・区ディレクトリ外へ出ない。
  function resolveContentUri(base, ward, uri) {
    if (!WARD_RE.test(ward || '')) return fail('bad-ward-id', String(ward));
    if (typeof uri !== 'string' || !uri) return fail('bad-uri');
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('//') || uri.startsWith('/') || uri.includes('\\')) return fail('uri-not-relative', uri);
    if (/[?#]/.test(uri)) return fail('uri-has-query', uri);
    let dec; try { dec = decodeURIComponent(uri); } catch (e) { return fail('bad-uri'); }
    const segs = dec.split('/');
    if (segs.includes('..') || segs.includes('.') || segs.includes('')) return fail('path-traversal', uri);
    if (!/\.(glb|json)$/.test(dec)) return fail('uri-extension', uri);
    return { ok: true, url: base + ward + '/' + dec, rel: dec };
  }

  // index.json: 24 区全て(重複なし)・served/not-served を厳格に判定。served は tileset 必須、not-served は null 必須。
  function validateIndex(idx, { expectedWards = 24 } = {}) {
    const problems = [];
    if (!idx || typeof idx !== 'object') return { ok: false, problems: ['index が object ではない'], wards: [] };
    if (Number(idx.vintage) !== 2025) problems.push('vintage != 2025');
    if (!Array.isArray(idx.wards)) problems.push('wards が配列ではない');
    const wards = Array.isArray(idx.wards) ? idx.wards : [];
    if (wards.length !== expectedWards) problems.push('wards 件数 ' + wards.length + ' != ' + expectedWards);
    const seen = new Set();
    for (const w of wards) {
      if (!w || !WARD_RE.test(w.ward || '')) { problems.push('ward id 不正'); continue; }
      if (seen.has(w.ward)) problems.push('重複: ' + w.ward);
      seen.add(w.ward);
      if (w.status === 'served') { if (w.tileset !== w.ward + '/tileset.json') problems.push(w.ward + ': served なのに tileset が不正'); }
      else if (w.status === 'not-served') { if (w.tileset !== null) problems.push(w.ward + ': not-served なのに tileset あり'); }
      else problems.push(w.ward + ': status 不正');
    }
    const served = wards.filter((w) => w.status === 'served').length;
    if (Number.isFinite(idx.servedCount) && idx.servedCount !== served) problems.push('servedCount 不一致');
    return { ok: problems.length === 0, problems, wards, servedCount: served, totalWards: wards.length };
  }

  // 区選択の状態。未配信は「2025データ未配信・配信準備中」。index が不正なら選択自体を許さない(unknown)。
  const NOT_SERVED_MESSAGE = '2025データ未配信・配信準備中';
  function describeSelection(idx, ward) {
    const v = validateIndex(idx);
    if (!v.ok) return { state: 'unknown', canRender: false, message: 'index.json を検証できないため描画しません(' + v.problems[0] + ')' };
    const w = v.wards.find((x) => x.ward === ward);
    if (!w) return { state: 'unknown', canRender: false, message: '不明な区: ' + ward };
    if (w.status === 'served') return { state: 'served', canRender: true, message: '', tileset: w.tileset };
    return { state: 'not-served', canRender: false, message: NOT_SERVED_MESSAGE };
  }

  // 区ごと manifest(assets に sha256/bytes)。vintage=2025・ward 一致・出典・整合性情報を要求。
  function validateWardManifest(m, ward, { requireNotSynthetic = false } = {}) {
    const problems = [];
    if (!m || typeof m !== 'object') return { ok: false, problems: ['manifest が object ではない'] };
    if (m.ward !== ward) problems.push('ward 不一致: ' + m.ward + ' != ' + ward);
    if (Number(m.vintage) !== 2025) problems.push('vintage != 2025');
    if (!m.source || !/PLATEAU/.test(String(m.source.attribution || ''))) problems.push('出典(PLATEAU 帰属)が無い');
    if (/OSM|OpenStreetMap/i.test(JSON.stringify(m.source || {}))) problems.push('OSM 混在の疑い');
    if (!m.contentVersion || !SHA_RE.test(m.contentVersion)) problems.push('contentVersion(sha256)が無い');
    if (!Array.isArray(m.assets) || !m.assets.length) problems.push('assets が空');
    else for (const a of m.assets) {
      if (resolveContentUri('x/', ward, a && a.path).ok !== true) problems.push('asset path 不正: ' + (a && a.path));
      else if (!SHA_RE.test(a.sha256 || '') || !(a.bytes > 0)) problems.push('asset 整合性情報不正: ' + a.path);
    }
    if (m.synthetic === true && requireNotSynthetic) problems.push('synthetic fixture は 2025 実源として扱えない');
    return { ok: problems.length === 0, problems, synthetic: m.synthetic === true };
  }

  async function sha256Hex(bytes) {
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || require('node:crypto').webcrypto.subtle;
    const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
    return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function verifyAsset(bytes, asset) {
    if (bytes.byteLength !== asset.bytes) return fail('size-mismatch', asset.path);
    if ((await sha256Hex(bytes)) !== asset.sha256) return fail('sha-mismatch', asset.path);
    return { ok: true };
  }

  // contentVersion = 全 asset の (path,sha256,bytes) を path 順に連結した sha256。CDN キャッシュ破棄用の版キー。
  async function contentVersionOf(assets) {
    const s = assets.slice().sort((a, b) => (a.path < b.path ? -1 : 1)).map((a) => a.path + ':' + a.sha256 + ':' + a.bytes).join('\n');
    return sha256Hex(new TextEncoder().encode(s));
  }

  return { DEFAULT_BASE, NOT_SERVED_MESSAGE, resolveBase, wardTilesetUrl, resolveContentUri, validateIndex, describeSelection, validateWardManifest, verifyAsset, sha256Hex, contentVersionOf };
});
