#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchZipEntry, readRemoteZipIndex } from './mission36k-build-ward-building-manifest.mjs';

const MANIFEST = path.resolve('public/map-data/osaka-city/building-sources/plateau-2024-manifest.json');
const OUT_REPORT = path.resolve('data/reports/mission36k-b3dm-smoke.json');

export function parseB3dmHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 28) {
    throw new Error(`B3DM is too short: ${bytes?.length ?? 0}`);
  }
  const magic = bytes.subarray(0, 4).toString('ascii');
  if (magic !== 'b3dm') throw new Error(`Invalid B3DM magic: ${JSON.stringify(magic)}`);

  const version = bytes.readUInt32LE(4);
  const byteLength = bytes.readUInt32LE(8);
  const featureTableJsonByteLength = bytes.readUInt32LE(12);
  const featureTableBinaryByteLength = bytes.readUInt32LE(16);
  const batchTableJsonByteLength = bytes.readUInt32LE(20);
  const batchTableBinaryByteLength = bytes.readUInt32LE(24);
  const glbOffset = 28
    + featureTableJsonByteLength
    + featureTableBinaryByteLength
    + batchTableJsonByteLength
    + batchTableBinaryByteLength;

  if (version !== 1) throw new Error(`Unsupported B3DM version: ${version}`);
  if (byteLength !== bytes.length) {
    throw new Error(`B3DM byteLength mismatch: header=${byteLength} actual=${bytes.length}`);
  }
  if (glbOffset + 12 > bytes.length) {
    throw new Error(`B3DM tables exceed payload: glbOffset=${glbOffset} bytes=${bytes.length}`);
  }

  const glbMagic = bytes.subarray(glbOffset, glbOffset + 4).toString('ascii');
  const glbVersion = bytes.readUInt32LE(glbOffset + 4);
  const glbByteLength = bytes.readUInt32LE(glbOffset + 8);
  if (glbMagic !== 'glTF') throw new Error(`Invalid embedded GLB magic: ${JSON.stringify(glbMagic)}`);
  if (glbByteLength <= 12 || glbOffset + glbByteLength > bytes.length) {
    throw new Error(`Invalid embedded GLB byteLength: ${glbByteLength}`);
  }

  return {
    magic,
    version,
    byteLength,
    featureTableJsonByteLength,
    featureTableBinaryByteLength,
    batchTableJsonByteLength,
    batchTableBinaryByteLength,
    glbOffset,
    glbMagic,
    glbVersion,
    glbByteLength,
  };
}

export function selectWardB3dmEntry(zipEntries, ward) {
  const root = ward?.preferredLod1?.root;
  if (!root) throw new Error('Ward has no preferred LOD1 root');
  const prefix = `${root}/`;
  const candidates = zipEntries
    .filter((entry) => !entry.isDirectory && entry.name.startsWith(prefix) && /\.b3dm$/i.test(entry.name))
    .sort((a, b) => a.compressedSize - b.compressedSize || a.name.localeCompare(b.name));
  if (!candidates.length) throw new Error(`No B3DM entries found under ${root}`);
  return candidates[0];
}

export async function smokeFetchWardB3dm({ manifest, wardId }) {
  const ward = manifest.wards?.[wardId];
  if (!ward) throw new Error(`Unknown ward: ${wardId}`);
  const url = manifest.source?.url;
  if (!url) throw new Error('Manifest source URL is missing');

  const zip = await readRemoteZipIndex(url);
  if (manifest.source?.etag && zip.etag && manifest.source.etag !== zip.etag) {
    throw new Error(`Remote ZIP ETag changed: manifest=${manifest.source.etag} live=${zip.etag}`);
  }

  const entry = selectWardB3dmEntry(zip.entries, ward);
  const bytes = await fetchZipEntry(url, entry);
  const header = parseB3dmHeader(bytes);

  return {
    mission: '36K',
    generatedAt: new Date().toISOString(),
    wardId: ward.id,
    wardName: ward.name,
    wardCode: ward.code,
    lod: 1,
    zipEntry: entry.name,
    compressedBytes: entry.compressedSize,
    uncompressedBytes: entry.uncompressedSize,
    compressionMethod: entry.method,
    header,
    verified: true,
    decision: 'A real PLATEAU LOD1 B3DM geometry tile was selectively fetched from the remote ZIP by HTTP Range, decompressed, and validated without downloading the full archive.',
  };
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--ward='));
  const wardId = arg ? arg.slice('--ward='.length) : 'sumiyoshi';
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  console.log(`[36K] Range-fetching one real ${wardId} LOD1 B3DM geometry tile…`);
  const report = await smokeFetchWardB3dm({ manifest, wardId });
  fs.mkdirSync(path.dirname(OUT_REPORT), { recursive: true });
  fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
