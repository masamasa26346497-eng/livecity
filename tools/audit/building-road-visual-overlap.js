#!/usr/bin/env node
// tools/audit/building-road-visual-overlap.js
// [Mission 31G-FIX12 §8] Building ∩ Canonical Road と Building ∩ Road Visual Surface を比較する。
//
//   Canonical Road polygon（PLATEAU 道路区域 = roadway + 歩道 + 法面 + 植樹帯 + setback）を
//   全面 road 色で塗ると、区域の縁に接する建物が「道路に乗って見える」。
//   renderClass（road-render-class.json）で primary（ROADWAY/INTERSECTION/RAMP）+ bridge のみを
//   「濃い道路面 = Road Visual Surface」として描くと、その重なりがどれだけ減るかを面積で測る。
//
//   source / canonical geometry は一切変更しない（読み取りのみ）。
//   重なり面積は footprint のサンプリング点 in road-polygon で近似（turf 不使用・ネットワーク不可環境）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const RENDER_CLASS = P('data', 'processed', 'osaka-city', 'derived', 'road-render-class.json');
const OUT = P('data', 'reports', 'building-road-visual-overlap.json');

const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

// ── 点 in ポリゴン（ring 配列: 外環 + 穴）──
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
function polysOf(ft) {
  return ft.geometryType === 'Polygon' ? [ft.coordinates] : (ft.coordinates || []);
}
// footprint のサンプル点（centroid + bbox を 4 分割した内側点）→ 面積按分の近似
function samplePoints(ft) {
  const b = ft.bbox; const c = ft.centroid || [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
  const qx = (b.maxX - b.minX) / 4, qz = (b.maxZ - b.minZ) / 4;
  const mx = (b.minX + b.maxX) / 2, mz = (b.minZ + b.maxZ) / 2;
  return [
    [c[0], c[1]],
    [mx - qx, mz - qz], [mx + qx, mz - qz], [mx - qx, mz + qz], [mx + qx, mz + qz],
  ];
}

function loadRenderClass() {
  const rc = JSON.parse(fs.readFileSync(RENDER_CLASS, 'utf-8'));
  const m = new Map();
  for (const [id, v] of Object.entries(rc.classMap || {})) m.set(id, v.rs);
  return m;
}

// 道路 polygon の格子インデックス（250m セル）
const CELL = 250;
const ckey = (cx, cz) => cx + ',' + cz;
function addToGrid(grid, ft, visualRs) {
  const rs = visualRs; // 'primary' なら index に無い
  const b = ft.bbox;
  const entry = { polys: polysOf(ft), bbox: b, rs, area: ft.areaM2 || 0 };
  const x0 = Math.floor(b.minX / CELL), x1 = Math.floor(b.maxX / CELL);
  const z0 = Math.floor(b.minZ / CELL), z1 = Math.floor(b.maxZ / CELL);
  for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
    const k = ckey(cx, cz); let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(entry);
  }
}

async function main() {
  const generatedAt = new Date().toISOString();
  const rsById = loadRenderClass();

  // ── 道路を格子へ ──
  console.log('[overlap] loading canonical roads → grid ...');
  const grid = new Map();
  let roadFeat = 0, roadAreaAll = 0;
  const areaByRs = {};
  const seenRoad = new Set();
  for (const f of fs.readdirSync(CANON_ROADS).filter(isTile)) {
    const t = JSON.parse(fs.readFileSync(path.join(CANON_ROADS, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (!ft.bbox) continue;
      if (seenRoad.has(ft.canonicalId)) continue;
      seenRoad.add(ft.canonicalId);
      roadFeat++; roadAreaAll += ft.areaM2 || 0;
      const rs = rsById.get(ft.canonicalId) || 'primary';
      areaByRs[rs] = (areaByRs[rs] || 0) + (ft.areaM2 || 0);
      addToGrid(grid, ft, rs);
    }
  }
  console.log('  roads', roadFeat, ' gridCells', grid.size);

  // Road Visual Surface = primary + bridge（濃い不透明道路面）。secondary も比較用に集計。
  const VISUAL = new Set(['primary', 'bridge']);
  const VISUAL_PLUS = new Set(['primary', 'bridge', 'secondary']);

  // ── 建物ごとに重なりを測る ──
  console.log('[overlap] scanning canonical buildings ...');
  let bldgFeat = 0, bldgArea = 0;
  let ovAllArea = 0, ovVisualArea = 0, ovVisualPlusArea = 0;
  let onAllCount = 0, onVisualCount = 0;          // サンプル過半が road 上の棟数
  const bins = { all: 0, visual: 0 };
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
      const cand = [];
      const seen = new Set();
      for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
        const arr = grid.get(ckey(cx, cz)); if (!arr) continue;
        for (const e of arr) { if (seen.has(e)) continue; seen.add(e); cand.push(e); }
      }
      if (!cand.length) continue;
      let hitAll = 0, hitVisual = 0, hitVisualPlus = 0;
      for (const [px, pz] of pts) {
        let inAll = false, inVisual = false, inVisualPlus = false;
        for (const e of cand) {
          const b = e.bbox;
          if (px < b.minX || px > b.maxX || pz < b.minZ || pz > b.maxZ) continue;
          let inside = false;
          for (const poly of e.polys) if (pointInPoly(px, pz, poly)) { inside = true; break; }
          if (!inside) continue;
          inAll = true;
          if (VISUAL.has(e.rs)) inVisual = true;
          if (VISUAL_PLUS.has(e.rs)) inVisualPlus = true;
          if (inVisual) break;
        }
        if (inAll) hitAll++;
        if (inVisual) hitVisual++;
        if (inVisualPlus) hitVisualPlus++;
      }
      const n = pts.length;
      ovAllArea += a * (hitAll / n);
      ovVisualArea += a * (hitVisual / n);
      ovVisualPlusArea += a * (hitVisualPlus / n);
      if (hitAll > n / 2) { onAllCount++; bins.all++; }
      if (hitVisual > n / 2) { onVisualCount++; bins.visual++; }
    }
    if (++done % 200 === 0) console.log('  tiles', done + '/' + files.length, ' bldg', bldgFeat);
  }

  const report = {
    generatedAt,
    method: 'footprint 5-point sampling × point-in-road-polygon（面積按分近似・turf 不使用）',
    canonicalRoadFeatureCount: roadFeat,
    canonicalRoadAreaM2: Math.round(roadAreaAll),
    roadAreaByRsM2: Object.fromEntries(Object.entries(areaByRs).map(([k, v]) => [k, Math.round(v)])),
    visualRoadSurfaceRs: ['primary', 'bridge'],
    canonicalBuildingCount: bldgFeat,
    canonicalBuildingAreaM2: Math.round(bldgArea),
    buildingOnCanonicalRoadAreaM2: Math.round(ovAllArea),
    buildingOnVisualRoadAreaM2: Math.round(ovVisualArea),
    buildingOnVisualPlusSecondaryAreaM2: Math.round(ovVisualPlusArea),
    overlapReductionRatio: +(1 - ovVisualArea / (ovAllArea || 1)).toFixed(3),
    buildingsMostlyOnCanonicalRoad: onAllCount,
    buildingsMostlyOnVisualRoad: onVisualCount,
    buildingsFreedFromVisualRoad: onAllCount - onVisualCount,
    sourceGeometryMutated: false,
    buildingGeometryMutated: false,
    RESULT: 'AUDIT-DONE',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await writeJson(OUT, report);
  console.log(JSON.stringify(report, null, 2));
  console.log('→', toProjectRelativePath(OUT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[overlap] 失敗:', e && e.stack || e); process.exit(1); });
