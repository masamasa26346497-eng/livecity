// tools/lib/chocho-normalize.js
// 町丁目名の表記ゆれを吸収する正規化処理。
// 地域コードでの結合を最優先とし、これは「正規化名称」でのフォールバック結合（優先順位3）専用。

// 漢数字 -> 算用数字（丁目表記で使われる範囲、一〜十まで対応。十一以上は稀なため複合パターンで対応）
const KANJI_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function kanjiToArabicChome(s) {
  // 「十」を挟む2桁パターン（十一〜十九、二十など）を先に処理する
  return s.replace(/([一二三四五六七八九]?)十([一二三四五六七八九]?)丁目/g, (_, tens, ones) => {
    const t = tens ? KANJI_NUM[tens] : 1;
    const o = ones ? KANJI_NUM[ones] : 0;
    return `${t * 10 + o}丁目`;
  }).replace(/([一二三四五六七八九])丁目/g, (_, d) => `${KANJI_NUM[d]}丁目`);
}

/**
 * 町丁目名を正規化する。
 * - 全角数字 -> 半角数字
 * - 漢数字の丁目表記 -> 算用数字
 * - 「ヶ」「ケ」「が」の異体字を統一
 * - 前後・内部の空白除去
 * - 旧字体の一部（代表的なもののみ、網羅はしない）を新字体へ
 */
export function normalizeChochoName(name) {
  if (!name) return '';
  let s = name;

  // 全角数字 -> 半角数字
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

  // 漢数字丁目 -> 算用数字丁目
  s = kanjiToArabicChome(s);

  // 「ヶ」「ケ」「丶ケ」等の異体字をすべて「ケ」に統一（例: 茶屋ヶ丘 / 茶屋ケ丘）
  s = s.replace(/[ヶゕガケが]/g, 'ケ');

  // 空白（全角・半角）を除去
  s = s.replace(/[\s　]/g, '');

  // 代表的な旧字体 -> 新字体（網羅的ではなく、町丁目名に出現しやすいもののみ）
  const oldToNew = { 澤: '沢', 廣: '広', 髙: '高', 﨑: '崎' };
  for (const [oldChar, newChar] of Object.entries(oldToNew)) {
    s = s.split(oldChar).join(newChar);
  }

  return s;
}

/**
 * 2つの町丁目名が正規化後に一致するか判定する。
 */
export function chochoNamesMatch(a, b) {
  return normalizeChochoName(a) === normalizeChochoName(b);
}

/**
 * 町丁字コードを6桁にゼロパディングする。
 * 【背景】国勢調査小地域集計XLSXの「町丁字コード」列は先頭ゼロを省略した形式
 * (例: "1001", "24003")だが、e-StatのKEY_CODE(標準地域コード)の町丁字コード部分は
 * 6桁ゼロパディング形式(例: "001001", "024003")である。実データで両者を比較し
 * (南住吉一丁目: "1001"⇔"001001"、杉本三丁目: "24003"⇔"024003"等)、6桁ゼロパディングが
 * 正しい対応関係であることを確認済み。この変換により、XLSX由来のコードとKEY_CODE由来の
 * コードを同一の複合キー(municipalityCode:chochoCode)で比較できるようにする。
 * @param {string|null} code
 * @returns {string|null}
 */
export function normalizeChochoCode(code) {
  if (!code) return null;
  const trimmed = String(code).trim();
  if (!/^\d+$/.test(trimmed)) return trimmed; // 数字以外を含む特殊コードはそのまま返す
  if (trimmed.length >= 6) return trimmed;
  return trimmed.padStart(6, '0');
}

/**
 * CSV/XLSXのヘッダーセルを、見出し判定用に正規化する(町丁目名の正規化とは別の関数)。
 * 次を行う:
 * - 全角数字を半角数字へ変換
 * - 全角空白・半角空白・改行を除去
 * - 括弧の表記差(（）と()、〔〕等)を吸収（除去）
 * - ハイフン・長音・波ダッシュの表記差(-,－,―,~,〜)を統一(除去)
 * - 注釈記号(*1, ※1, (注), 1)等の脚注番号)を除去
 * 【重要】数字の除去は行わない（"1人"の"1"等、見出しの意味を構成する数字は残す必要がある）。
 * 除去するのは記号・空白・括弧のみであり、数字そのものは正規化(全角→半角)するだけで保持する。
 * @param {string} s
 * @returns {string}
 */
