// tests/mission36h2-facility-coordinate-normalization.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  geoToLocal,
  geoToRuntimeLocal,
  runtimeLocalToGeo,
  RUNTIME_COORDINATE_CONVENTION,
} from '../tools/lib/projection.js';
import { convertFacilitiesExtended } from '../tools/convert/facilities-extended.js';
import { normalizeFacilityRecords } from '../tools/migrate-facility-coordinates-znorth-neg.js';

const projection = {
  type: 'local-equirectangular',
  centerLat: 34.604208,
  centerLon: 135.52502,
  metersPerDegree: 111320,
};

const tamade = {
  latitude: 34.6008545,
  longitude: 135.5076528,
};

test('[36H2] legacy geoToLocal remains north=+Z for old pipelines', () => {
  const legacy = geoToLocal(tamade.latitude, tamade.longitude, projection);
  assert.equal(legacy.x, -1591.3);
  assert.equal(legacy.z, -373.31);
});

test('[36H2] runtime projection is znorth-neg-v1 and flips only the Z convention', () => {
  const legacy = geoToLocal(tamade.latitude, tamade.longitude, projection);
  const runtime = geoToRuntimeLocal(tamade.latitude, tamade.longitude, projection);
  assert.equal(RUNTIME_COORDINATE_CONVENTION, 'znorth-neg-v1');
  assert.equal(runtime.x, legacy.x);
  assert.equal(runtime.z, 373.31);
  assert.equal(runtime.z, -legacy.z);
});

test('[36H2] runtime inverse projection round-trips lat/lon', () => {
  const runtime = geoToRuntimeLocal(tamade.latitude, tamade.longitude, projection);
  const geo = runtimeLocalToGeo(runtime.x, runtime.z, projection);
  assert.ok(Math.abs(geo.lat - tamade.latitude) < 0.000001);
  assert.ok(Math.abs(geo.lon - tamade.longitude) < 0.000001);
});

test('[36H2] facility converter emits znorth-neg-v1 coordinates', () => {
  const facilityConfig = {
    religiousFacilityRules: { shrineNamePatterns: [], templeNamePatterns: [] },
    historicRules: { categoryFor: 'tourism', subcategoryPrefix: 'historic-' },
    rules: [
      { tag: 'shop', value: 'supermarket', category: 'shopping', subcategory: 'supermarket' },
    ],
  };
  const raw = [{
    type: 'node',
    id: 750515219,
    lat: tamade.latitude,
    lon: tamade.longitude,
    tags: { name: 'スーパー玉出 アビコ店', shop: 'supermarket' },
  }];
  const bbox = { south: 34.59, west: 135.49, north: 34.62, east: 135.56 };
  const sourceMeta = {
    provider: 'OpenStreetMap (Overpass API)',
    license: 'ODbL 1.0',
    attribution: '© OpenStreetMap contributors',
    downloadedAt: '2026-09-30T00:00:00.000Z',
  };
  const { records } = convertFacilitiesExtended(raw, projection, bbox, facilityConfig, sourceMeta);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'osm-node-750515219');
  assert.equal(records[0].localX, -1591.3);
  assert.equal(records[0].localZ, 373.31);
});

test('[36H2] migration re-projects from lat/lon instead of blindly negating localZ', () => {
  const source = [{
    id: 'osm-node-750515219',
    name: 'スーパー玉出 アビコ店',
    latitude: tamade.latitude,
    longitude: tamade.longitude,
    localX: -1591.3,
    localZ: -99999, // intentionally wrong: proves migration trusts lat/lon, not sign flip
  }];
  const result = normalizeFacilityRecords(source, projection);
  assert.equal(result.changed, 1);
  assert.equal(result.missingCoordinates.length, 0);
  assert.equal(result.records[0].localX, -1591.3);
  assert.equal(result.records[0].localZ, 373.31);
});

test('[36H2] migration does not silently invent coordinates when lat/lon is missing', () => {
  const source = [{ id: 'no-geo', localX: 1, localZ: 2 }];
  const result = normalizeFacilityRecords(source, projection);
  assert.deepEqual(result.missingCoordinates, ['no-geo']);
  assert.equal(result.records[0].localX, 1);
  assert.equal(result.records[0].localZ, 2);
});
