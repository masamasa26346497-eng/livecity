// tests/http-download.test.js
// tools/lib/http-download.js の完了処理・再開・Range非対応時の挙動を、
// ローカルHTTPサーバ(ネットワーク非依存)で検証する。EBADF(二重close)の回帰防止が主目的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, statSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadLargeFile } from '../tools/lib/http-download.js';

// 決定的なテスト用ペイロード（2MB）
const PAYLOAD = Buffer.alloc(2 * 1024 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 31 + 7) & 0xff;
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

/**
 * テスト用HTTPサーバを起動する。
 * @param {object} opts
 * @param {boolean} opts.acceptRanges Rangeを受け付けるか
 * @param {number} [opts.cutAfter] このバイト数だけ送って接続を切る（途中切断の模擬）。未指定なら全送信。
 */
function startServer(opts = {}) {
  const { acceptRanges = true, cutAfter = null } = opts;
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.setHeader('content-length', String(PAYLOAD.length));
      res.setHeader('etag', '"test-etag"');
      if (acceptRanges) res.setHeader('accept-ranges', 'bytes');
      res.statusCode = 200;
      return res.end();
    }
    const range = acceptRanges ? req.headers['range'] : undefined;
    let start = 0;
    if (range) {
      const m = /bytes=(\d+)-/.exec(range);
      if (m) start = Number(m[1]);
    }
    const body = PAYLOAD.subarray(start);
    if (range && start > 0) {
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`);
      res.setHeader('content-length', String(body.length));
    } else {
      res.statusCode = 200;
      res.setHeader('content-length', String(PAYLOAD.length));
    }
    if (acceptRanges) res.setHeader('accept-ranges', 'bytes');
    if (cutAfter != null && cutAfter < body.length) {
      res.write(body.subarray(0, cutAfter));
      // 即destroyだとクライアントが1バイトも受け取る前に切れることがあるため、
      // フラッシュを待ってから切断する（部分.tempが確実に残る状況を再現）。
      setTimeout(() => { try { res.socket.destroy(); } catch { /* noop */ } }, 50);
    } else {
      res.end(body);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('正常完了: 二重closeエラー(EBADF)を起こさず保存でき、sha256が一致する', async () => {
  const { server, port } = await startServer({ acceptRanges: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  try {
    const dest = path.join(tmp, 'file.zip');
    const r = await downloadLargeFile(`http://127.0.0.1:${port}/file.zip`, dest, {
      timeoutMs: 5000, maxRetries: 1, retryBackoffMs: 10, log: () => {},
    });
    assert.equal(r.status, 'downloaded');
    assert.equal(r.bytes, PAYLOAD.length);
    assert.equal(r.sha256, PAYLOAD_SHA);
    assert.ok(existsSync(dest));
    assert.ok(!existsSync(dest + '.temp'), '.tempは正常時に残らない');
    assert.equal(createHash('sha256').update(readFileSync(dest)).digest('hex'), PAYLOAD_SHA);
  } finally {
    server.close(); rmSync(tmp, { recursive: true, force: true });
  }
});

test('途中切断→再実行で.tempから再開して完了する(Range対応)', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  const dest = path.join(tmp, 'file.zip');
  // 1回目: 半分だけ送って切断（maxRetries=0で必ず失敗させ、.tempを残す）
  const s1 = await startServer({ acceptRanges: true, cutAfter: PAYLOAD.length / 2 });
  try {
    await assert.rejects(() => downloadLargeFile(`http://127.0.0.1:${s1.port}/file.zip`, dest, {
      timeoutMs: 5000, maxRetries: 0, retryBackoffMs: 10, log: () => {},
    }));
    assert.ok(existsSync(dest + '.temp'), '失敗後は.tempが残る（再開用）');
    const partial = statSync(dest + '.temp').size;
    assert.ok(partial > 0 && partial < PAYLOAD.length, '部分ダウンロードが保存されている');
  } finally {
    s1.server.close();
  }
  // 2回目: 完全なサーバで再実行 → .tempから再開して完了
  const s2 = await startServer({ acceptRanges: true });
  try {
    const r = await downloadLargeFile(`http://127.0.0.1:${s2.port}/file.zip`, dest, {
      timeoutMs: 5000, maxRetries: 1, retryBackoffMs: 10, log: () => {},
    });
    assert.equal(r.status, 'downloaded');
    assert.equal(r.sha256, PAYLOAD_SHA, '再開後も内容が完全一致（追記位置ズレなし）');
    assert.ok(!existsSync(dest + '.temp'));
  } finally {
    s2.server.close(); rmSync(tmp, { recursive: true, force: true });
  }
});

test('Range非対応サーバ: 残存.tempを破棄して先頭から取得し完了する', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  const dest = path.join(tmp, 'file.zip');
  // 破損した.tempをあらかじめ置いておく
  writeFileSync(dest + '.temp', Buffer.from('corrupted partial data'));
  const { server, port } = await startServer({ acceptRanges: false });
  try {
    const r = await downloadLargeFile(`http://127.0.0.1:${port}/file.zip`, dest, {
      timeoutMs: 5000, maxRetries: 1, retryBackoffMs: 10, useRangeResume: true, log: () => {},
    });
    assert.equal(r.status, 'downloaded');
    assert.equal(r.sha256, PAYLOAD_SHA, '破損.tempに追記せず先頭から取り直して正しい内容になる');
  } finally {
    server.close(); rmSync(tmp, { recursive: true, force: true });
  }
});

test('サイズ不一致(途中切断)は失敗として扱い、正式ファイルを作らない', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  const dest = path.join(tmp, 'file.zip');
  // Range非対応かつ毎回途中で切断 → 常にサイズ不足で失敗
  const { server, port } = await startServer({ acceptRanges: false, cutAfter: 1024 });
  try {
    await assert.rejects(() => downloadLargeFile(`http://127.0.0.1:${port}/file.zip`, dest, {
      timeoutMs: 5000, maxRetries: 1, retryBackoffMs: 10, log: () => {},
    }));
    assert.ok(!existsSync(dest), '不完全な取得を正式ファイルへ昇格させない');
  } finally {
    server.close(); rmSync(tmp, { recursive: true, force: true });
  }
});
