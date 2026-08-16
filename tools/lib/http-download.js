// tools/lib/http-download.js
// 大容量アーカイブ(PLATEAU CityGML ZIP等)の安全な取得を担う共通ライブラリ。
//
// 設計方針（ご指示3「大容量取得への対策」への対応）:
//  - 途中DL用の .temp ファイルへ書き、完了時のみ正式ファイルへ rename する
//    （失敗時に完成ファイルを上書きしない。既存パイプラインの writeJsonSafely と同じ tmp→rename 思想）。
//  - 既存の正式ファイルがあり、記録済みハッシュ or Content-Length or ETag と整合するなら再取得しない。
//  - Content-Length / ETag / Last-Modified を記録する。
//  - タイムアウトとリトライ（指数バックオフ）を実装する。
//  - 進捗を表示する（一定バイトごと、TTYでなくても行更新でなく通常ログで出す）。
//  - Range Request に対応し、.temp が途中まで残っていれば続きから再開する（サーバがRangeを拒否したら先頭から）。
//
// このライブラリは fetch/undici(Node18+標準)に依存する。ネットワーク不可の環境では
// 呼び出し側がオフラインである旨を検出して停止するため、ここではネットワークI/Oのみ担う。

import { existsSync, statSync } from 'fs';
import { open, rename, unlink, readFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { ensureDir } from './area.js';

/**
 * sha256 を算出する（完成ファイルの検証・マニフェスト記録用）。
 */
export async function sha256OfFile(filePath) {
  const buf = await readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function human(bytes) {
  if (bytes == null) return '不明';
  const u = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)}${u[i]}`;
}

/**
 * HEADリクエストで Content-Length / ETag / Accept-Ranges を取得する（存在すれば）。
 * サーバがHEAD非対応でも致命的ではないので、失敗は null 群で返す。
 */
async function headInfo(url, { timeoutMs, userAgent }) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, headers: { 'user-agent': userAgent } });
    clearTimeout(t);
    if (!res.ok) return { ok: false };
    return {
      ok: true,
      contentLength: res.headers.get('content-length') ? Number(res.headers.get('content-length')) : null,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      acceptRanges: (res.headers.get('accept-ranges') || '').includes('bytes'),
    };
  } catch {
    return { ok: false };
  }
}

/**
 * 大容量ファイルを取得する。
 *
 * @param {string} url
 * @param {string} destPath 最終保存先（正式ファイル）
 * @param {object} opts
 * @param {number} [opts.timeoutMs=120000]
 * @param {number} [opts.maxRetries=4]
 * @param {number} [opts.retryBackoffMs=3000]
 * @param {boolean} [opts.useRangeResume=true]
 * @param {string} [opts.userAgent]
 * @param {object|null} [opts.priorRecord] 前回マニフェストの該当エントリ（{etag,contentLength,sha256}）。整合すれば再取得スキップ。
 * @param {(msg:string)=>void} [opts.log=console.log]
 * @returns {Promise<{status:'skipped-cached'|'downloaded', bytes:number, sha256:string, etag:string|null, lastModified:string|null, contentLength:number|null}>}
 */
export async function downloadLargeFile(url, destPath, opts = {}) {
  const {
    timeoutMs = 120000,
    maxRetries = 4,
    retryBackoffMs = 3000,
    useRangeResume = true,
    userAgent = 'LiveCity-DataPipeline/0.1',
    priorRecord = null,
    log = console.log,
  } = opts;

  await ensureDir(path.dirname(destPath));
  const tempPath = `${destPath}.temp`;

  // --- キャッシュ判定: 既存の正式ファイルがあり、記録と整合するなら再取得しない ---
  if (existsSync(destPath) && priorRecord) {
    const head = await headInfo(url, { timeoutMs, userAgent });
    const sizeOk = priorRecord.contentLength != null &&
      statSync(destPath).size === priorRecord.contentLength;
    const etagOk = head.ok && head.etag && priorRecord.etag && head.etag === priorRecord.etag;
    const remoteSizeOk = head.ok && head.contentLength != null &&
      statSync(destPath).size === head.contentLength;
    if (etagOk || (sizeOk && (remoteSizeOk || !head.ok))) {
      log(`[SKIP] キャッシュ有効: ${path.basename(destPath)} (${human(statSync(destPath).size)}) — 再取得しません。`);
      return {
        status: 'skipped-cached',
        bytes: statSync(destPath).size,
        sha256: priorRecord.sha256 || await sha256OfFile(destPath),
        etag: priorRecord.etag || (head.ok ? head.etag : null),
        lastModified: priorRecord.lastModified || (head.ok ? head.lastModified : null),
        contentLength: priorRecord.contentLength ?? (head.ok ? head.contentLength : null),
      };
    }
    log(`[INFO] 既存ファイルがキャッシュ記録と不一致のため再取得します: ${path.basename(destPath)}`);
  }

  const head = await headInfo(url, { timeoutMs, userAgent });
  const totalBytes = head.ok ? head.contentLength : null;
  const canResume = useRangeResume && head.ok && head.acceptRanges;

  let attempt = 0;
  let lastErr = null;
  while (attempt <= maxRetries) {
    attempt++;
    // fh は finally で必ず1回だけ close する。二重closeを構造的に防ぐため、
    // createWriteStream(autoCloseがfdをcloseする)は使わず FileHandle.write を直接使う。
    let fh = null;
    try {
      // .temp が残っていて Range 可能なら続きから、そうでなければ破損とみなして破棄。
      let startByte = 0;
      if (existsSync(tempPath)) {
        const tempSize = statSync(tempPath).size;
        if (canResume && tempSize > 0 && (totalBytes == null || tempSize < totalBytes)) {
          // 正常な部分ダウンロード → 続きから再開
          startByte = tempSize;
          log(`[INFO] 既存の.tempから再開します: ${human(tempSize)}${totalBytes ? '/' + human(totalBytes) : ''} 済み`);
        } else if (canResume && totalBytes != null && tempSize >= totalBytes) {
          // .temp がすでに総サイズ以上（前回の完了検証前に落ちた/破損の疑い）→ 破棄して先頭から
          log(`[INFO] .tempのサイズが総サイズ以上のため破損とみなし、先頭から取得します。`);
          await unlink(tempPath).catch(() => {});
        } else {
          // Range非対応 → 部分.tempは続きから書けないため破棄して先頭から明確に再取得
          log(`[INFO] サーバがRange非対応のため、既存の.tempを破棄して先頭から取得します。`);
          await unlink(tempPath).catch(() => {});
        }
      }

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const headers = { 'user-agent': userAgent };
      if (startByte > 0) headers['range'] = `bytes=${startByte}-`;

      const res = await fetch(url, { signal: ctrl.signal, headers });
      clearTimeout(t);

      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      // サーバがRangeを無視して200(全体)を返した場合は、追記でなく先頭から書き直す。
      // （206以外で startByte>0 のまま追記すると .temp が二重長になり破損するため。）
      const appending = res.status === 206 && startByte > 0;
      if (startByte > 0 && res.status === 200) {
        log(`[INFO] サーバがRangeを無視し全体を返しました。.tempを破棄して先頭から取得します。`);
        await unlink(tempPath).catch(() => {});
      }

      fh = await open(tempPath, appending ? 'r+' : 'w'); // 追記時も位置指定writeを使うため r+
      let writePos = appending ? startByte : 0;
      let received = writePos;
      let lastLog = Date.now();

      const reader = res.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        // FileHandle.write(位置指定)。戻り値の bytesWritten を検証し、部分書き込みに対処。
        let written = 0;
        while (written < chunk.length) {
          const { bytesWritten } = await fh.write(chunk, written, chunk.length - written, writePos + written);
          if (bytesWritten <= 0) throw new Error('書き込みが進みませんでした（ディスク容量不足の可能性）。');
          written += bytesWritten;
        }
        writePos += chunk.length;
        received += chunk.length;
        if (Date.now() - lastLog > 1500) {
          const pct = totalBytes ? ` (${((received / totalBytes) * 100).toFixed(1)}%)` : '';
          log(`      … ${human(received)}${totalBytes ? '/' + human(totalBytes) : ''}${pct}`);
          lastLog = Date.now();
        }
      }

      // 完了処理: fsync（ディスクへ確実に書き出す）→ close（1回だけ）。
      // この順序を守ることで、rename前にデータが永続化されていることを保証する。
      await fh.sync();
      await fh.close();
      fh = null; // finallyでの二重closeを防ぐ（closeは成功済み）

      // 完了サイズ検証（Content-Lengthが分かる場合）
      const finalSize = statSync(tempPath).size;
      if (totalBytes != null && finalSize !== totalBytes) {
        throw new Error(`サイズ不一致: 期待${totalBytes} 実際${finalSize}（途中切断の可能性）`);
      }

      const sha = await sha256OfFile(tempPath);
      // 完了時のみ正式ファイルへ rename（失敗時は正式ファイルを壊さない）
      await rename(tempPath, destPath);
      log(`[OK] 取得完了: ${path.basename(destPath)} (${human(finalSize)})`);
      return {
        status: 'downloaded',
        bytes: finalSize,
        sha256: sha,
        etag: head.ok ? head.etag : null,
        lastModified: head.ok ? head.lastModified : null,
        contentLength: totalBytes,
      };
    } catch (err) {
      lastErr = err;
      log(`[WARN] 取得失敗(試行${attempt}/${maxRetries + 1}): ${err.message}`);
      if (attempt <= maxRetries) {
        const wait = retryBackoffMs * attempt;
        log(`      ${wait}ms 待機して再試行します…`);
        await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      // 例外時のみ fh が残る。ここで1回だけ close する（正常時は上で close 済み & fh=null）。
      // 既にcloseされた/destroyされたfdを再closeしないよう、null チェックで守る。
      if (fh) {
        try { await fh.close(); } catch { /* 既にclose済み等は無視（二重closeを起こさない） */ }
        fh = null;
      }
    }
  }
  // 全リトライ失敗: .temp は次回再開のため残す（正式ファイルは無傷）
  throw new Error(`ダウンロードに${maxRetries + 1}回失敗しました: ${url}\n最後のエラー: ${lastErr && lastErr.message}`);
}
