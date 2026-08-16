'use strict';
/* io-guard v2 — 出力先の安全確認。
 *  - --project-root 必須（process.cwd() を信頼しない）
 *  - 許可する出力先は絶対パスで以下の内側のみ:
 *      <ProjectRoot>/temp/
 *      <ProjectRoot>/public/data/buildings/releases/
 *      <ProjectRoot>/public/data/overlays/releases/
 *    （パス要素に releases が含まれるだけでは許可しない）
 *  - 入力と出力が「完全に同一ファイル」なら停止（同一親フォルダ内の別ファイルは許可）
 *  - 入力と出力が包含関係（親子）にある場合も停止
 *  - 既存ファイルへの上書きは拒否 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) { const key = k.slice(2); const v = argv[i + 1]; if (!v || v.startsWith('--')) a[key] = true; else { a[key] = v; i++; } }
  }
  return a;
}

function requireProjectRoot(A) {
  if (!A['project-root'] || A['project-root'] === true) { console.error('[stop] --project-root は必須です（cwdは信頼しない）'); process.exit(2); }
  const r = path.resolve(String(A['project-root']));
  if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) { console.error('[stop] --project-root が存在しない/ディレクトリでない:', r); process.exit(2); }
  return r;
}

// child が parent の内側（真の子孫）か
const contains = (parent, child) => { const rel = path.relative(parent, child); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const insideOrEqual = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

function allowedRoots(projectRoot) {
  return [
    path.join(projectRoot, 'temp'),
    path.join(projectRoot, 'public', 'data', 'buildings', 'releases'),
    path.join(projectRoot, 'public', 'data', 'overlays', 'releases'),
  ];
}

/* inPath: 入力ファイル or ディレクトリ / outPath: 出力ファイル or ディレクトリ */
function assertSafeOutput(projectRoot, inPath, outPath) {
  const inAbs = path.resolve(inPath);
  const outAbs = path.resolve(outPath);
  if (inAbs === outAbs) { console.error('[stop] 入力と出力が完全に同一です:', outAbs); process.exit(2); }
  const roots = allowedRoots(projectRoot);
  if (!roots.some((r) => insideOrEqual(r, outAbs))) {
    console.error('[stop] 出力先が許可リスト外です。許可(絶対パス内側のみ):');
    for (const r of roots) console.error('   ', r);
    console.error('  指定:', outAbs);
    process.exit(2);
  }
  if (contains(inAbs, outAbs)) { console.error('[stop] 出力が入力の内側にあります（包含関係）:', outAbs, '⊂', inAbs); process.exit(2); }
  if (contains(outAbs, inAbs)) { console.error('[stop] 入力が出力の内側にあります（包含関係）:', inAbs, '⊂', outAbs); process.exit(2); }
}

function writeNoOverwrite(fp, data) {
  if (fs.existsSync(fp)) { console.error('[stop] 既存ファイルの上書きは拒否:', fp); process.exit(3); }
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, data);
}

/* 追記ストリーム用: 'wx' で開く（既存なら失敗） */
function openNoOverwrite(fp) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  try { return fs.openSync(fp, 'wx'); }
  catch (e) { console.error('[stop] 既存ファイルの上書きは拒否:', fp); process.exit(3); }
}

const memMB = () => Math.round(process.memoryUsage().heapUsed / 1048576);

module.exports = { parseArgs, requireProjectRoot, assertSafeOutput, writeNoOverwrite, openNoOverwrite, allowedRoots, contains, insideOrEqual, memMB };
