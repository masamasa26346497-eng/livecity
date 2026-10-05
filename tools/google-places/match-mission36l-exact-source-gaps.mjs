#!/usr/bin/env node
// Mission 36L: retry only exact-source gaps that can directly increase building photo coverage.
// Safety: 120m hard ceiling; persist VERIFIED facilityId<->googlePlaceId only; never persist photo media.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { createPlacesClient } from './lib/places-client.mjs';
import { createPacedCityGuard } from './lib/city-batch-guard.mjs';
import { classifyPilotMatch, DEFAULT_MAX_DISTANCE_METERS } from './lib/pilot-matching.mjs';
import { classifyConservativeJapaneseVariant } from './retry-sumiyoshi-unresolved.mjs';
import { assertDurableRecordSafe } from './lib/persistence-guard.mjs';
import { loadGooglePlacesApiKeyFromEnv } from './load-api-key.mjs';

const GAP_PATH = resolveProjectPath('data/reports/mission36l-building-photo-linking/exact-source-gaps.json');
const FACILITIES_PATH = resolveProjectPath('public/map-data/osaka-city/facilities/facilities.json');
const MAPPING_PATH = resolveProjectPath('public/map-data/osaka-city/derived/google-places-osaka-city-mapping.json');
const UI_MAPPING_PATH = resolveProjectPath('public/map-data/osaka-city/derived/google-places-pilot-mapping.json');
const REPORT_DIR = resolveProjectPath('data/reports/mission36l-exact-source-gap-places');
const PROGRESS_PATH = path.join(REPORT_DIR, 'progress.json');
const LAST_BATCH_PATH = path.join(REPORT_DIR, 'last-batch.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const readJsonIfExists = (p) => fs.existsSync(p) ? readJson(p) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildActionableGaps(gapsDoc, facilitiesDoc, mappingDoc, progressDoc = null) {
  const facilities = new Map((facilitiesDoc?.records || []).map((r) => [String(r.id || ''), r]));
  const verifiedIds = new Set((mappingDoc?.entries || []).filter((e) => e?.matchConfidence === 'VERIFIED').map((e) => e.facilityId));
  const attemptedIds = new Set((progressDoc?.attempts || []).map((a) => a.facilityId));
  const out = [];
  let missingFacilityRecord = 0;
  for (const g of (gapsDoc?.candidates || [])) {
    if (!g?.facilityId || verifiedIds.has(g.facilityId) || attemptedIds.has(g.facilityId)) continue;
    const facility = facilities.get(g.facilityId);
    if (!facility || !Number.isFinite(Number(facility.latitude)) || !Number.isFinite(Number(facility.longitude))) {
      missingFacilityRecord++;
      continue;
    }
    out.push({ gap: g, facility });
  }
  out.sort((a, b) => {
    const ta = a.gap.sourceId?.startsWith('way/') ? 0 : a.gap.sourceId?.startsWith('relation/') ? 1 : 2;
    const tb = b.gap.sourceId?.startsWith('way/') ? 0 : b.gap.sourceId?.startsWith('relation/') ? 1 : 2;
    return ta - tb || String(a.gap.facilityId).localeCompare(String(b.gap.facilityId));
  });
  return { actionable: out, missingFacilityRecord };
}

function chooseQueryName(gap, facility) {
  const buildingName = (gap?.buildingNames || []).find((n) => String(n || '').trim());
  return String(buildingName || facility?.name || '').trim();
}

