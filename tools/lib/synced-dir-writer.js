// tools/lib/synced-dir-writer.js
// [Mission 32N] OneDrive 同期下のディレクトリへ大量の tile を書くときの安全な書き方。
//
//   実測（32N）: 出力ディレクトリを rmSync → 同名ファイルを再作成すると、OneDrive が
//   前回分の同期と衝突して `tile_x_z-<PC名>.json` / `-<PC名>-2.json` の競合コピーを作り、
//   さらに正規名のファイルが競合名へリネームされて消える（988 tile 中 101 が消失）。
//   また同期中のファイルの読み込みが `UNKNOWN: unknown error, read` で失敗する。
//
//   対策:
//     - ディレクトリを消さない。期待するファイルを上書きし、期待外のファイルだけを消す。
//     - 書いた後に読み戻して内容を照合し、欠落・不一致は書き直す（静かになるまで繰り返す）。
//   消すのは呼び出し側が所有するディレクトリ内の「期待外の通常ファイル」だけ（§14）。
import fs from 'node:fs';
import path from 'node:path';

export const STRICT_TILE_RE = /^tile_-?\d+_-?\d+\.json$/;

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function readOrNull(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

/** 期待外の通常ファイルを消す（サブディレクトリには触れない）。消した数を返す。 */
export function removeUnexpectedFiles(dir, expectedNames) {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (expectedNames.has(f)) continue;
    const p = path.join(dir, f);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    try { fs.rmSync(p, { force: true }); removed++; } catch { /* 次の周回で再試行 */ }
  }
  return removed;
}

/**
 * files: Map<name, string> を dir へ書き、読み戻しで一致するまで検証する。
 * removeStray=false: 期待外ファイルを消さない・数えない（他の成果物と同居する作業ディレクトリ用）。
 * @returns {{written:number, rewrites:number, strayRemoved:number, rounds:number}}
 */
export function writeFilesVerified(dir, files, { settleMs = 15000, maxRounds = 12, label = dir, removeStray = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const expected = new Set(files.keys());
  let rewrites = 0, strayRemoved = 0;
  for (const [name, content] of files) {
    if (readOrNull(path.join(dir, name)) === content) continue; // 同一内容は触らない（同期を起こさない）
    fs.writeFileSync(path.join(dir, name), content);
  }
  let clean = 0;
  for (let round = 1; round <= maxRounds; round++) {
    sleepSync(settleMs);
    if (removeStray) strayRemoved += removeUnexpectedFiles(dir, expected);
    let bad = 0;
    for (const [name, content] of files) {
      const p = path.join(dir, name);
      if (readOrNull(p) === content) continue;
      bad++; rewrites++;
      try { fs.writeFileSync(p, content); } catch { /* 次の周回 */ }
    }
    const stray = removeStray ? fs.readdirSync(dir).filter((f) => !expected.has(f) && fs.statSync(path.join(dir, f)).isFile()).length : 0;
    console.log(`[synced-write] ${label}: round ${round} mismatched ${bad} stray ${stray}`);
    clean = (bad === 0 && stray === 0) ? clean + 1 : 0;
    if (clean >= 2) return { written: files.size, rewrites, strayRemoved, rounds: round };
  }
  throw new Error(`[synced-write] ${label}: ${maxRounds} 周回しても安定しない（OneDrive 同期を一時停止して再実行してください）`);
}

/** 同期中の一時的な読み込み失敗を吸収する readFileSync。 */
export function readFileRetry(p, enc = 'utf-8', tries = 8) {
  for (let i = 1; ; i++) {
    try { return fs.readFileSync(p, enc); }
    catch (e) {
      if (i >= tries || !/UNKNOWN|EBUSY|EPERM|EAGAIN/.test(String(e && e.code))) throw e;
      sleepSync(1000 * i);
    }
  }
}