export function normalizeHeaderForMatching(s) {
  if (!s) return '';
  let result = String(s);

  // 全角数字 -> 半角数字
  result = result.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));

  // 改行・空白(全角・半角)を除去
  result = result.replace(/[\r\n\s　]/g, '');

  // 括弧類を除去(中身は残す。例: "世帯人員(7区分)" -> "世帯人員7区分")
  result = result.replace(/[（）()〔〕\[\]【】]/g, '');

  // ハイフン・長音・波ダッシュ・中点の表記差を除去(項目名の区切りとしての役割のみのため)
  result = result.replace(/[-－―~〜・]/g, '');

  // 脚注番号・注釈記号(例: "*1", "※1", "注1", "1)", 上付き数字相当)を除去。
  // ただし見出し本体の意味を構成する数字(1人世帯の"1"等)は既に上の処理を通過済みであり、
  // ここでは「*」「※」「注」という記号そのもの、およびそれに続く脚注番号のみを対象にする。
  result = result.replace(/[*※]\d*/g, '');
  result = result.replace(/注\d*/g, '');

  return result;
}

/**
 * 内部項目キーごとの見出し別名候補。正規化後の文字列で部分一致を取るが、
 * 数字を含む項目(1人〜7人等)については、隣接する数字を誤って含まない厳密な境界一致を行う
 * （例: "15人"を"5人"と誤認しない）。
 */
export const HOUSEHOLD_COMPOSITION_HEADER_ALIASES = {
  generalHouseholds: ['一般世帯数', '一般世帯総数', '一般世帯の総数', '総数'],
  onePerson: ['世帯人員が1人', '1人世帯', '1人の一般世帯', '世帯人員1人'],
  twoPerson: ['世帯人員が2人', '2人世帯', '2人の一般世帯', '世帯人員2人'],
  threePerson: ['世帯人員が3人', '3人世帯', '3人の一般世帯', '世帯人員3人'],
  fourPerson: ['世帯人員が4人', '4人世帯', '4人の一般世帯', '世帯人員4人'],
  fivePerson: ['世帯人員が5人', '5人世帯', '5人の一般世帯', '世帯人員5人'],
  sixPerson: ['世帯人員が6人', '6人世帯', '6人の一般世帯', '世帯人員6人'],
  sevenOrMorePerson: ['世帯人員が7人以上', '7人以上世帯', '7人以上の一般世帯', '世帯人員7人以上'],
  personsPerHousehold: ['1世帯当たり人員', '一般世帯の1世帯当たり人員'],
};

/**
 * 数字を含む見出し別名候補に対して、誤った部分一致(「15人」を「5人」と誤認する等)を
 * 避けるための一致判定。別名候補自体を正規化した上で、対象文字列に「別名の前後が数字で
 * 連続していない位置」で出現するかを確認する。
 * @param {string} normalizedTarget 正規化済みの対象文字列(ヘッダーセル)
 * @param {string} alias 正規化前の別名候補
 * @returns {boolean}
 */
export function headerMatchesAlias(normalizedTarget, alias) {
  const normalizedAlias = normalizeHeaderForMatching(alias);
  if (!normalizedAlias) return false;
  let searchFrom = 0;
  while (true) {
    const idx = normalizedTarget.indexOf(normalizedAlias, searchFrom);
    if (idx === -1) return false;
    const before = idx > 0 ? normalizedTarget[idx - 1] : '';
    const afterIdx = idx + normalizedAlias.length;
    const after = afterIdx < normalizedTarget.length ? normalizedTarget[afterIdx] : '';
    // 別名候補の先頭・末尾が数字で始まる/終わる場合、直前/直後が数字だと誤った連結
    // (例: 別名"5人"が対象"15人"の一部に一致する誤検出)になるため、これを除外する。
    const aliasStartsWithDigit = /^\d/.test(normalizedAlias);
    const aliasEndsWithDigit = /\d$/.test(normalizedAlias);
    const invalidBefore = aliasStartsWithDigit && /\d/.test(before);
    const invalidAfter = aliasEndsWithDigit && /\d/.test(after);
    if (!invalidBefore && !invalidAfter) return true;
    searchFrom = idx + 1; // この出現は無効。次の出現を探す
  }
}
