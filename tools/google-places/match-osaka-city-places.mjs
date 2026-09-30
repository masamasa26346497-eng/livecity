// Mission 36J: resumable Google Places matching for all 24 Osaka wards.
// Safe policy inherited from 36H/36I:
// - 120m hard ceiling never widened.
// - only VERIFIED facilityId <-> googlePlaceId linkage is persisted.
// - ambiguous/unresolved attempts are kept only in progress/report (without candidate Place IDs).
// - photos/media URLs/resource names are never persisted; photo metadata is resolved at display time.
// - each invocation is bounded (default 140 facilities) so the 200-request session guard remains effective.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { createPlacesClient } from './lib/places-client.mjs';
import { RateLimitExceededError } from './lib/rate-guard.mjs';
import { classifyPilotMatch, DEFAULT_MAX_DISTANCE_METERS } from './lib/pilot-matching.mjs';
import { assertDurableRecordSafe } from './lib/persistence-guard.mjs';
import { loadGooglePlacesApiKeyFromEnv } from './load-api-key.mjs';
import { classifyConservativeJapaneseVariant } from './retry-sumiyoshi-unresolved.mjs';

export const CITY_SOURCE = resolveProjectPath('public/map-data/osaka-city/facilities/facilities.json');
export const CITY_MAPPING = resolveProjectPath('public/map-data/osaka-city/derived/google-places-osaka-city-mapping.json');
export const UI_MAPPING = resolveProjectPath('public/map-data/osaka-city/derived/google-places-pilot-mapping.json');
export const SUMIYOSHI_SEED_MAPPING = resolveProjectPath('public/map-data/osaka-city/derived/google-places-sumiyoshi-mapping.json');
export const PROFILE_PATH = resolveProjectPath('config/facilities/osaka-city-photo-profile.json');
export const WARD_REGISTRY_PATH = resolveProjectPath('config/wards/registry.json');
export const REPORT_DIR = resolveProjectPath('data/reports/mission36j-google-places-osaka-city');
export const PROGRESS_PATH = path.join(REPORT_DIR, 'progress.json');
export const LAST_BATCH_PATH = path.join(REPORT_DIR, 'last-batch.json');

const DEFAULT_LIMIT = 140;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_WINDOW_MS = 60_000;
const WINDOW_PAD_MS = 1_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_DETAILS_PER_CANDIDATE = 5;
const MAX_DETAILS_TOTAL = 30;
const CHECKPOINT_EVERY = 10;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const readJsonIfExists = (p) => fs.existsSync(p) ? readJson(p) : null;

export function relevanceClassForCityFacility(record) {
  switch (record?.category) {
    case 'medical': return 'hospital';
    case 'education': return 'school';
    case 'transport': return 'station';
    case 'public': return 'public-facility';
    case 'shopping': return 'retail-commercial';
    case 'dining': return 'dining';
    case 'lodging': return 'lodging';
    case 'tourism': return 'tourism';
    case 'park': return 'park';
    default: return String(record?.category || 'other');
  }
}

export function buildCityCandidates(dataset) {
  if (!dataset || !Array.isArray(dataset.records)) throw new Error('osaka-city facilities records が配列ではない');
  const ids = new Set();
  return dataset.records.map((record, index) => {
    const facilityId = String(record.id || '');
    const name = String(record.name || '').trim();
    const expectLat = Number(record.latitude);
    const expectLon = Number(record.longitude);
    const wardId = String(record.wardId || '');
    if (!facilityId || !name || !wardId || !Number.isFinite(expectLat) || !Number.isFinite(expectLon)) {
      throw new Error(`city facility #${index} に id/name/wardId/latitude/longitude が不足`);
    }
    if (ids.has(facilityId)) throw new Error('city facilityId が重複: ' + facilityId);
    ids.add(facilityId);
    return {
      facilityId,
      name,
      wardId,
      wardName: record.wardName || null,
      relevanceClass: relevanceClassForCityFacility(record),
      osmCategory: record.category || null,
      osmSubcategory: record.subcategory || null,
      expectLat,
      expectLon,
    };
  });
}

export function priorityRank(candidate, profile) {
  const p = profile?.priority || {};
  if ((p.highCategories || []).includes(candidate.osmCategory)) return 0;
  if (candidate.osmCategory === 'transport' && (p.transportHighSubcategories || []).includes(candidate.osmSubcategory)) return 1;
  if ((p.normalCategories || []).includes(candidate.osmCategory)) return 1;
  if ((p.lowSubcategories || []).includes(candidate.osmSubcategory)) return 3;
  return 2;
}

