// tools/convert/demographics/household-composition.js
// 第5-2表（世帯人員の人数別一般世帯数及び一般世帯の1世帯当たり人員）のCSV(CP932) -> 構造化JSON変換。
//
// 【入力形式】data/raw/{areaId}/census/osaka-census-2020-household-composition.csv
// は生バイトのまま保存されている前提（tools/download/census/index.jsがダウンロード時に
// 文字列化せずそのまま保存する）。本ファイルが文字コードの判定・デコードを担う。
//
// 【列構成】固定位置に依存せず、CP932復号後の正式ヘッダー名から列インデックスを解決する。
// 既存のpopulation-households.js/age-structure.jsと同じ設計方針（地域階層レベル4のみが
// 町丁目単位の最小粒度レコード、複合キーで結合する）を踏襲する。
import { readFile } from 'fs/promises';
import { resolveEncoding } from '../../lib/estat/file-download-client.js';
import {
  normalizeChochoCode, normalizeChochoName,
  normalizeHeaderForMatching, headerMatchesAlias, HOUSEHOLD_COMPOSITION_HEADER_ALIASES,
} from '../../lib/chocho-normalize.js';

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

function parseFloatCell(raw) {
  if (raw == null || raw === '') return { value: null, suppressed: false };
  const trimmed = String(raw).trim();
  if (SUPPRESSED_MARKERS.has(trimmed)) return { value: null, suppressed: true };
  if (ZERO_MARKERS.has(trimmed)) return { value: 0, suppressed: false };
  const n = Number(trimmed);
  if (Number.isNaN(n)) return { value: null, suppressed: false, unparseable: true };
  return { value: n, suppressed: false };
}

/**
 * CSVテキスト(改行区切り、カンマ区切り、ダブルクォート対応)を2次元配列に変換する。
 * 既存のtools/lib/xlsx.jsはXLSX専用のため、CSV用の最小限のパーサをここに持つ
 * （正規表現で十分なシンプルな構造であり、外部CSVパッケージは導入しない）。
 */
export function parseCsv(text) {
  const rows = [];
  // 改行はCRLF/LFいずれにも対応する
  const lines = text.split(/\r\n|\n/);
  for (const line of lines) {
    if (line === '') continue;
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { current += ch; }
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { cells.push(current); current = ''; }
        else { current += ch; }
      }
    }
    cells.push(current);
    rows.push(cells);
  }
  return rows;
}

// 列キーごとの必須識別語(見出し行自体を特定するために使う、複数該当するほど信頼度が高い)
const HEADER_ROW_IDENTIFIER_TOKENS = [
  '市区町村コード', '地域階層レベル', '一般世帯', '1人', '2人', '3人', '1世帯当たり人員',
];

/**
 * rows内から「ヘッダー行らしさ」が最も高い行を検出する。固定で「4行目」と決めつけず、
 * 識別語を複数含む行を見出し候補とする(候補が複数ある場合は、上段(大見出し)+下段(小見出し)の
 * 2行構成である可能性を考慮し、識別語が最も多く一致する行を「下段(主見出し)行」として採用する)。
 * @param {string[][]} rows
 * @returns {number} headerRowIndex (-1の場合は検出失敗)
 */
function detectHeaderRowIndex(rows) {
  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const normalizedCells = rows[i].map(normalizeHeaderForMatching);
    // 「市区町村コード」は表のタイトル文や説明文には通常出現しない、構造上必須の列名であるため、
    // これを含まない行はヘッダー行の候補から除外する(必須条件)。これが無いと、タイトル行
    // (例:「第5-2表 世帯人員の人数別一般世帯数及び一般世帯の1世帯当たり人員」)が「一般世帯」
    // 「1人」等の語を偶然含むだけでヘッダー行と誤判定される問題が実際に発生した。
    const hasMunicipalityCodeToken = normalizedCells.some((c) => c.includes(normalizeHeaderForMatching('市区町村コード')));
    if (!hasMunicipalityCodeToken) continue;

    const score = HEADER_ROW_IDENTIFIER_TOKENS.reduce((count, token) => {
      const normalizedToken = normalizeHeaderForMatching(token);
      return count + (normalizedCells.some((c) => c.includes(normalizedToken)) ? 1 : 0);
    }, 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex === -1 || bestScore < 2) return -1;
  return bestIndex;
}

