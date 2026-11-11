#!/usr/bin/env node
// Mission 79: PLATEAU Osaka-shi (27100) FY2025 CityGML (v5) source discovery + ZIP central-directory probe.
// Read-only. Fetches CKAN metadata, HEAD, and HTTP Range for the ZIP central directory only (no full download).
// Output: data/reports/mission79/source-lock.json  (locked manifest: URL, size, ETag, license, entry list)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mission 162: cwd 依存を廃止(リポジトリ外のフォルダから実行しても source-lock を解決できる)。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_ID = 'plateau-27100-osaka-shi-2025';
const CKAN = 'https://www.geospatial.jp/ckan/api/3/action/package_show?id=' + PACKAGE_ID;
export const LOCK_PATH = path.resolve(ROOT, 'data/reports/mission79/source-lock.json');
const UA = 'LiveCity-Mission79/1.0';

export function guardPackage(pkg) {
  // The Expo 2025 site dataset (plateau-27999-osaka-shi-2025) is a different, non-commercial dataset. Never mix.
  if (pkg.name !== PACKAGE_ID) throw new Error('Unexpected package ' + pkg.name);
}

export function pickCityGmlResource(pkg) {
  const r = (pkg.resources || []).find((x) => /citygml/i.test(x.name || '') && /\.zip$/i.test(x.url || ''));
  if (!r) throw new Error('CityGML ZIP resource not found');
  if (!/27100_osaka-shi_city_2025_citygml/.test(r.url)) throw new Error('Unexpected CityGML URL ' + r.url);
  return r;
}

export async function rangeFetch(url, start, end) {
  const res = await fetch(url, { headers: { range: 'bytes=' + start + '-' + end, 'accept-encoding': 'identity', 'user-agent': UA }, signal: AbortSignal.timeout(120000) });
  if (res.status !== 206) { try { await res.body?.cancel(); } catch {} throw new Error('Range HTTP ' + res.status); }
  return Buffer.from(await res.arrayBuffer());
}

// Parse a (possibly ZIP64) central directory buffer.
export function parseCentralDirectory(buf) {
  const out = [];
  let p = 0;
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const method = buf.readUInt16LE(p + 10);
    let comp = buf.readUInt32LE(p + 20), uncomp = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    let off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    if (comp === 0xffffffff || uncomp === 0xffffffff || off === 0xffffffff) {
      let q = p + 46 + nl; const end = q + el;
      while (q + 4 <= end) {
        const id = buf.readUInt16LE(q), sz = buf.readUInt16LE(q + 2);
        if (id === 1) {
          let r = q + 4;
          if (uncomp === 0xffffffff) { uncomp = Number(buf.readBigUInt64LE(r)); r += 8; }
          if (comp === 0xffffffff) { comp = Number(buf.readBigUInt64LE(r)); r += 8; }
          if (off === 0xffffffff) { off = Number(buf.readBigUInt64LE(r)); r += 8; }
        }
        q += 4 + sz;
      }
    }
    out.push({ name, method, compressedBytes: comp, uncompressedBytes: uncomp, localOffset: off });
    p += 46 + nl + el + cl;
  }
  return out;
}

export function kindOf(name) {
  return (path.basename(name).match(/^\d+_([a-z]+)_/) || [])[1] || 'other';
}

async function main() {
  const pkg = (await (await fetch(CKAN, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60000) })).json()).result;
  guardPackage(pkg);
  const res = pickCityGmlResource(pkg);
  const head = await fetch(res.url, { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60000) });
  const size = Number(head.headers.get('content-length') || 0);
  if (!size) throw new Error('content-length unavailable');
  if (head.headers.get('accept-ranges') !== 'bytes') throw new Error('Range not supported');
  const tailLen = Math.min(size, 4 * 1024 * 1024);
  const tail = await rangeFetch(res.url, size - tailLen, size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('EOCD not found');
  let cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16), zip64 = false;
  if (cdSize === 0xffffffff || cdOff === 0xffffffff) {
    zip64 = true;
    const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), eocd);
    if (loc < 0) throw new Error('ZIP64 locator not found');
    const e64off = Number(tail.readBigUInt64LE(loc + 8));
    const rec = await rangeFetch(res.url, e64off, e64off + 55);
    cdSize = Number(rec.readBigUInt64LE(40)); cdOff = Number(rec.readBigUInt64LE(48));
  }
  if (!(cdSize > 0 && cdSize < 256 * 1024 * 1024)) throw new Error('Unexpected central directory size ' + cdSize);
  const entries = parseCentralDirectory(await rangeFetch(res.url, cdOff, cdOff + cdSize - 1)).filter((e) => !e.name.endsWith('/'));
  const gml = entries.filter((e) => /\.gml$/i.test(e.name));
  const byKind = {};
  for (const e of gml) byKind[kindOf(e.name)] = (byKind[kindOf(e.name)] || 0) + 1;
  const lock = {
    mission: '79-plateau2025-source-lock',
    generatedAt: new Date().toISOString(),
    package: { id: pkg.id, name: pkg.name, metadataModified: pkg.metadata_modified, pageUrl: 'https://www.geospatial.jp/ckan/dataset/' + PACKAGE_ID },
    license: { id: pkg.license_id, title: pkg.license_title, url: pkg.license_url, agreement: pkg.license_agreement },
    attribution: '出典：国土交通省 Project PLATEAU（3D都市モデル 大阪市 2025 / CityGML v5）を加工して作成',
    resource: { id: res.id, name: res.name, url: res.url },
    http: { contentLength: size, etag: head.headers.get('etag'), lastModified: head.headers.get('last-modified'), acceptRanges: head.headers.get('accept-ranges') },
    zip: { zip64, centralDirectoryOffset: cdOff, centralDirectorySize: cdSize, fileCount: entries.length, gmlCount: gml.length, gmlByKind: byKind },
    entries: gml.filter((e) => ['bldg', 'tran'].includes(kindOf(e.name))).map((e) => ({ ...e, kind: kindOf(e.name), mesh: (path.basename(e.name).match(/^(\d{8})_/) || [])[1] || null })),
  };
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');
  console.log(JSON.stringify({ size, etag: lock.http.etag, zip64, files: entries.length, gmlByKind: byKind, locked: lock.entries.length, sample: lock.entries.slice(0, 4) }, null, 1));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