export async function runExactGapBatch({
  apiKey = loadGooglePlacesApiKeyFromEnv(),
  fetchImpl,
  limit = 100,
  requestsPerMinute = 50,
  now = () => new Date(),
} = {}) {
  for (const p of [GAP_PATH, FACILITIES_PATH, MAPPING_PATH]) {
    if (!fs.existsSync(p)) throw new Error(`required input missing: ${p}`);
  }
  const gaps = readJson(GAP_PATH);
  const facilities = readJson(FACILITIES_PATH);
  const mapping = readJson(MAPPING_PATH);
  const progress = readJsonIfExists(PROGRESS_PATH) || { version: 1, mission: '36L-exact-source-gap-places', attempts: [] };
  const { actionable, missingFacilityRecord } = buildActionableGaps(gaps, facilities, mapping, progress);
  const selected = actionable.slice(0, Math.max(1, Number(limit) || 100));
  const client = createPlacesClient({ apiKey, fetchImpl, requestGuard: createPacedCityGuard({ requestsPerMinute }) });
  if (!client.isEnabled()) throw new Error('GOOGLE_PLACES_API_KEY is not configured');

  const entries = [...(mapping.entries || [])].map(assertDurableRecordSafe);
  const results = [];
  for (let i = 0; i < selected.length; i++) {
    const { gap, facility } = selected[i];
    const queryName = chooseQueryName(gap, facility);
    if (!queryName) continue;
    const search = await client.searchText({ textQuery: queryName, lat: Number(facility.latitude), lon: Number(facility.longitude) });
    let match = search.ok
      ? classifyPilotMatch({
          facilityId: gap.facilityId,
          name: queryName,
          wardId: facility.wardId,
          relevanceClass: facility.category || 'other',
          osmCategory: facility.category || null,
          osmSubcategory: facility.subcategory || null,
          expectLat: Number(facility.latitude),
          expectLon: Number(facility.longitude),
        }, search.places, { maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS })
      : { matchConfidence: 'UNRESOLVED', googlePlaceId: null, distanceMeters: null, reason: `Places API: ${search.reason}` };

    if (search.ok && match.matchConfidence !== 'VERIFIED') {
      const candidate = {
        facilityId: gap.facilityId,
        name: queryName,
        expectLat: Number(facility.latitude),
        expectLon: Number(facility.longitude),
      };
      const variant = classifyConservativeJapaneseVariant(candidate, search.places, DEFAULT_MAX_DISTANCE_METERS);
      if (variant.ok) match = { matchConfidence: 'VERIFIED', googlePlaceId: variant.googlePlaceId, distanceMeters: variant.distanceMeters, reason: variant.reason };
    }

    const attemptedAt = now().toISOString();
    if (match.matchConfidence === 'VERIFIED') {
      const entry = assertDurableRecordSafe({
        facilityId: gap.facilityId,
        googlePlaceId: match.googlePlaceId,
        name: queryName,
        relevanceClass: facility.category || 'other',
        matchConfidence: 'VERIFIED',
        matchReason: match.reason,
        distanceMeters: match.distanceMeters,
        verifiedAt: attemptedAt,
        verifiedBy: 'automated-exact-source-gap-batch',
      });
      const idx = entries.findIndex((e) => e.facilityId === gap.facilityId);
      if (idx >= 0) entries[idx] = entry; else entries.push(entry);
    }
    progress.attempts = (progress.attempts || []).filter((a) => a.facilityId !== gap.facilityId);
    progress.attempts.push({
      facilityId: gap.facilityId,
      sourceId: gap.sourceId,
      buildingIds: gap.buildingIds || [],
      queryName,
      matchConfidence: match.matchConfidence,
      reason: match.reason,
      attemptedAt,
    });
    results.push({ facilityId: gap.facilityId, sourceId: gap.sourceId, queryName, matchConfidence: match.matchConfidence, distanceMeters: match.distanceMeters ?? null });
    if (i + 1 < selected.length) await sleep(Math.ceil(60000 / Math.max(1, requestsPerMinute)));
  }

  const generatedAt = now().toISOString();
  const updatedMapping = {
    ...mapping,
    generatedAt,
    maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS,
    policy: {
      ...(mapping.policy || {}),
      persistsOnlyVerifiedLinkage: true,
      ambiguousMatchesAreNotPersisted: true,
      exactSourceGapExpansion: true,
      neverPersists: ['photo binaries', 'photo media URLs', 'photo resource names'],
    },
    counts: { ...(mapping.counts || {}), verified: entries.length },
    entries,
  };
  await fsp.writeFile(MAPPING_PATH, JSON.stringify(updatedMapping, null, 2));
  await fsp.writeFile(UI_MAPPING_PATH, JSON.stringify(updatedMapping, null, 2));
  await fsp.mkdir(REPORT_DIR, { recursive: true });
  await fsp.writeFile(PROGRESS_PATH, JSON.stringify({ ...progress, generatedAt }, null, 2));

  const verifiedThisBatch = results.filter((r) => r.matchConfidence === 'VERIFIED').length;
  const remaining = buildActionableGaps(gaps, facilities, updatedMapping, progress).actionable.length;
  const report = {
    mission: '36L-exact-source-gap-places', generatedAt,
    policy: { maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS, verifiedOnlyPersistence: true, exactSourceOnly: true },
    selected: selected.length, processed: results.length, verifiedThisBatch, remainingActionable: remaining,
    missingFacilityRecord, apiUsage: client.getDebugCounters(), results,
  };
  await fsp.writeFile(LAST_BATCH_PATH, JSON.stringify(report, null, 2));
  return report;
}

function parseCli(argv) {
  const out = { limit: 100, requestsPerMinute: 50 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') out.limit = Math.min(100, Math.max(1, Number(argv[++i]) || 100));
    else if (argv[i] === '--requests-per-minute') out.requestsPerMinute = Math.max(1, Number(argv[++i]) || 50);
  }
  return out;
}

if (isMainModule(import.meta.url)) {
  runExactGapBatch(parseCli(process.argv.slice(2)))
    .then((r) => console.log('[36L exact-gap places]', JSON.stringify({ processed: r.processed, verifiedThisBatch: r.verifiedThisBatch, remainingActionable: r.remainingActionable, missingFacilityRecord: r.missingFacilityRecord })))
    .catch((e) => { console.error(e?.stack || e); process.exitCode = 1; });
}
