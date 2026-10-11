import test from 'node:test';
import assert from 'node:assert/strict';
import {
  facilityIdFromOsmSourceId,
  buildBuildingGooglePlaceIndex,
} from '../tools/photos/build-building-google-place-index.mjs';

function places(entries) {
  return { entries };
}

function verified(facilityId, googlePlaceId, name = null) {
  return {
    facilityId,
    googlePlaceId,
    name,
    matchConfidence: 'VERIFIED',
    verifiedAt: '2026-10-05T00:00:00.000Z',
  };
}

test('Mission 36L converts exact OSM node/way/relation source IDs deterministically', () => {
  assert.equal(facilityIdFromOsmSourceId('node/123'), 'osm-node-123');
  assert.equal(facilityIdFromOsmSourceId('way/456'), 'osm-way-456');
  assert.equal(facilityIdFromOsmSourceId('relation/789'), 'osm-relation-789');
  assert.equal(facilityIdFromOsmSourceId('way/not-a-number'), null);
  assert.equal(facilityIdFromOsmSourceId(''), null);
});

test('Mission 36L links a canonical building only through an exact VERIFIED OSM source chain', () => {
  const doc = buildBuildingGooglePlaceIndex({
    buildings: [{
      buildingId: 'gml:A',
      buildingName: 'Building A',
      source: 'osm',
      sourceId: 'way/100',
      matchMethod: 'building-way-name',
      confidence: 'high',
      facilities: [],
    }],
  }, places([
    verified('osm-way-100', 'place-A', 'Building A'),
    { facilityId: 'osm-way-999', googlePlaceId: 'place-unsafe', matchConfidence: 'AMBIGUOUS' },
  ]), { generatedAt: '2026-10-05T00:00:00.000Z' });

  assert.equal(doc.counts.linkedBuildings, 1);
  assert.equal(doc.records[0].buildingId, 'gml:A');
  assert.equal(doc.records[0].facilityId, 'osm-way-100');
  assert.equal(doc.records[0].googlePlaceId, 'place-A');
  assert.equal(doc.records[0].placeMatchConfidence, 'VERIFIED');
  assert.equal(doc.records[0].linkMethod, 'exact-osm-source-id-chain');
});

test('Mission 36L rejects non-VERIFIED Google mappings', () => {
  const doc = buildBuildingGooglePlaceIndex({
    buildings: [{
      buildingId: 'gml:B',
      source: 'osm',
      sourceId: 'way/200',
      facilities: [],
    }],
  }, places([
    { facilityId: 'osm-way-200', googlePlaceId: 'place-B', matchConfidence: 'AMBIGUOUS' },
  ]));

  assert.equal(doc.counts.linkedBuildings, 0);
  assert.equal(doc.counts.exactSourceWithoutVerifiedPlace, 1);
});

test('Mission 36L skips a building when exact source evidence resolves to multiple Google Places', () => {
  const doc = buildBuildingGooglePlaceIndex({
    buildings: [{
      buildingId: 'gml:C',
      buildingName: 'Building C',
      primaryFacilityName: 'Whole Building Facility',
      source: 'osm',
      sourceId: 'way/300',
      facilities: [{
        name: 'Whole Building Facility',
        source: 'osm',
        sourceId: 'node/301',
      }],
    }],
  }, places([
    verified('osm-way-300', 'place-C-building'),
    verified('osm-node-301', 'place-C-facility'),
  ]));

  assert.equal(doc.counts.linkedBuildings, 0);
  assert.equal(doc.counts.rejectedAmbiguous, 1);
  assert.deepEqual(doc.rejectedAmbiguous[0].googlePlaceIds.sort(), ['place-C-building', 'place-C-facility'].sort());
});

test('Mission 36L deduplicates two exact source paths when both identify the same Google Place', () => {
  const doc = buildBuildingGooglePlaceIndex({
    buildings: [{
      buildingId: 'gml:D',
      primaryFacilityName: 'Building D',
      source: 'osm',
      sourceId: 'relation/400',
      facilities: [{
        name: 'Building D',
        source: 'osm',
        sourceId: 'node/401',
      }],
    }],
  }, places([
    verified('osm-relation-400', 'place-D'),
    verified('osm-node-401', 'place-D'),
  ]));

  assert.equal(doc.counts.linkedBuildings, 1);
  assert.equal(doc.records[0].googlePlaceId, 'place-D');
});

test('Mission 36L durable output never persists Google photo media URLs or resource names', () => {
  const doc = buildBuildingGooglePlaceIndex({
    buildings: [{
      buildingId: 'gml:E',
      source: 'osm',
      sourceId: 'way/500',
      facilities: [],
    }],
  }, places([verified('osm-way-500', 'place-E')]));

  const serialized = JSON.stringify(doc).toLowerCase();
  assert.equal(doc.policy.persistsPhotoMedia, false);
  assert.equal(doc.policy.resolvesPhotosAtDisplayTime, true);
  assert.doesNotMatch(serialized, /photourl|mediaurl|resourcename|places\.googleapis\.com\/v1\/|\/media/);
});
