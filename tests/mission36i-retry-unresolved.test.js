import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeJapaneseVariantName,
  japaneseVariantEvidence,
  classifyConservativeJapaneseVariant,
} from '../tools/google-places/retry-sumiyoshi-unresolved.mjs';

test('Mission 36I retry normalizes only explicit Japanese display-name variants', () => {
  assert.equal(normalizeJapaneseVariantName('第２めぐむ保育園'), '第2めぐむ保育園');
  assert.equal(normalizeJapaneseVariantName('第二めぐむ保育園'), '第2めぐむ保育園');
  assert.equal(normalizeJapaneseVariantName('大阪府教育センター附属高等学校'), '教育センター附属高校');
  assert.equal(normalizeJapaneseVariantName('教育センター附属高校'), '教育センター附属高校');
  assert.equal(normalizeJapaneseVariantName('ヤスダ歯科クリニック'), 'やすだ歯科クリニック');
  assert.equal(normalizeJapaneseVariantName('医療法人豊永会 やすだ歯科クリニック'), 'やすだ歯科クリニック');
});

test('Mission 36I retry permits same-stem preschool rename but not arbitrary fuzzy names', () => {
  assert.deepEqual(japaneseVariantEvidence('あびこひかり保育園', 'あびこひかりこども園'),
    { ok: true, kind: 'preschool-type-rename' });
  assert.equal(japaneseVariantEvidence('ひまわり幼稚園', '全く別の保育園').ok, false);
});

test('Mission 36I retry variant requires Osaka, compatible type and strict distance', () => {
  const candidate = {
    facilityId: 'x',
    name: '第二めぐむ保育園',
    osmSubcategory: 'kindergarten',
    expectLat: 34.6000,
    expectLon: 135.5000,
  };

  // kindergarten is intentionally not in the Google type compatibility table, so no unsafe rescue.
  const noTypeEvidence = classifyConservativeJapaneseVariant(candidate, [{
    placeId: 'p1', displayName: '第２めぐむ保育園', lat: 34.6001, lon: 135.5000,
    formattedAddress: '大阪府大阪市', primaryType: 'preschool', types: ['preschool'],
  }]);
  assert.equal(noTypeEvidence.ok, false);

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
});
