import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  normalizeJapaneseVariantName,
  japaneseVariantEvidence,
  classifyConservativeJapaneseVariant,
  retrySumiyoshiUnresolved,
} from '../tools/google-places/retry-sumiyoshi-unresolved.mjs';

test('Mission 36I retry normalizes only explicit Japanese display-name variants', () => {
  assert.equal(normalizeJapaneseVariantName('第２めぐむ保育園'), '第2めぐむ保育園');
  assert.equal(normalizeJapaneseVariantName('第二めぐむ保育園'), '第2めぐむ保育園');
  assert.equal(normalizeJapaneseVariantName('大阪府教育センター附属高等学校'), '教育せんたー附属高校');
  assert.equal(normalizeJapaneseVariantName('教育センター附属高校'), '教育せんたー附属高校');
  assert.equal(normalizeJapaneseVariantName('ヤスダ歯科クリニック'), 'やすだ歯科くりにっく');
  assert.equal(normalizeJapaneseVariantName('医療法人豊永会 やすだ歯科クリニック'), 'やすだ歯科くりにっく');
});

test('Mission 36I retry permits same-stem preschool rename but not arbitrary fuzzy names', () => {
  assert.deepEqual(japaneseVariantEvidence('あびこひかり保育園', 'あびこひかりこども園'),
    { ok: true, kind: 'preschool-type-rename' });
  assert.equal(japaneseVariantEvidence('ひまわり幼稚園', '全く別の保育園').ok, false);
});

test('Mission 36I retry variant requires Osaka, compatible type and strict distance', () => {
  const candidate = {
    facilityId: 'x',
    name: 'あびこひかり保育園',
    osmSubcategory: 'kindergarten',
    expectLat: 34.6000,
    expectLon: 135.5000,
  };

  const preschoolRename = classifyConservativeJapaneseVariant(candidate, [{
    placeId: 'p1', displayName: 'あびこひかりこども園', lat: 34.60001, lon: 135.5000,
    formattedAddress: '大阪府大阪市', primaryType: 'preschool', types: ['preschool'],
  }]);
  assert.equal(preschoolRename.ok, true);
  assert.equal(preschoolRename.googlePlaceId, 'p1');

  const schoolCandidate = { ...candidate, name: '教育センター附属高校', osmSubcategory: 'school' };
  const ok = classifyConservativeJapaneseVariant(schoolCandidate, [{
    placeId: 'p2', displayName: '大阪府教育センター附属高等学校', lat: 34.6001, lon: 135.5000,
    formattedAddress: '大阪府大阪市', primaryType: 'high_school', types: ['high_school'],
  }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.googlePlaceId, 'p2');

  const tooFar = classifyConservativeJapaneseVariant(schoolCandidate, [{
    placeId: 'p3', displayName: '大阪府教育センター附属高等学校', lat: 34.6010, lon: 135.5000,
    formattedAddress: '大阪府大阪市', primaryType: 'high_school', types: ['high_school'],
  }]);
  assert.equal(tooFar.ok, false);

  const outsideOsaka = classifyConservativeJapaneseVariant(schoolCandidate, [{
    placeId: 'p4', displayName: '大阪府教育センター附属高等学校', lat: 34.6001, lon: 135.5000,
    formattedAddress: '兵庫県神戸市', primaryType: 'high_school', types: ['high_school'],
  }]);
  assert.equal(outsideOsaka.ok, false);
});

test('Mission 36I retry preserves every current VERIFIED entry and retries only the remainder', async () => {
  const currentMapping = JSON.parse(fs.readFileSync(
    new URL('../public/map-data/osaka-city/derived/google-places-sumiyoshi-mapping.json', import.meta.url), 'utf8'));
  const currentVerified = currentMapping.entries.filter((entry) => entry.matchConfidence === 'VERIFIED').length;
  const expectedRetried = 149 - currentVerified;

  let searchCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes(':searchText')) {
      searchCalls++;
      return { ok: true, json: async () => ({ places: [] }) };
    }
    throw new Error('unexpected URL in offline retry test: ' + url);
  };

  const result = await retrySumiyoshiUnresolved({
    apiKey: 'FAKE_KEY',
    fetchImpl,
    dryRun: true,
    rateGuard: { maxRequestsPerWindow: 1000, maxRequestsPerSession: 1000, windowMs: 1 },
    sleepImpl: async () => {},
    now: () => new Date('2026-09-30T00:00:00.000Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.previousVerified, currentVerified);
  assert.equal(result.retried, expectedRetried);
  assert.equal(searchCalls, expectedRetried);
  assert.equal(result.counts.verified, currentVerified);
  assert.equal(result.counts.unresolved, expectedRetried);
  assert.equal(result.counts.total, 149);
  assert.equal(result.mapping.entries.length, currentVerified);
});
