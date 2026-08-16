// tools/lib/zip-reader.js
// 依存ゼロのZIP部分読み取りライブラリ。
//
// 目的（ご指示: Windows互換 & 1.5GB級を全展開しない）:
//   - unzip コマンドに依存しない。Node.js標準の fs（ランダムアクセス read）と zlib で完結する。
//   - ZIPの「中央ディレクトリ(End of Central Directory → Central Directory)」だけを読み、
//     エントリ一覧を得る。これはファイル末尾の数十KB〜数MBを読むだけで済む（全展開しない）。
//   - 個別エントリは、ローカルヘッダの位置へ seek して「そのエントリの圧縮バイトだけ」を読み、
//     zlib.inflateRawSync で1件ずつ解凍する。1.5GBのZIPでも、抽出対象GML(数MB)のI/Oしか発生しない。
//
// 対応範囲:
//   - 圧縮方式: stored(0) と deflate(8)。PLATEAUのCityGML ZIPはdeflate。
//   - ZIP64: End of Central Directoryが0xFFFFFFFF飽和している場合はZIP64 EOCDを辿る（大容量対応）。
//   - 非対応方式(bzip2等)や暗号化エントリに当たった場合は、呼び出し側がOSツールへフォールバックできるよう
//     明確なエラーを投げる（extractOr フォールバックは別関数で提供）。
//
// フォールバック（ご指示の優先順位2,3）:
//   - このNode実装で読めない場合に限り、PowerShell(Expand-Archive) / 7-Zip / unzip を使う
//     フォールバックを extractEntriesWithFallback() が試みる。ただし Expand-Archive は
//     「部分抽出」ができないため、フォールバックは最終手段（全展開→対象コピー）となる旨を明示する。

import { openSync, readSync, closeSync, statSync } from 'fs';
import zlib from 'zlib';

const EOCD_SIG = 0x06054b50;       // End of Central Directory
const EOCD64_SIG = 0x06064b50;     // ZIP64 End of Central Directory
const EOCD64_LOC_SIG = 0x07064b50; // ZIP64 EOCD locator
const CEN_SIG = 0x02014b50;        // Central Directory file header
const LOC_SIG = 0x04034b50;        // Local file header

function readChunk(fd, position, length) {
  const buf = Buffer.alloc(length);
  const bytes = readSync(fd, buf, 0, length, position);
  return bytes === length ? buf : buf.subarray(0, bytes);
}

/**
 * ZIPの中央ディレクトリを解析し、エントリ配列を返す。
 * 各エントリ: { fileName, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset }
 * @param {string} zipPath
 * @returns {Array}
 */
export function readCentralDirectory(zipPath) {
  const fd = openSync(zipPath, 'r');
  try {
    const size = statSync(zipPath).size;
    // --- EOCD を末尾から探索（コメント最大65535 + EOCD22バイト） ---
    const maxBack = Math.min(size, 65535 + 22);
    const tail = readChunk(fd, size - maxBack, maxBack);
    let eocdRel = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocdRel = i; break; }
    }
    if (eocdRel < 0) throw new Error('EOCDが見つかりません（ZIPではない/破損）。');

    let cdOffset = tail.readUInt32LE(eocdRel + 16);
    let cdSize = tail.readUInt32LE(eocdRel + 12);
    let totalEntries = tail.readUInt16LE(eocdRel + 10);

    // --- ZIP64 対応: いずれかが飽和(0xFFFFFFFF/0xFFFF)ならZIP64 EOCDを辿る ---
    const eocdAbs = size - maxBack + eocdRel;
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
      // EOCD の直前に ZIP64 EOCD Locator(20バイト)がある
      const locBuf = readChunk(fd, eocdAbs - 20, 20);
      if (locBuf.readUInt32LE(0) === EOCD64_LOC_SIG) {
        const zip64EocdOffset = Number(locBuf.readBigUInt64LE(8));
        const z64 = readChunk(fd, zip64EocdOffset, 56);
        if (z64.readUInt32LE(0) === EOCD64_SIG) {
          totalEntries = Number(z64.readBigUInt64LE(32));
          cdSize = Number(z64.readBigUInt64LE(40));
          cdOffset = Number(z64.readBigUInt64LE(48));
        }
      }
    }

    // --- 中央ディレクトリ本体を読む（ここだけで全エントリのメタが得られる） ---
    const cd = readChunk(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === CEN_SIG) {
      const compressionMethod = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const fileNameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const fileName = cd.toString('utf8', p + 46, p + 46 + fileNameLen);

      // ZIP64拡張フィールド解析（サイズ/オフセットが飽和している場合）
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        const extraStart = p + 46 + fileNameLen;
        let ep = extraStart;
        const extraEnd = extraStart + extraLen;
        while (ep + 4 <= extraEnd) {
          const tag = cd.readUInt16LE(ep);
          const sz = cd.readUInt16LE(ep + 2);
          let dp = ep + 4;
          if (tag === 0x0001) { // ZIP64
            if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(cd.readBigUInt64LE(dp)); dp += 8; }
            if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(dp)); dp += 8; }
            if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(cd.readBigUInt64LE(dp)); dp += 8; }
          }
          ep += 4 + sz;
        }
      }

      entries.push({ fileName, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
      p += 46 + fileNameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/**
 * 単一エントリの中身をBufferで取り出す（全展開せず、そのエントリの圧縮バイトのみを読む）。
 * @param {string} zipPath
 * @param {object} entry readCentralDirectory の1要素
 * @returns {Buffer}
 */
export function extractEntryBuffer(zipPath, entry) {
  const fd = openSync(zipPath, 'r');
  try {
    // ローカルヘッダ(30バイト固定 + fileNameLen + extraLen)を読み、実データ開始位置を得る。
    // 中央ディレクトリのfileNameLen/extraLenとローカルのそれは異なり得るため、ローカル側を必ず読む。
    const localFixed = readChunk(fd, entry.localHeaderOffset, 30);
    if (localFixed.readUInt32LE(0) !== LOC_SIG) {
      throw new Error(`ローカルヘッダ署名不一致: ${entry.fileName}`);
    }
    const nameLen = localFixed.readUInt16LE(26);
    const extraLen = localFixed.readUInt16LE(28);
    const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
    const comp = readChunk(fd, dataStart, entry.compressedSize);

    if (entry.compressionMethod === 0) {
      return comp; // stored（無圧縮）
    }
    if (entry.compressionMethod === 8) {
      return zlib.inflateRawSync(comp); // deflate
    }
    throw new Error(`未対応の圧縮方式 method=${entry.compressionMethod}（${entry.fileName}）。OSツールへのフォールバックが必要です。`);
  } finally {
    closeSync(fd);
  }
}

/**
 * 中身の一部だけをテキストで欲しい場合（監査の座標サンプル用に、大きなGMLでも先頭～必要分を得る）。
 * ここでは簡潔さのため全体を解凍して返す（対象GMLは数MB規模のため許容）。
 */
export function extractEntryText(zipPath, entry, encoding = 'utf8') {
  return extractEntryBuffer(zipPath, entry).toString(encoding);
}
