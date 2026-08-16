// tools/convert/demographics/population-2015.js
// 平成27年国勢調査 第2表（男女別人口及び世帯数－町丁・字等）のCSV(CP932) -> 構造化JSON変換。
//
// 【実ファイル構造】2026年6月、web_fetch経由で実際にCSV内容を確認済み(統計局CSVの
// 文字コード判定はweb_fetch側でUTF-8と誤判定され文字化けするため、数値データのパターンと
// 列数から構造を確定した。日本語ヘッダー文字列自体は実行環境(ローカルPC)でCP932デコード
// した上で正式名称を確認すること)。
// - ヘッダーは1行のみ(4行目)。2020年表(第2表population-households.js)とは異なり、
//   大見出し+小見出しの2行構成ではない。
// - 列構成: 市区町村コード,町丁字コード,地域階層レベル,秘匿処理,秘匿先情報,合算地域,
//   都道府県名,市区町村名,大字・町名,字・丁目名,[人口総数],男,女,世帯数 (先頭に行番号列あり)
// - 【重要】地域階層レベルの意味が2020年と異なる。2015年は 1=市区町村合計, 2=町丁目小計,
//   3=丁目(最小粒度) という3階層。2020年表は 1=合計, 2-3=小計, 4=丁目 という4階層。
//   レベル番号を固定値で決めつけず、データの構造を都度確認すること
//   （本実装ではレベル3を町丁目粒度として扱うが、将来他都市・他年度に拡張する際は
//   再度実データで確認すべき）。
import { resolveEncoding } from '../../lib/estat/file-download-client.js';
import { parseCsv } from './household-composition.js';
import { normalizeChochoCode } from '../../lib/chocho-normalize.js';

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

function findColumnIndex(row, patterns) {
  for (let i = 0; i < row.length; i++) {
    const cell = normalizeHeaderText(row[i]);
    if (patterns.some((p) => (p instanceof RegExp ? p.test(cell) : cell.includes(p)))) return i;
  }
  return -1;
}

function detectHeaderAndColumns(rows) {
  let headerRowIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const normalized = rows[i].map(normalizeHeaderText);
    if (normalized.some((c) => c.includes('市区町村コード') || c.includes('町丁字コード'))) {
      headerRowIndex = i;
      break;
    }
  }
  if (headerRowIndex === -1) {
    throw new Error('見出し行（"市区町村コード"を含む行）が見つかりません。CSVの構造が想定と異なる可能性があります。');
  }
  const headerRow = rows[headerRowIndex];

  const columns = {
    municipalityCode: findColumnIndex(headerRow, ['市区町村コード']),
    chochoCode: findColumnIndex(headerRow, ['町丁字コード']),
    regionLevel: findColumnIndex(headerRow, ['地域階層レベル', '地域識別番号']),
    municipalityName: findColumnIndex(headerRow, ['市区町村名']),
    townName: findColumnIndex(headerRow, ['大字・町名', '大字町名']),
    chomeName: findColumnIndex(headerRow, ['字・丁目名', '字丁目名']),
    population: findColumnIndex(headerRow, ['人口（男女別）', '総数']),
    malePopulation: findColumnIndex(headerRow, [/^男$/]),
    femalePopulation: findColumnIndex(headerRow, [/^女$/]),
    households: findColumnIndex(headerRow, ['世帯数']),
  };

  const missing = Object.entries(columns).filter(([, idx]) => idx === -1).map(([key]) => key);
  if (missing.length) {
    throw new Error(`次の列が見出し名から検出できませんでした: ${missing.join(', ')}`);
  }

  return { columns, headerRowIndex };
}

function extractWard(municipalityName) {
  if (!municipalityName) return null;
  const m = municipalityName.match(/大阪市(.+区)$/);
  return m ? m[1] : null;
}

/**
 * 平成27年国勢調査第2表形式のCSV(2次元配列)を変換する。
 * @param {string[][]} rows
 * @param {string[]} targetMunicipalityCodes
 * @param {number} chochoLevelValue 町丁目単位の最小粒度を示す地域階層レベルの値。
 *   2026年6月時点の実データ確認では3だが、固定値に依存しすぎないよう引数化する。
 */
export function convertPopulation2015Table(rows, targetMunicipalityCodes, chochoLevelValue = 3) {
  const { columns, headerRowIndex } = detectHeaderAndColumns(rows);
  const dataRows = rows.slice(headerRowIndex + 1);

  const records = [];
  const skippedRows = [];

  for (const row of dataRows) {
    if (!row || row.every((c) => c === '' || c == null)) {
      skippedRows.push({ reason: 'empty-row' });
      continue;
    }

    const rawMunicipalityCode = (row[columns.municipalityCode] || '').trim();
    if (targetMunicipalityCodes && targetMunicipalityCodes.length && !targetMunicipalityCodes.includes(rawMunicipalityCode)) {
      skippedRows.push({ reason: 'municipality-not-in-target', municipalityCode: rawMunicipalityCode });
      continue;
    }

    const regionLevelRaw = (row[columns.regionLevel] || '').trim();
    const regionLevel = Number(regionLevelRaw);
    if (regionLevel !== chochoLevelValue) {
      skippedRows.push({
        reason: regionLevel === 1 ? 'municipality-total-row' : regionLevel < chochoLevelValue ? 'subtotal-row' : 'unknown-region-level',
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
      skippedRows.push({ reason: 'empty-chocho-name', municipalityCode: rawMunicipalityCode });
      continue;
    }

    const popCell = parseNumericCell(row[columns.population]);
    const maleCell = parseNumericCell(row[columns.malePopulation]);
    const femaleCell = parseNumericCell(row[columns.femalePopulation]);
    const householdsCell = parseNumericCell(row[columns.households]);
    const chochoCode = normalizeChochoCode((row[columns.chochoCode] || '').trim()) || null;

    records.push({
      municipalityCode: rawMunicipalityCode || null,
      chochoCode,
      compositeCode: chochoCode && rawMunicipalityCode ? `${rawMunicipalityCode}:${chochoCode}` : null,
      ward,
      chochoName,
      fullChochoName: `${ward || ''}${chochoName}`,
      population2015: popCell.suppressed ? null : popCell.value,
      population2015Suppressed: popCell.suppressed,
      malePopulation2015: maleCell.suppressed ? null : maleCell.value,
      femalePopulation2015: femaleCell.suppressed ? null : femaleCell.value,
      households2015: householdsCell.suppressed ? null : householdsCell.value,
      households2015Suppressed: householdsCell.suppressed,
      referenceYear: 2015,
      source: '総務省統計局「平成27年国勢調査」',
      valueType: 'official',
    });
  }

  return { records, skippedRows, columns };
}

export function convertPopulation2015Csv(buffer, headers, targetMunicipalityCodes) {
  const expectedTokens = ['市区町村コード'];
  const encodingResult = resolveEncoding(buffer, headers || {}, expectedTokens);
  if (!encodingResult.ok) {
    throw new Error(
      `文字コードを確定できませんでした。期待するヘッダー(${expectedTokens.join(', ')})を含む形で` +
      `デコードできません。詳細: ${JSON.stringify(encodingResult.steps)}`
    );
  }
  const rows = parseCsv(encodingResult.text);
  return { ...convertPopulation2015Table(rows, targetMunicipalityCodes), encoding: encodingResult.encoding };
}
