// Mission 36J: Osaka 24-ward photo-worthy facility ingestion.
// Downloads OSM facilities in 2km tiles, caches each tile for resume, de-duplicates by OSM source id,
// converts into Live City runtime coordinates, and classifies every point to the official 24-ward polygons.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadAreaConfig, ensureDir, writeJson } from '../lib/area.js';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { createCityTileGrid } from '../lib/city-tile-grid.js';
import { runOverpassQuery } from '../lib/overpass.js';
import { convertFacilitiesExtended } from '../convert/facilities-extended.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';

export const AREA_ID = 'osaka-city';
export const PROFILE_PATH = resolveProjectPath('config/facilities/osaka-city-photo-profile.json');
export const BASE_CATEGORY_PATH = resolveProjectPath('config/facilities/categories.json');
export const WARD_POLYGON_PATH = resolveProjectPath('public/map-data/osaka-city/boundaries/ward-classification-polygons.json');
export const TILE_DIR = resolveProjectPath('data/raw/osaka-city/facilities-tiles');
export const RAW_MERGED_PATH = resolveProjectPath('data/raw/osaka-city/facilities-osm.json');
export const PROCESSED_PATH = resolveProjectPath('data/processed/osaka-city/facilities/facilities.json');
export const PUBLIC_PATH = resolveProjectPath('public/map-data/osaka-city/facilities/facilities.json');
export const METADATA_PATH = resolveProjectPath('public/map-data/osaka-city/facilities/metadata.json');
export const REPORT_PATH = resolveProjectPath('data/reports/mission36j-google-places-osaka-city/facility-ingestion.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
}

export function selectorToOverpass(selector) {
  const eq = selector.indexOf('=');
  if (eq < 0) return `["${selector}"]`;
  const key = selector.slice(0, eq);
  const value = selector.slice(eq + 1);
  return `["${key}"="${value}"]`;
}

export function buildPhotoFacilityTileQuery(bbox, profile, timeoutSec = 90) {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const statements = [];
  for (const selector of profile.osmFilters || []) {
    const filter = selectorToOverpass(selector);
    for (const type of ['node', 'way', 'relation']) {
      statements.push(`  ${type}${filter}(${bboxStr});`);
    }
  }
  return `[out:json][timeout:${timeoutSec}];\n(\n${statements.join('\n')}\n);\nout center;`;
}

export function mergeOsmElements(tilePayloads) {
  const byId = new Map();
  for (const payload of tilePayloads) {
    for (const el of payload?.elements || []) {
      const key = `${el.type}/${el.id}`;
      if (!byId.has(key)) byId.set(key, el);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const ak = `${a.type}/${a.id}`;
    const bk = `${b.type}/${b.id}`;
    return ak.localeCompare(bk);
  });
}

export function buildFacilityConfig(baseConfig, profile) {
  return {
    ...baseConfig,
    rules: [...(baseConfig.rules || []), ...(profile.extraRules || [])],
  };
}

export function classifyFacilityRecordsToWards(records, wardData) {
  const wardById = new Map((wardData.wards || []).map((w) => [w.wardId, w]));
  const inside = [];
  const outside = [];
  const ambiguous = [];
  for (const record of records) {
    const result = classifyPointToWard(record.localX, record.localZ, wardData.wards || []);
    if (!result.wardId) {
      const item = { id: record.id, name: record.name, status: result.status, localX: record.localX, localZ: record.localZ };
      if (result.status === 'outside') outside.push(item); else ambiguous.push(item);
      continue;
    }
    const ward = wardById.get(result.wardId);
    inside.push({
      ...record,
      wardId: result.wardId,
      wardName: ward?.wardName || null,
      wardCode: ward?.wardCode || null,
      wardClassification: result.status,
    });
  }
  inside.sort((a, b) => a.wardId.localeCompare(b.wardId) || a.id.localeCompare(b.id));
  return { inside, outside, ambiguous };
}

