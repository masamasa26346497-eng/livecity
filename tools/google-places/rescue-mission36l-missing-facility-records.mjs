#!/usr/bin/env node
// Mission 36L: rescue exact-source gaps that are missing from facilities.json.
// Geometry is recovered from the exact OSM source via Overpass; Google Places linkage remains VERIFIED-only.

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
const REPORT_DIR = resolveProjectPath('data/reports/mission36l-missing-facility-rescue');
const PROGRESS_PATH = path.join(REPORT_DIR, 'progress.json');
const LAST_BATCH_PATH = path.join(REPORT_DIR, 'last-batch.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const readJsonIfExists = (p) => fs.existsSync(p) ? readJson(p) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseSourceId(sourceId) {
  const m = String(sourceId || '').match(/^(node|way|relation)\/(\d+)$/);
  return m ? { type: m[1], id: Number(m[2]) } : null;
}

// A Places API failure (429 quota/rate, 403 key/billing, 5xx...) says nothing about the candidate, so it must never be
// recorded as a consumed "UNRESOLVED" attempt. Attempts written by older versions with this reason are re-evaluable.
export const API_ERROR_REASON_PREFIX = 'Places API:';
export const isApiErrorAttempt = (a) => String(a?.reason || '').startsWith(API_ERROR_REASON_PREFIX);

export function pruneApiErrorAttempts(progress) {
  const before = progress.attempts.length;
  progress.attempts = progress.attempts.filter((a) => !isApiErrorAttempt(a));
  return before - progress.attempts.length;
}

export function buildMissingFacilityCandidates(gapsDoc, facilitiesDoc, mappingDoc, progressDoc = null) {
  const facilities = new Set((facilitiesDoc?.records || []).map((r) => String(r.id || '')));
  const verifiedIds = new Set((mappingDoc?.entries || []).filter((e) => e?.matchConfidence === 'VERIFIED').map((e) => String(e.facilityId || '')));
  const attemptedIds = new Set((progressDoc?.attempts || []).map((a) => String(a.facilityId || '')));
  const out = [];
  for (const g of (gapsDoc?.candidates || [])) {
    const id = String(g?.facilityId || '');
    if (!id || facilities.has(id) || verifiedIds.has(id) || attemptedIds.has(id)) continue;
    const src = parseSourceId(g.sourceId);
    if (!src || src.type === 'relation') continue;
    const queryName = String((g.buildingNames || []).find((n) => String(n || '').trim()) || '').trim();
    if (!queryName) continue;
    out.push({ gap: g, src, queryName });
  }
  out.sort((a, b) => (a.src.type === 'way' ? 0 : 1) - (b.src.type === 'way' ? 0 : 1) || a.src.id - b.src.id);
  return out;
}

async function fetchOverpassCentersOnce(items, fetchImpl = fetch) {
  const nodes = items.filter((x) => x.src.type === 'node').map((x) => x.src.id);
  const ways = items.filter((x) => x.src.type === 'way').map((x) => x.src.id);
  const parts = [];
  if (nodes.length) parts.push(`node(id:${nodes.join(',')});`);
  if (ways.length) parts.push(`way(id:${ways.join(',')});`);
  if (!parts.length) return new Map();
  const q = `[out:json][timeout:60];(${parts.join('')});out center tags;`;
  const res = await fetchImpl('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'LiveCity-Mission36L/1.0' },
    body: new URLSearchParams({ data: q }).toString(),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const body = await res.json();
  const map = new Map();
  for (const e of body.elements || []) {
    const lat = Number(e.lat ?? e.center?.lat);
    const lon = Number(e.lon ?? e.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    map.set(`${e.type}/${e.id}`, { lat, lon, tags: e.tags || {} });
  }
  return map;
}

export const OVERPASS_MAX_ATTEMPTS = 5;
export const OVERPASS_BASE_BACKOFF_MS = 5000;
export const OVERPASS_MAX_BACKOFF_MS = 60000;

export function isTransientOverpassError(e) {
  const msg = String(e?.message || e);
  return /Overpass HTTP (429|500|502|503|504)/.test(msg) || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|aborted/i.test(msg) || e?.name === 'SyntaxError';
}

export function overpassBackoffMs(attempt, random = Math.random) {
  const exp = Math.min(OVERPASS_MAX_BACKOFF_MS, OVERPASS_BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.round(exp * (0.75 + random() * 0.5));
}

export async function fetchOverpassCenters(items, fetchImpl = fetch, retries = OVERPASS_MAX_ATTEMPTS, sleepImpl = sleep) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetchOverpassCentersOnce(items, fetchImpl);
    } catch (e) {
      lastError = e;
      const transient = isTransientOverpassError(e);
      if (!transient || attempt === retries) {
        if (transient) e.transientOverpass = true;
        throw e;
      }
      await sleepImpl(overpassBackoffMs(attempt));
    }
  }
  throw lastError;
}

