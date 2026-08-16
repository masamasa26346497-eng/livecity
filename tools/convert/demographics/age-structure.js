// tools/convert/demographics/age-structure.js
// 第3表（男女，年齢（5歳階級）別人口，平均年齢及び総年齢）のXLSX -> 構造化JSON変換。
//
// 【実ファイル構造】2026年6月にアップロードされた実ファイルを直接調査して確認済み:
// - シート名「第3表」（1番目のシート「【利用上の注意】」ではない）
// - 列1「男女」: 各町丁目につき"総数"/"男"/"女"の3行が存在する。本変換では"総数"行のみを対象にする
//   （男女別の年齢構成は今回の対象外）。
// - 列4「地域階層レベル」: 値が4の行のみが町丁目単位の最小粒度レコード（他はpopulation-households.js
//   と同じ理由で除外）。
// - 列13〜33: 5歳階級別人口（0～4歳, 5～9歳, ..., 100歳以上）。21区分。
// - 列34: 年齢「不詳」
// - 列35〜40: （再掲）15歳未満・15～64歳・65歳以上・75歳以上・85歳以上・20～69歳
// - 列41: 総年齢、列42: 平均年齢
// - 列番号は固定位置に依存せず、見出し名（5歳階級の表記そのもの）から動的に検出する。
import { readXlsxSheet, getSheetNames } from '../../lib/xlsx.js';
import { normalizeChochoCode } from '../../lib/chocho-normalize.js';

// 秘匿値を示すマーカーは「X」「x」のみ。総務省統計局の公式「利用上の注意」によれば、
// 「-」は「該当数字がない（＝0、皆無）」を意味し、秘匿ではない（秘匿は数値を「X」に
// 置き換えることで示される）。このマーカーを誤って秘匿扱いすると、実際は0人である
// 値がnullになり、年齢区分の合算結果が不正確になる（実際にこの誤りが原因で発覚した）。
const SUPPRESSED_MARKERS = new Set(['X', 'x', '秘匿']);
const ZERO_MARKERS = new Set(['-', '－', '―']);

function parseNumericCell(raw) {
  if (raw == null || raw === '') return { value: null, suppressed: false, empty: true };
  const trimmed = String(raw).trim();
  if (SUPPRESSED_MARKERS.has(trimmed)) return { value: null, suppressed: true, empty: false };
  if (ZERO_MARKERS.has(trimmed)) return { value: 0, suppressed: false, empty: false };
  const n = Number(trimmed.replace(/,/g, ''));
  if (Number.isNaN(n)) return { value: null, suppressed: false, empty: false, unparseable: true };
  return { value: n, suppressed: false, empty: false };
}

function normalizeHeaderText(s) {
  return (s || '').replace(/[\r\n\s　]/g, '');
}

function findColumnIndex(majorRow, minorRow, majorPatterns, minorPatterns) {
  for (let i = 0; i < Math.max(majorRow.length, minorRow.length); i++) {
    const major = normalizeHeaderText(majorRow[i]);
    const minor = normalizeHeaderText(minorRow[i]);
    if (!minorPatterns) {
      const matchesEither = majorPatterns.some((p) => (p instanceof RegExp ? p.test(major) || p.test(minor) : major.includes(p) || minor.includes(p)));
      if (matchesEither) return i;
      continue;
    }
    const majorMatch = majorPatterns.some((p) => (p instanceof RegExp ? p.test(major) : major.includes(p)));
    if (!majorMatch) continue;
    const minorMatch = minorPatterns.some((p) => (p instanceof RegExp ? p.test(minor) : minor.includes(p)));
    if (minorMatch) return i;
  }
  return -1;
}

// 5歳階級の見出し文字列(例: "0～4歳", "100歳以上")に一致する列を、人口の大見出し配下から
// すべて検出する。固定の開始/終了列番号は使わず、見出しパターンで動的に集める。
const FIVE_YEAR_BRACKET_PATTERN = /^(\d+)[～-](\d+)歳$|^(\d+)歳以上$/;

function detectFiveYearBracketColumns(majorRow, minorRow) {
  const brackets = []; // [{colIndex, lower, upper(またはInfinity)}]
  for (let i = 0; i < Math.max(majorRow.length, minorRow.length); i++) {
    const major = normalizeHeaderText(majorRow[i]);
    const minor = normalizeHeaderText(minorRow[i]);
    if (!major.includes('人口')) continue; // 「人口」大見出し配下のみ対象
    if (minor.includes('再掲') || minor.includes('不詳')) continue; // 再掲・不詳列は別扱い
    const m = minor.match(FIVE_YEAR_BRACKET_PATTERN);
    if (!m) continue;
    if (m[3] != null) {
      brackets.push({ colIndex: i, lower: Number(m[3]), upper: Infinity }); // "100歳以上"
    } else {
      brackets.push({ colIndex: i, lower: Number(m[1]), upper: Number(m[2]) });
    }
  }
  return brackets;
}