/**
 * 上段見出し行(大見出し、結合セルにより空欄が多い)の空欄セルを、直前の非空白セルの値で
 * 補完する(forward-fill)。e-Stat CSVの結合セル表現(大見出しが先頭セルにのみ入り、
 * 以降の同じグループの列は空欄になる)に対応するための処理。
 * @param {string[]} row
 * @returns {string[]}
 */
function forwardFillRow(row) {
  const filled = [];
  let last = '';
  for (const cell of row) {
    const trimmed = (cell || '').trim();
    if (trimmed !== '') last = trimmed;
    filled.push(last);
  }
  return filled;
}

/**
 * 見出しが上段(大見出し)・下段(小見出し)の2行構成かどうかを判定する。
 * 下段行(主見出し行)の直前の行に、識別語以外の有意な文字列(空でない大見出しらしき文字列)が
 * 一定数あれば、2行見出しとみなす。
 */
function hasUpperHeaderRow(rows, headerRowIndex) {
  if (headerRowIndex <= 0) return false;
  const upperRow = rows[headerRowIndex - 1];
  const nonEmptyCount = upperRow.filter((c) => (c || '').trim() !== '').length;
  // 上段行に2つ以上の非空白セルがあれば、意味のある大見出し行とみなす
  // (1個だけならタイトル行等の可能性が高く、見出し構成要素ではないと判断する)。
  return nonEmptyCount >= 2;
}

/**
 * ヘッダー行(複数行の場合は結合済み)から、内部キーごとの列インデックスを、
 * 別名マッピング(HOUSEHOLD_COMPOSITION_HEADER_ALIASES)を使って検出する。
 * 単独項目(市区町村コード等)は固定の単一候補で検出し、世帯人員別項目は別名リストを使う。
 * @param {string[]} combinedRow 各列について「上段+下段」を連結した正規化済み文字列の配列
 * @returns {{columns: object, diagnostics: object}}
 */
function findColumnsFromCombinedHeader(combinedRow) {
  const singleIdentifierColumns = {
    municipalityCode: ['市区町村コード'],
    chochoCode: ['町丁字コード'],
    regionLevel: ['地域階層レベル'],
    municipalityName: ['市区町村名'],
    townName: ['大字・町名', '大字町名'],
    chomeName: ['字・丁目名', '字丁目名'],
  };

  const columns = {};
  const diagnostics = { triedAliases: {}, closestCandidates: {} };

  for (const [key, aliases] of Object.entries(singleIdentifierColumns)) {
    columns[key] = -1;
    diagnostics.triedAliases[key] = aliases;
    for (let i = 0; i < combinedRow.length; i++) {
      if (aliases.some((a) => headerMatchesAlias(combinedRow[i], a))) {
        columns[key] = i;
        break;
      }
    }
  }

  for (const [key, aliases] of Object.entries(HOUSEHOLD_COMPOSITION_HEADER_ALIASES)) {
    columns[key] = -1;
    diagnostics.triedAliases[key] = aliases;
    for (let i = 0; i < combinedRow.length; i++) {
      if (aliases.some((a) => headerMatchesAlias(combinedRow[i], a))) {
        columns[key] = i;
        break;
      }
    }
    // 検出失敗時の診断用に、最も近い候補(部分一致度が高い列)を記録する
    if (columns[key] === -1) {
      let closest = null;
      let closestScore = 0;
      for (let i = 0; i < combinedRow.length; i++) {
        for (const alias of aliases) {
          const normalizedAlias = normalizeHeaderForMatching(alias);
          if (normalizedAlias && combinedRow[i].length > 0) {
            // 簡易的な類似度: 共通する最長部分文字列の長さ
            let commonLen = 0;
            for (let len = Math.min(normalizedAlias.length, combinedRow[i].length); len > 0; len--) {
              if (normalizedAlias.includes(combinedRow[i].slice(0, len)) || combinedRow[i].includes(normalizedAlias.slice(0, len))) {
                commonLen = len;
                break;
              }
            }
            if (commonLen > closestScore) {
              closestScore = commonLen;
              closest = { columnIndex: i, headerText: combinedRow[i], alias };
            }
          }
        }
      }
      diagnostics.closestCandidates[key] = closest;
    }
  }

  return { columns, diagnostics };
}

