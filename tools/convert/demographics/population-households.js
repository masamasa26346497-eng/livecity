// tools/convert/demographics/population-households.js
// 第2表（男女別人口，外国人人口及び世帯数）のXLSX -> 構造化JSON変換。
//
// 【重要】実際の大阪市XLSX（2026年6月に取得した実ファイルで構造を直接確認済み）は、
// 当初想定していた「固定6列・2行ヘッダー」とは異なり、次の特徴を持つ:
// - シート名は「第2表」（1番目のシート「【利用上の注意】」ではない）
// - 1〜3行目: タイトル・注記行（データではない）
// - 4〜5行目: 2行構成のヘッダー（4行目=大見出し「人口」等、5行目=小見出し「総数」「男」「女」等）
// - 6行目以降: データ行。ただし「地域階層レベル」列の値によって、市区町村単位の合計行(レベル1)、
//   大字・町丁単位の小計行(レベル2-3)、丁目単位の最小粒度行(レベル4)が混在している。
//   町丁目レコードとして扱うべきはレベル4のみ。
// - 列構成は固定位置に依存せず、ヘッダーの見出し名から動的に検出する（列がずれても対応できる）。
import { readXlsxSheet, getSheetNames } from '../../lib/xlsx.js';
import { normalizeChochoCode } from '../../lib/chocho-normalize.js';

// 秘匿値・データなしを示す典型的なマーカー。これらは0や欠落として扱わず、
// suppressed:true の明示的なnullとして保持する。
// 秘匿値を示すマーカーは「X」「x」のみ。総務省統計局の公式「利用上の注意」によれば、
// 「-」は「該当数字がない（＝0、皆無）」を意味し、秘匿ではない（age-structure.jsの実装時に
// 公式ドキュメントで確認し、こちらも同様に修正した）。
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

// ヘッダーのセル内改行(\r\n)や全角スペースを除去し、見出し名の比較を安定させる。
function normalizeHeaderText(s) {
  return (s || '').replace(/[\r\n\s　]/g, '');
}

/**
 * 2行構成のヘッダー(majorRow, minorRow)から、見出し名でマッチする列インデックスを検出する。
 * majorPattern/minorPattern は正規表現または文字列の配列（いずれかに一致すればOK）。
 * minorPatternを省略した場合はmajorRowの見出し名だけで判定する（市区町村コード等の単独見出し列）。
 */
