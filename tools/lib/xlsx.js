// tools/lib/xlsx.js
// 外部パッケージに依存しない最小限のXLSX読み込み実装。Node.js組み込みのzlibのみ使用する。
// 統計表（単純な格子状データ、数式・書式は不要）を読むことに特化しており、
// 汎用XLSXライブラリの代替ではない。
import zlib from 'zlib';

// ZIP（XLSXはZIPコンテナ）のローカルファイルヘッダーを順に読み、
// 指定した名前のエントリの展開済みバイト列を返す。
// 完全なZIP実装ではなく、XLSXが内部で使う「非圧縮または通常deflate、暗号化なし」の
// エントリのみを想定した簡易パーサー。
function readZipEntries(buffer) {
  const entries = {};
  let offset = 0;
  while (offset < buffer.length - 4) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      // ローカルファイルヘッダー
      const compressionMethod = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const uncompressedSize = buffer.readUInt32LE(offset + 22);
      const fileNameLength = buffer.readUInt16LE(offset + 26);
      const extraFieldLength = buffer.readUInt16LE(offset + 28);
      const fileName = buffer.toString('utf-8', offset + 30, offset + 30 + fileNameLength);
      const dataStart = offset + 30 + fileNameLength + extraFieldLength;
      const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

      let data;
      if (compressionMethod === 0) {
        data = compressedData; // 無圧縮
      } else if (compressionMethod === 8) {
        data = zlib.inflateRawSync(compressedData); // 標準deflate
      } else {
        data = null; // 未対応の圧縮方式（XLSXでは通常発生しない）
      }
      if (data) entries[fileName] = data;
      offset = dataStart + compressedSize;
    } else {
      break; // 中央ディレクトリ等、ローカルファイルヘッダー以外に到達したら終了
    }
  }
  return entries;
}

// XML文字列から <t>...</t> や <v>...</v> のような単純なタグの値を全て抜き出す簡易パーサー。
// 統計表のセル値抽出にのみ使うため、属性やネストの厳密な解釈は行わない。
function extractTagValues(xml, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, 'g');
  const values = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    values.push(decodeXmlEntities(match[1]));
  }
  return values;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

// 列文字(A, B, ..., Z, AA, ...)を0始まりの列インデックスへ変換する
function columnLetterToIndex(letters) {
  let index = 0;
  for (let i = 0; i < letters.length; i++) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1;
}

/**
 * workbook.xml からシート名の宣言順序とrIdの対応を取得する。
 * 例: [{name: '【利用上の注意】', rId: 'rId1'}, {name: '第2表', rId: 'rId2'}]
 */
function parseWorkbookSheetList(entries) {
  const xml = entries['xl/workbook.xml'];
  if (!xml) return [];
  const xmlStr = xml.toString('utf-8');
  const sheetBlocks = xmlStr.match(/<sheet\b[^>]*?\/>/g) || [];
  return sheetBlocks.map((block) => {
    const name = (block.match(/name="([^"]*)"/) || [])[1];
    const rId = (block.match(/r:id="([^"]*)"/) || [])[1];
    return { name: name ? decodeXmlEntities(name) : null, rId };
  });
}

/**
 * workbook.xml.rels から rId -> 物理ファイル名(例: worksheets/sheet2.xml) の対応を取得する。
 * 【重要】OOXML仕様上、sheetN.xml という物理ファイル名はシートの宣言順序や見た目の並びと
 * 対応する保証がない。r:id を介してこのrelsファイルで解決するのが唯一正しい方法。
 * (本ファイルの旧実装は sheet1.xml を無条件に「最初のシート」として読んでいたため、
 * 実際には1番目のシートだが別ファイル名に対応するケースで誤った内容を読んでいた。)
 */
function parseWorkbookRels(entries) {
  const xml = entries['xl/_rels/workbook.xml.rels'];
  if (!xml) return {};
  const xmlStr = xml.toString('utf-8');
  const relBlocks = xmlStr.match(/<Relationship\b[^>]*?\/>/g) || [];
  const map = {};
  for (const block of relBlocks) {
    const id = (block.match(/Id="([^"]*)"/) || [])[1];
    const target = (block.match(/Target="([^"]*)"/) || [])[1];
    if (id && target) map[id] = target;
  }
  return map;
}

/**
 * XLSXバイナリに含まれる全シート名を、宣言順序のまま返す。
 * @param {Buffer} buffer
 * @returns {string[]}
 */
export function getSheetNames(buffer) {
  const entries = readZipEntries(buffer);
  const sheetList = parseWorkbookSheetList(entries);
  return sheetList.map((s) => s.name);
}

