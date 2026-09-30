// Mission 36I follow-up: retry only facilities that are not already VERIFIED.
// Keeps the existing verified mapping, reuses the 120m hard ceiling, and adds a narrowly-scoped
// Japanese-name variant fallback for cases where Google and OSM use slightly different labels.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { createPlacesClient } from './lib/places-client.mjs';
import { RateLimitExceededError } from './lib/rate-guard.mjs';
import { classifyPilotMatch, haversineMeters, DEFAULT_MAX_DISTANCE_METERS } from './lib/pilot-matching.mjs';
import { typesCompatible } from './lib/cross-language-name.mjs';
import { assertDurableRecordSafe } from './lib/persistence-guard.mjs';
import { loadGooglePlacesApiKeyFromEnv } from './load-api-key.mjs';
import {
  SUMIYOSHI_SOURCE,
  SUMIYOSHI_OUT_MAPPING,
  SUMIYOSHI_UI_MAPPING,
  SUMIYOSHI_REPORT_DIR,
  buildSumiyoshiCandidates,
} from './match-sumiyoshi-places.mjs';

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_WINDOW_MS = 60_000;
const WINDOW_PAD_MS = 1_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_DETAILS_PER_CANDIDATE = 5;
const MAX_DETAILS_TOTAL = 30;
const VARIANT_MAX_DISTANCE_METERS = 60;
const CANONICAL_EXACT_MAX_DISTANCE_METERS = 80;
const PRESCHOOL_VARIANT_MAX_DISTANCE_METERS = 20;
const KNOWN_BRAND_ALIAS_MAX_DISTANCE_METERS = 20;
const OSAKA_RE = /osaka|大阪/i;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function katakanaToHiragana(s) {
  return s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

const ORDINALS = Object.freeze([
  ['第十', '第10'], ['第九', '第9'], ['第八', '第8'], ['第七', '第7'], ['第六', '第6'],
  ['第五', '第5'], ['第四', '第4'], ['第三', '第3'], ['第二', '第2'], ['第一', '第1'],
]);

/**
 * Narrow Japanese display-name canonicalization for Mission 36I retry.
 * This intentionally does not do fuzzy edit-distance matching.
 */
export function normalizeJapaneseVariantName(name) {
  let s = String(name || '').normalize('NFKC').trim().toLowerCase();
  // Google sometimes appends a non-identity note such as "(有料)" or a school composition note.
  s = s.replace(/[（(][^）)]{1,80}[）)]\s*$/u, '');
  s = katakanaToHiragana(s);

  // Legal operator prefix: only strip when the legal-form marker is explicit.
  s = s.replace(/^(?:医療法人|社会福祉法人|学校法人)(?:[一-龯ぁ-んァ-ヶa-z0-9]{1,12}会)?/u, '');

  // Administrative prefixes do not identify the physical facility by themselves.
  for (const prefix of ['大阪市消防局', '大阪市立', '大阪府立', '大阪市', '大阪府', '市立', '府立']) {
    if (s.startsWith(prefix) && s.length > prefix.length) s = s.slice(prefix.length);
  }

  for (const [from, to] of ORDINALS) s = s.split(from).join(to);
  s = s.replace(/高等学校/g, '高校');
  s = s.replace(/我孫子/g, 'あびこ');

  // Mission 36I: explicit, observed historical/display-name variants only.
  // Do not generalize these into fuzzy matching.
  if (s === '天宗学園瓜破園') s = '天宗瓜破園';
  if (s === '南住吉大空小学校') s = '大空小学校';

  s = s.replace(/[\s　・･!！?？,，.。'’"“”「」【】]/g, '');
  return s;
}

export function japaneseVariantEvidence(a, b) {
  const na = normalizeJapaneseVariantName(a);
  const nb = normalizeJapaneseVariantName(b);
  if (!na || !nb) return { ok: false, kind: null };
  if (na === nb) return { ok: true, kind: 'canonical-exact' };

  // A preschool may be renamed from 保育園 to こども園 while staying at the same physical site.
  // Require the same sufficiently-specific stem; the caller additionally requires <=20m, Osaka and type compatibility.
  const preschool = /^(.*?)(保育園|こども園|幼稚園)$/u;
  const ma = na.match(preschool);
  const mb = nb.match(preschool);
  if (ma && mb && ma[1].length >= 4 && ma[1] === mb[1]) {
    return { ok: true, kind: 'preschool-type-rename' };
  }

  // Explicit convenience-store abbreviation observed in OSM. Require a very short distance in the caller.
  const famima = (na === 'ふぁみま' && nb.startsWith('ふぁみりーまーと'))
    || (nb === 'ふぁみま' && na.startsWith('ふぁみりーまーと'));
  if (famima) return { ok: true, kind: 'known-brand-alias' };

  return { ok: false, kind: null };
}

function distanceLimitForEvidence(kind, maxDistanceMeters) {
  if (kind === 'canonical-exact') {
    return Math.min(maxDistanceMeters, CANONICAL_EXACT_MAX_DISTANCE_METERS);
  }
  if (kind === 'preschool-type-rename') {
    return Math.min(maxDistanceMeters, PRESCHOOL_VARIANT_MAX_DISTANCE_METERS);
  }
  if (kind === 'known-brand-alias') {
    return Math.min(maxDistanceMeters, KNOWN_BRAND_ALIAS_MAX_DISTANCE_METERS);
  }
  return Math.min(maxDistanceMeters, VARIANT_MAX_DISTANCE_METERS);
}

/**
 * Conservative fallback after the Mission 36H classifier remains unresolved/ambiguous.
 * Never widens the 120m ceiling. Canonical exact variants may use <=80m; rename/brand aliases are much tighter.
 */
export function classifyConservativeJapaneseVariant(candidate, places, maxDistanceMeters = DEFAULT_MAX_DISTANCE_METERS) {
  if (!Array.isArray(places) || !places.length) return { ok: false };
  const evaluated = places.map((p) => ({
    ...p,
    distanceMeters: haversineMeters(candidate.expectLat, candidate.expectLon, p.lat, p.lon),
    evidence: japaneseVariantEvidence(candidate.name, p.displayName),
  })).filter((p) => Number.isFinite(p.distanceMeters)
    && p.evidence.ok
    && p.distanceMeters <= distanceLimitForEvidence(p.evidence.kind, maxDistanceMeters)
    && !!p.formattedAddress
    && OSAKA_RE.test(p.formattedAddress)
    && typesCompatible(candidate.osmSubcategory, p));

  if (evaluated.length !== 1) return { ok: false, candidateCount: evaluated.length };
  const p = evaluated[0];
  return {
    ok: true,
    googlePlaceId: p.placeId,
    distanceMeters: Math.round(p.distanceMeters),
    reason: 'Mission 36I retry: 日本語表記差(' + p.evidence.kind + ')・タイプ互換・所在地(大阪)・座標('
      + Math.round(p.distanceMeters) + 'm)が一意 [conservative-variant]',
  };
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

async function fetchIdentities(client, placeIds, budget, sleepImpl, windowMs) {
  const detailsByPlaceId = {};
  const failures = [];
  for (const id of placeIds.slice(0, MAX_DETAILS_PER_CANDIDATE)) {
    if (budget.remaining <= 0) { failures.push(id + ': Details全体上限に到達'); continue; }
    budget.remaining--;
    const r = await withRateLimitRetry(() => client.getPlaceIdentity(id), sleepImpl, windowMs);
    if (r.ok && r.place) detailsByPlaceId[id] = r.place;
    else failures.push(id + ': ' + r.reason);
  }
  return { detailsByPlaceId, failures };
}

export async function retrySumiyoshiUnresolved({
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
  const allCandidates = buildSumiyoshiCandidates(dataset);
  const current = JSON.parse(fs.readFileSync(SUMIYOSHI_OUT_MAPPING, 'utf-8'));
  const currentEntries = Array.isArray(current.entries) ? current.entries.map(assertDurableRecordSafe) : [];
  const validIds = new Set(allCandidates.map((c) => c.facilityId));
  const existingVerified = currentEntries.filter((e) => e.matchConfidence === 'VERIFIED' && validIds.has(e.facilityId));
  const existingIds = new Set(existingVerified.map((e) => e.facilityId));
  const candidates = allCandidates.filter((c) => !existingIds.has(c.facilityId));

  const client = createPlacesClient({ apiKey, fetchImpl, requestGuard, rateGuard });
  if (!client.isEnabled()) {
    return { ok: false, reason: 'no-api-key', message: 'GOOGLE_PLACES_API_KEY が未設定。' };
  }

  const verified = [...existingVerified];
  const unresolved = [];
  const detailsBudget = { remaining: MAX_DETAILS_TOTAL };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (i > 0 && i % batchSize === 0) await sleepImpl(windowMs + WINDOW_PAD_MS);

    const search = await withRateLimitRetry(() => client.searchText({
      textQuery: c.name, lat: c.expectLat, lon: c.expectLon,
    }), sleepImpl, windowMs);
    if (!search.ok) {
      unresolved.push({ facilityId: c.facilityId, name: c.name, matchConfidence: 'UNRESOLVED',
        reason: 'Places API 呼び出し失敗: ' + search.reason });
      continue;
    }

    let match = classifyPilotMatch(c, search.places, { maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS });
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
        match = { ...match, reason: match.reason + '（Details取得失敗: ' + failures.join('; ') + '）' };
      }
    }

    if (match.matchConfidence !== 'VERIFIED') {
      const variant = classifyConservativeJapaneseVariant(c, search.places, DEFAULT_MAX_DISTANCE_METERS);
      if (variant.ok) {
        match = { matchConfidence: 'VERIFIED', googlePlaceId: variant.googlePlaceId,
          distanceMeters: variant.distanceMeters, reason: variant.reason };
      }
    }

    if (match.matchConfidence === 'VERIFIED') {
      verified.push(assertDurableRecordSafe({
        facilityId: c.facilityId,
        googlePlaceId: match.googlePlaceId,
        name: c.name,
        relevanceClass: c.relevanceClass,
        matchConfidence: 'VERIFIED',
        matchReason: match.reason,
        distanceMeters: match.distanceMeters,
        verifiedAt: now().toISOString(),
        verifiedBy: 'automated-sumiyoshi-unresolved-retry',
      }));
    } else {
      unresolved.push({ facilityId: c.facilityId, name: c.name,
        matchConfidence: match.matchConfidence, reason: match.reason });
    }
  }

  const generatedAt = now().toISOString();
  const mapping = {
    ...current,
    version: 1,
    mission: '36I',
    generatedAt,
    maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS,
    counts: { verified: verified.length, unresolved: allCandidates.length - verified.length, total: allCandidates.length },
    entries: verified,
  };

  if (!dryRun) {
    const serialized = JSON.stringify(mapping, null, 2);
    fs.writeFileSync(SUMIYOSHI_OUT_MAPPING, serialized, 'utf-8');
    fs.writeFileSync(SUMIYOSHI_UI_MAPPING, serialized, 'utf-8');
    fs.mkdirSync(SUMIYOSHI_REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SUMIYOSHI_REPORT_DIR, 'retry-match-report.json'), JSON.stringify({
      mission: '36I-retry', generatedAt, previousVerified: existingVerified.length,
      retried: candidates.length, counts: mapping.counts, unresolved, apiUsage: client.getDebugCounters(),
    }, null, 2), 'utf-8');
  }

  return { ok: true, previousVerified: existingVerified.length, retried: candidates.length,
    counts: mapping.counts, unresolved, mapping };
}

if (isMainModule(import.meta.url)) {
  retrySumiyoshiUnresolved().then((r) => {
    if (!r.ok) { console.error('[google-places sumiyoshi-retry]', r.message); process.exit(1); }
    console.log('[google-places sumiyoshi-retry]', JSON.stringify({ previousVerified: r.previousVerified,
      retried: r.retried, ...r.counts }));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
