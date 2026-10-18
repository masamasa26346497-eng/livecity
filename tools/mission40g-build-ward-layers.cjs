#!/usr/bin/env node
// Mission 40G: build per-ward road / waterway / park / railway layers for the Cesium viewer from the OLD Live City
// tiled OSM layers (read-only), and quantify alignment with the converted buildings and the N03 ward polygon.
//
//   node tools/mission40g-build-ward-layers.cjs --src ..\livecity-data-pipeline\public\map-data\osaka-city ^
//        --ward fukushima --ext ..\livecity-3dtiles-out-fukushima [--margin 150] [--check-only]
//
//   reads : <src>/{roads,waterways,parks,railways}/tile_<tx>_<tz>.json  (+ manifest.json)   -- never written
//           <ext>/<ward>/attrs/t_*.json   (building representative points, for the alignment check)
//   writes: <ext>/<ward>/layers/{roads,waterways,parks,railways}.json + layers-report.json   -- NEW files only
//   It refuses to overwrite an existing layers/ file and never touches tileset.json / tiles / ids / attrs.
//   Nothing is invented: every feature comes from the source tiles; features are only clipped to the ward bbox + margin.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const LAYERS = ['roads', 'waterways', 'parks', 'railways'];
const r1 = (v) => Math.round(v * 10) / 10;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function parseArgs(argv) {
  const a = { src: null, ward: null, ext: null, margin: 150, checkOnly: false, wards: path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--src') a.src = argv[++i]; else if (k === '--ward') a.ward = argv[++i]; else if (k === '--ext') a.ext = argv[++i];
    else if (k === '--margin') a.margin = Number(argv[++i]); else if (k === '--check-only') a.checkOnly = true;
    else if (k === '--wards') a.wards = argv[++i]; else throw new Error('unknown argument: ' + k);
  }
  if (!a.src || !a.ward || !a.ext) throw new Error('--src, --ward and --ext are required');
  if (!/^[a-z0-9-]+$/.test(a.ward)) throw new Error('bad --ward');
  if (!(a.margin >= 0 && a.margin <= 1000)) throw new Error('--margin must be 0..1000');
  return a;
}

const inBox = (b, x, z) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
function pip(poly, x, z) {   // ray casting on one ring
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function inWard(ward, x, z) {
  for (const p of ward.polygons) {
    if (!pip(p.outer, x, z)) continue;
    if ((p.holes || []).some((h) => pip(h, x, z))) continue;
    return true;
  }
  return false;
}
// keeps runs of vertices inside the box plus one vertex on each side so lines do not float at the edge
function clipLine(points, box) {
  const runs = []; let cur = null;
  for (let i = 0; i < points.length; i++) {
    if (inBox(box, points[i][0], points[i][1])) {
      if (!cur) { cur = []; if (i > 0) cur.push(points[i - 1]); }
      cur.push(points[i]);
    } else if (cur) { cur.push(points[i]); runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.length >= 2);
}

function readLayer(src, layer, box) {
  const dir = path.join(src, layer), mp = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mp)) return { status: 'source-missing', features: [], path: dir };
  const manifest = readJson(mp), size = manifest.tileSize || 2000;
  const seen = new Set(), features = [], st = { sourceTiles: 0, missingTiles: 0, lines: 0, areas: 0, droppedOutside: 0, vertices: 0 };
  for (let tx = Math.floor(box.minX / size); tx <= Math.floor(box.maxX / size); tx++) {
    for (let tz = Math.floor(box.minZ / size); tz <= Math.floor(box.maxZ / size); tz++) {
      const p = path.join(dir, `tile_${tx}_${tz}.json`);
      if (!fs.existsSync(p)) { st.missingTiles++; continue; }
      st.sourceTiles++;
      for (const f of readJson(p).features || []) {
        if (!f || !Array.isArray(f.p) || seen.has(f.id)) continue;   // features are duplicated across tiles; dedupe by id
        seen.add(f.id);
        const base = {}; for (const [k, v] of Object.entries(f)) if (k !== 'p') base[k] = v;
        if (f.kind === 'area') {
          if (!f.p.some((pt) => inBox(box, pt[0], pt[1]))) { st.droppedOutside++; continue; }
          const ring = f.p.map((pt) => [r1(pt[0]), r1(pt[1])]);
          features.push({ ...base, p: ring }); st.areas++; st.vertices += ring.length;
        } else {
          const runs = clipLine(f.p, box);
          if (!runs.length) { st.droppedOutside++; continue; }
          runs.forEach((run, i) => {
            const line = run.map((pt) => [r1(pt[0]), r1(pt[1])]);
            features.push({ ...base, id: runs.length > 1 ? `${f.id}#${i}` : f.id, p: line }); st.lines++; st.vertices += line.length;
          });
        }
      }
    }
  }
  return { status: 'ok', manifest, features, stats: st };
}

function buildingPoints(extWardDir) {
  const dir = path.join(extWardDir, 'attrs'), pts = [];
  if (!fs.existsSync(dir)) return pts;
  for (const f of fs.readdirSync(dir)) {
    if (!/^t_-?\d+_-?\d+\.json$/.test(f)) continue;
    const j = readJson(path.join(dir, f));
    for (const v of Object.values(j.byId || {})) if (Array.isArray(v) && Number.isFinite(v[2]) && Number.isFinite(v[3])) pts.push([v[2], v[3]]);
  }
  return pts;
}

