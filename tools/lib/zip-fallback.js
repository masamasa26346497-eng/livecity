// tools/lib/zip-fallback.js
// Node.js実装(zip-reader.js)で読めないZIP(未対応圧縮方式・特殊構造)に当たった場合の、
// OS別フォールバック抽出。ご指示の優先順位 2(PowerShell Expand-Archive) → 3(7-Zip) に対応。
// unzip(Unix)も利用可能なら使う。
//
// 重要な制約:
//   - PowerShell の Expand-Archive は「部分抽出」ができないため、フォールバック時は
//     一時ディレクトリへ全展開してから対象GMLだけをコピーする（最終手段）。7-Zip/unzip は
//     エントリ指定抽出が可能なので、存在すればそちらを優先する。

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, statSync, copyFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

/** コマンドが実行可能か（--help/-h 等で存在確認）。 */
function commandExists(cmd, probeArgs) {
  try {
    const r = spawnSync(cmd, probeArgs, { stdio: 'ignore', shell: process.platform === 'win32' });
    return r.status === 0 || r.status === 1; // ヘルプは0/1どちらも「存在」とみなす
  } catch {
    return false;
  }
}

/** 利用可能なフォールバック手段を優先順位順に返す。 */
export function detectFallbackTools() {
  const tools = [];
  // 7-Zip: 7z / 7za。エントリ指定抽出が可能で高速。
  if (commandExists('7z', ['i'])) tools.push('7z');
  else if (commandExists('7za', ['i'])) tools.push('7za');
  // unzip(Unix/Git for Windows同梱等)
  if (commandExists('unzip', ['-v'])) tools.push('unzip');
  // PowerShell(Windows標準)。部分抽出不可のため最後。
  if (process.platform === 'win32' && commandExists('powershell', ['-Command', 'exit 0'])) {
    tools.push('powershell');
  }
  return tools;
}

/**
 * 指定エントリ名の集合を dest ディレクトリへ抽出する（basename で保存）。
 * @param {string} zipPath
 * @param {string[]} entryNames ZIP内フルパス
 * @param {string} destDir
 * @param {(msg:string)=>void} log
 * @returns {{tool:string, saved:string[]}}
 */
export function extractEntriesWithFallback(zipPath, entryNames, destDir, log = console.log) {
  const tools = detectFallbackTools();
  if (tools.length === 0) {
    throw new Error('Node実装で読めず、OSフォールバック手段(7-Zip/unzip/PowerShell)も見つかりません。' +
      '7-Zip の導入を検討してください。');
  }
  const tool = tools[0];
  log(`[FALLBACK] ZIP抽出にOSツールを使用します: ${tool}`);
  const saved = [];

  if (tool === '7z' || tool === '7za') {
    // 7z e: 指定エントリのみ、ディレクトリ構造を無視して dest へ
    for (const entry of entryNames) {
      const r = spawnSync(tool, ['e', '-y', `-o${destDir}`, zipPath, entry], {
        stdio: 'ignore', shell: process.platform === 'win32',
      });
      if (r.status !== 0) { log(`[FALLBACK] 7-Zip抽出失敗: ${entry}`); continue; }
      const dest = path.join(destDir, path.basename(entry));
      if (existsSync(dest)) saved.push(dest);
    }
    return { tool, saved };
  }

  if (tool === 'unzip') {
    for (const entry of entryNames) {
      // -j: パスを無視して展開, -o: 上書き, -d: 出力先
      const r = spawnSync('unzip', ['-j', '-o', zipPath, entry, '-d', destDir], { stdio: 'ignore' });
      if (r.status !== 0) { log(`[FALLBACK] unzip抽出失敗: ${entry}`); continue; }
      const dest = path.join(destDir, path.basename(entry));
      if (existsSync(dest)) saved.push(dest);
    }
    return { tool, saved };
  }

  // powershell Expand-Archive: 部分抽出不可 → 一時ディレクトリへ全展開して対象だけコピー
  if (tool === 'powershell') {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'livecity-lod2-'));
    try {
      log('[FALLBACK] PowerShell Expand-Archive は部分抽出不可のため一時全展開します（最終手段）。');
      const r = spawnSync('powershell', [
        '-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmp}' -Force`,
      ], { stdio: 'ignore' });
      if (r.status !== 0) throw new Error('Expand-Archive が失敗しました。');
      // 一時展開内から対象 basename を探してコピー
      const wanted = new Set(entryNames.map((e) => path.basename(e).toLowerCase()));
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const full = path.join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (wanted.has(name.toLowerCase())) {
            const dest = path.join(destDir, name);
            copyFileSync(full, dest);
            saved.push(dest);
          }
        }
      };
      walk(tmp);
      return { tool, saved };
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 無視 */ }
    }
  }

  throw new Error(`未知のフォールバックツール: ${tool}`);
}
