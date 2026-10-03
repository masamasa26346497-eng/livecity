// Mission 36L: building -> VERIFIED Google Place -> on-demand photo bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  facilityIdFromOsmSourceId,
  buildBuildingGooglePlaceIndex,
} from '../tools/photos/build-building-google-place-index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_JS = path.join(ROOT, 'public', 'livecity-building-photo-bridge.js');
const PREVIEW = path.join(ROOT, 'tools', 'preview.js');

test('[36L] OSM source identity -> facilityId conversion is exact', () => {
  assert.equal(facilityIdFromOsmSourceId('node/123'), 'osm-node-123');
  assert.equal(facilityIdFromOsmSourceId('way/456'), 'osm-way-456');
  assert.equal(facilityIdFromOsmSourceId('relation/789'), 'osm-relation-789');
  assert.equal(facilityIdFromOsmSourceId('x/1'), null);
  assert.equal(facilityIdFromOsmSourceId('node/not-number'), null);
});

test('[36L] exact OSM source chain + VERIFIED place is linked', () => {
  const buildings = {
    buildings: [{
      buildingId: 'b1', buildingName: 'Example Hospital', source: 'osm', sourceId: 'way/10',
      matchMethod: 'facility-polygon-overlap', confidence: 'high', facilities: [],
    }],
  };
  const places = {
    entries: [{
      facilityId: 'osm-way-10', googlePlaceId: 'ChIJ-verified', name: 'Example Hospital',
      matchConfidence: 'VERIFIED', verifiedAt: '2026-10-03T00:00:00Z',
    }],
  };
  const out = buildBuildingGooglePlaceIndex(buildings, places, { generatedAt: '2026-10-03T00:00:00Z' });
  assert.equal(out.counts.linkedBuildings, 1);
  assert.equal(out.byBuildingId.b1.googlePlaceId, 'ChIJ-verified');
  assert.equal(out.byBuildingId.b1.linkMethod, 'exact-osm-source-id-chain');
  assert.equal(out.policy.persistsPhotoMedia, false);
});

test('[36L] non-VERIFIED mapping is never linked', () => {
  const buildings = { buildings: [{
    buildingId: 'b1', buildingName: 'X', source: 'osm', sourceId: 'node/1',
    matchMethod: 'building-polygon-self', confidence: 'high', facilities: [],
  }] };
  const places = { entries: [{
    facilityId: 'osm-node-1', googlePlaceId: 'wrong', name: 'X', matchConfidence: 'AMBIGUOUS',
  }] };
  const out = buildBuildingGooglePlaceIndex(buildings, places);
  assert.equal(out.counts.linkedBuildings, 0);
  assert.equal(out.byBuildingId.b1, undefined);
});

test('[36L] arbitrary tenant POI does not become a building photo link', () => {
  const buildings = { buildings: [{
    buildingId: 'mall', buildingName: null, primaryFacilityName: null,
    source: null, sourceId: null, confidence: null,
    facilities: [
      { name: 'Shop A', source: 'osm', sourceId: 'node/1' },
      { name: 'Shop B', source: 'osm', sourceId: 'node/2' },
    ],
  }] };
  const places = { entries: [
    { facilityId: 'osm-node-1', googlePlaceId: 'p1', name: 'Shop A', matchConfidence: 'VERIFIED' },
    { facilityId: 'osm-node-2', googlePlaceId: 'p2', name: 'Shop B', matchConfidence: 'VERIFIED' },
  ] };
  const out = buildBuildingGooglePlaceIndex(buildings, places);
  assert.equal(out.counts.linkedBuildings, 0);
  assert.equal(out.counts.noExactSource, 1);
});

test('[36L] unique whole-building primary facility can link by exact source identity', () => {
  const buildings = { buildings: [{
    buildingId: 'school', buildingName: null, primaryFacilityName: 'Example School',
    source: 'osm', sourceId: 'node/5', matchMethod: 'poi-inside-building', confidence: 'medium',
    facilities: [{ name: 'Example School', source: 'osm', sourceId: 'node/5' }],
  }] };
  const places = { entries: [{
    facilityId: 'osm-node-5', googlePlaceId: 'school-place', name: 'Example School', matchConfidence: 'VERIFIED',
  }] };
  const out = buildBuildingGooglePlaceIndex(buildings, places);
  assert.equal(out.counts.linkedBuildings, 1);
  assert.equal(out.byBuildingId.school.googlePlaceId, 'school-place');
});

test('[36L] conflicting durable facility mappings are rejected', () => {
  const buildings = { buildings: [{
    buildingId: 'b1', buildingName: 'X', source: 'osm', sourceId: 'way/9',
    matchMethod: 'building-polygon-self', confidence: 'high', facilities: [],
  }] };
  const places = { entries: [
    { facilityId: 'osm-way-9', googlePlaceId: 'p1', name: 'X', matchConfidence: 'VERIFIED' },
    { facilityId: 'osm-way-9', googlePlaceId: 'p2', name: 'X', matchConfidence: 'VERIFIED' },
  ] };
  const out = buildBuildingGooglePlaceIndex(buildings, places);
  assert.equal(out.counts.linkedBuildings, 0);
});

test('[36L UI] photo bridge is dev-only, on-demand, and non-persistent', () => {
  const js = fs.readFileSync(BRIDGE_JS, 'utf8');
  const preview = fs.readFileSync(PREVIEW, 'utf8');
  assert.match(preview, /livecity-building-photo-bridge\.js/);
  assert.match(js, /BuildingPhoto\.fillCard/);
  assert.match(js, /placeMatchConfidence !== 'VERIFIED'/);
  assert.match(js, /places\.googleapis\.com\/v1\/places/);
  assert.match(js, /skipHttpRedirect=true/);
  assert.match(js, /MAX_PHOTOS = 3/);
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(js), 'Google photo data must not be persisted');
  assert.ok(!/searchText|:searchText/.test(js), 'building click must not start fuzzy Places searches');
  assert.ok(!/reviews|rating|priceLevel/.test(js), 'unneeded Places fields must not be requested');
});
