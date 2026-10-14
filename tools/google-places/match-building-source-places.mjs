#!/usr/bin/env node
// Mission 36L: building-photo-focused Google Places matching.
//
// Unlike the generic 24-ward matcher, this batch only spends API requests on OSM way/relation
// facilities. Those durable OSM identities can directly coincide with canonical building source
// identities (way/<id> or relation/<id>), so they are materially more useful for exact building
// -> facility -> VERIFIED Google Place -> photo linkage than arbitrary node POIs.
//
// Safety policy is intentionally identical to Mission 36J:
// - 120m hard distance ceiling.
// - only VERIFIED facilityId <-> googlePlaceId linkage is persisted.
// - ambiguous/unresolved attempts never persist candidate Place IDs.
// - photo URLs/resource names/binaries are never persisted.
// - results are merged into the existing citywide mapping; node mappings are never discarded.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { createPlacesClient } from './lib/places-client.mjs';
import { RateLimitExceededError } from './lib/rate-guard.mjs';
import { createPacedCityGuard } from './lib/city-batch-guard.mjs';
import { classifyPilotMatch, DEFAULT_MAX_DISTANCE_METERS } from './lib/pilot-matching.mjs';
import { assertDurableRecordSafe } from './lib/persistence-guard.mjs';
import { loadGooglePlacesApiKeyFromEnv } from './load-api-key.mjs';
import { classifyConservativeJapaneseVariant } from './retry-sumiyoshi-unresolved.mjs';
import {
  buildCityCandidates,
  priorityRank,
  resolveWardFilter,
} from './match-osaka-city-places.mjs';

export const CITY_SOURCE = resolveProjectPath('public/map-data/osaka-city/facilities/facilities.json');
export const CITY_MAPPING = resolveProjectPath('public/map-data/osaka-city/derived/google-places-osaka-city-mapping.json');
export const UI_MAPPING = resolveProjectPath('public/map-data/osaka-city/derived/google-places-pilot-mapping.json');
export const PROFILE_PATH = resolveProjectPath('config/facilities/osaka-city-photo-profile.json');
export const WARD_REGISTRY_PATH = resolveProjectPath('config/wards/registry.json');
export const PROGRESS_PATH = resolveProjectPath('data/reports/mission36j-google-places-osaka-city/progress.json');
export const REPORT_DIR = resolveProjectPath('data/reports/mission36l-building-source-places');
export const LAST_BATCH_PATH = path.join(REPORT_DIR, 'last-batch.json');

const DEFAULT_LIMIT = 100;
const DEFAULT_WINDOW_MS = 60_000;
const WINDOW_PAD_MS = 1_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_DETAILS_PER_CANDIDATE = 5;
const MAX_DETAILS_TOTAL = 30;
const CHECKPOINT_EVERY = 10;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const readJsonIfExists = (p) => fs.existsSync(p) ? readJson(p) : null;

export function osmElementTypeFromFacilityId(facilityId) {
  const m = String(facilityId || '').match(/^osm-(node|way|relation)-\d+$/);
  return m ? m[1] : null;
}

export function isBuildingSourceCandidate(candidate) {
  const type = osmElementTypeFromFacilityId(candidate?.facilityId);
  return type === 'way' || type === 'relation';
}

function wholeBuildingClassRank(candidate) {
  // Prefer classes that commonly occupy a whole named building/campus before tenant-heavy POIs.
  // Exact OSM source identity is still required later, so this only changes API request order.
  switch (candidate?.osmCategory) {
    case 'public':
    case 'education':
    case 'medical':
    case 'transport':
    case 'lodging':
      return 0;
    case 'tourism':
    case 'park':
      return 1;
    case 'shopping':
      return 2;
    case 'dining':
      return 3;
    default:
      return 2;
  }
}

export function selectBuildingSourceCandidates(candidates, {
  existingVerifiedIds = new Set(),
  attemptedIds = new Set(),
  retryUnresolved = false,
  wardId = null,
  maxPriority = 3,
  limit = DEFAULT_LIMIT,
  profile = {},
  wardOrder = [],
} = {}) {
  const wardIndex = new Map(wardOrder.map((id, i) => [id, i]));
  return candidates
    .filter(isBuildingSourceCandidate)
    .filter((c) => !existingVerifiedIds.has(c.facilityId))
    .filter((c) => retryUnresolved || !attemptedIds.has(c.facilityId))
    .filter((c) => !wardId || c.wardId === wardId)
    .filter((c) => priorityRank(c, profile) <= maxPriority)
    .sort((a, b) => wholeBuildingClassRank(a) - wholeBuildingClassRank(b)
      || priorityRank(a, profile) - priorityRank(b, profile)
      || (wardIndex.get(a.wardId) ?? 999) - (wardIndex.get(b.wardId) ?? 999)
      || (osmElementTypeFromFacilityId(a.facilityId) === 'relation' ? -1 : 0)
        - (osmElementTypeFromFacilityId(b.facilityId) === 'relation' ? -1 : 0)
      || a.facilityId.localeCompare(b.facilityId))
    .slice(0, Math.max(0, Number(limit) || DEFAULT_LIMIT));
}

