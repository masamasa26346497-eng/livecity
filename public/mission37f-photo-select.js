// Mission 37F: 建物写真の共通選定ロジック（ブラウザ / Node 共用・区に依存しない）
// 採択基準: 「現実の建物に一致する合法な写真の中で、できるだけ新しいもの」
//   1. 適格性（建物との一致 / 権利と帰属 / https / 移転前後の誤結合の除外）を満たさない写真は、新しくても採用しない
//   2. 適格な写真の中で、撮影日が新しいものを優先
//   3. 同順位なら解像度、さらに元の順序（36L の score 順）
// 撮影日の扱い:
//   - 索引（36L）に撮影日の項目は無い。アップロード日も撮影日とみなさない。
//   - 'verified'  : 検証済みの日付表（opts.dates）にあるもの。根拠 URL 付き。表示してよい唯一の日付。
//   - 'filename'  : ファイル名に含まれる年（例 "...2025.jpg", "..._2023-12_1.jpg"）。非検証の目安で、順位付けの補助にだけ使い、画面には出さない。
//   - 'unknown'   : 上記なし。最も新しい可能性として扱わず、日付ありより後ろに置く。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveCityPhotoSelect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEFAULT_OK_CONFIDENCE = ['VERY_HIGH', 'HIGH'];
  const BASIS_RANK = { verified: 2, filename: 1, unknown: 0 };

  const safeHttps = (u) => typeof u === 'string' && /^https:\/\//.test(u);

  // Commons ファイルページ URL → ファイル名（"File:" 以降、デコード済み）
  function fileName(p) {
    const m = String((p && p.sourcePageUrl) || '').match(/File:([^?#]+)$/);
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  // ファイル名から年（と月）の目安を取る。1990〜2039 の 4 桁が、前後を数字で挟まれていないときだけ。
  // 連番や寸法（例 "1024x768"）を年と誤読しないよう、直後に 'x' や 'px' が続く場合は除外する。
  function yearHint(name) {
    const s = String(name || '').replace(/\.[A-Za-z0-9]+$/, '');
    const re = /(?:^|[^0-9])((?:199\d|20[0-3]\d))(?:[-_.,]?(0[1-9]|1[0-2]))?(?![0-9]|\s*x|px)/g;
    let m, best = null;
    while ((m = re.exec(s))) {
      const cand = { year: +m[1], month: m[2] ? +m[2] : null };
      if (!best || cand.year > best.year) best = cand;
    }
    return best;
  }

  // 日付情報: { basis, year, month, evidenceUrl? }
  function dateInfo(p, dates) {
    const f = fileName(p);
    const v = dates && dates[f];
    if (v && v.verified === true && /^\d{4}(-\d{2})?(-\d{2})?$/.test(String(v.takenAt || '')) && safeHttps(v.evidenceUrl)) {
      const [y, mo] = String(v.takenAt).split('-');
      return { basis: 'verified', year: +y, month: mo ? +mo : null, takenAt: v.takenAt, evidenceUrl: v.evidenceUrl };
    }
    const h = yearHint(f);
    if (h) return { basis: 'filename', year: h.year, month: h.month };
    return { basis: 'unknown', year: null, month: null };
  }

  // 適格性。理由を返す（null なら適格）。
  function ineligibleReason(p, ctx) {
    if (!p) return 'no-photo';
    if (!safeHttps(p.thumbnailUrl)) return 'no-https-thumbnail';
    if (!p.license) return 'no-license';
    const f = fileName(p);
    if (ctx.exclude && ctx.exclude.indexOf(f) >= 0) return 'relocation-excluded';
    return null;
  }

  // 日付の新しさ比較用の数値（大きいほど新しい）。unknown は -1。
  const dateScore = (d) => (d.year == null ? -1 : d.year * 100 + (d.month || 0));
  const pixels = (p) => (+p.width || 0) * (+p.height || 0);

  // entry: 索引の byCanonicalId[...] 1 件。
  // opts: { okConfidence, exclude:[ファイル名], dates:{ファイル名:{takenAt,evidenceUrl,verified}} }
  // 戻り値: { eligibleEntry, reason, photos:[{photo,date}], rejected:[{file,reason}] }（photos は優先順）
  function rankPhotos(entry, opts) {
    const o = opts || {};
    const ok = o.okConfidence || DEFAULT_OK_CONFIDENCE;
    const out = { eligibleEntry: false, reason: null, photos: [], rejected: [] };
    if (!entry) { out.reason = 'no-entry'; return out; }
    if (ok.indexOf(entry.matchConfidence) < 0) { out.reason = 'confidence-' + entry.matchConfidence; return out; }
    out.eligibleEntry = true;
    const list = Array.isArray(entry.photos) ? entry.photos : [];
    const kept = [];
    list.forEach((p, i) => {
      const why = ineligibleReason(p, o);
      if (why) { out.rejected.push({ file: fileName(p), reason: why }); return; }
      kept.push({ photo: p, date: dateInfo(p, o.dates), order: i });
    });
    // 並べ替えは「より新しい日付の根拠がある」ときだけ。日付が同じ/不明どうしは 36L の元の順序(score 順)を保つ。
    // 解像度は、日付が既知で同じ(同年月)の写真どうしの決め手にだけ使う。
    // 検証済みの日付を最優先。ファイル名の年(非検証)が検証済みの日付より前に来ることはない。
    kept.sort((a, b) =>
      (BASIS_RANK[b.date.basis] - BASIS_RANK[a.date.basis]) ||
      (dateScore(b.date) - dateScore(a.date)) ||
      (a.date.year != null ? pixels(b.photo) - pixels(a.photo) : 0) ||
      (a.order - b.order));
    out.photos = kept.map((k) => ({ photo: k.photo, date: k.date }));
    if (!out.photos.length) out.reason = 'no-eligible-photo';
    return out;
  }

  return { fileName, yearHint, dateInfo, rankPhotos, DEFAULT_OK_CONFIDENCE };
});
