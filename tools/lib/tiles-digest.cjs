'use strict';
/* tiles-digest.cjs — タイル本体(tile_*.json)群から決定論的な全体digestを計算する共有ロジック。
 * verify-production-release.cjs / check-release-ready.cjs (Node) と
 * production-cutover.ps1 (PowerShellから node tools/compute-tiles-digest.cjs を呼び出す) の
 * 3箇所で「同一のNodeコード」を使うことで、言語間でのアルゴリズム相違を排除する。
 *
 * アルゴリズム:
 *   1. tilesDir 直下の tile_-?\d+_-?\d+\.json を列挙
 *   2. 各ファイルの relativePath を `buildings/${dataset}/${filename}` に固定（'/'区切り、OS非依存）
 *   3. 各ファイルの内容(バイト列)の sha256 を計算
 *   4. { relativePath, sha256 } を relativePath の辞書順(ordinal)でソート
 *   5. 各要素を `${relativePath}:${sha256}` の行にし、'\n'結合+末尾'\n'を付与
 *   6. その文字列全体(UTF-8)の sha256 を tilesDigest とする
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const TILE_RE = /^tile_-?\d+_-?\d+\.json$/;

/**
 * @param {string} tilesDir tile_*.json が直接置かれているディレクトリ（絶対パス推奨）
 * @param {string} dataset  relativePath ラベル用のdataset id
 * @returns {{tilesDigest:string, tileFiles:Array<{relativePath:string,sha256:string}>, count:number}}
 */
function computeTilesDigest(tilesDir, dataset) {
  if (!fs.existsSync(tilesDir) || !fs.statSync(tilesDir).isDirectory()) {
    throw new Error('タイルディレクトリが無い: ' + tilesDir);
  }
  const files = fs.readdirSync(tilesDir).filter((f) => TILE_RE.test(f));
  const tileFiles = files
    .map((f) => ({ relativePath: `buildings/${dataset}/${f}`, sha256: sha256File(path.join(tilesDir, f)) }))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  const lines = tileFiles.map((t) => `${t.relativePath}:${t.sha256}`).join('\n') + '\n';
  const tilesDigest = crypto.createHash('sha256').update(lines, 'utf8').digest('hex');
  return { tilesDigest, tileFiles, count: tileFiles.length };
}

module.exports = { computeTilesDigest, sha256File, TILE_RE };