function detectHeaderAndColumns(rows) {
  let minorRowIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const normalized = rows[i].map(normalizeHeaderText);
    if (normalized.some((c) => c.includes('市区町村コード') || c.includes('町丁字コード'))) {
      minorRowIndex = i;
      break;
    }
  }
  if (minorRowIndex === -1) {
    throw new Error('見出し行（"市区町村コード"を含む行）が見つかりません。');
  }
  const majorRowIndex = minorRowIndex - 1;
  const majorRow = rows[majorRowIndex] || [];
  const minorRow = rows[minorRowIndex] || [];

  const columns = {
    sex: findColumnIndex(majorRow, minorRow, ['男女'], null),
    municipalityCode: findColumnIndex(majorRow, minorRow, ['市区町村コード'], null),
    chochoCode: findColumnIndex(majorRow, minorRow, ['町丁字コード'], null),
    regionLevel: findColumnIndex(majorRow, minorRow, ['地域階層レベル'], null),
    municipalityName: findColumnIndex(majorRow, minorRow, ['市区町村名'], null),
    townName: findColumnIndex(majorRow, minorRow, ['大字・町名', '大字町名'], null),
    chomeName: findColumnIndex(majorRow, minorRow, ['字・丁目名', '字丁目名'], null),
    totalPopulation: findColumnIndex(majorRow, minorRow, ['人口'], ['総数']),
  };

  const missing = Object.entries(columns).filter(([, idx]) => idx === -1).map(([key]) => key);
  if (missing.length) {
    throw new Error(`次の列が見出し名から検出できませんでした: ${missing.join(', ')}`);
  }

  const fiveYearBrackets = detectFiveYearBracketColumns(majorRow, minorRow);
  if (fiveYearBrackets.length === 0) {
    throw new Error('5歳階級の年齢列が1つも検出できませんでした。見出し表記が想定と異なる可能性があります。');
  }

  return { columns, fiveYearBrackets, headerEndRowIndex: minorRowIndex };
}

function extractWard(municipalityName) {
  if (!municipalityName) return null;
  const m = municipalityName.match(/大阪市(.+区)$/);
  return m ? m[1] : null;
}

/**
 * 5歳階級の値配列(各要素 {lower, upper, value, suppressed}) から、ご依頼の年齢区分
 * (0-14, 15-24, 25-39, 40-64, 65-74, 75+) へ合算する。
 * 合算対象の階級に1つでも秘匿(suppressed)があれば、その区分全体もsuppressed:trueとし、
 * 値を推測で埋めない（一部の階級だけ秘匿で残りを合算する、という不正確な値を作らないため）。
 */
const TARGET_BRACKETS = [
  { key: 'age0to14', lower: 0, upper: 14 },
  { key: 'age15to24', lower: 15, upper: 24 },
  { key: 'age25to39', lower: 25, upper: 39 },
  { key: 'age40to64', lower: 40, upper: 64 },
  { key: 'age65to74', lower: 65, upper: 74 },
  { key: 'age75plus', lower: 75, upper: Infinity },
];

function aggregateAgeBrackets(fiveYearValues) {
  const result = {};
  for (const target of TARGET_BRACKETS) {
    const contributing = fiveYearValues.filter((b) => b.lower >= target.lower && b.lower <= target.upper);
    if (contributing.length === 0) {
      result[target.key] = null;
      result[`${target.key}Suppressed`] = false;
      result[`${target.key}MissingReason`] = 'no-contributing-bracket-found';
      continue;
    }
    const anySuppressed = contributing.some((b) => b.suppressed);
    if (anySuppressed) {
      result[target.key] = null;
      result[`${target.key}Suppressed`] = true;
    } else {
      result[target.key] = contributing.reduce((sum, b) => sum + (b.value || 0), 0);
      result[`${target.key}Suppressed`] = false;
    }
  }
  return result;
}

/**
 * 年少人口比率・生産年齢人口比率・高齢化率を計算する（livecity-calculated）。
 * 総人口が秘匿/欠損、または分子側の区分が秘匿の場合は計算しない。
 */
