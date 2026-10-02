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
export const PROGRESS_PATH = resolveProjectPath('data/reports/mission36j-google-places-osaka-city/ingestion-progress.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeOverpassString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeOverpassRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function selectorToOverpass(selector) {
  const eq = selector.indexOf('=');
  if (eq < 0) return `["${escapeOverpassString(selector)}"]`;
  const key = selector.slice(0, eq);
  const value = selector.slice(eq + 1);
  return `["${escapeOverpassString(key)}"="${escapeOverpassString(value)}"]`;
}

// Collapse many node/way/relation selectors into a small set of nwr selectors grouped by tag key.
// A key-only selector (e.g. shop) already covers shop=supermarket etc., so same-key exact selectors
// are deliberately suppressed. This keeps the semantics while greatly reducing Overpass parser/load cost.
export function buildCompactOverpassSelectors(selectors = []) {
  const keyOrder = [];
  const wildcardKeys = new Set();
  const exactByKey = new Map();

  for (const selector of selectors) {
    const eq = selector.indexOf('=');
    const key = eq < 0 ? selector : selector.slice(0, eq);
    if (!keyOrder.includes(key)) keyOrder.push(key);
    if (eq < 0) {
      wildcardKeys.add(key);
      continue;
    }
    if (!exactByKey.has(key)) exactByKey.set(key, []);
    const value = selector.slice(eq + 1);
    if (!exactByKey.get(key).includes(value)) exactByKey.get(key).push(value);
  }

  const filters = [];
  for (const key of keyOrder) {
    const safeKey = escapeOverpassString(key);
    if (wildcardKeys.has(key)) {
      filters.push(`["${safeKey}"]`);
      continue;
    }
    const values = exactByKey.get(key) || [];
    if (values.length === 1) {
      filters.push(`["${safeKey}"="${escapeOverpassString(values[0])}"]`);
    } else if (values.length > 1) {
      const pattern = values.map(escapeOverpassRegex).join('|');
      filters.push(`["${safeKey}"~"^(${pattern})$"]`);
    }
  }
  return filters;
}

export function buildPhotoFacilityTileQuery(bbox, profile, timeoutSec = 90) {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const statements = buildCompactOverpassSelectors(profile.osmFilters || [])
    .map((filter) => `  nwr${filter}(${bboxStr});`);
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

function tileFilename(tx, tz) {
  return `tile_${tx}_${tz}.json`;
}

function readPreviousFailedTileIds() {
  if (!fs.existsSync(PROGRESS_PATH)) return new Set();
  try {
    const p = readJson(PROGRESS_PATH);
    return new Set(p.failedTileIds || []);
  } catch {
    return new Set();
  }
}

export async function downloadCityFacilityTiles({
  force = false,
  maxTiles = Infinity,
  interTileDelayMs = 3000,
  onProgress = console.log,
} = {}) {
  const area = await loadAreaConfig(AREA_ID);
  const profile = readJson(PROFILE_PATH);
  const grid = createCityTileGrid({
    bbox: area.bbox,
    projection: area.projection,
    tileSizeMeters: profile.tileSizeMeters || 2000,
    bufferMeters: profile.bufferMeters ?? 120,
  });
  await ensureDir(TILE_DIR);
  await ensureDir(path.dirname(PROGRESS_PATH));

  const allTiles = grid.allTiles().map(({ tx, tz }) => ({ tx, tz, filename: tileFilename(tx, tz) }));
  const existingBefore = new Set(fs.existsSync(TILE_DIR) ? await fsp.readdir(TILE_DIR) : []);
  const previousFailed = readPreviousFailedTileIds();
  let pending = force ? allTiles : allTiles.filter((tile) => !existingBefore.has(tile.filename));

  // Previously failed tiles are retried after fresh missing tiles so one difficult area cannot block the citywide crawl.
  if (!force && previousFailed.size) {
    pending = pending.sort((a, b) => Number(previousFailed.has(a.filename)) - Number(previousFailed.has(b.filename)));
  }

  const finiteLimit = Number.isFinite(maxTiles) ? Math.max(0, Math.floor(maxTiles)) : pending.length;
  const selected = pending.slice(0, finiteLimit);
  let downloaded = 0;
  const failed = [];

  for (let i = 0; i < selected.length; i++) {
    const { tx, tz, filename } = selected[i];
    const filePath = path.join(TILE_DIR, filename);
    const bbox = grid.latLonBboxForTile(tx, tz);
    const query = buildPhotoFacilityTileQuery(bbox, profile);
    onProgress(`[36J facilities] ${filename} download...`);
    try {
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
    } catch (error) {
      const reason = error?.message || String(error);
      failed.push({ filename, tileId: `${tx}_${tz}`, reason });
      onProgress(`[36J facilities] skip ${filename} for this batch: ${reason}`);
    }
    if (interTileDelayMs > 0 && i < selected.length - 1) await sleep(interTileDelayMs);
  }

  const existingAfter = new Set(fs.existsSync(TILE_DIR) ? await fsp.readdir(TILE_DIR) : []);
  const completedTileCount = allTiles.filter((tile) => existingAfter.has(tile.filename)).length;
  const remaining = allTiles.length - completedTileCount;
  const progress = {
    mission: '36J',
    updatedAt: new Date().toISOString(),
    totalTiles: allTiles.length,
    completedTileCount,
    remaining,
    completedBeforeThisRun: allTiles.filter((tile) => existingBefore.has(tile.filename)).length,
    attemptedThisRun: selected.length,
    downloadedThisRun: downloaded,
    failedThisRun: failed.length,
    failedTileIds: failed.map((item) => item.filename),
    failures: failed,
    maxDistancePolicyForGooglePlaces: 120,
  };
  await writeJson(PROGRESS_PATH, progress);

  return {
    tileCount: grid.tileCount,
    downloaded,
    cached: progress.completedBeforeThisRun,
    completed: completedTileCount,
    remaining,
    failed: failed.length,
    progressPath: PROGRESS_PATH,
    tileDir: TILE_DIR,
  };
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

  const expectedFiles = grid.allTiles().map(({ tx, tz }) => tileFilename(tx, tz));
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
  const args = { command: 'all', force: false, maxTiles: Infinity, partial: false, interTileDelayMs: 3000 };
  if (argv[0] && !argv[0].startsWith('--')) args.command = argv[0];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--partial') args.partial = true;
    else if (argv[i] === '--max-tiles') args.maxTiles = Number(argv[++i] || Infinity);
    else if (argv[i] === '--inter-tile-delay-ms') args.interTileDelayMs = Number(argv[++i] || 0);
  }
  return args;
}

if (isMainModule(import.meta.url)) {
  const args = parseCli(process.argv.slice(2));
  try {
    let downloadResult = null;
    if (args.command === 'download' || args.command === 'all') {
      downloadResult = await downloadCityFacilityTiles({
        force: args.force,
        maxTiles: args.maxTiles,
        interTileDelayMs: args.interTileDelayMs,
      });
      console.log('[36J facilities download]', JSON.stringify(downloadResult));
      if (args.command === 'download') process.exit(0);
      if (downloadResult.remaining > 0 && !args.partial) {
        console.log(`[36J facilities] ${downloadResult.remaining} tiles remain; build deferred until acquisition is complete.`);
        process.exit(0);
      }
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