export function resolveWardFilter(value, registry) {
  if (!value) return null;
  const needle = String(value).trim();
  const wards = registry?.wards || [];
  const found = wards.find((w) => w.id === needle || w.name === needle || w.code === needle);
  if (!found) throw new Error('未知の ward: ' + needle);
  return found.id;
}

export function selectBatchCandidates(candidates, {
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
    .filter((c) => !existingVerifiedIds.has(c.facilityId))
    .filter((c) => retryUnresolved || !attemptedIds.has(c.facilityId))
    .filter((c) => !wardId || c.wardId === wardId)
    .filter((c) => priorityRank(c, profile) <= maxPriority)
    .sort((a, b) => (wardIndex.get(a.wardId) ?? 999) - (wardIndex.get(b.wardId) ?? 999)
      || priorityRank(a, profile) - priorityRank(b, profile)
      || a.facilityId.localeCompare(b.facilityId))
    .slice(0, Math.max(0, Number(limit) || DEFAULT_LIMIT));
}

async function withRateLimitRetry(call, sleepImpl, windowMs) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
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

function loadSeedMapping(validIds) {
  const source = readJsonIfExists(CITY_MAPPING) || readJsonIfExists(SUMIYOSHI_SEED_MAPPING);
  const entries = (source?.entries || [])
    .map(assertDurableRecordSafe)
    .filter((e) => e.matchConfidence === 'VERIFIED' && validIds.has(e.facilityId));
  return entries;
}

function loadProgress(validIds) {
  const p = readJsonIfExists(PROGRESS_PATH);
  const attempts = Array.isArray(p?.attempts) ? p.attempts.filter((a) => validIds.has(a.facilityId)) : [];
  return { version: 1, mission: '36J', attempts };
}

function summarize(candidates, verified, attempts) {
  const verifiedIds = new Set(verified.map((e) => e.facilityId));
  const unresolvedAttempts = attempts.filter((a) => !verifiedIds.has(a.facilityId));
  const attemptedIds = new Set(unresolvedAttempts.map((a) => a.facilityId));
  const unattempted = candidates.filter((c) => !verifiedIds.has(c.facilityId) && !attemptedIds.has(c.facilityId));
  const byWard = {};
  for (const c of candidates) {
    const row = byWard[c.wardId] ||= { total: 0, verified: 0, unresolvedOrAmbiguous: 0, unattempted: 0 };
    row.total++;
    if (verifiedIds.has(c.facilityId)) row.verified++;
    else if (attemptedIds.has(c.facilityId)) row.unresolvedOrAmbiguous++;
    else row.unattempted++;
  }
  return {
    total: candidates.length,
    verified: verifiedIds.size,
    unresolvedOrAmbiguous: attemptedIds.size,
    unattempted: unattempted.length,
    byWard,
  };
}

async function writeCheckpoint({ dataset, candidates, verified, progress, now, lastBatch = null }) {
  const generatedAt = now().toISOString();
  const summary = summarize(candidates, verified, progress.attempts);
  const mapping = {
    version: 1,
    mission: '36J',
    areaId: 'osaka-city',
    sourceDataset: 'public/map-data/osaka-city/facilities/facilities.json',
    generatedAt,
    maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS,
    policy: {
      persistsOnlyVerifiedLinkage: true,
      neverPersists: ['photo binaries', 'photo media URLs', 'photo resource names'],
      resolvesPhotosAtDisplayTime: true,
      ambiguousMatchesAreNotPersisted: true,
      resumableBatches: true,
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
  // Dev UI compatibility path: contains VERIFIED linkage only, now across all processed wards.
  await fsp.writeFile(UI_MAPPING, JSON.stringify(mapping, null, 2), 'utf8');
  await fsp.mkdir(REPORT_DIR, { recursive: true });
  await fsp.writeFile(PROGRESS_PATH, JSON.stringify({
    ...progress,
    generatedAt,
    sourceRecordCount: dataset.recordCount,
    counts: mapping.counts,
    wardCounts: summary.byWard,
  }, null, 2), 'utf8');
  if (lastBatch) await fsp.writeFile(LAST_BATCH_PATH, JSON.stringify(lastBatch, null, 2), 'utf8');
  return mapping;
}

export async function runCityMatchBatch({
  apiKey = loadGooglePlacesApiKeyFromEnv(),
  fetchImpl,
  ward = null,
  limit = DEFAULT_LIMIT,
  maxPriority = 3,
  retryUnresolved = false,
  requestGuard,
  rateGuard,
  sleepImpl = defaultSleep,
  batchSize = rateGuard?.maxRequestsPerWindow ?? DEFAULT_BATCH_SIZE,
  windowMs = rateGuard?.windowMs ?? DEFAULT_WINDOW_MS,
  now = () => new Date(),
  dryRun = false,
} = {}) {
  if (!fs.existsSync(CITY_SOURCE)) {
    return { ok: false, reason: 'missing-city-facilities', message: '24区施設データが未生成。先に Mission 36J facility download/build を実行してください。' };
  }
  const dataset = readJson(CITY_SOURCE);
  const profile = readJson(PROFILE_PATH);
  const registry = readJson(WARD_REGISTRY_PATH);
  const candidates = buildCityCandidates(dataset);
  const validIds = new Set(candidates.map((c) => c.facilityId));
  const verified = loadSeedMapping(validIds);
  const verifiedIds = new Set(verified.map((e) => e.facilityId));
  const progress = loadProgress(validIds);
  const attemptedIds = new Set(progress.attempts.map((a) => a.facilityId));
  const wardId = resolveWardFilter(ward, registry);
  const wardOrder = (registry.wards || []).map((w) => w.id);
  const selected = selectBatchCandidates(candidates, {
    existingVerifiedIds: verifiedIds,
    attemptedIds,
    retryUnresolved,
    wardId,
    maxPriority,
    limit,
    profile,
    wardOrder,
  });

  const client = createPlacesClient({ apiKey, fetchImpl, requestGuard, rateGuard });
  if (!client.isEnabled()) return { ok: false, reason: 'no-api-key', message: 'GOOGLE_PLACES_API_KEY が未設定。' };
  if (!selected.length) {
    const summary = summarize(candidates, verified, progress.attempts);
    return { ok: true, selected: 0, counts: summary, message: '指定条件で未処理施設はありません。' };
  }

  const detailsBudget = { remaining: MAX_DETAILS_TOTAL };
  const batchResults = [];
  let processed = 0;
  for (const c of selected) {
    if (processed > 0 && processed % batchSize === 0) await sleepImpl(windowMs + WINDOW_PAD_MS);
    const search = await withRateLimitRetry(() => client.searchText({
      textQuery: c.name, lat: c.expectLat, lon: c.expectLon,
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
          match = { matchConfidence: 'VERIFIED', googlePlaceId: variant.googlePlaceId,
            distanceMeters: variant.distanceMeters, reason: variant.reason };
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
        verifiedBy: 'automated-osaka-24ward-batch',
      });
      const oldIndex = verified.findIndex((e) => e.facilityId === c.facilityId);
      if (oldIndex >= 0) verified[oldIndex] = entry; else verified.push(entry);
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
    batchResults.push({ facilityId: c.facilityId, name: c.name, wardId: c.wardId,
      matchConfidence: match.matchConfidence, distanceMeters: match.distanceMeters ?? null, reason: match.reason });
    processed++;

    if (!dryRun && processed % CHECKPOINT_EVERY === 0) {
      await writeCheckpoint({ dataset, candidates, verified, progress, now });
    }
  }

  const summary = summarize(candidates, verified, progress.attempts);
  const lastBatch = {
    mission: '36J',
    generatedAt: now().toISOString(),
    wardFilter: wardId,
    maxPriority,
    requestedLimit: limit,
    processed,
    countsAfterBatch: summary,
    apiUsage: client.getDebugCounters(),
    results: batchResults,
  };
  if (!dryRun) await writeCheckpoint({ dataset, candidates, verified, progress, now, lastBatch });
  return { ok: true, selected: selected.length, processed, counts: summary, results: batchResults,
    apiUsage: client.getDebugCounters() };
}

function parseCli(argv) {
  const args = { ward: null, limit: DEFAULT_LIMIT, maxPriority: 3, retryUnresolved: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ward') args.ward = argv[++i];
    else if (argv[i] === '--limit') args.limit = Math.min(DEFAULT_LIMIT, Math.max(1, Number(argv[++i]) || DEFAULT_LIMIT));
    else if (argv[i] === '--priority') {
      const v = argv[++i];
      args.maxPriority = v === 'high' ? 0 : v === 'normal' ? 1 : v === 'medium' ? 2 : 3;
    } else if (argv[i] === '--retry-unresolved') args.retryUnresolved = true;
  }
  return args;
}

if (isMainModule(import.meta.url)) {
  const args = parseCli(process.argv.slice(2));
  runCityMatchBatch(args).then((r) => {
    if (!r.ok) { console.error('[36J places]', r.message || r.reason); process.exit(1); }
    console.log('[36J places]', JSON.stringify({ selected: r.selected, processed: r.processed || 0, counts: r.counts }));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
