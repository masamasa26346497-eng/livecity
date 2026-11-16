import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuildingGooglePlaceIndex } from '../tools/photos/build-building-google-place-index.mjs';

const buildingDoc = { buildings: [
  { buildingId: 'cg_test1', source: 'osm', sourceId: 'way/123', buildingName: 'A' },
  { buildingId: 'cg_test2', source: 'osm', sourceId: 'way/456', buildingName: 'B' },
] };
const entry = (facilityId, googlePlaceId) => ({ facilityId, googlePlaceId, matchConfidence: 'VERIFIED' });

test('verified exact OSM source links without media persistence', () => {
  const doc = buildBuildingGooglePlaceIndex(buildingDoc, { entries: [entry('osm-way-123', 'place-1')] }, { generatedAt: '2026-10-10T00:00:00Z' });
  assert.equal(doc.counts.linkedBuildings, 1);
  assert.equal(doc.byBuildingId.cg_test1.googlePlaceId, 'place-1');
  assert.equal(doc.byBuildingId.cg_test2, undefined);
  assert.equal(JSON.stringify(doc).includes('photoUri'), false);
});
test('conflicting IDs remain quarantined even if a later entry repeats first ID', () => {
  const doc = buildBuildingGooglePlaceIndex(buildingDoc, { entries: [
    entry('osm-way-123', 'place-1'), entry('osm-way-123', 'place-2'), entry('osm-way-123', 'place-1'),
  ] });
  assert.equal(doc.counts.linkedBuildings, 0);
  assert.equal(doc.counts.exactSourceWithoutVerifiedPlace, 2);
});
test('unverified places are never attached', () => {
  const doc = buildBuildingGooglePlaceIndex(buildingDoc, { entries: [{ ...entry('osm-way-123', 'place-1'), matchConfidence: 'AMBIGUOUS' }] });
  assert.equal(doc.counts.linkedBuildings, 0);
});
