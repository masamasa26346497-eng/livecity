#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const DISCOVERY = path.resolve('data/reports/mission36k-building-source-discovery.json');
const WARDS = path.resolve('config/wards/registry.json');
const OUT_PUBLIC = path.resolve('public/map-data/osaka-city/buildings/manifest.json');
const OUT_REPORT = path.resolve('data/reports/mission36k-building-ward-manifest.json');
const TAIL_BYTES = 262144;
const MAX_CD_BYTES = 128 * 1024 * 1024;

function reportHeaders(headers) {
  return Object.fromEntries([
    'content-length', 'content-type', 'accept-ranges', 'etag', 'last-modified', 'content-range',
  ].map((k) => [k, headers.get(k)]));
}

export async function fetchRange(url, start, end) {
  const res = await fetch(url, {
    headers: {
      range: `bytes=${start}-${end}`,
      'accept-encoding': 'identity',
      'user-agent': 'LiveCity-Mission36K/1.0',
    },
    signal: AbortSignal.timeout(120000),
  });
  if (res.status !== 206) {
    try { await res.body?.cancel(); } catch {}
    throw new Error(`Range request failed: HTTP ${res.status} bytes=${start}-${end}`);
  }
  return { bytes: Buffer.from(await res.arrayBuffer()), headers: reportHeaders(res.headers) };
}

export function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      return {
        offset: i,
        entries: buf.readUInt16LE(i + 10),
        centralDirectorySize: buf.readUInt32LE(i + 12),
        centralDirectoryOffset: buf.readUInt32LE(i + 16),
      };
    }
  }
  return null;
}

