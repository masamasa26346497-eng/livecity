import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FULL = path.join(ROOT, 'public/map-data/osaka-city/facilities/facilities.json');
const STARTUP = path.join(ROOT, 'public/map-data/osaka-city/facilities/facilities-startup.json');
const DEV = path.join(ROOT, 'public/osaka_3d_buildings.ward-ux-v1.html');
const PROTECTED = [
  path.join(ROOT, 'public/osaka_3d_buildings.html'),
  path.join(ROOT, 'public/osaka_3d_buildings.fullward-v3.html'),
];

const protectedBefore = new Map(PROTECTED.map((p) => [p, fs.readFileSync(p)]));
const full = JSON.parse(fs.readFileSync(FULL, 'utf8').replace(/^\uFEFF/, ''));
const records = Array.isArray(full) ? full : (full.records || []);
if (!records.length) throw new Error('citywide facilities dataset is empty');

const priority = new Map([
  ['tourism', 0], ['lodging', 1], ['dining', 2], ['shopping', 3],
  ['medical', 4], ['transport', 5], ['public', 6], ['education', 7],
  ['park', 8], ['welfare', 9], ['unknown', 99],
]);

function stableHash(value) {
  let h = 2166136261;
  for (const ch of String(value || '')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function recordSort(a, b) {
  const major = Number(!!b.majorFacility) - Number(!!a.majorFacility);
  if (major) return major;
  const pa = priority.get(String(a.category)) ?? 50;
  const pb = priority.get(String(b.category)) ?? 50;
  if (pa !== pb) return pa - pb;
  return stableHash(a.id) - stableHash(b.id);
}

const byWard = new Map();
for (const record of records) {
  const wardId = record.wardId || 'unknown';
  if (!byWard.has(wardId)) byWard.set(wardId, []);
  byWard.get(wardId).push(record);
}

const selected = [];
const wardCounts = {};
for (const [wardId, wardRecords] of [...byWard.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))) {
  wardRecords.sort(recordSort);
  const isSumiyoshi = wardRecords.some((r) => String(r.wardName || '').includes('住吉'));
  const limit = isSumiyoshi ? 120 : 40;
  const slice = wardRecords.slice(0, limit);
  selected.push(...slice);
  wardCounts[wardId] = slice.length;
}

selected.sort((a, b) => String(a.wardId).localeCompare(String(b.wardId)) || String(a.id).localeCompare(String(b.id)));
const startup = {
  areaId: full.areaId || 'osaka-city',
  mission: '36J-startup-lite',
  generatedAt: new Date().toISOString(),
  coordinateConvention: full.coordinateConvention || 'znorth-neg-v1',
  recordCount: selected.length,
  sourceRecordCount: records.length,
  wardCount: new Set(selected.map((r) => r.wardId)).size,
  wardCounts,
  note: 'Lightweight startup subset only. Full 40,585-record dataset remains unchanged for future ward/tile lazy loading.',
  records: selected,
};
fs.writeFileSync(STARTUP, JSON.stringify(startup) + '\n', 'utf8');

let html = fs.readFileSync(DEV, 'utf8');
const fullUrl = 'const url = `${FACILITY_CONFIG.basePath}/${FACILITY_CONFIG.areaId}/facilities/facilities.json`;';
const liteUrl = 'const url = `${FACILITY_CONFIG.basePath}/${FACILITY_CONFIG.areaId}/facilities/facilities-startup.json`;';
if (html.includes(fullUrl)) html = html.replace(fullUrl, liteUrl);
else if (!html.includes(liteUrl)) throw new Error('facility startup URL anchor not found');

html = html.replace('const MAX_RENDERED_FACILITIES = 800;', 'const MAX_RENDERED_FACILITIES = 200;');
html = html.replace('const FACILITY_RENDER_RADIUS_METERS = 4500;', 'const FACILITY_RENDER_RADIUS_METERS = 2500;');
html = html.replace('maxRenderedFacilities: MAX_RENDERED_FACILITIES,', 'maxRenderedFacilities: MAX_RENDERED_FACILITIES,');

fs.writeFileSync(DEV, html, 'utf8');

const out = fs.readFileSync(DEV, 'utf8');
if (!out.includes('facilities-startup.json')) throw new Error('startup dataset is not wired');
if (!out.includes('MAX_RENDERED_FACILITIES = 200')) throw new Error('facility render cap 200 missing');
if (!out.includes('FACILITY_RENDER_RADIUS_METERS = 2500')) throw new Error('facility render radius 2500 missing');
if (!out.includes("areaId: 'osaka-city'")) throw new Error('citywide facility config lost');
if (!out.includes('google-places-osaka-city-mapping.json')) throw new Error('Google Places citywide mapping lost');

for (const [p, before] of protectedBefore) {
  const after = fs.readFileSync(p);
  if (!before.equals(after)) throw new Error('protected production HTML changed: ' + path.basename(p));
}

console.log(JSON.stringify({
  fullRecords: records.length,
  startupRecords: selected.length,
  startupWards: startup.wardCount,
  renderCap: 200,
  renderRadiusMeters: 2500,
}));