export async function runRescueBatch({ apiKey = loadGooglePlacesApiKeyFromEnv(), fetchImpl = fetch, limit = 20, requestsPerMinute = 40, now = () => new Date() } = {}) {
  for (const p of [GAP_PATH, FACILITIES_PATH, MAPPING_PATH]) if (!fs.existsSync(p)) throw new Error(`required input missing: ${p}`);
  const gaps = readJson(GAP_PATH);
  const facilities = readJson(FACILITIES_PATH);
  const mapping = readJson(MAPPING_PATH);
  const progress = readJsonIfExists(PROGRESS_PATH) || { version: 1, mission: '36L-missing-facility-rescue', attempts: [] };
  const prunedApiErrorAttempts = pruneApiErrorAttempts(progress);
  const all = buildMissingFacilityCandidates(gaps, facilities, mapping, progress);
  const selected = all.slice(0, Math.max(1, Math.min(20, Number(limit) || 20)));
  if (!selected.length) return { mission: '36L-missing-facility-rescue', processed: 0, verifiedThisBatch: 0, remainingMissingActionable: 0, osmCentersResolved: 0, results: [] };

  const centers = await fetchOverpassCenters(selected, fetchImpl, OVERPASS_MAX_ATTEMPTS);
  const client = createPlacesClient({ apiKey, fetchImpl, requestGuard: createPacedCityGuard({ requestsPerMinute }) });
  if (!client.isEnabled()) throw new Error('GOOGLE_PLACES_API_KEY is not configured');
  const entries = [...(mapping.entries || [])].map(assertDurableRecordSafe);
  const results = [];
  let apiError = null;
  let apiErrorDiagnostics = null;

  for (let i = 0; i < selected.length; i++) {
    const { gap, queryName } = selected[i];
    const c = centers.get(gap.sourceId);
    const attemptedAt = now().toISOString();
    if (!c) {
      progress.attempts.push({ facilityId: gap.facilityId, sourceId: gap.sourceId, queryName, status: 'NO_OSM_CENTER', attemptedAt });
      results.push({ facilityId: gap.facilityId, sourceId: gap.sourceId, queryName, matchConfidence: 'UNRESOLVED', reason: 'No OSM center from Overpass' });
      continue;
    }

    const search = await client.searchText({ textQuery: queryName, lat: c.lat, lon: c.lon });
    if (!search.ok) {
      // Not evaluated: leave the candidate unattempted and stop the batch (retrying more only burns quota).
      apiError = `${API_ERROR_REASON_PREFIX} ${search.reason}`;
      apiErrorDiagnostics = search.diagnostics || null;
      results.push({ facilityId: gap.facilityId, sourceId: gap.sourceId, queryName, matchConfidence: 'NOT_EVALUATED', reason: apiError });
      break;
    }
    let match = classifyPilotMatch({
      facilityId: gap.facilityId,
      name: queryName,
      wardId: (gap.wardIds || [])[0] || null,
      relevanceClass: 'other',
      osmCategory: null,
      osmSubcategory: null,
      expectLat: c.lat,
      expectLon: c.lon,
    }, search.places, { maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS });

    if (match.matchConfidence !== 'VERIFIED') {
      const variant = classifyConservativeJapaneseVariant({ facilityId: gap.facilityId, name: queryName, expectLat: c.lat, expectLon: c.lon }, search.places, DEFAULT_MAX_DISTANCE_METERS);
      if (variant.ok) match = { matchConfidence: 'VERIFIED', googlePlaceId: variant.googlePlaceId, distanceMeters: variant.distanceMeters, reason: variant.reason };
    }

    if (match.matchConfidence === 'VERIFIED') {
      const entry = assertDurableRecordSafe({ facilityId: gap.facilityId, googlePlaceId: match.googlePlaceId, name: queryName, relevanceClass: 'other', matchConfidence: 'VERIFIED', matchReason: `missing-facility-rescue: ${match.reason}`, distanceMeters: match.distanceMeters, verifiedAt: attemptedAt, verifiedBy: 'automated-missing-facility-rescue' });
      const idx = entries.findIndex((e) => e.facilityId === gap.facilityId);
      if (idx >= 0) entries[idx] = entry; else entries.push(entry);
    }

    progress.attempts.push({ facilityId: gap.facilityId, sourceId: gap.sourceId, queryName, lat: c.lat, lon: c.lon, matchConfidence: match.matchConfidence, reason: match.reason, attemptedAt });
    results.push({ facilityId: gap.facilityId, sourceId: gap.sourceId, queryName, matchConfidence: match.matchConfidence, distanceMeters: match.distanceMeters ?? null });
    if (i + 1 < selected.length) await sleep(Math.ceil(60000 / Math.max(1, requestsPerMinute)));
  }

  const generatedAt = now().toISOString();
  const updatedMapping = { ...mapping, generatedAt, maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS, policy: { ...(mapping.policy || {}), persistsOnlyVerifiedLinkage: true, ambiguousMatchesAreNotPersisted: true, missingFacilityRescueUsesExactOsmSource: true, neverPersists: ['photo binaries','photo media URLs','photo resource names'] }, counts: { ...(mapping.counts || {}), verified: entries.length }, entries };
  await fsp.writeFile(MAPPING_PATH, JSON.stringify(updatedMapping, null, 2));
  await fsp.writeFile(UI_MAPPING_PATH, JSON.stringify(updatedMapping, null, 2));
  await fsp.mkdir(REPORT_DIR, { recursive: true });
  await fsp.writeFile(PROGRESS_PATH, JSON.stringify({ ...progress, generatedAt }, null, 2));

  const evaluated = results.filter((r) => r.matchConfidence !== 'NOT_EVALUATED');
  const verifiedThisBatch = results.filter((r) => r.matchConfidence === 'VERIFIED').length;
  const remaining = buildMissingFacilityCandidates(gaps, facilities, updatedMapping, progress).length;
  const report = { mission: '36L-missing-facility-rescue', generatedAt, policy: { exactOsmSourceOnly: true, maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS, verifiedOnlyPersistence: true }, selected: selected.length, processed: evaluated.length, notEvaluated: results.length - evaluated.length, apiError, apiErrorDiagnostics, prunedApiErrorAttempts, verifiedThisBatch, remainingMissingActionable: remaining, osmCentersResolved: centers.size, apiUsage: client.getDebugCounters(), results };
  await fsp.writeFile(LAST_BATCH_PATH, JSON.stringify(report, null, 2));
  return report;
}