function detectHeaderAndColumns(rows, csvContext) {
  const headerRowIndex = detectHeaderRowIndex(rows);
  if (headerRowIndex === -1) {
    throw new Error(
      '見出し行が見つかりません（"市区町村コード"等の識別語を複数含む行が検出できませんでした）。' +
      'CSVの構造が想定と異なる可能性があります。' +
      buildDiagnosticsSuffix(rows, null, null, csvContext)
    );
  }

  const lowerRow = rows[headerRowIndex];
  const isTwoRowHeader = hasUpperHeaderRow(rows, headerRowIndex);
  const upperRow = isTwoRowHeader ? forwardFillRow(rows[headerRowIndex - 1]) : null;

  // 上段+下段を結合した、正規化済みの「列ごとの完全な見出し文字列」を構築する。
  // 1行見出しの場合は下段(=唯一の見出し行)のみを使う。
  const combinedRow = lowerRow.map((cell, i) => {
    const lower = normalizeHeaderForMatching(cell);
    const upper = isTwoRowHeader ? normalizeHeaderForMatching(upperRow[i]) : '';
    return upper + lower;
  });

  const { columns, diagnostics } = findColumnsFromCombinedHeader(combinedRow);

  const missing = Object.entries(columns).filter(([, idx]) => idx === -1).map(([key]) => key);
  if (missing.length) {
    throw new Error(
      `次の列が見出し名から検出できませんでした: ${missing.join(', ')}` +
      buildDiagnosticsSuffix(rows, headerRowIndex, { columns, diagnostics, isTwoRowHeader, combinedRow }, csvContext)
    );
  }

  return { columns, headerEndRowIndex: headerRowIndex };
}

/**
 * 列検出失敗時に出力する診断情報。ご指示の「検出した見出し行番号・実際の全見出し一覧・
 * 各内部項目に対して試した別名・最も近い候補・CSVの文字コード・各行の列数・
 * データ先頭行の列数」を含む。
 */
function buildDiagnosticsSuffix(rows, headerRowIndex, detection, csvContext) {
  const lines = ['\n\n=== 診断情報 ==='];
  lines.push(`検出した見出し行番号: ${headerRowIndex != null ? headerRowIndex + 1 : '検出失敗'}`);
  if (csvContext) {
    lines.push(`CSVの文字コード: ${csvContext.encoding || '不明'}`);
  }
  lines.push(`先頭10行の列数: ${rows.slice(0, 10).map((r) => r.length).join(', ')}`);
  if (headerRowIndex != null) {
    lines.push(`実際の見出し行(${headerRowIndex + 1}行目)の内容: ${JSON.stringify(rows[headerRowIndex])}`);
    if (headerRowIndex > 0) {
      lines.push(`直前行(${headerRowIndex}行目)の内容: ${JSON.stringify(rows[headerRowIndex - 1])}`);
    }
    const dataRowIndex = headerRowIndex + 1;
    if (rows[dataRowIndex]) {
      lines.push(`データ先頭行(${dataRowIndex + 1}行目)の列数: ${rows[dataRowIndex].length}`);
    }
  }
  if (detection) {
    lines.push(`2行見出しと判定: ${detection.isTwoRowHeader}`);
    lines.push(`結合後の見出し一覧(正規化済み): ${JSON.stringify(detection.combinedRow)}`);
    for (const [key, idx] of Object.entries(detection.columns)) {
      if (idx === -1) {
        lines.push(`  [${key}] 試した別名: ${JSON.stringify(detection.diagnostics.triedAliases[key])}`);
        const closest = detection.diagnostics.closestCandidates[key];
        lines.push(`  [${key}] 最も近い候補: ${closest ? JSON.stringify(closest) : '該当なし'}`);
      }
    }
  }
  return lines.join('\n');
}

