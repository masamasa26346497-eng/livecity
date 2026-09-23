// tools/lib/geotiff-header.js
// [Mission 35B §2] GeoTIFF の **ヘッダだけ** を読んで、画素数と地上画素寸法（GSD）を出す。
//   数百 MB を丸ごと落とさずに済むよう HTTP Range で必要な部分だけ取る。
//   依存を増やさないため TIFF/GeoTIFF の必要最小限だけを自前で解く。

export const TIFF_TAG = {
  256: 'ImageWidth', 257: 'ImageLength', 258: 'BitsPerSample', 259: 'Compression',
  262: 'PhotometricInterpretation', 273: 'StripOffsets', 277: 'SamplesPerPixel',
  278: 'RowsPerStrip', 279: 'StripByteCounts', 282: 'XResolution', 283: 'YResolution',
  296: 'ResolutionUnit', 305: 'Software', 306: 'DateTime',
  322: 'TileWidth', 323: 'TileLength', 324: 'TileOffsets', 325: 'TileByteCounts',
  33550: 'ModelPixelScale', 33922: 'ModelTiepoint', 34264: 'ModelTransformation',
  34735: 'GeoKeyDirectory', 34736: 'GeoDoubleParams', 34737: 'GeoAsciiParams',
  42112: 'GDAL_METADATA', 42113: 'GDAL_NODATA',
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

/** EPSG コードなどが入る GeoKey のうち、座標系の判別に要るものだけ。 */
export const GEO_KEY = {
  1024: 'GTModelType', 1025: 'GTRasterType', 2048: 'GeographicTypeGeoKey',
  3072: 'ProjectedCSTypeGeoKey', 3076: 'ProjLinearUnitsGeoKey', 1026: 'GTCitation', 3073: 'PCSCitation',
};

function readVal(buf, off, type, count, le) {
  const rd = {
    1: (o) => buf.readUInt8(o), 2: (o) => buf.readUInt8(o), 6: (o) => buf.readInt8(o), 7: (o) => buf.readUInt8(o),
    3: (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)),
    8: (o) => (le ? buf.readInt16LE(o) : buf.readInt16BE(o)),
    4: (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)),
    9: (o) => (le ? buf.readInt32LE(o) : buf.readInt32BE(o)),
    11: (o) => (le ? buf.readFloatLE(o) : buf.readFloatBE(o)),
    12: (o) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o)),
    16: (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o)),
    17: (o) => Number(le ? buf.readBigInt64LE(o) : buf.readBigInt64BE(o)),
    5: (o) => { const a = le ? buf.readUInt32LE(o) : buf.readUInt32BE(o); const b = le ? buf.readUInt32LE(o + 4) : buf.readUInt32BE(o + 4); return b ? a / b : 0; },
    10: (o) => { const a = le ? buf.readInt32LE(o) : buf.readInt32BE(o); const b = le ? buf.readInt32LE(o + 4) : buf.readInt32BE(o + 4); return b ? a / b : 0; },
  }[type];
  if (!rd) return null;
  const sz = TYPE_SIZE[type] || 1;
  if (type === 2) return buf.slice(off, off + count).toString('latin1').replace(/\0+$/, '');
  const out = [];
  for (let i = 0; i < count; i++) {
    if (off + i * sz + sz > buf.length) break;
    out.push(rd(off + i * sz));
  }
  return out.length === 1 ? out[0] : out;
}

/**
 * TIFF / BigTIFF の最初の IFD を解く。
 * @param {(start:number, end:number)=>Promise<Buffer>} readRange バイト範囲を返す関数
 */
export async function readTiffHeader(readRange) {
  const head = await readRange(0, 15);
  if (!head || head.length < 8) throw new Error('ヘッダが読めない');
  const le = head[0] === 0x49 && head[1] === 0x49;
  const be = head[0] === 0x4d && head[1] === 0x4d;
  if (!le && !be) throw new Error('TIFF ではない');
  const magic = le ? head.readUInt16LE(2) : head.readUInt16BE(2);
  const bigTiff = magic === 43;
  if (magic !== 42 && magic !== 43) throw new Error('TIFF magic が違う: ' + magic);
  const ifdOffset = bigTiff
    ? Number(le ? head.readBigUInt64LE(8) : head.readBigUInt64BE(8))
    : (le ? head.readUInt32LE(4) : head.readUInt32BE(4));

  const entrySize = bigTiff ? 20 : 12;
  const countSize = bigTiff ? 8 : 2;
  const cntBuf = await readRange(ifdOffset, ifdOffset + countSize - 1);
  const nEntries = bigTiff
    ? Number(le ? cntBuf.readBigUInt64LE(0) : cntBuf.readBigUInt64BE(0))
    : (le ? cntBuf.readUInt16LE(0) : cntBuf.readUInt16BE(0));
  if (!(nEntries > 0 && nEntries < 4096)) throw new Error('IFD entry 数が異常: ' + nEntries);
  const dirStart = ifdOffset + countSize;
  const dir = await readRange(dirStart, dirStart + nEntries * entrySize - 1);

  const tags = {};
  const deferred = [];
  for (let i = 0; i < nEntries; i++) {
    const o = i * entrySize;
    const tag = le ? dir.readUInt16LE(o) : dir.readUInt16BE(o);
    const type = le ? dir.readUInt16LE(o + 2) : dir.readUInt16BE(o + 2);
    const count = bigTiff
      ? Number(le ? dir.readBigUInt64LE(o + 4) : dir.readBigUInt64BE(o + 4))
      : (le ? dir.readUInt32LE(o + 4) : dir.readUInt32BE(o + 4));
    const valueOff = o + (bigTiff ? 12 : 8);
    const inlineBytes = bigTiff ? 8 : 4;
    const total = (TYPE_SIZE[type] || 1) * count;
    const name = TIFF_TAG[tag] || ('tag' + tag);
    if (total <= inlineBytes) {
      tags[name] = readVal(dir, valueOff, type, count, le);
    } else {
      const ptr = bigTiff
        ? Number(le ? dir.readBigUInt64LE(valueOff) : dir.readBigUInt64BE(valueOff))
        : (le ? dir.readUInt32LE(valueOff) : dir.readUInt32BE(valueOff));
      // 巨大な配列（StripOffsets 等）は読まない。GSD に要るものだけ。
      if (total < 64 * 1024 || /ModelPixelScale|ModelTiepoint|GeoKeyDirectory|GeoDoubleParams|GeoAsciiParams|GDAL_METADATA/.test(name)) {
        deferred.push({ name, ptr, type, count, total });
      } else {
        tags[name] = { deferred: true, byteCount: total };
      }
    }
  }
  for (const d of deferred) {
    try {
      const b = await readRange(d.ptr, d.ptr + Math.min(d.total, 256 * 1024) - 1);
      tags[d.name] = readVal(b, 0, d.type, Math.min(d.count, 32768), le);
    } catch { tags[d.name] = { unreadable: true }; }
  }
  return { littleEndian: le, bigTiff, ifdOffset, entryCount: nEntries, tags };
}

