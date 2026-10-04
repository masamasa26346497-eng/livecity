import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  osmElementTypeFromFacilityId,
  isBuildingSourceCandidate,
  selectBuildingSourceCandidates,
} from '../tools/google-places/match-building-source-places.mjs';

const scriptPath = new URL('../tools/google-places/match-building-source-places.mjs', import.meta.url);

test('[36L building-source] only OSM way/relation are building-source candidates', () => {
  assert.equal(osmElementTypeFromFacilityId('osm-node-123'), 'node');
  assert.equal(osmElementTypeFromFacilityId('osm-way-456'), 'way');
  assert.equal(osmElementTypeFromFacilityId('osm-relation-789'), 'relation');
  assert.equal(osmElementTypeFromFacilityId('other-1'), null);
  assert.equal(isBuildingSourceCandidate({ facilityId: 'osm-node-123' }), false);
  assert.equal(isBuildingSourceCandidate({ facilityId: 'osm-way-456' }), true);
  assert.equal(isBuildingSourceCandidate({ facilityId: 'osm-relation-789' }), true);
});

test('[36L building-source] selection excludes node POIs and preserves verified/attempted guards', () => {
  const candidates = [
    { facilityId: 'osm-node-1', wardId: 'kita', osmCategory: 'public', osmSubcategory: 'x' },
    { facilityId: 'osm-way-2', wardId: 'kita', osmCategory: 'public', osmSubcategory: 'x' },
    { facilityId: 'osm-way-3', wardId: 'kita', osmCategory: 'public', osmSubcategory: 'x' },
    { facilityId: 'osm-relation-4', wardId: 'chuo', osmCategory: 'education', osmSubcategory: 'x' },
  ];
  const selected = selectBuildingSourceCandidates(candidates, {
    existingVerifiedIds: new Set(['osm-way-2']),
    attemptedIds: new Set(['osm-way-3']),
    profile: { priority: { highCategories: ['public', 'education'] } },
    wardOrder: ['kita', 'chuo'],
    maxPriority: 0,
    limit: 10,
  });
  assert.deepEqual(selected.map((c) => c.facilityId), ['osm-relation-4']);
});

test('[36L building-source] whole-building classes are ordered ahead of tenant-heavy dining', () => {
  const candidates = [
    { facilityId: 'osm-way-10', wardId: 'kita', osmCategory: 'dining', osmSubcategory: 'restaurant' },
    { facilityId: 'osm-way-11', wardId: 'kita', osmCategory: 'medical', osmSubcategory: 'hospital' },
    { facilityId: 'osm-way-12', wardId: 'kita', osmCategory: 'public', osmSubcategory: 'townhall' },
  ];
  const selected = selectBuildingSourceCandidates(candidates, {
    profile: { priority: { highCategories: ['dining', 'medical', 'public'] } },
    wardOrder: ['kita'],
    maxPriority: 0,
    limit: 10,
  });
  assert.deepEqual(selected.map((c) => c.facilityId), ['osm-way-11', 'osm-way-12', 'osm-way-10']);
});

test('[36L building-source] persistence safety stays VERIFIED-only and photo-media-free', async () => {
  const source = await readFile(scriptPath, 'utf8');
  assert.match(source, /DEFAULT_MAX_DISTANCE_METERS/);
  assert.match(source, /persistsOnlyVerifiedLinkage: true/);
  assert.match(source, /verifiedOnlyPersistence: true/);
  assert.match(source, /assertDurableRecordSafe/);
  assert.match(source, /photo binaries/);
  assert.doesNotMatch(source, /photoUri\s*:/);
  assert.doesNotMatch(source, /photoName\s*:/);
});