function loadVerified(validIds) {
  const source = readJsonIfExists(CITY_MAPPING);
  return (source?.entries || [])
    .map(assertDurableRecordSafe)
    .filter((e) => e.matchConfidence === 'VERIFIED' && validIds.has(e.facilityId));
}

function loadProgress(validIds) {
  const p = readJsonIfExists(PROGRESS_PATH);
  const attempts = Array.isArray(p?.attempts)
    ? p.attempts.filter((a) => validIds.has(a.facilityId))
    : [];
  return { version: 1, mission: '36J', attempts };
}

function summarize(allCandidates, verified, attempts) {
  const verifiedIds = new Set(verified.map((e) => e.facilityId));
  const unresolvedAttempts = attempts.filter((a) => !verifiedIds.has(a.facilityId));
  const attemptedIds = new Set(unresolvedAttempts.map((a) => a.facilityId));
  const byWard = {};
  let unattempted = 0;
  for (const c of allCandidates) {
    const row = byWard[c.wardId] ||= { total: 0, verified: 0, unresolvedOrAmbiguous: 0, unattempted: 0 };
    row.total++;
    if (verifiedIds.has(c.facilityId)) row.verified++;
    else if (attemptedIds.has(c.facilityId)) row.unresolvedOrAmbiguous++;
    else { row.unattempted++; unattempted++; }
  }
  return {
    total: allCandidates.length,
    verified: verifiedIds.size,
    unresolvedOrAmbiguous: attemptedIds.size,
    unattempted,
    byWard,
  };
}

function summarizeBuildingSources(allCandidates, verified, attempts) {
  const targeted = allCandidates.filter(isBuildingSourceCandidate);
  return summarize(targeted, verified, attempts);
}

async function writeCheckpoint({ dataset, allCandidates, verified, progress, now, lastBatch = null }) {
  const generatedAt = now().toISOString();
  const summary = summarize(allCandidates, verified, progress.attempts);
  const oldMapping = readJsonIfExists(CITY_MAPPING) || {};
  const mapping = {
    ...oldMapping,
    version: 1,
    mission: '36J',
    areaId: 'osaka-city',
    sourceDataset: 'public/map-data/osaka-city/facilities/facilities.json',
    generatedAt,
    maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS,
    policy: {
      ...(oldMapping.policy || {}),
      persistsOnlyVerifiedLinkage: true,
      neverPersists: ['photo binaries', 'photo media URLs', 'photo resource names'],
      resolvesPhotosAtDisplayTime: true,
      ambiguousMatchesAreNotPersisted: true,
      resumableBatches: true,
      buildingSourceFocusedBatches: true,
    },
    counts: {
      verified: summary.verified,
      unresolved: summary.unresolvedOrAmbiguous,
      unattempted: summary.unattempted,
      total: summary.total,
    },
    wardCounts: summary.byWard,
    entries: verified.map(assertDurableRecordSafe),
  };

  await fsp.mkdir(path.dirname(CITY_MAPPING), { recursive: true });
  await fsp.writeFile(CITY_MAPPING, JSON.stringify(mapping, null, 2), 'utf8');
  await fsp.writeFile(UI_MAPPING, JSON.stringify(mapping, null, 2), 'utf8');
  await fsp.mkdir(path.dirname(PROGRESS_PATH), { recursive: true });
  await fsp.writeFile(PROGRESS_PATH, JSON.stringify({
    ...progress,
    generatedAt,
    sourceRecordCount: dataset.recordCount,
    counts: mapping.counts,
    wardCounts: summary.byWard,
  }, null, 2), 'utf8');

  if (lastBatch) {
    await fsp.mkdir(REPORT_DIR, { recursive: true });
    await fsp.writeFile(LAST_BATCH_PATH, JSON.stringify(lastBatch, null, 2), 'utf8');
  }
  return mapping;
}