function buildSharedStrings(entries) {
  let sharedStrings = [];
  if (entries['xl/sharedStrings.xml']) {
    const xml = entries['xl/sharedStrings.xml'].toString('utf-8');
    // <si><t>text</t></si> という構造。1つの<si>に複数の<t>(リッチテキスト分割)が
    // 入ることがあるため、<si>単位で連結してから格納する。
    const siBlocks = xml.match(/<si>.*?<\/si>/gs) || [];
    sharedStrings = siBlocks.map((block) => extractTagValues(block, 't').join(''));
  }
  return sharedStrings;
}

function parseSheetXml(sheetXml, sharedStrings) {
  const rowBlocks = sheetXml.match(/<row[^>]*>.*?<\/row>/gs) || [];
  const rows = [];
  for (const rowBlock of rowBlocks) {
    const cellBlocks = rowBlock.match(/<c[^>]*\/>|<c[^>]*>.*?<\/c>/gs) || [];
    const rowCells = {};
    let maxCol = -1;
    for (const cellBlock of cellBlocks) {
      const refMatch = cellBlock.match(/r="([A-Z]+)\d+"/);
      if (!refMatch) continue;
      const colIndex = columnLetterToIndex(refMatch[1]);
      maxCol = Math.max(maxCol, colIndex);

      const typeMatch = cellBlock.match(/t="([^"]+)"/);
      const cellType = typeMatch ? typeMatch[1] : null;
      const valueMatch = cellBlock.match(/<v>([^<]*)<\/v>/);
      let value = valueMatch ? valueMatch[1] : '';

      if (cellType === 's') {
        // 共有文字列インデックス参照
        const idx = parseInt(value, 10);
        value = sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
      } else if (cellType === 'inlineStr') {
        value = extractTagValues(cellBlock, 't').join('');
      }
      rowCells[colIndex] = value;
    }
    const rowArray = [];
    for (let i = 0; i <= maxCol; i++) {
      rowArray.push(rowCells[i] !== undefined ? rowCells[i] : '');
    }
    rows.push(rowArray);
  }
  return rows;
}

/**
 * XLSXバイナリ(Buffer)を読み込み、指定したシート名(または宣言順序のインデックス)の内容を
 * 2次元配列(行×列、文字列)として返す。
 * @param {Buffer} buffer
 * @param {string|number} [sheetNameOrIndex] シート名。省略時は宣言順序の先頭シート。数値を渡すと
 *   宣言順序のN番目(0始まり)のシートを読む。
 * @returns {string[][]}
 */
export function readXlsxSheet(buffer, sheetNameOrIndex) {
  const entries = readZipEntries(buffer);
  const sheetList = parseWorkbookSheetList(entries);
  const rels = parseWorkbookRels(entries);

  let targetSheet;
  if (sheetNameOrIndex == null) {
    targetSheet = sheetList[0];
  } else if (typeof sheetNameOrIndex === 'number') {
    targetSheet = sheetList[sheetNameOrIndex];
  } else {
    targetSheet = sheetList.find((s) => s.name === sheetNameOrIndex);
  }
  if (!targetSheet) {
    throw new Error(
      `シート "${sheetNameOrIndex}" が見つかりません。存在するシート: ${sheetList.map((s) => s.name).join(', ')}`
    );
  }

  const physicalPath = rels[targetSheet.rId]; // 例: "worksheets/sheet2.xml" または "/xl/worksheets/sheet1.xml"
  if (!physicalPath) {
    throw new Error(`シート "${targetSheet.name}" (rId=${targetSheet.rId}) の物理ファイルが見つかりません。`);
  }
  // OOXML仕様上、Target属性は「xl/からの相対パス」（Excel等が一般的に使う形式）と
  // 「パッケージルートからの絶対パス（先頭/、xl/を含む）」（openpyxl等が使う形式）の
  // どちらもあり得る。どちらの形式でも同じZIPエントリキーに正規化する。
  const normalizedPath = physicalPath.replace(/^\//, '').replace(/^xl\//, '');
  const sheetKey = `xl/${normalizedPath}`;
  const sheetXmlBuffer = entries[sheetKey];
  if (!sheetXmlBuffer) {
    throw new Error(`シートファイル "${sheetKey}" がZIP内に存在しません。(Target属性の元の値: "${physicalPath}")`);
  }

  const sharedStrings = buildSharedStrings(entries);
  return parseSheetXml(sheetXmlBuffer.toString('utf-8'), sharedStrings);
}

/**
 * 後方互換用: 宣言順序の先頭シートを読む（既存呼び出し元向け）。
 * 新規コードでは readXlsxSheet(buffer, sheetName) でシートを明示的に指定することを推奨する。
 * @param {Buffer} buffer
 * @returns {string[][]}
 */
export function readXlsxFirstSheet(buffer) {
  return readXlsxSheet(buffer);
}