function findColumnIndex(majorRow, minorRow, majorPatterns, minorPatterns) {
  for (let i = 0; i < Math.max(majorRow.length, minorRow.length); i++) {
    const major = normalizeHeaderText(majorRow[i]);
    const minor = normalizeHeaderText(minorRow[i]);
    if (!minorPatterns) {
      // 単独見出し列（市区町村コード等）。実ファイルによってこの見出しが大見出し行・
      // 小見出し行のどちらに入っているか異なる可能性があるため、両方を検索対象にする。
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

/**
 * ヘッダー2行を探索し、各項目の列インデックスを検出する。
 * 行位置を固定値で決めつけず、「市区町村コード」等の見出し文字列が現れる行を
 * ヘッダー行として認識する。
 */
function detectHeaderAndColumns(rows) {
  // 「市区町村コード」「町丁字コード」等の単独見出しが現れる行を「ヘッダー小見出し行」とみなす。
  // その直前の行を「ヘッダー大見出し行」とする（実ファイルでは5行目が小見出し、4行目が大見出し）。
  let minorRowIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const normalized = rows[i].map(normalizeHeaderText);
    if (normalized.some((c) => c.includes('市区町村コード') || c.includes('町丁字コード'))) {
      minorRowIndex = i;
      break;
    }
  }
  if (minorRowIndex === -1) {
    throw new Error(
      '見出し行（"市区町村コード"を含む行）が見つかりません。先頭20行以内にヘッダーがない、' +
      'またはシート構造が想定と異なります。'
    );
  }
  const majorRowIndex = minorRowIndex - 1;
  const majorRow = rows[majorRowIndex] || [];
  const minorRow = rows[minorRowIndex] || [];

  const columns = {
    municipalityCode: findColumnIndex(majorRow, minorRow, ['市区町村コード'], null),
    chochoCode: findColumnIndex(majorRow, minorRow, ['町丁字コード'], null),
    regionLevel: findColumnIndex(majorRow, minorRow, ['地域階層レベル'], null),
    municipalityName: findColumnIndex(majorRow, minorRow, ['市区町村名'], null),
    townName: findColumnIndex(majorRow, minorRow, ['大字・町名', '大字町名'], null),
    chomeName: findColumnIndex(majorRow, minorRow, ['字・丁目名', '字丁目名'], null),
    population: findColumnIndex(majorRow, minorRow, ['人口'], ['総数']),
    malePopulation: findColumnIndex(majorRow, minorRow, ['人口'], [/^男$/]),
    femalePopulation: findColumnIndex(majorRow, minorRow, ['人口'], [/^女$/]),
    foreignPopulation: findColumnIndex(majorRow, minorRow, ['外国人人口'], null),
    households: findColumnIndex(majorRow, minorRow, ['世帯数'], null),
  };

  const missing = Object.entries(columns).filter(([, idx]) => idx === -1).map(([key]) => key);
  if (missing.length) {
    throw new Error(`次の列が見出し名から検出できませんでした: ${missing.join(', ')}`);
  }

  return { columns, headerEndRowIndex: minorRowIndex, majorRowIndex, minorRowIndex };
}

/**
 * 市区町村名(例: "大阪市都島区", "大阪市住吉区")から区名を抽出する。
 * 大阪市以外の市区町村名（他都市比較用データ等が混在する場合）も考慮し、
 * 末尾の「区」までを区名として扱う。
 */
function extractWard(municipalityName) {
  if (!municipalityName) return null;
  const m = municipalityName.match(/大阪市(.+区)$/);
  return m ? m[1] : null; // 大阪市以外の行はnullになる（対象外として後段でフィルタされる）
}

/**
 * 第2表形式のXLSXシート(2次元配列)を変換する。
 * @param {string[][]} rows readXlsxSheetの出力（"第2表"シート）
 * @param {string[]} [targetWards] 抽出対象の区名リスト（例: ['住吉区','東住吉区','平野区']）。
 *   省略時は大阪市の全区を対象にする。
 * @returns {{records: object[], skippedRows: object[], columns: object}}
 */
export function convertPopulationHouseholdsTable(rows, targetWards) {
  const { columns, headerEndRowIndex } = detectHeaderAndColumns(rows);
  const dataRows = rows.slice(headerEndRowIndex + 1);

  const records = [];
  const skippedRows = [];

  for (const row of dataRows) {
    if (!row || row.every((c) => c === '' || c == null)) {
      skippedRows.push({ reason: 'empty-row' });
      continue;
    }

    const regionLevelRaw = (row[columns.regionLevel] || '').trim();
    const regionLevel = Number(regionLevelRaw);

    // 地域階層レベル4のみが丁目単位の最小粒度レコード。1-3は市・区・大字町丁単位の小計/合計のため
    // 町丁目レコードとして取り込まない（区合計・市合計の混入防止）。
    if (regionLevel !== 4) {
      skippedRows.push({
        reason: regionLevel === 1 ? 'municipality-total-row' : regionLevel <= 3 ? 'subtotal-row' : 'unknown-region-level',
        regionLevel: regionLevelRaw,
        municipalityName: row[columns.municipalityName],
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
      skippedRows.push({ reason: 'empty-chocho-name', ward, row });
      continue;
    }

    const totalPop = parseNumericCell(row[columns.population]);
    const malePop = parseNumericCell(row[columns.malePopulation]);
    const femalePop = parseNumericCell(row[columns.femalePopulation]);
    const foreignPop = parseNumericCell(row[columns.foreignPopulation]);
    const households = parseNumericCell(row[columns.households]);

    records.push({
      ward,
      chochoName,
      fullChochoName: `${ward}${chochoName}`,
      chochoCode: normalizeChochoCode((row[columns.chochoCode] || '').trim()) || null,
      municipalityCode: (row[columns.municipalityCode] || '').trim() || null,
      population: totalPop.suppressed ? null : totalPop.value,
      populationSuppressed: totalPop.suppressed,
      malePopulation: malePop.suppressed ? null : malePop.value,
      malePopulationSuppressed: malePop.suppressed,
      femalePopulation: femalePop.suppressed ? null : femalePop.value,
      femalePopulationSuppressed: femalePop.suppressed,
      households: households.suppressed ? null : households.value,
      householdsSuppressed: households.suppressed,
      foreignPopulation: foreignPop.suppressed ? null : foreignPop.value,
      foreignPopulationSuppressed: foreignPop.suppressed,
      valueType: 'official',
    });
  }

  return { records, skippedRows, columns };
}

/**
 * XLSXバイナリから「第2表」シートを読み込み、変換する便利関数。
 * シート名は固定文字列"第2表"を期待するが、見つからない場合は全シート名をエラーに含める。
 */
export function convertPopulationHouseholdsXlsx(buffer, targetWards) {
  const sheetNames = getSheetNames(buffer);
  const targetSheetName = sheetNames.find((n) => n === '第2表') || sheetNames.find((n) => /第2表/.test(n || ''));
  if (!targetSheetName) {
    throw new Error(`"第2表"という名前のシートが見つかりません。存在するシート: ${sheetNames.join(', ')}`);
  }
  const rows = readXlsxSheet(buffer, targetSheetName);
  return convertPopulationHouseholdsTable(rows, targetWards);
}