async function withRateLimitRetry(call, sleepImpl, windowMs) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await call();
      if (result?.ok === false && /^http-(429|5\d\d)$/.test(result.reason || '')) {
        if (attempt >= MAX_RATE_LIMIT_RETRIES) {
          throw new Error('Transient Places failure; batch stopped without marking this facility unresolved: ' + result.reason);
        }
        await sleepImpl(Math.max(windowMs + WINDOW_PAD_MS, 60_000) * (attempt + 1));
        continue;
      }
      if (result?.ok === false && /^http-(401|403)$/.test(result.reason || '')) {
        throw new Error('Places authentication/billing failure; batch stopped: ' + result.reason);
      }
      return result;
    } catch (e) {
      if (!(e instanceof RateLimitExceededError)) throw e;
      if (attempt >= MAX_RATE_LIMIT_RETRIES) return { ok: false, reason: 'rate-limited: ' + e.message };
      await sleepImpl(windowMs + WINDOW_PAD_MS);
    }
  }
}

async function fetchIdentities(client, placeIds, budget, sleepImpl, windowMs) {
  const detailsByPlaceId = {};
  const failures = [];
  for (const id of placeIds.slice(0, MAX_DETAILS_PER_CANDIDATE)) {
    if (budget.remaining <= 0) { failures.push('Details全体上限に到達'); break; }
    budget.remaining--;
    const r = await withRateLimitRetry(() => client.getPlaceIdentity(id), sleepImpl, windowMs);
    if (r.ok && r.place) detailsByPlaceId[id] = r.place;
    else failures.push(r.reason || 'details-failed');
  }
  return { detailsByPlaceId, failures };
}

export async function runBuildingSourceMatchBatch({
  apiKey = loadGooglePlacesApiKeyFromEnv(),
  fetchImpl,
  ward = null,
  limit = DEFAULT_LIMIT,
  maxPriority = 3,
  retryUnresolved = false,
  requestGuard,
  rateGuard,
  sleepImpl = defaultSleep,
  windowMs = rateGuard?.windowMs ?? DEFAULT_WINDOW_MS,
  now = () => new Date(),
  dryRun = false,
} = {}) {
  if (!fs.existsSync(CITY_SOURCE)) {
    return { ok: false, reason: 'missing-city-facilities', message: '24区施設データが未生成。' };
  }

  const dataset = readJson(CITY_SOURCE);
  const profile = readJson(PROFILE_PATH);
  const registry = readJson(WARD_REGISTRY_PATH);
  const allCandidates = buildCityCandidates(dataset);
  const validIds = new Set(allCandidates.map((c) => c.facilityId));
  const verified = loadVerified(validIds);
  const verifiedIds = new Set(verified.map((e) => e.facilityId));
  const progress = loadProgress(validIds);
  const attemptedIds = new Set(progress.attempts.map((a) => a.facilityId));
  const wardId = resolveWardFilter(ward, registry);
  const wardOrder = (registry.wards || []).map((w) => w.id);
  const selected = selectBuildingSourceCandidates(allCandidates, {
    existingVerifiedIds: verifiedIds,
    attemptedIds,
    retryUnresolved,
    wardId,
    maxPriority,
    limit,
    profile,
    wardOrder,
  });

  const targetedBefore = summarizeBuildingSources(allCandidates, verified, progress.attempts);
  const client = createPlacesClient({ apiKey, fetchImpl, requestGuard, rateGuard });
  if (!client.isEnabled()) return { ok: false, reason: 'no-api-key', message: 'GOOGLE_PLACES_API_KEY が未設定。' };
  if (!selected.length) {
    return { ok: true, selected: 0, processed: 0, counts: summarize(allCandidates, verified, progress.attempts),
      buildingSourceCounts: targetedBefore, message: '未処理の way/relation 施設は指定条件にありません。' };
  }

  const detailsBudget = { remaining: MAX_DETAILS_TOTAL };
  const batchResults = [];
  let processed = 0;
  for (const c of selected) {
    const search = await withRateLimitRetry(() => client.searchText({
      textQuery: c.name,
      lat: c.expectLat,
      lon: c.expectLon,
    }), sleepImpl, windowMs);

    let match;
    if (!search.ok) {
      match = { matchConfidence: 'UNRESOLVED', googlePlaceId: null, distanceMeters: null,
        reason: 'Places API 呼び出し失敗: ' + search.reason };
    } else {
      match = classifyPilotMatch(c, search.places, { maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS });
      if (match.matchConfidence === 'AMBIGUOUS' && match.needsDetailsFor?.length) {
        const { detailsByPlaceId, failures } = await fetchIdentities(
          client, match.needsDetailsFor, detailsBudget, sleepImpl, windowMs);
        if (Object.keys(detailsByPlaceId).length) {
          match = classifyPilotMatch(c, search.places, {
            maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS,
            detailsByPlaceId,
          });
        }
        if (match.matchConfidence !== 'VERIFIED' && failures.length) {
          match = { ...match, reason: match.reason + '（Details: ' + failures.join('; ') + '）' };
        }
      }
      if (match.matchConfidence !== 'VERIFIED') {
        const variant = classifyConservativeJapaneseVariant(c, search.places, DEFAULT_MAX_DISTANCE_METERS);
        if (variant.ok) {
          match = {
            matchConfidence: 'VERIFIED',
            googlePlaceId: variant.googlePlaceId,
            distanceMeters: variant.distanceMeters,
            reason: variant.reason,
          };
        }
      }
    }

    const attemptedAt = now().toISOString();
    if (match.matchConfidence === 'VERIFIED') {
      const entry = assertDurableRecordSafe({
        facilityId: c.facilityId,
        googlePlaceId: match.googlePlaceId,
        name: c.name,
        relevanceClass: c.relevanceClass,
        matchConfidence: 'VERIFIED',
        matchReason: match.reason,
        distanceMeters: match.distanceMeters,
        verifiedAt: attemptedAt,
        verifiedBy: 'automated-building-source-batch',
      });
      const oldIndex = verified.findIndex((e) => e.facilityId === c.facilityId);
      if (oldIndex >= 0) verified[oldIndex] = entry;
      else verified.push(entry);
      progress.attempts = progress.attempts.filter((a) => a.facilityId !== c.facilityId);
    } else {
      const attempt = {
        facilityId: c.facilityId,
        name: c.name,
        wardId: c.wardId,
        category: c.osmCategory,
        subcategory: c.osmSubcategory,
        matchConfidence: match.matchConfidence,
        reason: match.reason,
        attemptedAt,
      };
      progress.attempts = progress.attempts.filter((a) => a.facilityId !== c.facilityId);
      progress.attempts.push(attempt);
    }

    batchResults.push({
      facilityId: c.facilityId,
      osmElementType: osmElementTypeFromFacilityId(c.facilityId),
      name: c.name,
      wardId: c.wardId,
      matchConfidence: match.matchConfidence,
      distanceMeters: match.distanceMeters ?? null,
      reason: match.reason,
    });
    processed++;

    if (!dryRun && processed % CHECKPOINT_EVERY === 0) {
      await writeCheckpoint({ dataset, allCandidates, verified, progress, now });
    }
  }

  const summary = summarize(allCandidates, verified, progress.attempts);
  const buildingSourceSummary = summarizeBuildingSources(allCandidates, verified, progress.attempts);
  const verifiedThisBatch = batchResults.filter((r) => r.matchConfidence === 'VERIFIED').length;
  const lastBatch = {
    mission: '36L-building-source-places',
    generatedAt: now().toISOString(),
    policy: {
      sourceTypes: ['way', 'relation'],
      exactBuildingSourceIdentityGoal: true,
      maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS,
      verifiedOnlyPersistence: true,
    },
    wardFilter: wardId,
    maxPriority,
    requestedLimit: limit,
    processed,
    verifiedThisBatch,
    buildingSourceCountsBefore: targetedBefore,
    buildingSourceCountsAfter: buildingSourceSummary,
    countsAfterBatch: summary,
    apiUsage: client.getDebugCounters(),
    results: batchResults,
  };

  if (!dryRun) await writeCheckpoint({ dataset, allCandidates, verified, progress, now, lastBatch });
  return {
    ok: true,
    selected: selected.length,
    processed,
    verifiedThisBatch,
    counts: summary,
    buildingSourceCounts: buildingSourceSummary,
    results: batchResults,
    apiUsage: client.getDebugCounters(),
  };
}

