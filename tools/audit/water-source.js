#!/usr/bin/env node
// tools/audit/water-source.js
// P1-6F: 水域 normalized feature を OSM source（way / relation + member ways）まで遡って解析する。
//   巨大 feature が「壊れた assemble 結果」なのか「実在の大河川」なのかを切り分けるための監査。
//
// 実行: node tools/audit/water-source.js [--raw data/raw/osaka-city/waterways-osm.json] [--area osaka-city] [--top 20]
// 出力: data/reports/water-source-audit.json（+ 上位を stdout）

import fs from 'node:fs';
import path from 'node:path';
import { loadAreaConfig, writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { convertCoordsArray, geoToLocal } from '../lib/projection.js';
import { assembleMultipolygon } from '../lib/osm-multipolygon.js';
import { buildWardIndex, featureWardOverlap } from '../lib/feature-ward-overlap.js';

function parseArgs(argv) {
  const a = { raw: 'data/raw/osaka-city/waterways-osm.json', area: 'osaka-city', top: 20, report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--raw') a.raw = argv[++i];
    else if (argv[i] === '--area') a.area = argv[++i];
    else if (argv[i] === '--top') a.top = parseInt(argv[++i], 10) || 20;
    else if (argv[i] === '--report') a.report = argv[++i];
  }
  return a;
}

function negZ(pts) { return pts.map(([x, z]) => [x, -z]); }
function ringStats(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const edges = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    edges.push(Math.hypot(a[0] - b[0], a[1] - b[1]));
    if (a[0] < minX) minX = a[0]; if (a[0] > maxX) maxX = a[0];
    if (a[1] < minZ) minZ = a[1]; if (a[1] > maxZ) maxZ = a[1];
  }
  edges.sort((x, y) => x - y);
  let area = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; area += p[0] * q[1] - q[0] * p[1]; }
  return {
    points: ring.length,
    bbox: { w: Math.round(maxX - minX), h: Math.round(maxZ - minZ), diag: Math.round(Math.hypot(maxX - minX, maxZ - minZ)) },
    area: Math.round(Math.abs(area / 2)),
    maxEdge: Math.round(edges[edges.length - 1] || 0),
    medianEdge: +(edges[Math.floor(edges.length / 2)] || 0).toFixed(1),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const area = await loadAreaConfig(args.area);
  const proj = area.projection;
  const raw = JSON.parse(fs.readFileSync(resolveProjectPath(args.raw), 'utf-8'));
  const els = raw.elements || raw;

  let wardIndex = null;
  const wpPath = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
  if (fs.existsSync(wpPath)) wardIndex = buildWardIndex(JSON.parse(fs.readFileSync(wpPath, 'utf-8').replace(/^﻿/, '')));

  const entries = [];

  for (const el of els) {
    const tags = el.tags || {};
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      const isArea = tags.natural === 'water' || tags.water || tags.waterway === 'riverbank';
      if (!isArea) continue;
      const coords = el.geometry.map((p) => [p.lon, p.lat]);
      let xz = negZ(convertCoordsArray(coords, proj));
      const closedByCoord = xz.length > 2 && Math.hypot(xz[0][0] - xz[xz.length - 1][0], xz[0][1] - xz[xz.length - 1][1]) < 0.5;
      if (closedByCoord) xz = xz.slice(0, -1);
      if (xz.length < 3) continue;
      const st = ringStats(xz);
      const ov = wardIndex ? featureWardOverlap(xz, wardIndex, { bufferM: 500 }) : { inCount: -1, total: 0, wards: [] };
      const g = el.geometry;
      const startEndGapM = Math.hypot(geoToLocal(g[0].lat, g[0].lon, proj).x - geoToLocal(g[g.length - 1].lat, g[g.length - 1].lon, proj).x,
        geoToLocal(g[0].lat, g[0].lon, proj).z - geoToLocal(g[g.length - 1].lat, g[g.length - 1].lon, proj).z);
      entries.push({
        sourceType: 'way', sourceId: el.id, name: tags.name || '', tags,
        outerRingCount: 1, innerRingCount: 0, memberWayCount: 1, memberWayIds: [el.id],
        outerPointCounts: [st.points], bbox: st.bbox, area: st.area, maxEdge: st.maxEdge, medianEdge: st.medianEdge,
        closedBeforeNormalization: Math.round(startEndGapM) < 1, closedAfterNormalization: true,
        wardOverlap: { inCount: ov.inCount, total: ov.total, wards: ov.wards },
        keptByWardFilter: ov.inCount !== 0,
      });
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      const isWater = tags.natural === 'water' || tags.waterway === 'riverbank' || tags.water;
      if (!isWater) continue;
      const asm = assembleMultipolygon(el.members);
      const outers = el.members.filter((m) => m.type === 'way' && (m.role === 'outer' || !m.role));
      const inners = el.members.filter((m) => m.type === 'way' && m.role === 'inner');
      for (const [pi, poly] of asm.polygons.entries()) {
        let xz = negZ(convertCoordsArray(poly.outer, proj));
        if (xz.length > 2 && Math.hypot(xz[0][0] - xz[xz.length - 1][0], xz[0][1] - xz[xz.length - 1][1]) < 0.5) xz = xz.slice(0, -1);
        const st = ringStats(xz);
        const ov = wardIndex ? featureWardOverlap(xz, wardIndex, { bufferM: 500 }) : { inCount: -1, total: 0, wards: [] };
        entries.push({
          sourceType: 'relation', sourceId: el.id, polygonIndex: pi, name: tags.name || '', tags,
          relationOuterWayCount: outers.length, relationInnerWayCount: inners.length,
          outerRingCount: asm.polygons.length, innerRingCount: poly.holes.length,
          memberWayCount: (poly.memberWayIds || []).length, memberWayIds: poly.memberWayIds || [],
          memberWayRoles: outers.map((m) => m.role || '(none)'),
          outerPointCounts: [st.points], bbox: st.bbox, area: st.area, maxEdge: st.maxEdge, medianEdge: st.medianEdge,
          unclosedFragments: asm.unclosed.length,
          closedBeforeNormalization: null, // relation は member way 群なので単一 gap の概念なし
          closedAfterNormalization: true,   // asm.polygons は閉じたリングのみ
          wardOverlap: { inCount: ov.inCount, total: ov.total, wards: ov.wards },
          keptByWardFilter: ov.inCount !== 0,
        });
      }
      if (asm.unclosed.length) {
        entries.push({
          sourceType: 'relation', sourceId: el.id, name: tags.name || '', tags,
          UNCLOSED: true, fragments: asm.unclosed.map((f) => ({ role: f.role, points: f.points, wayIds: f.wayIds })),
          closedAfterNormalization: false, keptByWardFilter: false,
        });
      }
    }
  }

  const areas = entries.filter((e) => !e.UNCLOSED);
  areas.sort((a, b) => (b.bbox.diag || 0) - (a.bbox.diag || 0));
  const topByDiag = areas.slice(0, args.top);
  const topByArea = [...areas].sort((a, b) => b.area - a.area).slice(0, args.top);
  const droppedByWardFilter = areas.filter((e) => e.keptByWardFilter === false);

  const report = {
    generatedAt: new Date().toISOString(), raw: toProjectRelativePath(resolveProjectPath(args.raw)),
    totals: {
      wayAreas: entries.filter((e) => e.sourceType === 'way').length,
      relationPolygons: areas.filter((e) => e.sourceType === 'relation').length,
      unclosedRelations: entries.filter((e) => e.UNCLOSED).length,
      droppedByWardFilter: droppedByWardFilter.length,
    },
    droppedByWardFilter: droppedByWardFilter.map((e) => ({ sourceType: e.sourceType, sourceId: e.sourceId, name: e.name, bbox: e.bbox, wardOverlap: e.wardOverlap })),
    topByBboxDiagonal: topByDiag,
    topByPolygonArea: topByArea,
    unclosed: entries.filter((e) => e.UNCLOSED),
  };
  const reportPath = resolveProjectPath(args.report || path.join('data', 'reports', 'water-source-audit.json'));
  await writeJson(reportPath, report);

  console.log('=== water source audit ===');
  console.log(`way areas: ${report.totals.wayAreas} / relation polygons: ${report.totals.relationPolygons} / unclosed relations: ${report.totals.unclosedRelations}`);
  console.log(`24区外フィルタで除外される見込み: ${report.totals.droppedByWardFilter}`);
  console.log(`\n--- top ${args.top} by bbox diagonal ---`);
  for (const e of topByDiag) {
    console.log(`  ${e.sourceType}/${e.sourceId}${e.polygonIndex != null ? '#' + e.polygonIndex : ''} [${e.name || '(no name)'}] ` +
      `${JSON.stringify(e.tags.water || e.tags.natural || '')} diag=${e.bbox.diag}m area=${e.area}m² maxEdge=${e.maxEdge}m ` +
      `outerWays=${e.relationOuterWayCount || 1}→rings=${e.outerRingCount} inner=${e.innerRingCount} ` +
      `wardIn=${e.wardOverlap.inCount}/${e.wardOverlap.total} kept=${e.keptByWardFilter}`);
  }
  console.log(`\n保存: ${toProjectRelativePath(reportPath)}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error('audit エラー:', e.message, e.stack); process.exit(1); });
}

export { main };
