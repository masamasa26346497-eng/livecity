import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  SUMIYOSHI_SOURCE,
  EXPECTED_SUMIYOSHI_FACILITY_COUNT,
  buildSumiyoshiCandidates,
  relevanceClassForFacility,
} from '../tools/google-places/match-sumiyoshi-places.mjs';
import {
  classifyPilotMatch,
  DEFAULT_MAX_DISTANCE_METERS,
} from '../tools/google-places/lib/pilot-matching.mjs';

test('Mission 36I reads the canonical 149-facility Sumiyoshi dataset without a second candidate list', () => {
  const dataset = JSON.parse(fs.readFileSync(SUMIYOSHI_SOURCE, 'utf-8'));
  const candidates = buildSumiyoshiCandidates(dataset);

  assert.equal(EXPECTED_SUMIYOSHI_FACILITY_COUNT, 149);
  assert.equal(dataset.recordCount, 149);
  assert.equal(candidates.length, 149);
  assert.equal(new Set(candidates.map((c) => c.facilityId)).size, 149);
  assert.ok(candidates.every((c) => c.facilityId && c.name));
  assert.ok(candidates.every((c) => Number.isFinite(c.expectLat) && Number.isFinite(c.expectLon)));

  const tamade = candidates.find((c) => c.facilityId === 'osm-node-750515219');
  assert.ok(tamade, 'known facility スーパー玉出 アビコ店 must remain in the 149 set');
  assert.equal(tamade.name, 'スーパー玉出 アビコ店');
  assert.equal(tamade.osmSubcategory, 'supermarket');
  assert.equal(tamade.relevanceClass, 'retail-commercial');
});

test('Mission 36I keeps the Mission 36H 120m matching ceiling unchanged', () => {
  assert.equal(DEFAULT_MAX_DISTANCE_METERS, 120);

  const candidate = {
    facilityId: 'test-facility',
    name: 'テスト施設',
    osmSubcategory: 'hospital',
    expectLat: 34.600000,
    expectLon: 135.500000,
  };

  const inside = classifyPilotMatch(candidate, [{
    placeId: 'inside120m',
    displayName: 'テスト施設',
    lat: 34.600500,
    lon: 135.500000,
    primaryType: 'hospital',
    types: ['hospital'],
    formattedAddress: '大阪府大阪市',
  }]);
  assert.equal(inside.matchConfidence, 'VERIFIED');

  const outside = classifyPilotMatch(candidate, [{
    placeId: 'outside120m',
    displayName: 'テスト施設',
    lat: 34.601200,
    lon: 135.500000,
    primaryType: 'hospital',
    types: ['hospital'],
    formattedAddress: '大阪府大阪市',
  }]);
  assert.equal(outside.matchConfidence, 'UNRESOLVED');
  assert.equal(outside.googlePlaceId, null);
  assert.match(outside.reason, /120m/);
});

test('Mission 36I derives relevance metadata only; matching still uses original OSM subcategory', () => {
  assert.equal(relevanceClassForFacility({ category: 'medical' }), 'hospital');
  assert.equal(relevanceClassForFacility({ category: 'education' }), 'school');
  assert.equal(relevanceClassForFacility({ category: 'transport' }), 'station');
  assert.equal(relevanceClassForFacility({ category: 'public' }), 'public-facility');
  assert.equal(relevanceClassForFacility({ category: 'shopping' }), 'retail-commercial');
  assert.equal(relevanceClassForFacility({ category: 'park' }), 'park');
});
