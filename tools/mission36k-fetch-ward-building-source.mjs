#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertSafeZipPath,
  fetchZipEntry,
  readRemoteZipIndex,
} from './mission36k-build-ward-building-manifest.mjs';
import { parseB3dmHeader } from './mission36k-smoke-b3dm.mjs';

const MANIFEST_PATH = path.resolve('public/map-data/osaka-city/building-sources/plateau-2024-manifest.json');
const DEFAULT_OUT = path.resolve('.cache/mission36k-buildings');

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

export function resolveWard(manifest, token) {
  if (!token) throw new Error('--ward is required');
  if (manifest.wards?.[token]) return manifest.wards[token];
  const found = Object.values(manifest.wards || {}).find((w) => w.code === token);
  if (!found) throw new Error(`Unknown ward: ${token}`);
  return found;
}

export function resolveVariant(ward, lod = 1, noTexture = false) {
  const variant = (ward.variants || []).find((v) => v.lod === lod && Boolean(v.noTexture) === Boolean(noTexture));
  if (!variant?.root || !variant?.tilesetPath) {
    throw new Error(`Building variant unavailable: ward=${ward.id} lod=${lod} noTexture=${noTexture}`);
  }
  return variant;
}

export function selectWardEntries(zipEntries, variant, { maxFiles = Infinity, tilesetOnly = false } = {}) {
  const prefix = `${variant.root}/`;
  const files = zipEntries
    .filter((e) => !e.isDirectory && e.name.startsWith(prefix))
    .sort((a, b) => {
      const aTileset = a.name === variant.tilesetPath ? 0 : 1;
      const bTileset = b.name === variant.tilesetPath ? 0 : 1;
      return aTileset - bTileset || a.name.localeCompare(b.name);
    });
  if (!files.some((e) => e.name === variant.tilesetPath)) {
    throw new Error(`tileset.json missing from remote ZIP: ${variant.tilesetPath}`);
  }
  if (tilesetOnly) return files.filter((e) => e.name === variant.tilesetPath);
  if (!Number.isFinite(maxFiles)) return files;
  const n = Math.max(1, Math.floor(maxFiles));
  return files.slice(0, n);
}

export function safeDestination(outDir, root, entryName) {
  assertSafeZipPath(entryName);
  const prefix = `${root}/`;
  if (!entryName.startsWith(prefix)) throw new Error(`Entry is outside selected ward root: ${entryName}`);
  const relative = entryName.slice(prefix.length);
  assertSafeZipPath(relative);
  const base = path.resolve(outDir);
  const dest = path.resolve(base, relative);
  if (dest !== base && !dest.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Unsafe extraction destination: ${entryName}`);
  }
  return dest;
}

export async function extractWardVariant({
  manifest,
  wardToken,
  lod = 1,
  noTexture = false,
  outDir = DEFAULT_OUT,
  maxFiles = Infinity,
  tilesetOnly = false,
}) {
  const ward = resolveWard(manifest, wardToken);
  const variant = resolveVariant(ward, lod, noTexture);
  const url = manifest.source?.url;
  if (!url) throw new Error('Manifest source URL is missing');

  const zip = await readRemoteZipIndex(url);
  if (manifest.source?.etag && zip.etag && manifest.source.etag !== zip.etag) {
    throw new Error(`Remote ZIP ETag changed: manifest=${manifest.source.etag} live=${zip.etag}`);
  }

  const selected = selectWardEntries(zip.entries, variant, { maxFiles, tilesetOnly });
  const destinationRoot = path.resolve(outDir, `${ward.id}-lod${lod}${noTexture ? '-no-texture' : ''}`);
  const extracted = [];

  for (const entry of selected) {
    const bytes = await fetchZipEntry(url, entry);
    const dest = safeDestination(destinationRoot, variant.root, entry.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    let b3dm = null;
    if (/\.b3dm$/i.test(entry.name)) b3dm = parseB3dmHeader(bytes);
    extracted.push({
      entry: entry.name,
      relativePath: path.relative(destinationRoot, dest).split(path.sep).join('/'),
      compressedBytes: entry.compressedSize,
      uncompressedBytes: entry.uncompressedSize,
      b3dm: b3dm ? {
        version: b3dm.version,
        byteLength: b3dm.byteLength,
        glbVersion: b3dm.glbVersion,
        glbByteLength: b3dm.glbByteLength,
      } : null,
    });
  }

  const report = {
    mission: '36K',
    generatedAt: new Date().toISOString(),
    sourceEtag: zip.etag,
    wardId: ward.id,
    wardName: ward.name,
    wardCode: ward.code,
    lod,
    noTexture,
    variantRoot: variant.root,
    destinationRoot,
    mode: tilesetOnly ? 'tileset-only' : Number.isFinite(maxFiles) ? 'limited' : 'full',
    selectedFiles: selected.length,
    variantFiles: variant.fileCount,
    variantB3dmCount: variant.b3dmCount,
    selectedCompressedBytes: selected.reduce((n, e) => n + e.compressedSize, 0),
    selectedUncompressedBytes: selected.reduce((n, e) => n + e.uncompressedSize, 0),
    fullVariantCompressedBytes: variant.compressedBytes,
    fullVariantUncompressedBytes: variant.uncompressedBytes,
    extracted,
  };

  const reportPath = path.resolve(`data/reports/mission36k-ward-extract-${ward.id}-lod${lod}${noTexture ? '-no-texture' : ''}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return { report, reportPath };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const wardToken = argValue('ward');
  const lod = Number(argValue('lod', '1'));
  if (!Number.isInteger(lod) || lod < 1 || lod > 3) throw new Error(`Invalid --lod: ${lod}`);
  const noTexture = process.argv.includes('--no-texture');
  const tilesetOnly = process.argv.includes('--tileset-only');
  const maxFilesRaw = argValue('max-files');
  const maxFiles = maxFilesRaw == null ? Infinity : Number(maxFilesRaw);
  if (maxFilesRaw != null && (!Number.isInteger(maxFiles) || maxFiles < 1)) {
    throw new Error(`Invalid --max-files: ${maxFilesRaw}`);
  }
  const outDir = path.resolve(argValue('out', DEFAULT_OUT));

  console.log(`[36K] Extracting ward=${wardToken} lod=${lod} mode=${tilesetOnly ? 'tileset-only' : Number.isFinite(maxFiles) ? `max-${maxFiles}` : 'full'}…`);
  const { report, reportPath } = await extractWardVariant({
    manifest,
    wardToken,
    lod,
    noTexture,
    outDir,
    maxFiles,
    tilesetOnly,
  });
  console.log(JSON.stringify({ ...report, reportPath: path.relative(process.cwd(), reportPath) }, null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
