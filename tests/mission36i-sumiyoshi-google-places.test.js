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

test('Mission 36I keeps the Google Places photo mapping on dev HTML only', () => {
  const dev = fs.readFileSync(new URL('../public/osaka_3d_buildings.ward-ux-v1.html', import.meta.url), 'utf-8');
  const prod = fs.readFileSync(new URL('../public/osaka_3d_buildings.html', import.meta.url), 'utf-8');
  const protectedHtml = fs.readFileSync(new URL('../public/osaka_3d_buildings.fullward-v3.html', import.meta.url), 'utf-8');

  assert.match(dev, /google-places-pilot-mapping\.json/,
    'dev HTML must keep reading the compatibility mapping that 36I replaces after a successful API run');
  assert.doesNotMatch(prod, /google-places-pilot-mapping\.json/,
    'production HTML must remain untouched by Mission 36I');
  assert.doesNotMatch(protectedHtml, /google-places-pilot-mapping\.json/,
    'protected fullward HTML must remain untouched by Mission 36I');

  const uiMapping = JSON.parse(fs.readFileSync(
    new URL('../public/map-data/osaka-city/derived/google-places-pilot-mapping.json', import.meta.url), 'utf-8'));
  assert.ok([30, 149].includes(uiMapping.counts?.total),
    'UI mapping must be either the preserved 30-item pilot or the completed 149-item Mission 36I mapping');
  assert.equal(uiMapping.entries.length, uiMapping.counts.verified,
    'UI mapping must contain VERIFIED linkage entries only');
});
