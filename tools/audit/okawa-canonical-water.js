#!/usr/bin/env node
// tools/audit/okawa-canonical-water.js
// [Mission 31A §11] 大川を canonical water polygon 化する前提の監査。
//   current ribbon area / polygon source area / width profile / building overlap / road overlap / confidence。
//   ※ RiverLayerV2 は置換しない。読み取り専用の監査。
//   出力: data/reports/okawa-canonical-water-audit.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { normalizeRiverName } from '../lib/river-network.js';
import { polygonAreaM2, ringAreaM2, bboxOf } from '../lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON_WATER = P('data', 'processed', 'osaka-city', 'canonical', 'water.json');
const WATERWAYS_DIR = P('public', 'map-data', 'osaka-city', 'waterways');
const RIVERS = P('public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json');
const BUILD_DIR = P('public', 'map-data', 'osaka-city', 'buildings');
const ROADS_DIR = P('public', 'map-data', 'osaka-city', 'roads');
const REPORT = P('data', 'reports', 'okawa-canonical-water-audit.json');

const TARGET = '大川';
const GRID_M = 4;

function pointInRing(x, z, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) ins = !ins;
  }
  return ins;
}
function bboxHit(b, bb) { return !(b.maxX < bb.minX || b.minX > bb.maxX || b.maxZ < bb.minZ || b.minZ > bb.maxZ); }
function ringBbox(ring) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const [x, z] of ring) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
  return { minX: a, maxX: b, minZ: c, maxZ: d };
}
function distToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az; const l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function loadWaterwayAreas() {
  const byId = new Map();
  for (const f of fs.readdirSync(WATERWAYS_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(WATERWAYS_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) if (ft.kind === 'area' && !byId.has(ft.id)) byId.set(ft.id, ft);
  }
  return [...byId.values()];
}
function loadBuildingsNear(bb) {
  const out = [];
  for (const ds of fs.readdirSync(BUILD_DIR)) {
    const dp = path.join(BUILD_DIR, ds);
    if (!fs.statSync(dp).isDirectory() || ds === 'unclassified') continue;
    for (const f of fs.readdirSync(dp)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      const t = JSON.parse(fs.readFileSync(path.join(dp, f), 'utf-8'));
      for (const b of (t.buildings || [])) {
        if (!Array.isArray(b.fp) || b.fp.length < 3) continue;
        const rb = ringBbox(b.fp);
        if (bboxHit(rb, bb)) out.push({ fp: b.fp, rb, source: (ds === 'osaka-osm-fallback' ? 'osm-fallback' : 'plateau') });
      }
    }
  }
  return out;
}
function loadRoadSegsNear(bb) {
  const segs = [];
  for (const f of fs.readdirSync(ROADS_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(ROADS_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (ft.kind !== 'line' || !Array.isArray(ft.p)) continue;
      for (let i = 0; i + 1 < ft.p.length; i++) {
        const a = ft.p[i], c = ft.p[i + 1];
        const sb = { minX: Math.min(a[0], c[0]) - 12, maxX: Math.max(a[0], c[0]) + 12, minZ: Math.min(a[1], c[1]) - 12, maxZ: Math.max(a[1], c[1]) + 12 };
        if (bboxHit(sb, bb)) segs.push([a[0], a[1], c[0], c[1], ft.highway || 'road']);
      }
    }
  }
  return segs;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const key = normalizeRiverName(TARGET);
  const rivers = JSON.parse(fs.readFileSync(RIVERS, 'utf-8')).rivers || [];
  const segs = rivers.filter((r) => r.ok && (r.normName === key || (r.name && normalizeRiverName(r.name) === key)));
  if (!segs.length) {
    await writeJson(REPORT, { generatedAt, target: TARGET, resolved: false, RESULT: 'FAIL' });
    console.log('[okawa-canonical-water] 大川 が rivers.json に無い'); process.exitCode = 1; return;
  }

  // ── current ribbon（canonical water feature）──
  const canon = fs.existsSync(CANON_WATER) ? JSON.parse(fs.readFileSync(CANON_WATER, 'utf-8')) : { features: [] };
  const canonFeats = (canon.features || []).filter((f) => f.attributes && f.attributes.name === TARGET && f.source.geometrySource === 'osm-waterway-centerline');
  let ribbonArea = 0;
  const ribbonRings = [];
  for (const f of canonFeats) { ribbonArea += polygonAreaM2(f.geometryType, f.coordinates); ribbonRings.push(f.coordinates[0]); }
  for (const r of segs) if (!canonFeats.length && Array.isArray(r.left) && Array.isArray(r.right)) {
    const ring = r.left.concat(r.right.slice().reverse());
    ribbonRings.push(ring); ribbonArea += ringAreaM2(ring);
  }

  // ── polygon source（OSM riverbank / water=river polygon で 大川 と重なるもの）──
  const areas = loadWaterwayAreas();
  const ribbonBbox = bboxOf(ribbonRings);
  const expand = (bb, m) => ({ minX: bb.minX - m, maxX: bb.maxX + m, minZ: bb.minZ - m, maxZ: bb.maxZ + m });
  const searchBb = expand(ribbonBbox, 60);
  const polySources = areas.filter((a) => {
    if (a.waterClass !== 'river' && a.subtype !== 'water') return false;
    const ab = ringBbox(a.p);
    if (!bboxHit(ab, searchBb)) return false;
    // 大川 centerline のいずれかの点を含むか
    const cl = segs.flatMap((s) => s.centerline || []);
    return cl.some(([x, z]) => pointInRing(x, z, a.p));
  });
  const polySourceArea = polySources.reduce((s, a) => s + ringAreaM2(a.p), 0);

  // ── width profile ──
  const widthProfile = segs.map((r) => ({
    id: r.id, method: r.widthMethod, min: r.widthMin, median: r.widthMedian, max: r.widthMax, p95: r.widthP95,
    matchedRiverbanks: r.widthMatchedRiverbanks || 0, sampleCount: r.widthSampleCount || 0,
    widthsStat: (() => { const a = (r.widths || []).filter(Number.isFinite).sort((x, y) => x - y); return a.length ? { min: +a[0].toFixed(1), median: +a[Math.floor(a.length / 2)].toFixed(1), max: +a[a.length - 1].toFixed(1) } : null; })(),
  }));

  // ── overlap（grid サンプリング）──
  const bld = loadBuildingsNear(expand(ribbonBbox, 20));
  const roadSegs = loadRoadSegsNear(expand(ribbonBbox, 20));
  let inside = 0, inBuilding = 0, nearRoad = 0;
  const bldHitSrc = { plateau: 0, 'osm-fallback': 0 };
  for (let x = ribbonBbox.minX; x <= ribbonBbox.maxX; x += GRID_M) {
    for (let z = ribbonBbox.minZ; z <= ribbonBbox.maxZ; z += GRID_M) {
      if (!ribbonRings.some((ring) => pointInRing(x, z, ring))) continue;
      inside++;
      let hitB = null;
      for (const b of bld) { if (b.rb.minX <= x && x <= b.rb.maxX && b.rb.minZ <= z && z <= b.rb.maxZ && pointInRing(x, z, b.fp)) { hitB = b.source; break; } }
      if (hitB) { inBuilding++; bldHitSrc[hitB]++; }
      let nr = false;
      for (const s of roadSegs) { if (distToSeg(x, z, s[0], s[1], s[2], s[3]) <= 6) { nr = true; break; } }
      if (nr) nearRoad++;
    }
  }
  const cellArea = GRID_M * GRID_M;

  const confidence = {
    currentRibbon: canonFeats.length ? canonFeats[0].source.confidence : null,
    ifPolygonSource: polySources.length ? 0.90 : null,
    note: 'polygon source があれば canonical geometry を osm-riverbank(0.90) へ引き上げられる。',
  };

  const report = {
    generatedAt, target: TARGET, resolved: true,
    segmentCount: segs.length,
    sourceIds: segs.map((r) => (r.source && r.source.id ? `${r.source.type || 'way'}/${r.source.id}` : r.id)),
    currentRibbon: {
      areaM2: Math.round(ribbonArea),
      bbox: ribbonBbox,
      centerlineLengthM: Math.round(segs.reduce((s, r) => s + (r.centerlineLength || 0), 0)),
      widthMethod: [...new Set(segs.map((r) => r.widthMethod))],
    },
    polygonSource: {
      count: polySources.length,
      sourceIds: polySources.map((a) => (a.source && a.source.id ? `${a.source.type || 'way'}/${a.source.id}` : a.id)),
      areaM2: Math.round(polySourceArea),
      areaRatioVsRibbon: ribbonArea > 0 ? +(polySourceArea / ribbonArea).toFixed(3) : null,
    },
    widthProfile,
    overlap: {
      gridM: GRID_M,
      sampledInteriorCells: inside,
      interiorAreaM2: Math.round(inside * cellArea),
      buildingOverlap: { cells: inBuilding, areaM2: Math.round(inBuilding * cellArea), fraction: inside ? +(inBuilding / inside).toFixed(4) : 0, bySource: bldHitSrc },
      roadOverlap: { cells: nearRoad, areaM2: Math.round(nearRoad * cellArea), fraction: inside ? +(nearRoad / inside).toFixed(4) : 0, note: 'road centerline から 6m 以内の水面セル' },
    },
    confidence,
    migrationReadiness: {
      hasPolygonSource: polySources.length > 0,
      widthBackedByRiverbank: segs.some((r) => (r.widthMatchedRiverbanks || 0) >= 6),
      recommendation: polySources.length > 0
        ? '31B: geometry を osm-riverbank polygon へ差し替え、confidence 0.90 へ。'
        : '31B: riverbank polygon が無いため ribbon(measured 幅) を維持。confidence 0.78。',
    },
    RESULT: 'AUDIT-DONE',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[okawa-canonical-water] 大川:');
  console.log('  current ribbon area ' + Math.round(ribbonArea) + ' m² / centerline ' + report.currentRibbon.centerlineLengthM + ' m / widthMethod ' + report.currentRibbon.widthMethod.join(','));
  console.log('  polygon source: ' + polySources.length + ' 枚 / area ' + Math.round(polySourceArea) + ' m² (ribbon 比 ' + report.polygonSource.areaRatioVsRibbon + ')');
  console.log('  overlap: building ' + report.overlap.buildingOverlap.fraction + ' (' + JSON.stringify(bldHitSrc) + ') / road ' + report.overlap.roadOverlap.fraction);
  console.log('  migration: ' + report.migrationReadiness.recommendation);
  console.log('保存: ' + toProjectRelativePath(REPORT));
}

main().catch((e) => { console.error('[okawa-canonical-water] 失敗:', e && e.stack || e); process.exit(1); });