function extractWard(municipalityName) {
  if (!municipalityName) return null;
  const m = municipalityName.match(/大阪市(.+区)$/);
  return m ? m[1] : null;
}

/**
 * 4人以上世帯数を計算する。4・5・6・7人以上世帯のいずれかが秘匿の場合は合算しない
 * （一部だけ合算した不正確な値を作らない）。
 */
function calculateFourOrMore(fourCell, fiveCell, sixCell, sevenPlusCell) {
  const cells = [fourCell, fiveCell, sixCell, sevenPlusCell];
  if (cells.some((c) => c.suppressed)) {
    return { value: null, suppressed: true };
  }
  if (cells.some((c) => c.value == null)) {
    return { value: null, suppressed: false };
  }
  return { value: cells.reduce((sum, c) => sum + c.value, 0), suppressed: false };
}

/**
 * 世帯人数別比率を計算する(livecity-calculated)。一般世帯数が0/null/秘匿の場合は計算しない。
 */
function calculateRate(countCell, generalHouseholdsCell) {
  if (generalHouseholdsCell.suppressed || generalHouseholdsCell.value == null || generalHouseholdsCell.value === 0) {
    return null;
  }
  if (countCell.suppressed || countCell.value == null) return null;
  return Math.round((countCell.value / generalHouseholdsCell.value) * 1000) / 10; // 小数第1位(丸め前は別途保持)
}

/**
 * 第5-2表形式のCSV(2次元配列)を変換する。
 * @param {string[][]} rows
 * @param {string[]} targetMunicipalityCodes 抽出対象の市区町村コード(文字列、先頭ゼロ保持)
 * @param {{encoding?: string}} [csvContext] 診断ログ用のコンテキスト(検出失敗時のエラーメッセージに含める)
 */
