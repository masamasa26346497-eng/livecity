import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  selectorToOverpass,
  buildCompactOverpassSelectors,
  buildPhotoFacilityTileQuery,
  mergeOsmElements,
  buildFacilityConfig,
  classifyFacilityRecordsToWards,
} from '../tools/facilities/osaka-city-photo-facilities.mjs';
import {
  buildCityCandidates,
  priorityRank,
  resolveWardFilter,
  selectBatchCandidates,
} from '../tools/google-places/match-osaka-city-places.mjs';
import { DEFAULT_MAX_DISTANCE_METERS, classifyPilotMatch } from '../tools/google-places/lib/pilot-matching.mjs';
import { typesCompatible } from '../tools/google-places/lib/cross-language-name.mjs';

const rj = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/^﻿/, ''));
const registry = rj('../config/wards/registry.json');
const profile = rj('../config/facilities/osaka-city-photo-profile.json');
const baseCategories = rj('../config/facilities/categories.json');
const wardPolygons = rj('../public/map-data/osaka-city/boundaries/ward-classification-polygons.json');

test('Mission 36J targets exactly all 24 Osaka wards', () => {
  assert.equal(registry.wards.length, 24);
  assert.equal(new Set(registry.wards.map((w) => w.id)).size, 24);
  assert.ok(registry.wards.some((w) => w.id === 'kita'));
  assert.ok(registry.wards.some((w) => w.id === 'sumiyoshi'));
  assert.ok(registry.wards.some((w) => w.id === 'nishinari'));
  assert.equal(wardPolygons.wards.length, 24);
});