function calculateAgeRatios(ageBrackets, totalPopulation) {
  const ratios = {};
  const youngPop = ageBrackets.age0to14; // 年少人口(0-14歳)
  // 生産年齢人口(15-64歳) = 15-24歳+25-39歳+40-64歳の合算。3区分すべてが揃っている場合のみ計算する。
  const productiveAgePop = (ageBrackets.age15to24 != null && ageBrackets.age25to39 != null && ageBrackets.age40to64 != null)
    ? ageBrackets.age15to24 + ageBrackets.age25to39 + ageBrackets.age40to64
    : null;
  const elderlyPop = (ageBrackets.age65to74 != null && ageBrackets.age75plus != null) ? ageBrackets.age65to74 + ageBrackets.age75plus : null;

  function ratioOrNull(numerator, denominator) {
    if (numerator == null || denominator == null || denominator === 0) return null;
    return Math.round((numerator / denominator) * 1000) / 10;
  }

  ratios.youngPopulationRatio = ratioOrNull(youngPop, totalPopulation);
  ratios.productiveAgePopulationRatio = ratioOrNull(productiveAgePop, totalPopulation);
  ratios.agingRatio = ratioOrNull(elderlyPop, totalPopulation);
  ratios.elderlyPopulation = elderlyPop;
  ratios.productiveAgePopulation = productiveAgePop;
  return ratios;
}

/**
 * 第3表形式のXLSXシート(2次元配列)を変換する。"総数"行（男女合計）のみを対象にする。
 */
export function convertAgeStructureTable(rows, targetWards) {
  const { columns, fiveYearBrackets, headerEndRowIndex } = detectHeaderAndColumns(rows);
  const dataRows = rows.slice(headerEndRowIndex + 1);

  const records = [];
  const skippedRows = [];

  for (const row of dataRows) {
    if (!row || row.every((c) => c === '' || c == null)) {
      skippedRows.push({ reason: 'empty-row' });
      continue;
    }

    const sexValue = (row[columns.sex] || '').trim();
    if (sexValue !== '総数') {
      skippedRows.push({ reason: 'sex-breakdown-row', sex: sexValue }); // 男/女別行は対象外
      continue;
    }

    const regionLevel = Number((row[columns.regionLevel] || '').trim());
    if (regionLevel !== 4) {
      skippedRows.push({
        reason: regionLevel === 1 ? 'municipality-total-row' : regionLevel <= 3 ? 'subtotal-row' : 'unknown-region-level',
        regionLevel: row[columns.regionLevel],
      });
      continue;
    }

    const municipalityName = (row[columns.municipalityName] || '').trim();
    const ward = extractWard(municipalityName);
    if (!ward) {
      skippedRows.push({ reason: 'non-osaka-city-row', municipalityName });
      continue;
    }
    if (targetWards && targetWards.length && !targetWards.includes(ward)) {
      skippedRows.push({ reason: 'ward-not-in-target', ward });
      continue;
    }

    const townName = (row[columns.townName] || '').trim();
    const chomeName = (row[columns.chomeName] || '').trim();
    const chochoName = `${townName}${chomeName}`;
    if (!chochoName) {
      skippedRows.push({ reason: 'empty-chocho-name', ward });
      continue;
    }

    const totalPopCell = parseNumericCell(row[columns.totalPopulation]);
    const fiveYearValues = fiveYearBrackets.map((b) => {
      const cell = parseNumericCell(row[b.colIndex]);
      return { lower: b.lower, upper: b.upper, value: cell.value, suppressed: cell.suppressed };
    });

    const ageBrackets = aggregateAgeBrackets(fiveYearValues);
    const totalPopulation = totalPopCell.suppressed ? null : totalPopCell.value;
    const ratios = calculateAgeRatios(ageBrackets, totalPopulation);

    records.push({
      ward,
      chochoName,
      fullChochoName: `${ward}${chochoName}`,
      chochoCode: normalizeChochoCode((row[columns.chochoCode] || '').trim()) || null,
      totalPopulation,
      totalPopulationSuppressed: totalPopCell.suppressed,
      ...ageBrackets,
      productiveAgePopulation: ratios.productiveAgePopulation,
      elderlyPopulation: ratios.elderlyPopulation,
      youngPopulationRatio: ratios.youngPopulationRatio,
      productiveAgePopulationRatio: ratios.productiveAgePopulationRatio,
      agingRatio: ratios.agingRatio,
      ratioValueType: 'livecity-calculated',
      valueType: 'official',
    });
  }

  return { records, skippedRows, columns, fiveYearBrackets };
}

export function convertAgeStructureXlsx(buffer, targetWards) {
  const sheetNames = getSheetNames(buffer);
  const targetSheetName = sheetNames.find((n) => n === '第3表') || sheetNames.find((n) => /第3表/.test(n || ''));
  if (!targetSheetName) {
    throw new Error(`"第3表"という名前のシートが見つかりません。存在するシート: ${sheetNames.join(', ')}`);
  }
  const rows = readXlsxSheet(buffer, targetSheetName);
  return convertAgeStructureTable(rows, targetWards);
}