export function convertHouseholdCompositionTable(rows, targetMunicipalityCodes, csvContext = null) {
  const { columns, headerEndRowIndex } = detectHeaderAndColumns(rows, csvContext);
  const dataRows = rows.slice(headerEndRowIndex + 1);

  const records = [];
  const skippedRows = [];

  for (const row of dataRows) {
    if (!row || row.every((c) => c === '' || c == null)) {
      skippedRows.push({ reason: 'empty-row' });
      continue;
    }

    const municipalityCode = normalizeChochoCode(row[columns.municipalityCode]) || (row[columns.municipalityCode] || '').trim();
    if (targetMunicipalityCodes && targetMunicipalityCodes.length && !targetMunicipalityCodes.includes((row[columns.municipalityCode] || '').trim())) {
      skippedRows.push({ reason: 'municipality-not-in-target', municipalityCode: row[columns.municipalityCode] });
      continue;
    }

    const regionLevelRaw = (row[columns.regionLevel] || '').trim();
    const regionLevel = Number(regionLevelRaw);
    if (regionLevel !== 4) {
      skippedRows.push({
        reason: regionLevel === 1 ? 'municipality-total-row' : regionLevel <= 3 ? 'subtotal-row' : 'unknown-region-level',
        regionLevel: regionLevelRaw,
      });
      continue;
    }

    const municipalityName = (row[columns.municipalityName] || '').trim();
    const ward = extractWard(municipalityName);
    const townName = (row[columns.townName] || '').trim();
    const chomeName = (row[columns.chomeName] || '').trim();
    const chochoName = `${townName}${chomeName}`;
    if (!chochoName) {
      skippedRows.push({ reason: 'empty-chocho-name', municipalityCode: row[columns.municipalityCode] });
      continue;
    }

    const generalHouseholdsCell = parseNumericCell(row[columns.generalHouseholds]);
    const oneCell = parseNumericCell(row[columns.onePerson]);
    const twoCell = parseNumericCell(row[columns.twoPerson]);
    const threeCell = parseNumericCell(row[columns.threePerson]);
    const fourCell = parseNumericCell(row[columns.fourPerson]);
    const fiveCell = parseNumericCell(row[columns.fivePerson]);
    const sixCell = parseNumericCell(row[columns.sixPerson]);
    const sevenPlusCell = parseNumericCell(row[columns.sevenOrMorePerson]);
    const personsPerHouseholdCell = parseFloatCell(row[columns.personsPerHousehold]);

    const fourOrMore = calculateFourOrMore(fourCell, fiveCell, sixCell, sevenPlusCell);

    const chochoCode = normalizeChochoCode((row[columns.chochoCode] || '').trim()) || null;

    records.push({
      municipalityCode: (row[columns.municipalityCode] || '').trim() || null,
      chochoCode,
      compositeCode: chochoCode && municipalityCode ? `${(row[columns.municipalityCode] || '').trim()}:${chochoCode}` : null,
      ward,
      chochoName,
      fullChochoName: `${ward || ''}${chochoName}`,

      generalHouseholds: generalHouseholdsCell.suppressed ? null : generalHouseholdsCell.value,
      generalHouseholdsSuppressed: generalHouseholdsCell.suppressed,

      onePersonHouseholds: oneCell.suppressed ? null : oneCell.value,
      onePersonHouseholdsSuppressed: oneCell.suppressed,
      twoPersonHouseholds: twoCell.suppressed ? null : twoCell.value,
      twoPersonHouseholdsSuppressed: twoCell.suppressed,
      threePersonHouseholds: threeCell.suppressed ? null : threeCell.value,
      threePersonHouseholdsSuppressed: threeCell.suppressed,
      fourPersonHouseholds: fourCell.suppressed ? null : fourCell.value,
      fourPersonHouseholdsSuppressed: fourCell.suppressed,
      fivePersonHouseholds: fiveCell.suppressed ? null : fiveCell.value,
      fivePersonHouseholdsSuppressed: fiveCell.suppressed,
      sixPersonHouseholds: sixCell.suppressed ? null : sixCell.value,
      sixPersonHouseholdsSuppressed: sixCell.suppressed,
      sevenOrMorePersonHouseholds: sevenPlusCell.suppressed ? null : sevenPlusCell.value,
      sevenOrMorePersonHouseholdsSuppressed: sevenPlusCell.suppressed,
      fourOrMorePersonHouseholds: fourOrMore.value,
      fourOrMorePersonHouseholdsSuppressed: fourOrMore.suppressed,

      personsPerHousehold: personsPerHouseholdCell.suppressed ? null : personsPerHouseholdCell.value,
      personsPerHouseholdSuppressed: personsPerHouseholdCell.suppressed,

      singlePersonHouseholdRate: calculateRate(oneCell, generalHouseholdsCell),
      twoPersonHouseholdRate: calculateRate(twoCell, generalHouseholdsCell),
      threePersonHouseholdRate: calculateRate(threeCell, generalHouseholdsCell),
      fourOrMorePersonHouseholdRate: calculateRate(
        { value: fourOrMore.value, suppressed: fourOrMore.suppressed }, generalHouseholdsCell
      ),
      rateValueType: 'livecity-calculated',
      valueType: 'official',
    });
  }

  return { records, skippedRows, columns };
}

/**
 * 生バイト(CP932/UTF-8等)から第5-2表を変換する便利関数。
 * @param {Buffer} buffer
 * @param {Record<string,string>} headers HTTPレスポンスヘッダー(取得時にmeta.jsonへ保存済みのものを渡す。
 *   ローカルファイルから読む場合は{}を渡せば、BOM/UTF-8/CP932の順に厳密判定する)。
 * @param {string[]} targetMunicipalityCodes
 */
export function convertHouseholdCompositionCsv(buffer, headers, targetMunicipalityCodes) {
  const expectedTokens = ['市区町村コード', '一般世帯数'];
  const encodingResult = resolveEncoding(buffer, headers || {}, expectedTokens);
  if (!encodingResult.ok) {
    throw new Error(
      `文字コードを確定できませんでした。BOM/HTTPヘッダー/UTF-8/CP932のいずれでも、` +
      `期待するヘッダー(${expectedTokens.join(', ')})を含む形でデコードできません。` +
      `詳細: ${JSON.stringify(encodingResult.steps)}`
    );
  }
  const rows = parseCsv(encodingResult.text);
  return { ...convertHouseholdCompositionTable(rows, targetMunicipalityCodes, { encoding: encodingResult.encoding }), encoding: encodingResult.encoding };
}
