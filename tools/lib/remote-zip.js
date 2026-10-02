// tools/lib/remote-zip.js
// [Mission 35B §2] 数 GB の ZIP を落とさずに、HTTP Range で中身の一覧と
//   個別エントリの先頭だけを読む。GeoTIFF のヘッダを見て地上画素寸法を確かめるために使う。
//   tools/lib/zip-reader.js はローカルファイル用なので、こちらはリモート専用。
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;

/** Range で読む関数を作る。 */
export function httpRangeReader(url, { userAgent, timeoutMs = 60000 } = {}) {
  return async (start, end) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal,
        headers: { Range: `bytes=${start}-${end}`, ...(userAgent ? { 'User-Agent': userAgent } : {}) } });
      if (res.status !== 206) throw new Error('Range 非対応 (status ' + res.status + ')');
      return Buffer.from(await res.arrayBuffer());
    } finally { clearTimeout(t); }
  };
}

export async function contentLength(url, { userAgent } = {}) {
  const res = await fetch(url, { method: 'HEAD', headers: userAgent ? { 'User-Agent': userAgent } : {} });
  if (!res.ok) throw new Error('HEAD 失敗 ' + res.status);
  const n = Number(res.headers.get('content-length'));
  if (!Number.isFinite(n) || n <= 0) throw new Error('content-length が取れない');
  return { size: n, acceptRanges: res.headers.get('accept-ranges') };
}

/** ZIP の中央ディレクトリを読み、エントリ一覧を返す。ZIP64 に対応。 */
export async function listRemoteZip(url, { userAgent, tailBytes = 128 * 1024 } = {}) {
  const { size } = await contentLength(url, { userAgent });
  const read = httpRangeReader(url, { userAgent });
  const tailStart = Math.max(0, size - tailBytes);
  const tail = await read(tailStart, size - 1);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD が見つからない');
  let cenSize = tail.readUInt32LE(eocd + 12);
  let cenOffset = tail.readUInt32LE(eocd + 16);
  let total = tail.readUInt16LE(eocd + 10);

  // ZIP64
  if (cenOffset === 0xffffffff || cenSize === 0xffffffff || total === 0xffff) {
    let loc = -1;
    for (let i = eocd - 20; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD64_LOCATOR_SIG) { loc = i; break; }
    if (loc < 0) throw new Error('ZIP64 locator が見つからない');
    const eocd64Off = Number(tail.readBigUInt64LE(loc + 8));
    const b = await read(eocd64Off, eocd64Off + 55);
    if (b.readUInt32LE(0) !== EOCD64_SIG) throw new Error('ZIP64 EOCD が壊れている');
    total = Number(b.readBigUInt64LE(32));
    cenSize = Number(b.readBigUInt64LE(40));
    cenOffset = Number(b.readBigUInt64LE(48));
  }

  const cen = await read(cenOffset, cenOffset + cenSize - 1);
  const entries = [];
  let p = 0;
  while (p + 46 <= cen.length && cen.readUInt32LE(p) === CEN_SIG) {
    const method = cen.readUInt16LE(p + 10);
    let compressedSize = cen.readUInt32LE(p + 20);
    let uncompressedSize = cen.readUInt32LE(p + 24);
    const nameLen = cen.readUInt16LE(p + 28);
    const extraLen = cen.readUInt16LE(p + 30);
    const commentLen = cen.readUInt16LE(p + 32);
    let localOffset = cen.readUInt32LE(p + 42);
    const name = cen.slice(p + 46, p + 46 + nameLen).toString('utf-8');
    // ZIP64 extra field
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const hid = cen.readUInt16LE(e), hsz = cen.readUInt16LE(e + 2);
        if (hid === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(cen.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(cen.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cen.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + hsz;
      }
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { url, size, totalEntries: total, entries, read };
}

/**
 * 1 エントリの **先頭だけ** を取り出す。deflate でも部分展開する。
 * @param {number} wantBytes 取り出したい展開後のバイト数
 */
export async function readEntryHead(zip, entry, wantBytes = 256 * 1024) {
  const lh = await zip.read(entry.localOffset, entry.localOffset + 29);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('local header が壊れている: ' + entry.name);
  const nameLen = lh.readUInt16LE(26), extraLen = lh.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  if (entry.method === 0) {
    const n = Math.min(wantBytes, entry.uncompressedSize);
    return zip.read(dataStart, dataStart + n - 1);
  }
  if (entry.method !== 8) throw new Error('未対応の圧縮方式 ' + entry.method);
  // deflate は伸び率が読めないので、必要量の 4 倍 + 余白を取って部分展開する
  const grab = Math.min(entry.compressedSize, Math.max(wantBytes, 64 * 1024) * 4 + 4096);
  const raw = await zip.read(dataStart, dataStart + grab - 1);
  return new Promise((resolve) => {
    const inf = zlib.createInflateRaw();
    const chunks = []; let got = 0; let done = false;
    const finish = () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } };
    inf.on('data', (c) => { chunks.push(c); got += c.length; if (got >= wantBytes) { inf.destroy(); finish(); } });
    inf.on('end', finish); inf.on('close', finish); inf.on('error', finish);
    inf.end(raw);
  });
}

/** エントリ全体を取り出す（小さいものだけに使う）。 */
export async function readEntryFull(zip, entry) {
  const lh = await zip.read(entry.localOffset, entry.localOffset + 29);
  const nameLen = lh.readUInt16LE(26), extraLen = lh.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const raw = await zip.read(dataStart, dataStart + entry.compressedSize - 1);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error('未対応の圧縮方式 ' + entry.method);
  return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(entry.uncompressedSize, 1) });
}

/** ZIP エントリの中の 1 ファイルを、バイト範囲で読む reader にする（GeoTIFF ヘッダ用）。 */
export function entryRangeReader(zip, entry) {
  if (entry.method !== 0) return null;   // 無圧縮のときだけ真のランダムアクセスができる
  let dataStart = null;
  return async (start, end) => {
    if (dataStart == null) {
      const lh = await zip.read(entry.localOffset, entry.localOffset + 29);
      dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    }
    return zip.read(dataStart + start, dataStart + end);
  };
}