function parseCli(argv) {
  const args = { ward: null, limit: DEFAULT_LIMIT, maxPriority: 3, retryUnresolved: false, requestsPerMinute: 60 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ward') args.ward = argv[++i];
    else if (argv[i] === '--limit') args.limit = Math.min(DEFAULT_LIMIT, Math.max(1, Number(argv[++i]) || DEFAULT_LIMIT));
    else if (argv[i] === '--priority') {
      const v = argv[++i];
      args.maxPriority = v === 'high' ? 0 : v === 'normal' ? 1 : v === 'medium' ? 2 : 3;
    } else if (argv[i] === '--requests-per-minute') args.requestsPerMinute = Number(argv[++i]);
    else if (argv[i] === '--retry-unresolved') args.retryUnresolved = true;
  }
  return args;
}

if (isMainModule(import.meta.url)) {
  const args = parseCli(process.argv.slice(2));
  runBuildingSourceMatchBatch({
    ...args,
    requestGuard: createPacedCityGuard({ requestsPerMinute: args.requestsPerMinute }),
  }).then((r) => {
    if (!r.ok) { console.error('[36L building-source places]', r.message || r.reason); process.exit(1); }
    console.log('[36L building-source places]', JSON.stringify({
      selected: r.selected,
      processed: r.processed || 0,
      verifiedThisBatch: r.verifiedThisBatch || 0,
      counts: r.counts,
      buildingSourceCounts: r.buildingSourceCounts,
    }));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
