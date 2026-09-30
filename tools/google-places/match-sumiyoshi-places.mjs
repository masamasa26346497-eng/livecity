// tools/google-places/match-sumiyoshi-places.mjs
// [Mission 36I] osaka-sumiyoshi の既存149施設を Google Places API (New) と保守的に照合する。
//
// 重要:
// - 施設は public/map-data/osaka-sumiyoshi/facilities/facilities.json を直接読む（二重管理しない）。
// - 判定は Mission 36H の classifyPilotMatch() をそのまま再利用し、120m閾値を変更しない。
// - VERIFIED の linkage だけを durable mapping に保存する。
// - AMBIGUOUS / UNRESOLVED は report に理由だけを残し、Place ID を確定保存しない。
// - 写真バイナリ / media URL / photo resource name は永続化しない。
//
// 実行例（ネットワーク接続可能なローカル環境）:
//   GOOGLE_PLACES_API_KEY=xxxx node tools/google-places/match-sumiyoshi-places.mjs

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { createPlacesClient } from './lib/places-client.mjs';
import { RateLimitExceededError } from './lib/rate-guard.mjs';
import { classifyPilotMatch, DEFAULT_MAX_DISTANCE_METERS } from './lib/pilot-matching.mjs';
import { assertDurableRecordSafe } from './lib/persistence-guard.mjs';
import { loadGooglePlacesApiKeyFromEnv } from './load-api-key.mjs';

export const SUMIYOSHI_SOURCE = resolveProjectPath('public/map-data/osaka-sumiyoshi/facilities/facilities.json');
export const SUMIYOSHI_OUT_MAPPING = resolveProjectPath('public/map-data/osaka-city/derived/google-places-sumiyoshi-mapping.json');
export const SUMIYOSHI_REPORT_DIR = resolveProjectPath('data/reports/mission36i-google-places-sumiyoshi');
export const EXPECTED_SUMIYOSHI_FACILITY_COUNT = 149;

// createPlacesClient の既定保護（10 req / 60 sec, session 200 req）を弱めない。
// 149 Text Search + 最大30 Details = 最大179 API requests に抑える。
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_WINDOW_MS = 60_000;
const WINDOW_PAD_MS = 1_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_DETAILS_PER_CANDIDATE = 5;
const MAX_DETAILS_TOTAL = 30;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function relevanceClassForFacility(record) {
  switch (record?.category) {
    case 'medical': return 'hospital';
    case 'education': return 'school';
    case 'transport': return 'station';
    case 'public': return 'public-facility';
    case 'shopping': return 'retail-commercial';
    case 'tourism': return 'temple-shrine';
    case 'park': return 'park';
    default: return String(record?.category || 'other');
  }
}

export function buildSumiyoshiCandidates(dataset) {
  if (!dataset || !Array.isArray(dataset.records)) {
    throw new Error('施設データの records が配列ではない');
  }
  if (dataset.recordCount !== EXPECTED_SUMIYOSHI_FACILITY_COUNT || dataset.records.length !== EXPECTED_SUMIYOSHI_FACILITY_COUNT) {
    throw new Error('Mission 36I は149施設を前提とする: recordCount=' + dataset.recordCount
      + ', records.length=' + dataset.records.length);
  }

  const ids = new Set();
  return dataset.records.map((record, index) => {
    const facilityId = String(record.id || '');
    const name = String(record.name || '').trim();
    const expectLat = Number(record.latitude);
    const expectLon = Number(record.longitude);
    if (!facilityId || !name || !Number.isFinite(expectLat) || !Number.isFinite(expectLon)) {
      throw new Error('施設 #' + index + ' に照合必須フィールド(id/name/latitude/longitude)が不足');
    }
    if (ids.has(facilityId)) throw new Error('facilityId が重複: ' + facilityId);
    ids.add(facilityId);
    return {
      facilityId,
      name,
      relevanceClass: relevanceClassForFacility(record),
      osmCategory: record.category || null,
      osmSubcategory: record.subcategory || null,
      expectLat,
      expectLon,
    };
  });
}

async function withRateLimitRetry(call, sleepImpl, windowMs) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (!(e instanceof RateLimitExceededError)) throw e;
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        return { ok: false, reason: 'rate-limited (retries exhausted): ' + e.message };
      }
      await sleepImpl(windowMs + WINDOW_PAD_MS);
    }
  }
}

const searchCandidate = (client, candidate, sleepImpl, windowMs) =>
  withRateLimitRetry(() => client.searchText({
    textQuery: candidate.name,
    lat: candidate.expectLat,
    lon: candidate.expectLon,
  }), sleepImpl, windowMs);

async function fetchIdentities(client, placeIds, budget, sleepImpl, windowMs) {
  const detailsByPlaceId = {};
  const failures = [];
  for (const id of placeIds.slice(0, MAX_DETAILS_PER_CANDIDATE)) {
    if (budget.remaining <= 0) {
      failures.push(id + ': Details全体上限に到達');
      continue;
    }
    budget.remaining--;
    const result = await withRateLimitRetry(
      () => client.getPlaceIdentity(id), sleepImpl, windowMs);
    if (result.ok && result.place) detailsByPlaceId[id] = result.place;
    else failures.push(id + ': ' + result.reason);
  }
  return { detailsByPlaceId, failures };
}

