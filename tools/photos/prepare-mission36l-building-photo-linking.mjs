#!/usr/bin/env node
// Mission 36L one-shot local preparation for exact canonical building -> Google Place linkage.
// This intentionally refuses to fall back to compact public building tiles because they do not
// carry the exact OSM source identity required by the Mission 36L safety policy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BUILDING_INDEX,
  DEFAULT_PLACES_MAPPING,
  DEFAULT_OUT,
  run as buildBuildingGooglePlaceIndex,
} from './build-building-google-place-index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/');

function fail(message, code = 1) {
  console.error(`[36L prepare] ${message}`);
  process.exitCode = code;
  return null;
}

function assertSafeOutput(doc) {
  const errors = [];
  if (doc?.policy?.exactOsmSourceIdentityOnly !== true) errors.push('exactOsmSourceIdentityOnly must be true');
  if (doc?.policy?.verifiedGooglePlaceOnly !== true) errors.push('verifiedGooglePlaceOnly must be true');
  if (doc?.policy?.persistsPhotoMedia !== false) errors.push('persistsPhotoMedia must be false');
  if (doc?.policy?.resolvesPhotosAtDisplayTime !== true) errors.push('resolvesPhotosAtDisplayTime must be true');

  const records = Array.isArray(doc?.records) ? doc.records : [];
  const seenBuildings = new Set();
  for (const record of records) {
    if (!record?.buildingId) errors.push('record missing buildingId');
    if (!record?.facilityId) errors.push(`record ${record?.buildingId || '?'} missing facilityId`);
    if (!record?.googlePlaceId) errors.push(`record ${record?.buildingId || '?'} missing googlePlaceId`);
    if (!record?.sourceId) errors.push(`record ${record?.buildingId || '?'} missing sourceId`);
    if (record?.placeMatchConfidence !== 'VERIFIED') errors.push(`record ${record?.buildingId || '?'} is not VERIFIED`);
    if (record?.linkMethod !== 'exact-osm-source-id-chain') errors.push(`record ${record?.buildingId || '?'} has unsafe linkMethod`);
    if (record?.buildingId && seenBuildings.has(record.buildingId)) errors.push(`duplicate buildingId ${record.buildingId}`);
    if (record?.buildingId) seenBuildings.add(record.buildingId);
  }

  const serialized = JSON.stringify(doc).toLowerCase();
  for (const forbidden of ['photourl', 'mediaurl', 'resourcename', 'places.googleapis.com/v1/', '/media']) {
    if (serialized.includes(forbidden)) errors.push(`durable output contains forbidden photo/media token: ${forbidden}`);
  }

  if (errors.length) {
    const err = new Error(`Mission 36L output validation failed:\n- ${[...new Set(errors)].join('\n- ')}`);
    err.validationErrors = errors;
    throw err;
  }
  return records.length;
}

export function prepareMission36L() {
  if (!fs.existsSync(DEFAULT_BUILDING_INDEX)) {
    throw new Error([
      `required full building index is missing: ${rel(DEFAULT_BUILDING_INDEX)}`,
      'Generate it locally first with:',
      '  node tools/build-building-facility-index.js',
      'The compact public building tiles are not a safe substitute because they do not preserve exact OSM source identity.',
    ].join('\n'));
  }
  if (!fs.existsSync(DEFAULT_PLACES_MAPPING)) {
    throw new Error(`Google Places mapping is missing: ${rel(DEFAULT_PLACES_MAPPING)}`);
  }

  const doc = buildBuildingGooglePlaceIndex();
  const linked = assertSafeOutput(doc);
  console.log('[36L prepare] exact building -> Google Place index ready');
  console.log(`[36L prepare] output: ${rel(DEFAULT_OUT)}`);
  console.log(`[36L prepare] linked buildings: ${linked}`);
  console.log(`[36L prepare] rejected ambiguous: ${doc.counts?.rejectedAmbiguous ?? 0}`);
  console.log(`[36L prepare] no exact source: ${doc.counts?.noExactSource ?? 0}`);
  console.log(`[36L prepare] exact source without VERIFIED Place: ${doc.counts?.exactSourceWithoutVerifiedPlace ?? 0}`);
  return doc;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    prepareMission36L();
  } catch (err) {
    fail(err?.stack || String(err), 2);
  }
}
