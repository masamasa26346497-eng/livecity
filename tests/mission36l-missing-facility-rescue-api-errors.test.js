import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMissingFacilityCandidates, pruneApiErrorAttempts, isApiErrorAttempt, runChunks,
} from '../tools/google-places/rescue-mission36l-missing-facility-records.mjs';
import { classifyPilotMatch } from '../tools/google-places/lib/pilot-matching.mjs';

const gap = (n, name = `建物${n}`) => ({ facilityId: `osm-way-${n}`, sourceId: `way/${n}`, buildingNames: [name], wardIds: [] });
const gaps = { candidates: [gap(1), gap(2), gap(3)] };
const none = { records: [] };
const noMapping = { entries: [] };

test('attempts recorded from Places API errors are pruned and become candidates again', () => {
  const progress = { attempts: [
    { facilityId: 'osm-way-1', matchConfidence: 'UNRESOLVED', reason: 'Places API: http-429' },
    { facilityId: 'osm-way-2', matchConfidence: 'UNRESOLVED', reason: 'Places API: http-403' },
    { facilityId: 'osm-way-3', matchConfidence: 'UNRESOLVED', reason: 'Google Places 側に候補が無い' },
  ] };
  assert.equal(buildMissingFacilityCandidates(gaps, none, noMapping, progress).length, 0);
  assert.equal(pruneApiErrorAttempts(progress), 2);
  assert.ok(!progress.attempts.some(isApiErrorAttempt));
  const ids = buildMissingFacilityCandidates(gaps, none, noMapping, progress).map((c) => c.gap.facilityId);
  assert.deepEqual(ids, ['osm-way-1', 'osm-way-2']);
});

test('genuinely evaluated UNRESOLVED/AMBIGUOUS attempts stay consumed', () => {
  const progress = { attempts: [
    { facilityId: 'osm-way-1', matchConfidence: 'UNRESOLVED', reason: 'Google Places 側に候補が無い' },
    { facilityId: 'osm-way-2', matchConfidence: 'AMBIGUOUS', reason: '座標は近い(5m)が名前が一致しない: "x"' },
  ] };
  assert.equal(pruneApiErrorAttempts(progress), 0);
  assert.equal(buildMissingFacilityCandidates(gaps, none, noMapping, progress).length, 1);
});

test('classifier returns no distance for an empty result (not a fabricated VERIFIED) and never relaxes 120m', () => {
  const cand = { facilityId: 'f', name: 'ホテルファインガーデン', expectLat: 34.7, expectLon: 135.5 };
  const empty = classifyPilotMatch(cand, [], { maxDistanceMeters: 120 });
  assert.equal(empty.matchConfidence, 'UNRESOLVED');
  assert.equal(empty.distanceMeters, null);
  const far = classifyPilotMatch(cand, [{ placeId: 'p', displayName: 'ホテルファインガーデン', lat: 34.7 + 0.002, lon: 135.5 }], { maxDistanceMeters: 120 });
  assert.equal(far.matchConfidence, 'UNRESOLVED');
  assert.ok(far.distanceMeters > 120);
});

test('runChunks stops with a warning on Places API error and reports it', async () => {
  const logs = [];
  let calls = 0;
  const runBatch = async () => { calls++; return calls === 1
    ? { processed: 20, verifiedThisBatch: 1, remainingMissingActionable: 100 }
    : { processed: 3, notEvaluated: 1, apiError: 'Places API: http-429', verifiedThisBatch: 0, remainingMissingActionable: 97 }; };
  const s = await runChunks({ chunks: 10 }, { runBatch, sleepImpl: async () => {}, log: (...a) => logs.push(a.join(' ')) });
  assert.equal(calls, 2);
  assert.equal(s.processed, 23);
  assert.match(s.stoppedEarly, /http-429/);
  assert.ok(logs.some((l) => l.startsWith('::warning::')));
});
