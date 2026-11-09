// Mission 36L: build a conservative building -> Google Place bridge.
//
// Durable data policy:
// - Persist only canonical buildingId <-> VERIFIED facilityId <-> googlePlaceId linkage.
// - Never persist Google photo resource names, media URLs, binaries, reviews, or ratings.
// - Prefer exact OSM source identity. Do not use nearest-place or fuzzy-name matching here.
// - If one building resolves to more than one distinct Google Place, reject it as ambiguous.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_BUILDING_INDEX = path.join(ROOT, 'data', 'processed', 'osaka-city', 'derived', 'building-facility-index.json');
export const DEFAULT_PLACES_MAPPING = path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived', 'google-places-osaka-city-mapping.json');
export const DEFAULT_OUT = path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived', 'building-google-place-index.json');
export const DEFAULT_REPORT = path.join(ROOT, 'data', 'reports', 'mission36l-building-photo-linking', 'building-google-place-index.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

export function facilityIdFromOsmSourceId(sourceId) {
  const m = String(sourceId || '').trim().match(/^(node|way|relation)\/(\d+)$/);
  return m ? `osm-${m[1]}-${m[2]}` : null;
}

function addSourceCandidate(target, sourceId, reason) {
  const facilityId = facilityIdFromOsmSourceId(sourceId);
  if (!facilityId) return;
  if (!target.has(facilityId)) target.set(facilityId, { facilityId, sourceId, reason });
}

function buildingSourceCandidates(building) {
  const candidates = new Map();

  // A/B in Mission 35O: the building name itself came from this exact OSM way/relation.
  if (building?.source === 'osm' && building?.sourceId) {
    addSourceCandidate(candidates, building.sourceId, building.matchMethod || 'building-osm-source');
  }

  // C in Mission 35O: primaryFacilityName is only set when a whole-building category is unique.
  // Restrict this route to the unique primary facility; do not attach arbitrary tenants/shops.
  const facilities = Array.isArray(building?.facilities) ? building.facilities : [];
  if (building?.primaryFacilityName && facilities.length === 1) {
    const only = facilities[0];
    if (only?.source === 'osm' && only?.sourceId && only?.name === building.primaryFacilityName) {
      addSourceCandidate(candidates, only.sourceId, 'unique-primary-facility-source');
    }
  }

  return [...candidates.values()];
}

export function buildBuildingGooglePlaceIndex(buildingDoc, placesDoc, { generatedAt = new Date().toISOString() } = {}) {
  const buildings = Array.isArray(buildingDoc?.buildings) ? buildingDoc.buildings : [];
  const verifiedEntries = (Array.isArray(placesDoc?.entries) ? placesDoc.entries : [])
    .filter((e) => e?.matchConfidence === 'VERIFIED' && e?.facilityId && e?.googlePlaceId);

  const placeByFacility = new Map();
  const conflictedFacilities = new Set();
  for (const entry of verifiedEntries) {
    // A duplicate durable facilityId with conflicting Google IDs is unsafe: remove it from the usable map.
    if (conflictedFacilities.has(entry.facilityId)) continue;
    const old = placeByFacility.get(entry.facilityId);
    if (!old) placeByFacility.set(entry.facilityId, entry);
    else if (old.googlePlaceId !== entry.googlePlaceId) {
      conflictedFacilities.add(entry.facilityId);
      placeByFacility.delete(entry.facilityId);
    }
  }

  const records = [];
  const rejectedAmbiguous = [];
  let noExactSource = 0;
  let sourceNotVerified = 0;

  for (const building of buildings) {
    if (!building?.buildingId) continue;
    const sourceCandidates = buildingSourceCandidates(building);
    if (!sourceCandidates.length) {
      noExactSource++;
      continue;
    }

    const linked = [];
    for (const candidate of sourceCandidates) {
      const mapped = placeByFacility.get(candidate.facilityId);
      if (!mapped) continue;
      linked.push({ ...candidate, mapped });
    }
    if (!linked.length) {
      sourceNotVerified++;
      continue;
    }

    const byPlace = new Map();
    for (const link of linked) {
      if (!byPlace.has(link.mapped.googlePlaceId)) byPlace.set(link.mapped.googlePlaceId, link);
    }
    if (byPlace.size !== 1) {
      rejectedAmbiguous.push({
        buildingId: building.buildingId,
        buildingName: building.buildingName || building.primaryFacilityName || null,
        googlePlaceIds: [...byPlace.keys()],
      });
      continue;
    }

    const link = [...byPlace.values()][0];
    records.push({
      buildingId: building.buildingId,
      buildingName: building.buildingName || building.primaryFacilityName || link.mapped.name || null,
      facilityId: link.facilityId,
      googlePlaceId: link.mapped.googlePlaceId,
      linkMethod: 'exact-osm-source-id-chain',
      sourceId: link.sourceId,
      sourceReason: link.reason,
      buildingMatchConfidence: building.confidence || null,
      placeMatchConfidence: 'VERIFIED',
      placeVerifiedAt: link.mapped.verifiedAt || null,
    });
  }

  records.sort((a, b) => a.buildingId.localeCompare(b.buildingId));
  const byBuildingId = Object.fromEntries(records.map((r) => [r.buildingId, r]));

  return {
    version: 1,
    mission: '36L',
    generatedAt,
    sourceBuildingIndex: 'data/processed/osaka-city/derived/building-facility-index.json',
    sourcePlacesMapping: 'public/map-data/osaka-city/derived/google-places-osaka-city-mapping.json',
    policy: {
      exactOsmSourceIdentityOnly: true,
      verifiedGooglePlaceOnly: true,
      rejectsMultipleGooglePlacesPerBuilding: true,
      persistsPhotoMedia: false,
      resolvesPhotosAtDisplayTime: true,
    },
    counts: {
      buildingsScanned: buildings.length,
      verifiedFacilityMappingsAvailable: verifiedEntries.length,
      linkedBuildings: records.length,
      rejectedAmbiguous: rejectedAmbiguous.length,
      noExactSource,
      exactSourceWithoutVerifiedPlace: sourceNotVerified,
    },
    byBuildingId,
    records,
    rejectedAmbiguous,
  };
}

export function run({
  buildingIndexPath = DEFAULT_BUILDING_INDEX,
  placesMappingPath = DEFAULT_PLACES_MAPPING,
  outPath = DEFAULT_OUT,
  reportPath = DEFAULT_REPORT,
} = {}) {
  if (!fs.existsSync(buildingIndexPath)) throw new Error(`building facility index missing: ${buildingIndexPath}`);
  if (!fs.existsSync(placesMappingPath)) throw new Error(`Google Places mapping missing: ${placesMappingPath}`);

  const doc = buildBuildingGooglePlaceIndex(readJson(buildingIndexPath), readJson(placesMappingPath));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(doc));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    mission: doc.mission,
    generatedAt: doc.generatedAt,
    policy: doc.policy,
    counts: doc.counts,
    rejectedAmbiguous: doc.rejectedAmbiguous,
  }, null, 2));
  return doc;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const doc = run();
    console.log('[36L building-place]', JSON.stringify(doc.counts));
  } catch (err) {
    console.error('[36L building-place]', err?.stack || err);
    process.exitCode = 1;
  }
}
