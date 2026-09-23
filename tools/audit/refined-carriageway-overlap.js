#!/usr/bin/env node
// tools/audit/refined-carriageway-overlap.js
// [Mission 31G-FIX13 §14] Building ∩ Road を 3 種類に分けて計測する。
//   1. Building ∩ CanonicalRoad          … source truth（PLATEAU 道路区域全体）
//   2. Building ∩ CurrentVisualRoad(FIX12) … primary/bridge（ROADWAY 全体を車道扱い）
//   3. Building ∩ RefinedCarriageway(FIX13) … primary/bridge（CARRIAGEWAY/INTERSECTION/RAMP。
//      SIDEWALK/MEDIAN を車道から除外した後の面）
//
//   source truth overlap（1）と、表示上の道路 overlap（2・3）を区別する（§14）。
//   source / canonical geometry は一切変更しない（読み取りのみ）。
//   重なり面積は footprint 5 点サンプル × point-in-road-polygon の面積按分近似（turf 不使用）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const FIX12_CLASS = P('data', 'processed', 'osaka-city', 'derived', 'road-render-class.json');
const FIX13_CLASS = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const OUT = P('data', 'reports', 'refined-carriageway-overlap.json');

const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function pointInPoly(x, z, poly) {
  if (!poly.length || !pointInRing(x, z, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) if (pointInRing(x, z, poly[h])) return false;
  return true;
}
function polysOf(ft) { return ft.geometryType === 'Polygon' ? [ft.coordinates] : (ft.coordinates || []); }
function samplePoints(ft) {
  const b = ft.bbox; const c = ft.centroid || [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
  const qx = (b.maxX - b.minX) / 4, qz = (b.maxZ - b.minZ) / 4;
  const mx = (b.minX + b.maxX) / 2, mz = (b.minZ + b.maxZ) / 2;
  return [[c[0], c[1]], [mx - qx, mz - qz], [mx + qx, mz - qz], [mx - qx, mz + qz], [mx + qx, mz + qz]];
}

function loadFix12() {
  const rc = JSON.parse(fs.readFileSync(FIX12_CLASS, 'utf-8'));
  const m = new Map();
  for (const [id, v] of Object.entries(rc.classMap || {})) m.set(id, v.rs);
  return m;
}
function loadFix13() {
  const rc = JSON.parse(fs.readFileSync(FIX13_CLASS, 'utf-8'));
  const pfx = rc.keyPrefix || '';
  const codes = rc.rsCodes || {};
  const m = new Map();
  for (const [k, code] of Object.entries(rc.classMap || {})) m.set(pfx + k, codes[code] || code);
  return m;
}

const CELL = 250;
const ckey = (cx, cz) => cx + ',' + cz;
function addToGrid(grid, ft, rs12, rs13) {
  const b = ft.bbox;
  const entry = { polys: polysOf(ft), bbox: b, rs12, rs13, area: ft.areaM2 || 0 };
  const x0 = Math.floor(b.minX / CELL), x1 = Math.floor(b.maxX / CELL);
  const z0 = Math.floor(b.minZ / CELL), z1 = Math.floor(b.maxZ / CELL);
  for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
    const k = ckey(cx, cz); let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(entry);
  }
}

async function main() {
  const generatedAt = new Date().toISOString();
  const rs12ById = loadFix12();
  const rs13ById = loadFix13();

  console.log('[refined-overlap] loading canonical roads → grid ...');
  const grid = new Map();
  let roadFeat = 0, roadAreaAll = 0;
  const areaByRs12 = {}, areaByRs13 = {};
  const seenRoad = new Set();
  for (const f of fs.readdirSync(CANON_ROADS).filter(isTile)) {
    const t = JSON.parse(fs.readFileSync(path.join(CANON_ROADS, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (!ft.bbox || seenRoad.has(ft.canonicalId)) continue;
      seenRoad.add(ft.canonicalId);
      roadFeat++; roadAreaAll += ft.areaM2 || 0;
      const rs12 = rs12ById.get(ft.canonicalId) || 'primary';
      const rs13 = rs13ById.get(ft.canonicalId) || 'primary';
      areaByRs12[rs12] = (areaByRs12[rs12] || 0) + (ft.areaM2 || 0);
      areaByRs13[rs13] = (areaByRs13[rs13] || 0) + (ft.areaM2 || 0);
      addToGrid(grid, ft, rs12, rs13);
    }
  }
  console.log('  roads', roadFeat, ' gridCells', grid.size);

  const VISUAL12 = new Set(['primary', 'bridge']);          // FIX12: ROADWAY/INTERSECTION/RAMP + BRIDGE
  const CARRIAGEWAY13 = new Set(['primary', 'bridge']);      // FIX13: CARRIAGEWAY/INTERSECTION/RAMP + BRIDGE

  console.log('[refined-overlap] scanning canonical buildings ...');
  let bldgFeat = 0, bldgArea = 0;
  let ovCanonicalArea = 0, ovFix12Area = 0, ovFix13Area = 0;
  let onCanonicalCount = 0, onFix12Count = 0, onFix13Count = 0;
  const files = fs.readdirSync(CANON_BLDGS).filter(isTile);
  let done = 0;
  for (const f of files) {
    const t = JSON.parse(fs.readFileSync(path.join(CANON_BLDGS, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (!ft.bbox) continue;
      bldgFeat++; const a = ft.areaM2 || 0; bldgArea += a;
      const pts = samplePoints(ft);
      const cx0 = Math.floor(ft.bbox.minX / CELL), cx1 = Math.floor(ft.bbox.maxX / CELL);
      const cz0 = Math.floor(ft.bbox.minZ / CELL), cz1 = Math.floor(ft.bbox.maxZ / CELL);
      const cand = []; const seen = new Set();
      for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
        const arr = grid.get(ckey(cx, cz)); if (!arr) continue;
        for (const e of arr) { if (seen.has(e)) continue; seen.add(e); cand.push(e); }
      }
      if (!cand.length) continue;
      let hitCanonical = 0, hitFix12 = 0, hitFix13 = 0;
      for (const [px, pz] of pts) {
        let inCanonical = false, inFix12 = false, inFix13 = false;
        for (const e of cand) {
          const b = e.bbox;
          if (px < b.minX || px > b.maxX || pz < b.minZ || pz > b.maxZ) continue;
          let inside = false;
          for (const poly of e.polys) if (pointInPoly(px, pz, poly)) { inside = true; break; }
          if (!inside) continue;
          inCanonical = true;
          if (VISUAL12.has(e.rs12)) inFix12 = true;
          if (CARRIAGEWAY13.has(e.rs13)) inFix13 = true;
          if (inFix12 && inFix13) break;
        }
        if (inCanonical) hitCanonical++;
        if (inFix12) hitFix12++;
        if (inFix13) hitFix13++;
      }
      const n = pts.length;
      ovCanonicalArea += a * (hitCanonical / n);
      ovFix12Area += a * (hitFix12 / n);
      ovFix13Area += a * (hitFix13 / n);
      if (hitCanonical > n / 2) onCanonicalCount++;
      if (hitFix12 > n / 2) onFix12Count++;
      if (hitFix13 > n / 2) onFix13Count++;
    }
    if (++done % 200 === 0) console.log('  tiles', done + '/' + files.length, ' bldg', bldgFeat);
  }

  const report = {
    generatedAt,
    method: 'footprint 5-point sampling × point-in-road-polygon（面積按分近似・turf 不使用）',
    canonicalRoadFeatureCount: roadFeat,
    canonicalRoadAreaM2: Math.round(roadAreaAll),
    canonicalBuildingCount: bldgFeat,
    canonicalBuildingAreaM2: Math.round(bldgArea),
    // 1. Building ∩ CanonicalRoad（source truth 全体）
    buildingOnCanonicalRoadAreaM2: Math.round(ovCanonicalArea),
    buildingsMostlyOnCanonicalRoad: onCanonicalCount,
    // 2. Building ∩ CurrentVisualRoad（FIX12: ROADWAY/INTERSECTION/RAMP + BRIDGE）
    buildingOnFix12VisualRoadAreaM2: Math.round(ovFix12Area),
    buildingsMostlyOnFix12VisualRoad: onFix12Count,
    // 3. Building ∩ RefinedCarriageway（FIX13: CARRIAGEWAY/INTERSECTION/RAMP + BRIDGE。SIDEWALK/MEDIAN 除外後）
    buildingOnRefinedCarriagewayAreaM2: Math.round(ovFix13Area),
    buildingsMostlyOnRefinedCarriageway: onFix13Count,
    // 差分
    reductionCanonicalToFix12: +(1 - ovFix12Area / (ovCanonicalArea || 1)).toFixed(3),
    reductionCanonicalToFix13: +(1 - ovFix13Area / (ovCanonicalArea || 1)).toFixed(3),
    reductionFix12ToFix13: +(1 - ovFix13Area / (ovFix12Area || 1)).toFixed(3),
    buildingsFreedFix12ToFix13: onFix12Count - onFix13Count,
    roadAreaByFix12RsM2: Object.fromEntries(Object.entries(areaByRs12).map(([k, v]) => [k, Math.round(v)])),
    roadAreaByFix13RsM2: Object.fromEntries(Object.entries(areaByRs13).map(([k, v]) => [k, Math.round(v)])),
    sourceGeometryMutated: false,
    buildingGeometryMutated: false,
    RESULT: 'AUDIT-DONE',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await writeJson(OUT, report);
  console.log(JSON.stringify(report, null, 2));
  console.log('→', toProjectRelativePath(OUT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[refined-overlap] 失敗:', e && e.stack || e); process.exit(1); });