export const DEFAULT_REQUESTS_PER_MINUTE = 20;

export function parseCli(argv) {
  const out = { limit: 20, requestsPerMinute: DEFAULT_REQUESTS_PER_MINUTE, chunks: 10 };
  for (let i = 0; i < argv.length; i++) {
    // Bounded diagnostic: 1 chunk x 3 candidates at 10 req/min (<=3 Places searches; stops at the first API error).
    if (argv[i] === '--diagnostic') { out.limit = 3; out.chunks = 1; out.requestsPerMinute = 10; }
    else
    if (argv[i] === '--limit') out.limit = Math.min(20, Math.max(1, Number(argv[++i]) || 20));
    else if (argv[i] === '--requests-per-minute') out.requestsPerMinute = Math.max(1, Number(argv[++i]) || DEFAULT_REQUESTS_PER_MINUTE);
    else if (argv[i] === '--chunks') out.chunks = Math.min(25, Math.max(1, Number(argv[++i]) || 10));
  }
  return out;
}

// Each runRescueBatch call persists mapping/progress/last-batch to disk before returning, so every completed
// chunk is already a checkpoint. A transient Overpass failure (after retries) stops the run gracefully (exit 0)
// so the workflow's Validate/Commit steps still persist completed chunks; the next run resumes from progress.json.
// Non-transient errors (including safety violations) still fail the run.
export async function runChunks(opts, { runBatch = runRescueBatch, sleepImpl = sleep, log = console.log } = {}) {
  let processed = 0;
  let verified = 0;
  let remaining = null;
  let stoppedEarly = null;
  let summaryDiagnostics = null;
  for (let chunk = 1; chunk <= opts.chunks; chunk++) {
    let r;
    try {
      r = await runBatch(opts);
    } catch (e) {
      if (!(e?.transientOverpass || isTransientOverpassError(e))) throw e;
      stoppedEarly = `chunk ${chunk}: ${e?.message || e}`;
      log(`[36L missing-facility rescue] transient Overpass failure; keeping ${chunk - 1} completed chunk(s), stopping gracefully: ${stoppedEarly}`);
      break;
    }
    processed += r.processed;
    verified += r.verifiedThisBatch;
    remaining = r.remainingMissingActionable;
    log(`[36L missing-facility rescue] chunk ${chunk}/${opts.chunks}`, JSON.stringify({ processed:r.processed, verifiedThisBatch:r.verifiedThisBatch, remainingMissingActionable:r.remainingMissingActionable, osmCentersResolved:r.osmCentersResolved }));
    if (r.apiError) {
      stoppedEarly = `chunk ${chunk}: ${r.apiError}`;
      const d = r.apiErrorDiagnostics;
      const diag = d ? ` (httpStatus=${d.httpStatus ?? 'n/a'} retryAfter=${d.retryAfter ?? 'none'} errorCode=${d.errorCode ?? 'n/a'} errorStatus=${d.errorStatus ?? 'n/a'})` : '';
      log(`::warning::[36L missing-facility rescue] Places API error; candidates left unattempted, stopping: ${r.apiError}${diag}`);
      if (d) summaryDiagnostics = d;
      break;
    }
    if (!r.processed || !r.remainingMissingActionable) break;
    await sleepImpl(3000);
  }
  const summary = { processed, verifiedThisRun: verified, remainingMissingActionable: remaining, stoppedEarly, apiErrorDiagnostics: summaryDiagnostics };
  log('[36L missing-facility rescue] total', JSON.stringify(summary));
  return summary;
}

async function runCli(opts) {
  // Fail closed: activating billing in Google Cloud never authorizes paid batch execution.
  // Explicit opt-in is required even for --diagnostic. This is an emergency cost-safety
  // interlock; a durable monthly budget ledger must be implemented and tested separately.
  if (process.env.LIVECITY_PLACES_RESCUE_ENABLED !== 'true') {
    console.log('[36L missing-facility rescue] PAUSED: paid API calls disabled; no Places requests issued.');
    return;
  }
  throw new Error('Paid rescue remains locked until Issue #25 monthly budget enforcement is implemented and tested.');
}

if (isMainModule(import.meta.url)) {
  runCli(parseCli(process.argv.slice(2))).catch((e) => { console.error(e?.stack || e); process.exitCode = 1; });
}
