#!/usr/bin/env node
'use strict';
// Mission 144: why "water-surface 0 wards", and a safe way to fill it ONLY where a real source exists.
//
// ROOT CAUSE (from the code, not from owner data):
//   * Mission115 / 45I (tools/mission45i-build-layers-24.cjs) writes roads / waterways / parks / railways (+ labels, report). It never writes water-surface.json.
//   * water-surface.json is a SEPARATE sea/bay triangle layer made citywide by tools/build-water-surface.js (raster of "sea mask AND NOT any ward land").
//     That is a different pipeline and it was never sliced per ward into <layers-root>/<ward>/layers/. So the launcher counted 0 files.
//   * Real OSM water POLYGONS (natural=water, riverbanks, multipolygon outers) that the old tiles hold travel inside waterways.json as kind:'area'
//     features and ARE drawn by the viewer's waterways layer (makeAreaLayer). They are reported here as waterAreas, not as "water-surface".
//   * A river that exists only as a centre LINE has no width in the source. No surface is generated from it (widths are not invented).
//
//   node tools/mission144-water-surface.cjs --layers-root <dir>                       diagnose (read-only)
//   node tools/mission144-water-surface.cjs --layers-root <dir> --source <water-surface.json> [--wards a,b] [--apply]
//        slices the citywide sea triangles into wards whose triangles lie fully inside the ward clip box. Dry-run unless --apply.
//        With --apply only NEW files are created (flag 'wx'); an existing water-surface.json is never overwritten. Nothing else is touched.
//   Alternative free polygon source (adoption proposal, NOT fetched here): OSM water polygons / Geofabrik extract, ODbL, attribution
//   "OpenStreetMap contributors"; refresh by re-running the old-tile converter. Network: none in this tool.
const fs = require('node:fs');
const path = require('node:path');
const L = require('./mission144-lib.cjs');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function diagnose(layersRoot, onlyWards) {
  const rows = [];
  for (const w of fs.readdirSync(layersRoot).sort()) {
    if (onlyWards && !onlyWards.includes(w)) continue;
    const d = path.join(layersRoot, w, 'layers');
    if (!fs.existsSync(d)) continue;
    const row = { ward: w, waterLines: 0, waterAreas: 0, waterSurfaceFile: fs.existsSync(path.join(d, 'water-surface.json')), bboxLocal: null };
    try { const j = readJson(path.join(d, 'waterways.json')); Object.assign(row, { waterLines: L.featureKinds(j).lines, waterAreas: L.featureKinds(j).areas, bboxLocal: j.bboxLocal || null }); } catch (e) { row.waterwaysFile = 'absent-or-unparseable'; }
    row.cause = row.waterSurfaceFile ? 'water-surface.json present'
      : row.waterAreas > 0 ? 'no separate sea-surface file; real water polygons are inside waterways.json (drawn by the waterways layer)'
      : row.waterLines > 0 ? 'only river centre lines in the source: no surface is generated (width would be invented)'
      : 'no water data in this ward\'s source';
    rows.push(row);
  }
  return rows;
}

function apply(layersRoot, sourceFile, wards, doWrite) {
  const payload = readJson(sourceFile), out = [];
  for (const row of diagnose(layersRoot, wards)) {
    if (row.waterSurfaceFile) { out.push({ ward: row.ward, action: 'skip-existing' }); continue; }
    if (!row.bboxLocal) { out.push({ ward: row.ward, action: 'skip-no-clip-box' }); continue; }
    const s = L.sliceWaterSurface(payload, row.bboxLocal);
    if (!s.features.length) { out.push({ ward: row.ward, action: 'none', reason: s.reason }); continue; }
    if (doWrite) {
      const f = path.join(layersRoot, row.ward, 'layers', 'water-surface.json');
      fs.writeFileSync(f, JSON.stringify({ layer: 'water-surface', mission: '144', ward: row.ward, coordinateConvention: payload.coordinateConvention || 'znorth-neg-v1', coordinateSystem: 'local-meters',
        source: 'tools/build-water-surface.js citywide sea raster (sea mask AND NOT ward land); triangles fully inside the ward clip box; not clipped, not invented', clipped: 'triangles-inside-box', bboxLocal: row.bboxLocal, count: s.features.length, features: s.features }), { flag: 'wx' });
    }
    out.push({ ward: row.ward, action: doWrite ? 'written' : 'would-write', triangles: s.features.length });
  }
  return out;
}

function main() {
  const a = process.argv.slice(2), g = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const root = g('--layers-root'); if (!root) { console.error('--layers-root required'); process.exit(2); }
  const wards = g('--wards') ? g('--wards').split(',') : null;
  const rows = diagnose(root, wards);
  console.log('[144] water diagnosis (' + rows.length + ' wards with layers/):');
  for (const r of rows) console.log('  ' + r.ward + ' lines=' + r.waterLines + ' polygons=' + r.waterAreas + ' water-surface.json=' + (r.waterSurfaceFile ? 'yes' : 'no') + ' :: ' + r.cause);
  console.log('[144] water-surface.json present: ' + rows.filter((r) => r.waterSurfaceFile).length + '/' + rows.length + ' | wards with real water polygons in waterways.json: ' + rows.filter((r) => r.waterAreas > 0).length);
  const src = g('--source');
  if (src) { const res = apply(root, src, wards, a.includes('--apply')); for (const r of res) console.log('  [slice] ' + JSON.stringify(r)); if (!a.includes('--apply')) console.log('[144] dry run: add --apply to create NEW water-surface.json files'); }
  else console.log('[144] no --source given: nothing is created. The citywide sea file comes from `node tools/build-water-surface.js` (needs public/map-data/osaka-city/boundaries/ward-classification-polygons.json).');
}
if (require.main === module) main();
module.exports = { diagnose, apply };
