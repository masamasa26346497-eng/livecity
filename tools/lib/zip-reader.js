// tools/lib/zip-reader.js
// ローカル ZIP の中央ディレクトリを読み、エントリ単位で展開する最小リーダ。
//   ZIP64 対応 / store(0) と deflate(8) をサポート。依存なし（Node 組み込み fs + zlib のみ）。
//   PLATEAU の市配布 CityGML（数 GB・数千エントリ）を全展開せず必要な GML だけ取り出すために使う。
import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * @param {string} file ZIP パス
 * @returns {Array<{name:string, method:number, compSize:number, uncompSize:number, localOff:number}>}
 */
export function readZipEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.statSync(file).size;
    const tailLen = Math.min(size, 66560); // EOCD(22) + comment(最大65535) を確実に含む
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('EOCD が見つからない（ZIP ではない可能性）: ' + file);
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xFFFFFFFF || count === 0xFFFF || cdSize === 0xFFFFFFFF) {
      let loc = -1;
      for (let i = eocd - 20; i >= 0; i--) if (tail.readUInt32LE(i) === 0x07064b50) { loc = i; break; }
      if (loc >= 0) {
        const z64Off = Number(tail.readBigUInt64LE(loc + 8));
        const z = Buffer.alloc(56);
        fs.readSync(fd, z, 0, 56, z64Off);
        if (z.readUInt32LE(0) === 0x06064b50) {
          count = Number(z.readBigUInt64LE(32));
          cdSize = Number(z.readBigUInt64LE(40));
          cdOff = Number(z.readBigUInt64LE(48));
        }
      }
    }
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOff = cd.readUInt32LE(p + 42);
      const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');
      if (uncompSize === 0xFFFFFFFF || compSize === 0xFFFFFFFF || localOff === 0xFFFFFFFF) {
        let e = p + 46 + nameLen; const end = e + extraLen;
        while (e + 4 <= end) {
          const id = cd.readUInt16LE(e), sz = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (uncompSize === 0xFFFFFFFF) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (compSize === 0xFFFFFFFF) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (localOff === 0xFFFFFFFF) { localOff = Number(cd.readBigUInt64LE(q)); q += 8; }
            break;
          }
          e += 4 + sz;
        }
      }
      entries.push({ name, method, compSize, uncompSize, localOff });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally { fs.closeSync(fd); }
}

/** エントリ 1 件を展開して Buffer で返す。 */
export function extractEntry(file, entry) {
  const fd = fs.openSync(file, 'r');
  try {
    const hdr = Buffer.alloc(30);
    fs.readSync(fd, hdr, 0, 30, entry.localOff);
    if (hdr.readUInt32LE(0) !== 0x04034b50) throw new Error('local header 不正: ' + entry.name);
    const nl = hdr.readUInt16LE(26), el = hdr.readUInt16LE(28);
    const comp = Buffer.alloc(entry.compSize);
    fs.readSync(fd, comp, 0, entry.compSize, entry.localOff + 30 + nl + el);
    if (entry.method === 0) return comp;
    if (entry.method === 8) return zlib.inflateRawSync(comp, { maxOutputLength: 1 << 30 });
    throw new Error('未対応の圧縮方式 ' + entry.method + ': ' + entry.name);
  } finally { fs.closeSync(fd); }
}

// [Mission 31G-FIX22] ネスト ZIP（ZIP の中に ZIP が入っている GSI 基盤地図情報の一括ダウンロード形式）
//   対応のため、file path ではなく in-memory Buffer から直接読む版を追加する。
//   既存の readZipEntries/extractEntry（file path 版）はロジック・シグネチャとも一切変更しない
//   （他の利用箇所への影響ゼロ・純粋な追加のみ）。中央ディレクトリ解析ロジックは同一。
/**
 * @param {Buffer} buf ZIP 全体を読み込んだ Buffer
 * @returns {Array<{name:string, method:number, compSize:number, uncompSize:number, localOff:number}>}
 */
export function readZipEntriesFromBuffer(buf) {
  const size = buf.length;
  const tailLen = Math.min(size, 66560);
  const tail = buf.slice(size - tailLen, size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('EOCD が見つからない（ZIP ではない可能性、または buffer が不完全）');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOff = tail.readUInt32LE(eocd + 16);
  if (cdOff === 0xFFFFFFFF || count === 0xFFFF || cdSize === 0xFFFFFFFF) {
    let loc = -1;
    for (let i = eocd - 20; i >= 0; i--) if (tail.readUInt32LE(i) === 0x07064b50) { loc = i; break; }
    if (loc >= 0) {
      const z64Off = Number(tail.readBigUInt64LE(loc + 8));
      const z = buf.slice(z64Off, z64Off + 56);
      if (z.readUInt32LE(0) === 0x06064b50) {
        count = Number(z.readBigUInt64LE(32));
        cdSize = Number(z.readBigUInt64LE(40));
        cdOff = Number(z.readBigUInt64LE(48));
      }
    }
  }
  const cd = buf.slice(cdOff, cdOff + cdSize);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOff = cd.readUInt32LE(p + 42);
    const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (uncompSize === 0xFFFFFFFF || compSize === 0xFFFFFFFF || localOff === 0xFFFFFFFF) {
      let e = p + 46 + nameLen; const end = e + extraLen;
      while (e + 4 <= end) {
        const id = cd.readUInt16LE(e), sz = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xFFFFFFFF) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xFFFFFFFF) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOff === 0xFFFFFFFF) { localOff = Number(cd.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + sz;
      }
    }
    entries.push({ name, method, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
/** エントリ 1 件を Buffer から展開する（file path 不要）。 */
export function extractEntryFromBuffer(buf, entry) {
  const hdr = buf.slice(entry.localOff, entry.localOff + 30);
  if (hdr.readUInt32LE(0) !== 0x04034b50) throw new Error('local header 不正: ' + entry.name);
  const nl = hdr.readUInt16LE(26), el = hdr.readUInt16LE(28);
  const start = entry.localOff + 30 + nl + el;
  const comp = buf.slice(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(comp);
  if (entry.method === 8) return zlib.inflateRawSync(comp, { maxOutputLength: 1 << 30 });
  throw new Error('未対応の圧縮方式 ' + entry.method + ': ' + entry.name);
}

/** codelist XML（gml:Definition の name/description）→ { code: 説明 }。 */
export function parseCodelist(xml) {
  const out = {};
  for (const m of String(xml).matchAll(/<gml:Definition>[\s\S]*?<\/gml:Definition>/g)) {
    const nm = (m[0].match(/<gml:name>([^<]*)<\/gml:name>/) || [])[1];
    const de = (m[0].match(/<gml:description>([^<]*)<\/gml:description>/) || [])[1];
    if (nm != null) out[nm.trim()] = (de || '').trim();
  }
  if (!Object.keys(out).length) {
    for (const m of String(xml).matchAll(/<gml:description>([^<]*)<\/gml:description>\s*<gml:name>([^<]*)<\/gml:name>/g)) out[m[2].trim()] = m[1].trim();
  }
  return out;
}
