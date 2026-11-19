// Mission 37D: 町丁目名の正規化（ブラウザ / Node 共用）
// 表記ゆれ（漢数字・全角数字・空白・「大阪市」「住吉区」接頭辞）を吸収して、
// 検索と境界データの結合に使う比較キーを作る。表示には使わない（表示は常に公式データの表記）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveCityTownNormalize = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KANJI = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

  // 「十二」「二十」「十」→ 数値。上限 99（町丁目の丁目数として十分）。解釈できなければ null。
  function kanjiToInt(s) {
    if (!s || !/^[〇一二三四五六七八九十]+$/.test(s)) return null;
    if (s.indexOf('十') < 0) {
      let n = 0;
      for (const ch of s) n = n * 10 + KANJI[ch];
      return n;
    }
    const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
    if (!m) return null;
    return (m[1] ? KANJI[m[1]] : 1) * 10 + (m[2] ? KANJI[m[2]] : 0);
  }

  // 比較キー: NFKC → 空白除去 → 接頭辞除去 → 「N丁目」の N を算用数字へ。
  // 町名中の漢数字（例: 「四天王寺」「三宅」）は丁目の直前でない限り変換しない。
  function normalizeTownName(input) {
    let s = String(input == null ? '' : input).normalize('NFKC');
    s = s.replace(/[\s　]+/g, '').replace(/[-‐−ー]+(?=\d)/g, '');
    s = s.replace(/^大阪府/, '').replace(/^大阪市/, '');
    s = s.replace(/([〇一二三四五六七八九十]+)(丁目|丁)/g, (all, k, unit) => {
      const n = kanjiToInt(k);
      return n == null ? all : n + '丁目';
    });
    s = s.replace(/(\d+)丁(?!目)/g, '$1丁目');
    return s;
  }

  // 区名接頭辞を外した町丁目名の比較キー（"住吉区長居東4丁目" → "長居東4丁目"）
  function stripWard(key, ward) {
    return ward && key.indexOf(ward) === 0 ? key.slice(ward.length) : key;
  }

  // 「長居東4丁目」→ { base: '長居東', chome: 4 }。丁目が無ければ chome: null。
  function splitTown(key) {
    const m = String(key).match(/^(.*?)(\d+)丁目$/);
    return m ? { base: m[1], chome: +m[2] } : { base: String(key), chome: null };
  }

  // 検索照合。完全一致 > 前方一致 > 部分一致。
  // 「長居東」のように丁目を省略した入力は、その町の全丁目に一致する（前方一致）。
  // ward を明示した入力（"住吉区長居東4丁目"）は ward 接頭辞付きキーとも照合する。
  function matchTown(termKey, rec) {
    if (!termKey) return 0;
    const full = rec.wardKey + rec.key;
    if (termKey === rec.key || termKey === full) return 3;
    if (rec.key.indexOf(termKey) === 0 || full.indexOf(termKey) === 0) return 2;
    if (rec.key.indexOf(termKey) >= 0) return 1;
    return 0;
  }

  return { kanjiToInt, normalizeTownName, stripWard, splitTown, matchTown };
});
