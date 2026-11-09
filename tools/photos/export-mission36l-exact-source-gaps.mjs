#!/usr/bin/env node
// Mission 36L: export only exact building-source identities that still lack a VERIFIED Google Place.
// This is generated from the full local Mission 35O provenance index; no nearest/fuzzy building linkage is introduced.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILDINGS = path.join(ROOT, 'data', 'processed', 'osaka-city', 'derived', 'building-facility-index.json');
const PLACES = path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived', 'google-places-osaka-city-mapping.json');
const OUT = path.join(ROOT, 'data', 'reports', 'mission36l-building-photo-linking', 'exact-source-gaps.json');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

function facilityIdFromSource(sourceId) {
  const m = String(sourceId || '').trim().match(/^(node|way|relation)\/(\d+)$/);
  return m ? `osm-${m[1]}-${m[2]}` : null;
}

function exactCandidates(building) {
  const out = new Map();
  const add = (sourceId, reason) => {
    const facilityId = facilityIdFromSource(sourceId);
    if (facilityId && !out.has(facilityId)) out.set(facilityId, { facilityId, sourceId, reason });
  };
  if (building?.source === 'osm' && building?.sourceId) add(building.sourceId, building.matchMethod || 'building-osm-source');
  const facilities = Array.isArray(building?.facilities) ? building.facilities : [];
  if (building?.primaryFacilityName && facilities.length === 1) {
    const only = facilities[0];
    if (only?.source === 'osm' && only?.sourceId && only?.name === building.primaryFacilityName) {
      add(only.sourceId, 'unique-primary-facility-source');
    }
  }
  return [...out.values()];
}

if (!fs.existsSync(BUILDINGS)) throw new Error(`missing ${BUILDINGS}`);
if (!fs.existsSync(PLACES)) throw new Error(`missing ${PLACES}`);

const buildingDoc = readJson(BUILDINGS);
const placesDoc = readJson(PLACES);
const verified = new Set((placesDoc.entries || [])
  .filter((e) => e?.matchConfidence === 'VERIFIED' && e?.facilityId && e?.googlePlaceId)
  .map((e) => e.facilityId));

const byFacility = new Map();
for (const building of (buildingDoc.buildings || [])) {
  for (const c of exactCandidates(building)) {
    if (verified.has(c.facilityId)) continue;
    let row = byFacility.get(c.facilityId);
    if (!row) {
      row = {
        facilityId: c.facilityId,
        sourceId: c.sourceId,
        sourceReason: c.reason,
        buildingIds: [],
        buildingNames: [],
        wardIds: [],
      };
      byFacility.set(c.facilityId, row);
    }
    row.buildingIds.push(building.buildingId);
    const name = building.buildingName || building.primaryFacilityName || null;
    if (name && !row.buildingNames.includes(name)) row.buildingNames.push(name);
    if (building.wardId && !row.wardIds.includes(building.wardId)) row.wardIds.push(building.wardId);
  }
}

const candidates = [...byFacility.values()].sort((a, b) => a.facilityId.localeCompare(b.facilityId));
const byType = { node: 0, way: 0, relation: 0 };
for (const c of candidates) {
  const m = c.facilityId.match(/^osm-(node|way|relation)-/);
  if (m) byType[m[1]]++;
}
const doc = {
  version: 1,
  mission: '36L-exact-source-gap-export',
  generatedAt: new Date().toISOString(),
  policy: {
    exactOsmSourceIdentityOnly: true,
    verifiedEntriesExcluded: true,
    noNearestBuildingLinkage: true,
    candidateGooglePlaceIdsPersisted: false,
  },
  counts: {
    exactSourceGaps: candidates.length,
    byType,
  },
  candidates,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
console.log('[36L gap export]', JSON.stringify(doc.counts));
console.log('[36L gap export] output:', path.relative(ROOT, OUT).replaceAll('\\', '/'));