export async function runSumiyoshiMatch({
  apiKey = loadGooglePlacesApiKeyFromEnv(),
  fetchImpl,
  dryRun = false,
  requestGuard,
  rateGuard,
  sleepImpl = defaultSleep,
  batchSize = rateGuard?.maxRequestsPerWindow ?? DEFAULT_BATCH_SIZE,
  windowMs = rateGuard?.windowMs ?? DEFAULT_WINDOW_MS,
  now = () => new Date(),
} = {}) {
  const dataset = JSON.parse(fs.readFileSync(SUMIYOSHI_SOURCE, 'utf-8'));
  const candidates = buildSumiyoshiCandidates(dataset);
  const client = createPlacesClient({ apiKey, fetchImpl, requestGuard, rateGuard });

  if (!client.isEnabled()) {
    return {
      ok: false,
      reason: 'no-api-key',
      message: 'GOOGLE_PLACES_API_KEY が未設定。149施設の照合はネットワーク接続可能な環境で実行すること。',
    };
  }

  const verified = [];
  const unresolved = [];
  const detailsBudget = { remaining: MAX_DETAILS_TOTAL };

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (i > 0 && i % batchSize === 0) {
      await sleepImpl(windowMs + WINDOW_PAD_MS);
    }

    const search = await searchCandidate(client, candidate, sleepImpl, windowMs);
    if (!search.ok) {
      unresolved.push({
        facilityId: candidate.facilityId,
        name: candidate.name,
        matchConfidence: 'UNRESOLVED',
        reason: 'Places API 呼び出し失敗: ' + search.reason,
      });
      continue;
    }

    // Mission 36H の判定器をそのまま使う。DEFAULT_MAX_DISTANCE_METERS (=120m) を明示し、
    // 36I側で閾値を緩めない。
    let match = classifyPilotMatch(candidate, search.places, {
      maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS,
    });

    if (match.matchConfidence === 'AMBIGUOUS' && match.needsDetailsFor?.length) {
      const { detailsByPlaceId, failures } = await fetchIdentities(
        client, match.needsDetailsFor, detailsBudget, sleepImpl, windowMs);
      if (Object.keys(detailsByPlaceId).length) {
        match = classifyPilotMatch(candidate, search.places, {
          maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS,
          detailsByPlaceId,
        });
      }
      if (match.matchConfidence !== 'VERIFIED' && failures.length) {
        match = { ...match, reason: match.reason + '（Details取得失敗: ' + failures.join('; ') + '）' };
      }
    }

    if (match.matchConfidence === 'VERIFIED') {
      verified.push(assertDurableRecordSafe({
        facilityId: candidate.facilityId,
        googlePlaceId: match.googlePlaceId,
        name: candidate.name,
        relevanceClass: candidate.relevanceClass,
        matchConfidence: 'VERIFIED',
        matchReason: match.reason,
        distanceMeters: match.distanceMeters,
        verifiedAt: now().toISOString(),
        verifiedBy: 'automated-sumiyoshi-149-match',
      }));
    } else {
      unresolved.push({
        facilityId: candidate.facilityId,
        name: candidate.name,
        matchConfidence: match.matchConfidence,
        reason: match.reason,
      });
    }
  }

  const generatedAt = now().toISOString();
  const mapping = {
    version: 1,
    mission: '36I',
    areaId: dataset.areaId || 'osaka-sumiyoshi',
    sourceDataset: 'public/map-data/osaka-sumiyoshi/facilities/facilities.json',
    generatedAt,
    maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS,
    policy: {
      persistsOnlyVerifiedLinkage: true,
      neverPersists: ['photo binaries', 'photo media URLs', 'photo resource names'],
      resolvesPhotosAtDisplayTime: true,
      ambiguousMatchesAreNotPersisted: true,
    },
    counts: {
      verified: verified.length,
      unresolved: unresolved.length,
      total: candidates.length,
    },
    entries: verified,
  };

  if (!dryRun) {
    fs.mkdirSync(path.dirname(SUMIYOSHI_OUT_MAPPING), { recursive: true });
    fs.writeFileSync(SUMIYOSHI_OUT_MAPPING, JSON.stringify(mapping, null, 2), 'utf-8');

    fs.mkdirSync(SUMIYOSHI_REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SUMIYOSHI_REPORT_DIR, 'match-report.json'), JSON.stringify({
      mission: '36I',
      generatedAt,
      sourceCount: candidates.length,
      maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS,
      counts: mapping.counts,
      unresolved,
      apiUsage: client.getDebugCounters(),
    }, null, 2), 'utf-8');
  }

  return { ok: true, counts: mapping.counts, mapping, unresolved };
}

if (isMainModule(import.meta.url)) {
  runSumiyoshiMatch().then((result) => {
    if (!result.ok) {
      console.error('[google-places sumiyoshi-149]', result.message);
      process.exit(1);
    }
    console.log('[google-places sumiyoshi-149]', JSON.stringify(result.counts));
    process.exit(0);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