function countsBy(records, key) {
  const out = {};
  for (const r of records) {
    const value = String(r[key] ?? 'unknown');
    out[value] = (out[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export async function downloadCityFacilityTiles({ force = false, maxTiles = Infinity, onProgress = console.log } = {}) {
  const area = await loadAreaConfig(AREA_ID);
  const profile = readJson(PROFILE_PATH);
  const grid = createCityTileGrid({
    bbox: area.bbox,
    projection: area.projection,
    tileSizeMeters: profile.tileSizeMeters || 2000,
    bufferMeters: profile.bufferMeters ?? 120,
  });
  await ensureDir(TILE_DIR);

  let downloaded = 0;
  let cached = 0;
  let considered = 0;
  for (const { tx, tz } of grid.allTiles()) {
    const filename = `tile_${tx}_${tz}.json`;
    const filePath = path.join(TILE_DIR, filename);
    if (!force && fs.existsSync(filePath)) {
      cached++;
      continue;
    }
    if (considered >= maxTiles) break;
    considered++;
    const bbox = grid.latLonBboxForTile(tx, tz);
    const query = buildPhotoFacilityTileQuery(bbox, profile);
    onProgress(`[36J facilities] ${filename} download...`);
    const data = await runOverpassQuery(query, {
      onRetry: (attempt, reason) => onProgress(`[36J facilities] retry ${filename} #${attempt}: ${reason}`),
    });
    await writeJson(filePath, {
      mission: '36J',
      tileId: `${tx}_${tz}`,
      bbox: { south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east },
      downloadedAt: new Date().toISOString(),
      elements: data.elements || [],
    });
    downloaded++;
  }
  return { tileCount: grid.tileCount, downloaded, cached, tileDir: TILE_DIR };
}

export async function buildCityFacilityDataset({ requireComplete = true, now = () => new Date() } = {}) {
  const area = await loadAreaConfig(AREA_ID);
  const profile = readJson(PROFILE_PATH);
  const baseConfig = readJson(BASE_CATEGORY_PATH);
  const facilityConfig = buildFacilityConfig(baseConfig, profile);
  const wards = readJson(WARD_POLYGON_PATH);
  const grid = createCityTileGrid({
    bbox: area.bbox,
    projection: area.projection,
    tileSizeMeters: profile.tileSizeMeters || 2000,
    bufferMeters: profile.bufferMeters ?? 120,
  });

  const expectedFiles = grid.allTiles().map(({ tx, tz }) => `tile_${tx}_${tz}.json`);
  const existing = fs.existsSync(TILE_DIR) ? new Set(await fsp.readdir(TILE_DIR)) : new Set();
  const missingTiles = expectedFiles.filter((f) => !existing.has(f));
  if (requireComplete && missingTiles.length) {
    throw new Error(`36J施設タイルが未完了: ${missingTiles.length}/${expectedFiles.length} missing。先に download を再実行してください。`);
  }

  const tilePayloads = [];
  for (const filename of expectedFiles) {
    if (!existing.has(filename)) continue;
    tilePayloads.push(readJson(path.join(TILE_DIR, filename)));
  }
  const mergedElements = mergeOsmElements(tilePayloads);
  const generatedAt = now().toISOString();
  const sourceMeta = {
    provider: 'OpenStreetMap (Overpass API)',
    license: 'ODbL 1.0',
    attribution: '© OpenStreetMap contributors',
    downloadedAt: generatedAt,
  };
  const converted = convertFacilitiesExtended(mergedElements, area.projection, area.bbox, facilityConfig, sourceMeta);
  const classified = classifyFacilityRecordsToWards(converted.records, wards);
  const records = classified.inside;

  const dataset = {
    areaId: AREA_ID,
    mission: '36J',
    generatedAt,
    coordinateConvention: 'znorth-neg-v1',
    recordCount: records.length,
    wardCount: new Set(records.map((r) => r.wardId)).size,
    wardCounts: countsBy(records, 'wardId'),
    categoryCounts: countsBy(records, 'category'),
    records,
  };
  const rawMerged = {
    areaId: AREA_ID,
    generatedAt,
    sourceTileCount: tilePayloads.length,
    expectedTileCount: expectedFiles.length,
    elementCount: mergedElements.length,
    elements: mergedElements,
  };
  const report = {
    mission: '36J',
    generatedAt,
    expectedTileCount: expectedFiles.length,
    loadedTileCount: tilePayloads.length,
    missingTileCount: missingTiles.length,
    rawElementCountAfterTileDedup: mergedElements.length,
    convertedRecordCount: converted.records.length,
    insideOsakaCityCount: records.length,
    outsideCount: classified.outside.length,
    ambiguousWardCount: classified.ambiguous.length,
    skippedCount: converted.skipped.length,
    wardCounts: dataset.wardCounts,
    categoryCounts: dataset.categoryCounts,
    missingTiles,
    outside: classified.outside.slice(0, 200),
    ambiguousWard: classified.ambiguous.slice(0, 200),
    skippedSample: converted.skipped.slice(0, 200),
  };
  const metadata = {
    mission: '36J',
    areaId: AREA_ID,
    generatedAt,
    recordCount: records.length,
    wardCount: dataset.wardCount,
    source: 'OpenStreetMap / Overpass tiled acquisition',
    license: 'ODbL 1.0',
    tileSizeMeters: grid.tileSize,
    maxDistancePolicyForGooglePlaces: 120,
  };

  await writeJson(RAW_MERGED_PATH, rawMerged);
  await writeJson(PROCESSED_PATH, dataset);
  await writeJson(PUBLIC_PATH, dataset);
  await writeJson(METADATA_PATH, metadata);
  await writeJson(REPORT_PATH, report);
  return { dataset, report };
}

function parseCli(argv) {
  const args = { command: 'all', force: false, maxTiles: Infinity, partial: false };
  if (argv[0] && !argv[0].startsWith('--')) args.command = argv[0];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--partial') args.partial = true;
    else if (argv[i] === '--max-tiles') args.maxTiles = Number(argv[++i] || Infinity);
  }
  return args;
}

if (isMainModule(import.meta.url)) {
  const args = parseCli(process.argv.slice(2));
  try {
    if (args.command === 'download' || args.command === 'all') {
      const d = await downloadCityFacilityTiles({ force: args.force, maxTiles: args.maxTiles });
      console.log('[36J facilities download]', JSON.stringify(d));
      if (args.command === 'download') process.exit(0);
    }
    if (args.command === 'build' || args.command === 'all') {
      const b = await buildCityFacilityDataset({ requireComplete: !args.partial });
      console.log('[36J facilities build]', JSON.stringify({
        records: b.dataset.recordCount,
        wards: b.dataset.wardCount,
        missingTiles: b.report.missingTileCount,
      }));
      process.exit(0);
    }
    throw new Error('command must be download | build | all');
  } catch (error) {
    console.error('[36J facilities]', error.message || error);
    process.exit(1);
  }
}
