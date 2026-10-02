import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROTECTED = [
  path.join(ROOT, 'public', 'osaka_3d_buildings.html'),
  path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'),
];
const MARKER = '[Mission 36K PERF] facility spatial index';

const protectedBefore = new Map(PROTECTED.map((p) => [p, fs.readFileSync(p)]));
let html = fs.readFileSync(DEV, 'utf8');

if (html.includes(MARKER)) {
  console.log('[36K PERF] already applied');
  process.exit(0);
}
if (!html.includes('[Mission 36J LAZY] 24-ward facility lazy loading')) {
  throw new Error('Mission 36J lazy facility store is required before 36K');
}
if (!html.includes('[Mission 36J PERF] bounded facility renderer')) {
  throw new Error('Mission 36J bounded facility renderer is required before 36K');
}

function replaceExactlyOnce(needle, replacement, label) {
  const count = html.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly 1 match, got ${count}`);
  html = html.replace(needle, replacement);
}

// ---------------------------------------------------------------------------
// 1) FacilityDataStore: 500m grid index
// ---------------------------------------------------------------------------
const declarationNeedle = `  let allRecords = [];
  let recordsById = new Map();
  let metadata = null;`;
const declarationReplacement = `  let allRecords = [];
  let recordsById = new Map();
  // ${MARKER}
  // 施設検索を読み込み済み全件の O(n) 走査から、周辺グリッドだけの走査へ変える。
  // 元の40,585件・24区shardは削減しない。索引はruntime上の補助構造だけ。
  const FACILITY_GRID_CELL_METERS = 500;
  let spatialGrid = new Map();
  let spatialIndexedIds = new Set();
  let spatialQueryStats = { calls: 0, candidateIds: 0, accepted: 0, fullScanFallbacks: 0 };
  let metadata = null;`;
replaceExactlyOnce(declarationNeedle, declarationReplacement, 'store declarations');

const normalizeNeedle = `  function normalizeRecords(doc) {
    if (Array.isArray(doc)) return doc;
    if (doc && Array.isArray(doc.records)) return doc.records;
    if (doc && Array.isArray(doc.facilities)) return doc.facilities;
    return [];
  }

  function mergeRecords(records) {`;
const normalizeReplacement = `  function normalizeRecords(doc) {
    if (Array.isArray(doc)) return doc;
    if (doc && Array.isArray(doc.records)) return doc.records;
    if (doc && Array.isArray(doc.facilities)) return doc.facilities;
    return [];
  }

  function spatialCellCoord(v) {
    return Math.floor(Number(v) / FACILITY_GRID_CELL_METERS);
  }

  function spatialCellKey(cx, cz) {
    return cx + ':' + cz;
  }

  function indexSpatialRecord(record) {
    if (!record || !record.id) return;
    const x = Number(record.localX), z = Number(record.localZ);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const key = spatialCellKey(spatialCellCoord(x), spatialCellCoord(z));
    let ids = spatialGrid.get(key);
    if (!ids) { ids = new Set(); spatialGrid.set(key, ids); }
    ids.add(record.id);
    spatialIndexedIds.add(record.id);
  }

  function queryNearbySpatial(x, z, radiusM, subcategories = [], options = {}) {
    spatialQueryStats.calls++;
    const qx = Number(x), qz = Number(z), radius = Number(radiusM);
    const cats = Array.isArray(subcategories) ? subcategories : [];
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Number(options.limit)) : Infinity;
    const prioritizeMajor = !!options.prioritizeMajor;

    // Infinity query (nearestBySubcategory legacy API) keeps exact legacy semantics.
    // Normal map rendering/count-nearby uses finite radii and therefore the grid path.
    if (!Number.isFinite(qx) || !Number.isFinite(qz) || !Number.isFinite(radius) || radius < 0) {
      spatialQueryStats.fullScanFallbacks++;
      const out = [];
      for (const r of allRecords) {
        if (cats.length && !cats.includes(r.subcategory)) continue;
        const dx = Number(r.localX) - qx, dz = Number(r.localZ) - qz;
        const d2 = dx * dx + dz * dz;
        if (!Number.isFinite(d2)) continue;
        out.push({ record: r, distanceM: Math.sqrt(d2), d2 });
      }
      out.sort((a, b) => (prioritizeMajor ? Number(!!b.record.majorFacility) - Number(!!a.record.majorFacility) : 0) || a.d2 - b.d2);
      return Number.isFinite(limit) ? out.slice(0, limit) : out;
    }

    const radiusSq = radius * radius;
    const minCx = spatialCellCoord(qx - radius), maxCx = spatialCellCoord(qx + radius);
    const minCz = spatialCellCoord(qz - radius), maxCz = spatialCellCoord(qz + radius);
    const seen = new Set();
    const out = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const ids = spatialGrid.get(spatialCellKey(cx, cz));
        if (!ids) continue;
        spatialQueryStats.candidateIds += ids.size;
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          const r = recordsById.get(id);
          if (!r) continue;
          if (cats.length && !cats.includes(r.subcategory)) continue;
          const dx = Number(r.localX) - qx, dz = Number(r.localZ) - qz;
          const d2 = dx * dx + dz * dz;
          if (!Number.isFinite(d2) || d2 > radiusSq) continue;
          out.push({ record: r, distanceM: Math.sqrt(d2), d2 });
        }
      }
    }
    spatialQueryStats.accepted += out.length;
    out.sort((a, b) => (prioritizeMajor ? Number(!!b.record.majorFacility) - Number(!!a.record.majorFacility) : 0) || a.d2 - b.d2);
    return Number.isFinite(limit) ? out.slice(0, limit) : out;
  }

  function mergeRecords(records) {`;
replaceExactlyOnce(normalizeNeedle, normalizeReplacement, 'insert spatial helpers');

const mergeNeedle = `      recordsById.set(record.id, record);
    }
    return added;`;
const mergeReplacement = `      recordsById.set(record.id, record);
      indexSpatialRecord(record);
    }
    return added;`;
replaceExactlyOnce(mergeNeedle, mergeReplacement, 'index records on merge');

const reloadNeedle = `    allRecords = [];
    recordsById = new Map();
    metadata = null;`;
const reloadReplacement = `    allRecords = [];
    recordsById = new Map();
    spatialGrid = new Map();
    spatialIndexedIds = new Set();
    spatialQueryStats = { calls: 0, candidateIds: 0, accepted: 0, fullScanFallbacks: 0 };
    metadata = null;`;
replaceExactlyOnce(reloadNeedle, reloadReplacement, 'reset spatial index on reload');

const nearbyStart = html.indexOf('  function nearbyRecords(x, z, subcategories, radiusM = Infinity) {');
if (nearbyStart < 0) throw new Error('nearbyRecords start not found');
const nearbyEndNeedle = '\n  }\n\n  // 従来APIを維持する。';
const nearbyEnd = html.indexOf(nearbyEndNeedle, nearbyStart);
if (nearbyEnd < 0) throw new Error('nearbyRecords end not found');
const oldNearby = html.slice(nearbyStart, nearbyEnd + '\n  }'.length);
const newNearby = `  function nearbyRecords(x, z, subcategories, radiusM = Infinity) {
    return queryNearbySpatial(x, z, radiusM, subcategories, {});
  }`;
html = html.slice(0, nearbyStart) + newNearby + html.slice(nearbyEnd + '\n  }'.length);

const apiNeedle = `    getById(id) { return recordsById.get(id) || null; },
    onReady(cb) {`;
const apiReplacement = `    getById(id) { return recordsById.get(id) || null; },
    queryNearby(x, z, radiusM, options = {}) {
      if (state !== 'ready') return [];
      return queryNearbySpatial(x, z, radiusM, options.subcategories || [], options);
    },
    getSpatialDebug() {
      return {
        cellMeters: FACILITY_GRID_CELL_METERS,
        gridCells: spatialGrid.size,
        indexedIds: spatialIndexedIds.size,
        loadedRecords: allRecords.length,
        ...spatialQueryStats,
      };
    },
    onReady(cb) {`;
replaceExactlyOnce(apiNeedle, apiReplacement, 'expose spatial query API');

// ---------------------------------------------------------------------------
// 2) FacilityLayer: candidate selection from nearby cells, not all loaded rows
// ---------------------------------------------------------------------------
const rendererNeedle = `    const allFacilityRecords = FacilityDataStore.getAllRecords();
    totalFacilityCount = allFacilityRecords.length;
    const centerX = (typeof cs !== 'undefined' && Number.isFinite(cs.tx)) ? cs.tx : 0;
    const centerZ = (typeof cs !== 'undefined' && Number.isFinite(cs.tz)) ? cs.tz : 0;
    const radiusSq = FACILITY_RENDER_RADIUS_METERS * FACILITY_RENDER_RADIUS_METERS;
    const selectedFacilityRecords = allFacilityRecords
      .map((record) => {
        const dx = Number(record.localX) - centerX;
        const dz = Number(record.localZ) - centerZ;
        return { record, d2: dx * dx + dz * dz };
      })
      .filter((x) => Number.isFinite(x.d2) && x.d2 <= radiusSq)
      .sort((a, b) => Number(!!b.record.majorFacility) - Number(!!a.record.majorFacility) || a.d2 - b.d2)
      .slice(0, MAX_RENDERED_FACILITIES)
      .map((x) => x.record);`;
const rendererReplacement = `    totalFacilityCount = FacilityDataStore.getAllRecords().length;
    const centerX = (typeof cs !== 'undefined' && Number.isFinite(cs.tx)) ? cs.tx : 0;
    const centerZ = (typeof cs !== 'undefined' && Number.isFinite(cs.tz)) ? cs.tz : 0;
    const selectedFacilityRecords = FacilityDataStore.queryNearby(centerX, centerZ, FACILITY_RENDER_RADIUS_METERS, {
      limit: MAX_RENDERED_FACILITIES,
      prioritizeMajor: true,
    }).map((x) => x.record);`;
replaceExactlyOnce(rendererNeedle, rendererReplacement, 'replace full renderer scan');

// Add index diagnostics to the existing performance hook.
const debugNeedle = `      renderRadiusMeters: FACILITY_RENDER_RADIUS_METERS,
    };`;
const debugReplacement = `      renderRadiusMeters: FACILITY_RENDER_RADIUS_METERS,
      spatial: (FacilityDataStore.getSpatialDebug ? FacilityDataStore.getSpatialDebug() : null),
    };`;
replaceExactlyOnce(debugNeedle, debugReplacement, 'facility perf spatial debug');

fs.writeFileSync(DEV, html, 'utf8');

// Safety assertions: dataset/source semantics preserved; only dev UI may change.
const out = fs.readFileSync(DEV, 'utf8');
if (!out.includes(MARKER)) throw new Error('36K performance marker missing');
if (!out.includes('FACILITY_GRID_CELL_METERS = 500')) throw new Error('500m spatial grid missing');
if (!out.includes('queryNearbySpatial')) throw new Error('spatial query missing');
if (!out.includes('FacilityDataStore.queryNearby(centerX, centerZ, FACILITY_RENDER_RADIUS_METERS')) throw new Error('renderer is not using spatial query');
if (out.includes('const selectedFacilityRecords = allFacilityRecords')) throw new Error('legacy full renderer scan remains');
if (!out.includes('[Mission 36J LAZY] 24-ward facility lazy loading')) throw new Error('24-ward lazy loading was lost');
if (!out.includes("areaId: 'osaka-city'")) throw new Error('Osaka city facility source was lost');
if (!out.includes('google-places-osaka-city-mapping.json')) throw new Error('Google Places mapping was lost');
if (!out.includes('MAX_RENDERED_FACILITIES')) throw new Error('facility render cap was lost');

for (const [p, before] of protectedBefore) {
  const after = fs.readFileSync(p);
  if (!before.equals(after)) throw new Error('protected production HTML changed: ' + path.basename(p));
}

console.log('[36K PERF] patched dev UI: 500m facility spatial grid + bounded nearby renderer');