export function parseCentralDirectory(buf) {
  const out = [];
  let p = 0;
  while (p + 46 <= buf.length) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.push({
      name, flags, method, crc32, compressedSize, uncompressedSize, localHeaderOffset,
      isDirectory: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export async function readRemoteZipIndex(url) {
  const headRes = await fetch(url, {
    method: 'HEAD',
    headers: { 'user-agent': 'LiveCity-Mission36K/1.0' },
    signal: AbortSignal.timeout(120000),
  });
  if (!headRes.ok) throw new Error(`HEAD failed: HTTP ${headRes.status}`);
  const size = Number(headRes.headers.get('content-length'));
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('ZIP content-length missing/invalid');
  if ((headRes.headers.get('accept-ranges') || '').toLowerCase() !== 'bytes') {
    throw new Error('Remote ZIP does not advertise byte ranges');
  }

  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = await fetchRange(url, tailStart, size - 1);
  const eocd = findEocd(tail.bytes);
  if (!eocd) throw new Error('ZIP EOCD not found');
  if (eocd.entries === 0xffff || eocd.centralDirectorySize === 0xffffffff || eocd.centralDirectoryOffset === 0xffffffff) {
    throw new Error('ZIP64 is not supported by Mission36K range reader');
  }
  if (eocd.centralDirectorySize <= 0 || eocd.centralDirectorySize > MAX_CD_BYTES) {
    throw new Error(`Unexpected central directory size: ${eocd.centralDirectorySize}`);
  }

  const cd = await fetchRange(
    url,
    eocd.centralDirectoryOffset,
    eocd.centralDirectoryOffset + eocd.centralDirectorySize - 1,
  );
  const entries = parseCentralDirectory(cd.bytes);
  if (entries.length !== eocd.entries) {
    throw new Error(`Central directory entry count mismatch: ${entries.length} != ${eocd.entries}`);
  }
  return {
    size,
    etag: headRes.headers.get('etag'),
    lastModified: headRes.headers.get('last-modified'),
    entries,
    eocd,
  };
}

export function assertSafeZipPath(name) {
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Unsafe ZIP path: ${name}`);
  }
  const parts = name.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) throw new Error(`Unsafe ZIP path: ${name}`);
  return name;
}

export async function fetchZipEntry(url, entry) {
  assertSafeZipPath(entry.name);
  if (entry.isDirectory) return Buffer.alloc(0);
  if (![0, 8].includes(entry.method)) throw new Error(`Unsupported ZIP method ${entry.method}: ${entry.name}`);
  if (entry.flags & 0x1) throw new Error(`Encrypted ZIP entry is unsupported: ${entry.name}`);

  const header = await fetchRange(url, entry.localHeaderOffset, entry.localHeaderOffset + 29);
  if (header.bytes.length < 30 || header.bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`Invalid local header: ${entry.name}`);
  }
  const nameLen = header.bytes.readUInt16LE(26);
  const extraLen = header.bytes.readUInt16LE(28);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const packed = entry.compressedSize > 0
    ? (await fetchRange(url, dataStart, dataStart + entry.compressedSize - 1)).bytes
    : Buffer.alloc(0);
  const unpacked = entry.method === 0 ? packed : zlib.inflateRawSync(packed);
  if (unpacked.length !== entry.uncompressedSize) {
    throw new Error(`Uncompressed size mismatch for ${entry.name}: ${unpacked.length} != ${entry.uncompressedSize}`);
  }
  return unpacked;
}

export function classifyBuildingEntry(name) {
  const m = /^(.*_bldg_3dtiles_(\d{5})_([^/]+?)_lod(\d+)(_no_texture)?)\/(.*)$/.exec(name);
  if (!m) return null;
  return {
    root: m[1],
    wardCode: m[2],
    slug: m[3],
    lod: Number(m[4]),
    noTexture: Boolean(m[5]),
    relativePath: m[6],
  };
}

export function buildWardManifest({ source, zip, registry }) {
  const groups = new Map();
  for (const entry of zip.entries) {
    const c = classifyBuildingEntry(entry.name);
    if (!c) continue;
    const key = `${c.wardCode}|${c.lod}|${c.noTexture ? 1 : 0}|${c.root}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        root: c.root,
        wardCode: c.wardCode,
        slug: c.slug,
        lod: c.lod,
        noTexture: c.noTexture,
        fileCount: 0,
        b3dmCount: 0,
        compressedBytes: 0,
        uncompressedBytes: 0,
        tilesetPath: null,
      };
      groups.set(key, g);
    }
    if (!entry.isDirectory) {
      g.fileCount++;
      g.compressedBytes += entry.compressedSize;
      g.uncompressedBytes += entry.uncompressedSize;
      if (/\.b3dm$/i.test(c.relativePath)) g.b3dmCount++;
      if (/^tileset\.json$/i.test(c.relativePath)) g.tilesetPath = entry.name;
    }
  }

  const byCode = new Map();
  for (const g of groups.values()) {
    if (!g.tilesetPath) continue;
    if (!byCode.has(g.wardCode)) byCode.set(g.wardCode, []);
    byCode.get(g.wardCode).push(g);
  }

  const wards = {};
  const missingLod1 = [];
  for (const ward of registry.wards) {
    const groupsForWard = (byCode.get(ward.code) || [])
      .sort((a, b) => a.lod - b.lod || Number(a.noTexture) - Number(b.noTexture));
    const regular = groupsForWard.filter((g) => !g.noTexture);
    const preferred = regular.find((g) => g.lod === 1) || groupsForWard.find((g) => g.lod === 1) || null;
    if (!preferred) missingLod1.push(ward.code);
    const lodLevels = [...new Set(regular.map((g) => g.lod))].sort((a, b) => a - b);
    wards[ward.id] = {
      id: ward.id,
      name: ward.name,
      code: ward.code,
      datasetId: ward.datasetId,
      slug: preferred?.slug || groupsForWard[0]?.slug || null,
      lodLevels,
      hasLod1: lodLevels.includes(1),
      hasLod2: lodLevels.includes(2),
      hasLod3: lodLevels.includes(3),
      preferredLod1: preferred ? {
        root: preferred.root,
        tilesetPath: preferred.tilesetPath,
        fileCount: preferred.fileCount,
        b3dmCount: preferred.b3dmCount,
        compressedBytes: preferred.compressedBytes,
        uncompressedBytes: preferred.uncompressedBytes,
      } : null,
      variants: groupsForWard.map((g) => ({
        lod: g.lod,
        noTexture: g.noTexture,
        root: g.root,
        tilesetPath: g.tilesetPath,
        fileCount: g.fileCount,
        b3dmCount: g.b3dmCount,
        compressedBytes: g.compressedBytes,
        uncompressedBytes: g.uncompressedBytes,
      })),
    };
  }
  if (missingLod1.length) throw new Error(`LOD1 missing for wards: ${missingLod1.join(',')}`);

  return {
    version: 1,
    mission: '36K',
    generatedAt: new Date().toISOString(),
    strategy: 'remote-zip-range',
    city: registry.city,
    cityCode: registry.cityCode,
    wardCount: registry.wards.length,
    source: {
      packageId: source.packageId,
      name: source.name,
      format: source.format,
      url: source.url,
      sizeBytes: zip.size,
      etag: zip.etag,
      lastModified: zip.lastModified,
      rangeSupported: true,
      zipEntries: zip.entries.length,
    },
    coverage: {
      lod1Wards: Object.values(wards).filter((w) => w.hasLod1).length,
      lod2Wards: Object.values(wards).filter((w) => w.hasLod2).length,
      lod3Wards: Object.values(wards).filter((w) => w.hasLod3).length,
    },
    wards,
  };
}