/** GeoKeyDirectory を読める形にする。 */
export function parseGeoKeys(dirArr, asciiParams, doubleParams) {
  if (!Array.isArray(dirArr) || dirArr.length < 4) return null;
  const n = dirArr[3];
  const out = {};
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 4;
    const key = dirArr[o], loc = dirArr[o + 1], count = dirArr[o + 2], val = dirArr[o + 3];
    const name = GEO_KEY[key] || ('key' + key);
    if (loc === 0) out[name] = val;
    else if (loc === 34737 && typeof asciiParams === 'string') out[name] = asciiParams.substr(val, count).replace(/\|$/, '');
    else if (loc === 34736 && Array.isArray(doubleParams)) out[name] = doubleParams[val];
    else out[name] = { location: loc, offset: val, count };
  }
  return out;
}

/**
 * ModelPixelScale から地上画素寸法を出す。
 * 投影座標系（GTModelType=1）なら m そのもの。
 * **地理座標系（GTModelType=2）なら度なので、緯度を使って m へ直す**。
 * ここを間違えると 0.37m を 0.000004m と読んでしまう。
 * @param {object} h readTiffHeader の戻り値
 * @param {number|null} fallbackLat 地理座標系のとき使う緯度（無ければ tiepoint の緯度）
 */
export function gsdFromHeader(h, fallbackLat = null) {
  const t = h.tags || {};
  const sc = t.ModelPixelScale;
  let px = Array.isArray(sc) ? sc[0] : null;
  let py = Array.isArray(sc) ? sc[1] : null;
  const keys = parseGeoKeys(t.GeoKeyDirectory, t.GeoAsciiParams, t.GeoDoubleParams) || {};
  const geographic = keys.GTModelType === 2;
  let latForScale = fallbackLat;
  if (latForScale == null && Array.isArray(t.ModelTiepoint) && t.ModelTiepoint.length >= 6) {
    latForScale = t.ModelTiepoint[4];
  }
  let gsdXm = px, gsdYm = py;
  if (geographic && px != null && py != null) {
    const lat = latForScale ?? 35;
    gsdXm = px * 111320 * Math.cos((lat * Math.PI) / 180);
    gsdYm = py * 111320;
  }
  return {
    width: t.ImageWidth ?? null, height: t.ImageLength ?? null,
    crsKind: geographic ? 'geographic' : 'projected',
    crs: keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey || null,
    crsName: keys.GTCitation || keys.PCSCitation || keys.key2049 || null,
    pixelScaleX: px, pixelScaleY: py,
    gsdXm: gsdXm != null ? +Number(gsdXm).toFixed(4) : null,
    gsdYm: gsdYm != null ? +Number(gsdYm).toFixed(4) : null,
    // 代表値は「粗いほう」を採る。細かいほうを名乗ると過大評価になる。
    gsdM: (gsdXm != null && gsdYm != null) ? +Math.max(gsdXm, gsdYm).toFixed(4) : null,
    samplesPerPixel: t.SamplesPerPixel ?? null,
    bitsPerSample: t.BitsPerSample ?? null,
    compression: t.Compression ?? null,
    tileWidth: t.TileWidth ?? null, tileLength: t.TileLength ?? null,
    dateTime: t.DateTime ?? null, software: t.Software ?? null,
    megapixels: (t.ImageWidth && t.ImageLength) ? +((t.ImageWidth * t.ImageLength) / 1e6).toFixed(1) : null,
    groundWidthM: (t.ImageWidth && gsdXm) ? +(t.ImageWidth * gsdXm).toFixed(1) : null,
    groundHeightM: (t.ImageLength && gsdYm) ? +(t.ImageLength * gsdYm).toFixed(1) : null,
    tiepoint: t.ModelTiepoint ?? null,
  };
}

/** HTTP Range で読む reader を作る。Range 非対応なら null を返す。 */
export function rangeReader(url, { userAgent, timeoutMs = 30000 } = {}) {
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
