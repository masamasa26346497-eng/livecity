// tools/lib/large-json-array-reader.js
// [Mission 31G-FIX22 §4] importer scalability の続き（読み込み側）。
//   大阪市24区全域(6メッシュ)を対象にすると building-outline-lines.json は数百MB規模になり、
//   fs.readFileSync(...).toString('utf-8') → JSON.parse という「1文字列へ全展開してからparse」
//   方式では、write側で実測した RangeError: Invalid string length と同種の上限に読み込み側でも
//   当たりうる（V8 の1文字列あたりの上限）。
//   tools/import-gsi-building-outline.js の writeLargeLinesJson が「1 feature = 1行」という
//   決め打ちの出力形式で書いているため、それに対応する形で行単位に streaming parse する
//   （§0 遵守: 内容・値の解釈は一切変えない。読み方のみを変える純粋なスケーラビリティ対応）。
//   汎用JSONパーサではない点に注意（writeLargeLinesJsonの出力専用）。
import fs from 'node:fs';
import readline from 'node:readline';

/**
 * @param {string} filePath
 * @returns {Promise<{features: Array<any>, [key:string]: any}|null>} ファイルが無ければ null
 */
export async function readFeatureCollectionStreaming(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const meta = {};
  const features = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line || line === '{' || line === '}' || line === ']' || line.startsWith('"features"')) continue;
    if (line.startsWith('{')) {
      const jsonStr = line.endsWith(',') ? line.slice(0, -1) : line;
      features.push(JSON.parse(jsonStr));   // 壊れていれば例外で正直に落とす（黙って欠落させない）
      continue;
    }
    const m = line.match(/^"([^"]+)":\s*(.+?),?$/);
    if (m) { try { meta[m[1]] = JSON.parse(m[2].endsWith(',') ? m[2].slice(0, -1) : m[2]); } catch { /* 不明なメタ行は無視（features本体には影響しない） */ } }
  }
  return { ...meta, features };
}