export async function smokeFetchWardTileset(url, zip, wardManifest) {
  const target = wardManifest.preferredLod1?.tilesetPath;
  if (!target) throw new Error(`No preferred LOD1 tileset for ${wardManifest.id}`);
  const entry = zip.entries.find((e) => e.name === target);
  if (!entry) throw new Error(`Tileset entry missing from central directory: ${target}`);
  const bytes = await fetchZipEntry(url, entry);
  const json = JSON.parse(bytes.toString('utf8'));
  return {
    wardId: wardManifest.id,
    wardCode: wardManifest.code,
    tilesetPath: target,
    compressedBytes: entry.compressedSize,
    uncompressedBytes: entry.uncompressedSize,
    assetVersion: json.asset?.version || null,
    geometricError: Number.isFinite(json.geometricError) ? json.geometricError : null,
    rootHasContent: Boolean(json.root?.content || json.root?.contents),
    rootChildren: Array.isArray(json.root?.children) ? json.root.children.length : 0,
  };
}

async function main() {
  const discovery = JSON.parse(fs.readFileSync(DISCOVERY, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(WARDS, 'utf8'));
  const source = discovery.lighterRuntimeCandidates?.[0];
  if (!source?.url) throw new Error('No runtime ZIP source in Mission36K discovery report');
  if (!Array.isArray(registry.wards) || registry.wards.length !== 24) throw new Error('Ward registry must contain 24 wards');

  console.log('[36K] Reading remote ZIP central directory by HTTP Range…');
  const zip = await readRemoteZipIndex(source.url);
  const manifest = buildWardManifest({
    source: { ...source, packageId: discovery.packageId },
    zip,
    registry,
  });

  const smokeArg = process.argv.find((a) => a.startsWith('--smoke-ward='));
  let smoke = null;
  if (smokeArg) {
    const wardId = smokeArg.slice('--smoke-ward='.length);
    const ward = manifest.wards[wardId];
    if (!ward) throw new Error(`Unknown smoke ward: ${wardId}`);
    console.log(`[36K] Range-fetching ${ward.name} LOD1 tileset.json…`);
    smoke = await smokeFetchWardTileset(source.url, zip, ward);
  }

  fs.mkdirSync(path.dirname(OUT_PUBLIC), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_REPORT), { recursive: true });
  fs.writeFileSync(OUT_PUBLIC, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(OUT_REPORT, JSON.stringify({
    mission: '36K',
    generatedAt: manifest.generatedAt,
    source: manifest.source,
    coverage: manifest.coverage,
    wardCount: manifest.wardCount,
    smoke,
    decision: 'All 24 wards have PLATEAU LOD1 and can be acquired selectively from the remote ZIP with HTTP Range requests.',
  }, null, 2) + '\n');

  console.log(JSON.stringify({
    wardCount: manifest.wardCount,
    coverage: manifest.coverage,
    zipEntries: manifest.source.zipEntries,
    smoke,
    output: path.relative(process.cwd(), OUT_PUBLIC),
  }, null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