test('Mission 36J citywide source is tiled and uses compact nwr selectors for broad photo-worthy categories', () => {
  assert.equal(profile.tileSizeMeters, 2000);
  for (const selector of ['shop', 'tourism', 'leisure', 'amenity=restaurant', 'amenity=cafe',
    'amenity=hospital', 'amenity=school', 'railway=station']) {
    assert.ok(profile.osmFilters.includes(selector), selector + ' must be covered');
  }
  assert.equal(selectorToOverpass('shop'), '["shop"]');
  assert.equal(selectorToOverpass('amenity=restaurant'), '["amenity"="restaurant"]');

  const compact = buildCompactOverpassSelectors(profile.osmFilters);
  assert.ok(compact.includes('["shop"]'));
  assert.ok(compact.includes('["tourism"]'));
  assert.ok(compact.some((f) => f.startsWith('["amenity"~') && f.includes('restaurant') && f.includes('school')));
  assert.ok(compact.length < 20, `compact selector count should stay small, got ${compact.length}`);

  const q = buildPhotoFacilityTileQuery({ south: 34.6, west: 135.4, north: 34.61, east: 135.41 }, profile);
  assert.match(q, /nwr\["shop"\]/);
  assert.match(q, /nwr\["tourism"\]/);
  assert.match(q, /nwr\["amenity"~/);
  assert.match(q, /restaurant/);
  assert.match(q, /out center;/);
  assert.doesNotMatch(q, /\n\s*(?:node|way|relation)\[/, 'query must not expand every filter three times');
});

test('Mission 36J compact selector keeps wildcard semantics and suppresses redundant same-key exact selectors', () => {
  const compact = buildCompactOverpassSelectors([
    'shop', 'shop=supermarket', 'shop=convenience',
    'amenity=restaurant', 'amenity=cafe', 'office=government',
  ]);
  assert.deepEqual(compact, [
    '["shop"]',
    '["amenity"~"^(restaurant|cafe)$"]',
    '["office"="government"]',
  ]);
});

test('Mission 36J tile overlap is de-duplicated by OSM type/id deterministically', () => {
  const merged = mergeOsmElements([
    { elements: [{ type: 'node', id: 2, tags: { name: 'B' } }, { type: 'node', id: 1, tags: { name: 'A' } }] },
    { elements: [{ type: 'node', id: 2, tags: { name: 'B duplicate tile' } }, { type: 'way', id: 2, tags: { name: 'Way' } }] },
  ]);
  assert.deepEqual(merged.map((e) => `${e.type}/${e.id}`), ['node/1', 'node/2', 'way/2']);
  assert.equal(merged[1].tags.name, 'B');
});

test('Mission 36J overlays dining/lodging/shop wildcard rules after existing exact rules', () => {
  const cfg = buildFacilityConfig(baseCategories, profile);
  assert.ok(cfg.rules.some((r) => r.category === 'dining' && r.subcategory === 'restaurant'));
  assert.ok(cfg.rules.some((r) => r.category === 'lodging' && r.subcategory === 'hotel'));
  assert.ok(cfg.rules.some((r) => r.tag === 'shop' && r.value === '*' && r.subcategory === 'shop_other'));
  const supermarketIndex = cfg.rules.findIndex((r) => r.tag === 'shop' && r.value === 'supermarket');
  const wildcardIndex = cfg.rules.findIndex((r) => r.tag === 'shop' && r.value === '*');
  assert.ok(supermarketIndex >= 0 && wildcardIndex > supermarketIndex, 'specific shop rule must win before wildcard');
});

test('Mission 36J official polygons classify known Sumiyoshi runtime point into Sumiyoshi ward', () => {
  const sample = [{
    id: 'osm-node-750515219', name: 'スーパー玉出 アビコ店',
    localX: -1591.3, localZ: 373.31,
  }];
  const result = classifyFacilityRecordsToWards(sample, wardPolygons);
  assert.equal(result.inside.length, 1);
  assert.equal(result.inside[0].wardId, 'sumiyoshi');
  assert.equal(result.outside.length, 0);
  assert.equal(result.ambiguous.length, 0);
});

test('Mission 36J keeps the hard Google Places ceiling at 120m', () => {
  assert.equal(DEFAULT_MAX_DISTANCE_METERS, 120);
  const c = { facilityId: 'x', name: 'テスト店', expectLat: 34.6, expectLon: 135.5, osmSubcategory: 'restaurant' };
  const far = classifyPilotMatch(c, [{
    placeId: 'far', displayName: 'テスト店', lat: 34.6012, lon: 135.5,
    formattedAddress: '大阪府大阪市', primaryType: 'restaurant', types: ['restaurant'],
  }], { maxDistanceMeters: DEFAULT_MAX_DISTANCE_METERS });
  assert.equal(far.matchConfidence, 'UNRESOLVED');
  assert.equal(far.googlePlaceId, null);
});

test('Mission 36J extends type evidence for dense city dining/lodging while never verifying on type alone', () => {
  assert.equal(typesCompatible('restaurant', { primaryType: 'restaurant', types: ['restaurant'] }), true);
  assert.equal(typesCompatible('hotel', { primaryType: 'hotel', types: ['hotel'] }), true);
  assert.equal(typesCompatible('shop_other', { primaryType: 'store', types: ['store'] }), true);
  assert.equal(typesCompatible('restaurant', { primaryType: 'hotel', types: ['hotel'] }), false);
});

test('Mission 36J candidate selection resumes safely and supports ward/priority/limit filters', () => {
  const synthetic = {
    records: [
      { id: 'a', name: 'A restaurant', wardId: 'kita', wardName: '北区', category: 'dining', subcategory: 'restaurant', latitude: 34.7, longitude: 135.5 },
      { id: 'b', name: 'B school', wardId: 'kita', wardName: '北区', category: 'education', subcategory: 'school', latitude: 34.7, longitude: 135.5 },
      { id: 'c', name: 'C bus', wardId: 'sumiyoshi', wardName: '住吉区', category: 'transport', subcategory: 'bus_stop', latitude: 34.6, longitude: 135.5 },
      { id: 'd', name: 'D hotel', wardId: 'sumiyoshi', wardName: '住吉区', category: 'lodging', subcategory: 'hotel', latitude: 34.6, longitude: 135.5 },
    ],
  };
  const candidates = buildCityCandidates(synthetic);
  assert.equal(priorityRank(candidates[0], profile), 0);
  assert.equal(priorityRank(candidates[1], profile), 1);
  assert.equal(priorityRank(candidates[2], profile), 3);
  assert.equal(resolveWardFilter('北区', registry), 'kita');
  assert.equal(resolveWardFilter('sumiyoshi', registry), 'sumiyoshi');

  const selected = selectBatchCandidates(candidates, {
    existingVerifiedIds: new Set(['a']),
    attemptedIds: new Set(['b']),
    retryUnresolved: false,
    wardId: null,
    maxPriority: 3,
    limit: 10,
    profile,
    wardOrder: registry.wards.map((w) => w.id),
  });
  assert.deepEqual(selected.map((c) => c.facilityId), ['d', 'c']);

  const highSumiyoshi = selectBatchCandidates(candidates, {
    existingVerifiedIds: new Set(), attemptedIds: new Set(), wardId: 'sumiyoshi',
    maxPriority: 0, limit: 1, profile, wardOrder: registry.wards.map((w) => w.id),
  });
  assert.deepEqual(highSumiyoshi.map((c) => c.facilityId), ['d']);
});

test('Mission 36J does not leak citywide Google Places wiring into production/protected HTML', () => {
  const prod = fs.readFileSync(new URL('../public/osaka_3d_buildings.html', import.meta.url), 'utf8');
  const protectedHtml = fs.readFileSync(new URL('../public/osaka_3d_buildings.fullward-v3.html', import.meta.url), 'utf8');
  for (const html of [prod, protectedHtml]) {
    assert.doesNotMatch(html, /google-places-osaka-city-mapping\.json/);
    assert.doesNotMatch(html, /match-osaka-city-places/);
  }
});