/** Quantitative alignment + "what is the white area" diagnosis, on a 100 m grid over the ward polygon. */
function analyze(ward, bpts, layers) {
  const CELL = 100, b = ward.bbox;
  const key = (x, z) => Math.floor(x / CELL) + '_' + Math.floor(z / CELL);
  const sets = { building: new Set(), road: new Set(), water: new Set(), park: new Set(), rail: new Set() };
  for (const [x, z] of bpts) sets.building.add(key(x, z));
  const mark = (set, f) => {   // sample along segments every ~CELL/2 so a long line marks every cell it crosses
    const p = f.p;
    if (f.kind === 'area') { for (const [x, z] of p) set.add(key(x, z)); return; }
    for (let i = 0; i + 1 < p.length; i++) {
      const n = Math.max(1, Math.ceil(Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]) / (CELL / 2)));
      for (let k = 0; k <= n; k++) set.add(key(p[i][0] + (p[i + 1][0] - p[i][0]) * k / n, p[i][1] + (p[i + 1][1] - p[i][1]) * k / n));
    }
  };
  for (const f of layers.roads || []) mark(sets.road, f);
  for (const f of layers.waterways || []) mark(sets.water, f);
  for (const f of layers.parks || []) mark(sets.park, f);
  for (const f of layers.railways || []) mark(sets.rail, f);
  let cells = 0, empty = 0, onlyWater = 0, withB = 0, withRoad = 0, bNoRoad = 0;
  for (let x = Math.floor(b.minX / CELL) * CELL; x <= b.maxX; x += CELL) {
    for (let z = Math.floor(b.minZ / CELL) * CELL; z <= b.maxZ; z += CELL) {
      if (!inWard(ward, x + CELL / 2, z + CELL / 2)) continue;
      cells++;
      const k = key(x + 1, z + 1), hb = sets.building.has(k), hr = sets.road.has(k), hw = sets.water.has(k), hp = sets.park.has(k), hl = sets.rail.has(k);
      if (hb) withB++; if (hr) withRoad++; if (hb && !hr) bNoRoad++;
      if (!hb && !hr && !hw && !hp && !hl) empty++;
      else if (!hb && !hr && hw && !hp && !hl) onlyWater++;
    }
  }
  let inside = 0; for (const [x, z] of bpts) if (inWard(ward, x, z)) inside++;
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (const [x, z] of bpts) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  return {
    gridCellM: CELL, wardCells: cells,
    buildingRepPoints: bpts.length, buildingPointsInsideWardPolygonPct: pct(inside, bpts.length),
    buildingBBoxLocal: bpts.length ? { minX: r1(bx0), maxX: r1(bx1), minZ: r1(bz0), maxZ: r1(bz1) } : null,
    wardBBoxLocal: b,
    cellsWithBuildingsPct: pct(withB, cells), cellsWithRoadsPct: pct(withRoad, cells),
    cellsWithBuildingsButNoRoadPct: pct(bNoRoad, cells),
    cellsWithNoDataAtAllPct: pct(empty, cells),   // no building, road, water, park or railway: "blank map" / no source data
    cellsWithOnlyWaterPct: pct(onlyWater, cells),  // blank because it is water (river/sea), not missing data
    interpretation: 'Blank cells that are neither building/road/park/rail nor water are source-data gaps (or unmapped land); '
      + 'cells with only water are water. A large blank share together with a high roads-per-building share means the source tiles lack coverage there.',
  };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const wards = readJson(a.wards).wards, ward = wards.find((w) => w.wardId === a.ward);
  if (!ward) throw new Error('unknown ward ' + a.ward);
  const extWard = path.join(a.ext, a.ward);
  if (!fs.existsSync(path.join(extWard, 'tileset.json'))) throw new Error('no converted tileset at ' + extWard + ' (run Mission 40C convert first)');
  const b = ward.bbox, box = { minX: b.minX - a.margin, maxX: b.maxX + a.margin, minZ: b.minZ - a.margin, maxZ: b.maxZ + a.margin };
  const out = path.join(extWard, 'layers');
  const report = { mission: '40G', ward: a.ward, wardCode: ward.wardCode, generatedAt: new Date().toISOString(), coordinateConvention: 'znorth-neg-v1 (x east, z south-positive; same local frame as buildings / N03 polygons)',
    clipBoxLocal: box, marginM: a.margin, source: 'OLD Live City tiled OSM layers (read-only): ' + a.src, layers: {} };
  const layerData = {};
  for (const l of LAYERS) {
    const r = readLayer(a.src, l, box);
    layerData[l] = r.features;
    report.layers[l] = r.status === 'ok' ? { status: 'ok', features: r.features.length, ...r.stats, sourceGeneratedAt: r.manifest.generatedAt || null } : { status: r.status, path: r.path };
    if (r.status === 'ok' && !a.checkOnly) {
      fs.mkdirSync(out, { recursive: true });
      const file = path.join(out, l + '.json');
      if (fs.existsSync(file)) throw new Error('refusing to overwrite ' + file);
      fs.writeFileSync(file, JSON.stringify({ layer: l, mission: '40G', ward: a.ward, coordinateConvention: 'znorth-neg-v1', coordinateSystem: 'local-meters', bboxLocal: box, count: r.features.length, features: r.features }));
      report.layers[l].bytes = fs.statSync(file).size;
    }
  }
  report.alignment = analyze(ward, buildingPoints(extWard), layerData);
  console.log(JSON.stringify(report, null, 2));
  if (!a.checkOnly) {
    fs.mkdirSync(out, { recursive: true });
    const rp = path.join(out, 'layers-report.json');
    if (fs.existsSync(rp)) throw new Error('refusing to overwrite ' + rp);
    fs.writeFileSync(rp, JSON.stringify(report, null, 2));
  }
  if (Object.values(report.layers).every((l) => l.status !== 'ok')) process.exitCode = 2;
}
module.exports = { clipLine, inWard, analyze, readLayer, parseArgs };
if (require.main === module) { try { main(); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); } }
