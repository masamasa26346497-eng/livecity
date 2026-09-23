#!/usr/bin/env node
// tools/audit/building-coverage.js
// [Mission21B] 大阪市24区の建物 coverage 監査レポートを生成する。
//   実装順 A(raw)→B(classification)→C(tile)→D(runtime は HTML debug)→E(gap cluster)→F(cause)。
//   出力: data/reports/building-coverage-audit.json
//
// 実行: node tools/audit/building-coverage.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { auditBuildingCoverage, clusterGapCells, indexWards, wardAt, rasterizeTriangleCells } from '../lib/building-coverage.js';
import { flattenWardPolygons, pointInRing } from '../lib/water-surface.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const BUILD_DIR = P('public', 'map-data', 'osaka-city', 'buildings');
const WARDS = P('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const ROADS = P('public', 'map-data', 'osaka-city', 'roads');
const RAILS = P('public', 'map-data', 'osaka-city', 'railways');
const PARKS = P('public', 'map-data', 'osaka-city', 'parks');
const RIVERS = P('public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json');
const WATER = P('public', 'map-data', 'osaka-city', 'water-surface', 'water-surface.json');
const CLASSIFY_REPORT = P('data', 'reports', 'building-dataset-generation.json');
const REPORT = P('data', 'reports', 'building-coverage-audit.json');

function loadTileFeatures(dir) {
  const byId = new Map();
  if (!fs.existsSync(dir)) return [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    for (const ft of (t.features || [])) if (ft.kind === 'line' || ft.kind === 'area') if (!byId.has(ft.id)) byId.set(ft.id, ft);
  }
  return [...byId.values()];
}

function fpArea(fp) {
  let a = 0;
  for (let i = 0; i < fp.length; i++) { const p = fp[i], q = fp[(i + 1) % fp.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
}

function loadRenderedBuildings(includeFallback) {
  const out = [];
  let fallbackCount = 0;
  for (const ds of fs.readdirSync(BUILD_DIR)) {
    const dsPath = path.join(BUILD_DIR, ds);
    if (!fs.statSync(dsPath).isDirectory() || ds === 'unclassified') continue;
    const isFallback = ds === 'osaka-osm-fallback';
    if (isFallback && !includeFallback) continue;
    for (const f of fs.readdirSync(dsPath)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      const t = JSON.parse(fs.readFileSync(path.join(dsPath, f), 'utf-8'));
      for (const b of (t.buildings || [])) {
        if (!b || !Array.isArray(b.fp) || b.fp.length < 3) continue;
        const x = b.repX != null ? b.repX : b.fp[0][0];
        const z = b.repZ != null ? b.repZ : b.fp[0][1];
        out.push({ x, z, fp: b.fp, fpArea: fpArea(b.fp), fallback: isFallback });
        if (isFallback) fallbackCount++;
      }
    }
  }
  out._fallbackCount = fallbackCount;
  return out;
}

function loadUnclassified() {
  const dir = path.join(BUILD_DIR, 'unclassified');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    for (const b of (t.buildings || [])) {
      if (!b || !Array.isArray(b.fp) || b.fp.length < 3) continue;
      const x = b.repX != null ? b.repX : b.fp[0][0];
      const z = b.repZ != null ? b.repZ : b.fp[0][1];
      out.push({ x, z, id: b.id, fpArea: fpArea(b.fp), reason: b.unclassifiedReason || null });
    }
  }
  return out;
}

async function main() {
  const wardsRaw = JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards || [];
  const idxW = indexWards(wardsRaw);
  const rootManifest = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'manifest.json'), 'utf-8'));
  const classifyRep = fs.existsSync(CLASSIFY_REPORT) ? JSON.parse(fs.readFileSync(CLASSIFY_REPORT, 'utf-8')) : null;

  // ── B. classification audit ──
  const renderedNoFb = loadRenderedBuildings(false);
  const rendered = loadRenderedBuildings(true); // OSM 補完込み（最終 coverage）
  const fallbackCount = rendered._fallbackCount || 0;
  const unclassified = loadUnclassified();
  // 未分類建物を「区外 / 区内すきま」へ再照合（§4）
  let uInBbox = 0, uOutBbox = 0, uInWardPoly = 0;
  let uMinX = Infinity, uMaxX = -Infinity, uMinZ = Infinity, uMaxZ = -Infinity;
  for (const w of idxW) { uMinX = Math.min(uMinX, w._bb.minX); uMaxX = Math.max(uMaxX, w._bb.maxX); uMinZ = Math.min(uMinZ, w._bb.minZ); uMaxZ = Math.max(uMaxZ, w._bb.maxZ); }
  const unclCluster = {};
  for (const u of unclassified) {
    const inBbox = u.x >= uMinX && u.x <= uMaxX && u.z >= uMinZ && u.z <= uMaxZ;
    if (wardAt(u.x, u.z, idxW)) uInWardPoly++;
    else if (inBbox) uInBbox++;
    else uOutBbox++;
    const ck = Math.floor(u.x / 500) + ',' + Math.floor(u.z / 500);
    unclCluster[ck] = (unclCluster[ck] || 0) + 1;
  }
  const unclTopCells = Object.entries(unclCluster).sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([k, n]) => { const [cx, cz] = k.split(',').map(Number); return { center: [cx * 500 + 250, cz * 500 + 250], count: n }; });

  // ── C. tile completeness ──
  const tileAudit = { datasets: 0, expectedTiles: 0, presentTiles: 0, emptyTiles: 0, missingTiles: [] };
  for (const ds of rootManifest.datasets) {
    tileAudit.datasets++;
    const dsDir = path.join(BUILD_DIR, ds.id);
    const man = JSON.parse(fs.readFileSync(path.join(dsDir, 'manifest.json'), 'utf-8'));
    for (const t of (man.tiles || [])) {
      tileAudit.expectedTiles++;
      const fp = path.join(dsDir, `tile_${t.tx}_${t.tz}.json`);
      if (!fs.existsSync(fp)) { tileAudit.missingTiles.push({ ward: ds.wardId, tx: t.tx, tz: t.tz }); continue; }
      tileAudit.presentTiles++;
      const td = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (!(td.buildings || []).length) tileAudit.emptyTiles++;
    }
  }

  // ── E. gap grid audit（100m） ──
  const roads = loadTileFeatures(ROADS).filter((f) => f.kind === 'line' && f.underground !== true);
  const rails = loadTileFeatures(RAILS).filter((f) => f.kind === 'line');
  const parkRings = loadTileFeatures(PARKS).filter((f) => f.kind === 'area').map((f) => f.p);
  let riverLines = [];
  try {
    const rv = JSON.parse(fs.readFileSync(RIVERS, 'utf-8'));
    for (const r of (rv.rivers || [])) if (r.ok && Array.isArray(r.centerline) && r.centerline.length >= 2) riverLines.push({ p: r.centerline });
  } catch (e) { /* optional */ }
  let waterCells = new Set();
  try {
    const w = JSON.parse(fs.readFileSync(WATER, 'utf-8'));
    if (Array.isArray(w.positions)) waterCells = rasterizeTriangleCells(w.positions, 100, { x: Math.floor(uMinX / 100) * 100, z: Math.floor(uMinZ / 100) * 100 });
  } catch (e) { /* optional */ }

  const auditBefore = auditBuildingCoverage({
    wards: wardsRaw, cellM: 100,
    buildings: renderedNoFb, roads, rails, parkRings, rivers: riverLines, waterCells,
  });
  const clustersBefore = clusterGapCells(auditBefore.gapCells, auditBefore.cellM, { minCells: 4 });
  const audit = auditBuildingCoverage({
    wards: wardsRaw, cellM: 100,
    buildings: rendered, roads, rails, parkRings, rivers: riverLines, waterCells,
  });
  const clusters = clusterGapCells(audit.gapCells, audit.cellM, { minCells: 4 });

  // ── F. cause 分類（fallback 後に残るクラスタが対象） ──
  // 100m cell ごとの in-city OSM 建物数（PLATEAU/OSM とも建物なし = 実際に建物が無い土地）
  const OSM_GRID = P('data', 'reports', 'osm-building-incity-grid.json');
  let osmGrid = null;
  try { osmGrid = JSON.parse(fs.readFileSync(OSM_GRID, 'utf-8')).counts; } catch (e) { /* optional */ }
  // gapCells を id で引けるように
  const gapByCell = new Map();
  for (const g of audit.gapCells) gapByCell.set(g.cx + ',' + g.cz, g);
  for (const c of clusters) {
    let unclNear = 0;
    for (const u of unclassified) {
      if (u.x >= c.bbox.minX - 150 && u.x <= c.bbox.maxX + 150 && u.z >= c.bbox.minZ - 150 && u.z <= c.bbox.maxZ + 150) unclNear++;
    }
    c.unclassifiedNear = unclNear;
    let edgeDist = Infinity;
    for (const w of idxW) {
      for (let i = 0; i < w.outer.length - 1; i++) {
        const ax = w.outer[i][0], az = w.outer[i][1], bx = w.outer[i + 1][0], bz = w.outer[i + 1][1];
        const dx = bx - ax, dz = bz - az; const L2 = dx * dx + dz * dz || 1;
        let t = ((c.center[0] - ax) * dx + (c.center[1] - az) * dz) / L2; t = Math.max(0, Math.min(1, t));
        edgeDist = Math.min(edgeDist, Math.hypot(c.center[0] - (ax + t * dx), c.center[1] - (az + t * dz)));
      }
    }
    c.wardEdgeDistM = Math.round(edgeDist);
    // クラスタ内の gap cell で OSM 建物が密（>=3/cell）に残っている数
    let osmDenseCells = 0, osmTotal = 0, cellN = 0;
    for (const g of audit.gapCells) {
      if (g.x < c.bbox.minX - 50 || g.x > c.bbox.maxX + 50 || g.z < c.bbox.minZ - 50 || g.z > c.bbox.maxZ + 50) continue;
      cellN++;
      const ok = osmGrid ? (osmGrid[Math.floor(g.x / 100) + ',' + Math.floor(g.z / 100)] || 0) : 0;
      osmTotal += ok;
      if (ok >= 3) osmDenseCells++;
    }
    c.osmDenseGapCells = osmDenseCells;
    c.osmBuildingsInGap = osmTotal;
    // fallback 後の残余。OSM 建物が密に残る cell が多い → PLATEAU/OSM 双方の hole 端 or 補完漏れ（要確認）。
    //   OSM も疎 → 実際に建物が無い土地（cause I。港湾/工業/緑地/河川敷）。
    if (osmGrid && cellN > 0 && osmDenseCells / cellN >= 0.5 && osmDenseCells >= 4) {
      c.likelyCause = 'A: PLATEAU 欠落で OSM 補完も届いていない疑い（OSM 建物が gap cell に密。granularity edge or 補完閾値外）';
      c.unexplained = true;
    } else if (c.areaKm2 >= 0.3) {
      c.likelyCause = 'I: 大規模の非建物地（港湾ヤード/コンテナターミナル/操車場/工場敷地/公園外緑地/河川敷）。PLATEAU も OSM も建物を持たない。';
      c.unexplained = false;
    } else if (edgeDist < 200) {
      c.likelyCause = 'I: 区界・海岸線・河川縁のノイズ（敷地境界の道路のみ）';
      c.unexplained = false;
    } else {
      c.likelyCause = 'I: 建物が存在しない土地（PLATEAU/OSM とも建物なし。港湾・工業・緑地系）';
      c.unexplained = false;
    }
  }
  const unexplained = clusters.filter((c) => c.unexplained);

  // ── 区別 coverage（§14） ──
  const byWard = {};
  for (const [w, s] of Object.entries(audit.byWard)) {
    byWard[w] = {
      landCells: s.landCells, landAreaKm2: +(s.landCells * 0.01).toFixed(2),
      buildingCells: s.buildingCells, buildings: s.buildings,
      footprintAreaM2: s.footprintArea, buildingCoverageRatio: s.coverageRatio,
      gapCells: s.gapCells,
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'N03 24区陸域 100m グリッド。cell 内 rendered building 0 かつ roadLen>30m かつ park/water/rail/river で説明不能 → suspectedBuildingGap。連続クラスタ化し原因分類。',
    corpus: {
      rawBuildings: (classifyRep && classifyRep.totals && classifyRep.totals.input) || null,
      classified: (classifyRep && classifyRep.totals && classifyRep.totals.classified) || renderedNoFb.length,
      unclassified: unclassified.length,
      renderedTileBuildings: renderedNoFb.length,
      osmFallbackBuildings: fallbackCount,
      totalRenderable: rendered.length,
    },
    unclassifiedAnalysis: {
      total: unclassified.length,
      insideWardPolygon: uInWardPoly,
      insideUnionBboxOutsidePolygons: uInBbox,
      outsideUnionBbox: uOutBbox,
      topClusters500m: unclTopCells,
      note: 'insideUnionBboxOutsidePolygons は「大阪市 bbox 内だが N03 区ポリゴン外」。区界近傍なら守口/門真/東大阪等の隣接市か、N03 分類ポリゴンの誤差。',
    },
    tileCompleteness: {
      datasets: tileAudit.datasets,
      expectedTiles: tileAudit.expectedTiles,
      presentTiles: tileAudit.presentTiles,
      missingTiles: tileAudit.missingTiles.length,
      missingTileList: tileAudit.missingTiles.slice(0, 30),
      emptyTiles: tileAudit.emptyTiles,
    },
    gridAudit: {
      cellM: audit.cellM,
      totalLandCells: audit.totalLandCells,
      beforeFallback: {
        cellsWithBuildings: auditBefore.cellsWithBuildings,
        suspectedGapCells: auditBefore.suspectedGapCells,
        gapClusters: clustersBefore.length,
        buildingCellCoverage: +(auditBefore.cellsWithBuildings / auditBefore.totalLandCells).toFixed(3),
      },
      afterFallback: {
        cellsWithBuildings: audit.cellsWithBuildings,
        suspectedGapCells: audit.suspectedGapCells,
        gapClusters: clusters.length,
        buildingCellCoverage: +(audit.cellsWithBuildings / audit.totalLandCells).toFixed(3),
      },
      cellsWithRoadsNoBuildings: audit.cellsWithRoadsNoBuildings,
    },
    gapClusters: {
      total: clusters.length,
      totalBefore: clustersBefore.length,
      unexplained: unexplained.length,
      list: clusters.slice(0, 40),
    },
    byWard,
    RESULT: (unexplained.length === 0 && tileAudit.missingTiles.length === 0) ? 'PASS' : 'REVIEW',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[building-coverage-audit] raw ' + report.corpus.rawBuildings + ' / classified ' + report.corpus.classified + ' / unclassified ' + report.corpus.unclassified + ' / OSM補完 ' + fallbackCount + ' → renderable ' + rendered.length);
  console.log('  unclassified: inWardPoly ' + uInWardPoly + ' / inBbox-outPoly ' + uInBbox + ' / outBbox ' + uOutBbox);
  console.log('  tiles: expected ' + tileAudit.expectedTiles + ' present ' + tileAudit.presentTiles + ' missing ' + tileAudit.missingTiles.length + ' empty ' + tileAudit.emptyTiles);
  console.log('  grid(' + audit.cellM + 'm): land cells ' + audit.totalLandCells);
  console.log('    before fallback: withBuildings ' + auditBefore.cellsWithBuildings + ' (' + (report.gridAudit.beforeFallback.buildingCellCoverage * 100).toFixed(1) + '%) / gap cells ' + auditBefore.suspectedGapCells + ' / clusters ' + clustersBefore.length);
  console.log('    after  fallback: withBuildings ' + audit.cellsWithBuildings + ' (' + (report.gridAudit.afterFallback.buildingCellCoverage * 100).toFixed(1) + '%) / gap cells ' + audit.suspectedGapCells + ' / clusters ' + clusters.length);
  console.log('  gap clusters (after): ' + clusters.length + ' (unexplained ' + unexplained.length + ')');
  for (const c of clusters.slice(0, 12)) console.log('    ' + c.id + ' ' + c.ward + ' center=' + JSON.stringify(c.center) + ' ' + c.areaKm2 + 'km² road=' + c.roadLengthKm + 'km osmDense=' + c.osmDenseGapCells + ' edge=' + c.wardEdgeDistM + 'm  ' + c.likelyCause.slice(0, 44));
  console.log('  -- byWard (building cell coverage) --');
  for (const [w, s] of Object.entries(byWard).sort((a, b) => a[1].buildingCoverageRatio - b[1].buildingCoverageRatio)) {
    console.log('    ' + w.padEnd(18) + (s.buildingCoverageRatio * 100).toFixed(1) + '%  cells ' + s.buildingCells + '/' + s.landCells + '  buildings ' + s.buildings + '  gapCells ' + s.gapCells);
  }
  console.log('保存:', toProjectRelativePath(REPORT), '  RESULT:', report.RESULT);
}

main().catch((e) => { console.error('[building-coverage-audit] 失敗:', e && e.stack || e); process.exit(1); });
