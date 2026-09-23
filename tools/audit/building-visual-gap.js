#!/usr/bin/env node
// tools/audit/building-visual-gap.js
// [Mission21C] 実機で「まだ建物が欠けて見える」領域を audit と突合して再判定する。
//   Mission21B の cause I / OSM fallback filter を再検証し、sparse-mismatch（PLATEAU 少数 + OSM 大量）
//   を検出、fallback 拡張後の residual を確認する。
//   出力: data/reports/building-visual-gap-reconciliation.json
//
// 実行: node tools/audit/building-visual-gap.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { SPARSE_AREA_RATIO, SPARSE_MIN_OSM_COUNT, SPARSE_PLATEAU_AREA_FLOOR } from '../lib/osm-building-fallback.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const GRID = P('data', 'reports', 'osm-building-incity-grid.json');
const FB_REPORT = P('data', 'reports', 'osm-building-fallback.json');
const COVERAGE_AUDIT = P('data', 'reports', 'building-coverage-audit.json');
const ROOT_MANIFEST = P('public', 'map-data', 'osaka-city', 'buildings', 'manifest.json');
const REPORT = P('data', 'reports', 'building-visual-gap-reconciliation.json');

function clusterKeys(keys, cellM) {
  const set = new Set(keys);
  const seen = new Set();
  const clusters = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    const [sx, sz] = k.split(',').map(Number);
    const stack = [[sx, sz]]; const cells = [];
    seen.add(k);
    while (stack.length) {
      const [cx, cz] = stack.pop(); cells.push([cx, cz]);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const nk = (cx + dx) + ',' + (cz + dz);
        if (set.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push([cx + dx, cz + dz]); }
      }
    }
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [cx, cz] of cells) { const x = cx * cellM, z = cz * cellM; if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
    clusters.push({ cells: cells.length, bbox: { minX: a, maxX: b + cellM, minZ: c, maxZ: d + cellM }, center: [Math.round((a + b) / 2), Math.round((c + d) / 2)], areaKm2: +(cells.length * cellM * cellM / 1e6).toFixed(3) });
  }
  return clusters.sort((x, y) => y.cells - x.cells);
}

async function main() {
  for (const f of [GRID, FB_REPORT]) if (!fs.existsSync(f)) { console.error('[stop] 入力なし: ' + toProjectRelativePath(f) + '\n  先に: node tools/build-osm-building-fallback.js'); process.exit(1); }
  const grid = JSON.parse(fs.readFileSync(GRID, 'utf-8'));
  const fbReport = JSON.parse(fs.readFileSync(FB_REPORT, 'utf-8'));
  const covAudit = fs.existsSync(COVERAGE_AUDIT) ? JSON.parse(fs.readFileSync(COVERAGE_AUDIT, 'utf-8')) : null;
  const root = JSON.parse(fs.readFileSync(ROOT_MANIFEST, 'utf-8'));
  const cellM = grid.cellM || 100;
  const cellArea = cellM * cellM;

  const plat = grid.plateau || {};
  const osm = grid.osm || {};
  const fb = grid.fallback || {};

  // ── footprint 面積 coverage（100m cell 単位。0..1 を集計） ──
  const allKeys = new Set([...Object.keys(plat), ...Object.keys(osm), ...Object.keys(fb)]);
  let cells = 0, covBefore = 0, covAfter = 0, covOsm = 0;
  for (const k of allKeys) {
    cells++;
    const pa = (plat[k] && plat[k].area) || 0;
    const fa = (fb[k] && fb[k].area) || 0;
    const oa = (osm[k] && osm[k].area) || 0;
    covBefore += Math.min(1, pa / cellArea);
    covAfter += Math.min(1, (pa + fa) / cellArea);
    covOsm += Math.min(1, oa / cellArea);
  }

  // ── residual sparse-mismatch: fallback 追加後も OSM >> (PLATEAU + fallback) ──
  //   「未説明の見落とし」は面積比だけでなく件数でも判定する。fallback 追加後に
  //   (PLATEAU + fallback) 棟数が 3 未満のまま OSM 棟数 >= SPARSE_MIN_OSM_COUNT の cell だけを
  //   residual とする（OSM が大きな 1 ポリゴンで市場/アーケードを描き、こちらは個別ストールを
  //   多数持つ場合＝視覚的には建物あり＝granularity 差であって欠落ではない）。
  const residualKeys = [];
  const granularityOnlyKeys = [];
  const preSparse = new Set(grid.sparseCells || []);
  const platSub = grid.plateauSubCells || {}; // 100m cell → PLATEAU 占有 50m sub-cell 数（0..4）
  let residualOsmBuildings = 0;
  for (const k of preSparse) {
    const o = osm[k]; if (!o || o.count < SPARSE_MIN_OSM_COUNT) continue;
    const coveredCount = ((plat[k] && plat[k].count) || 0) + ((fb[k] && fb[k].count) || 0);
    const coveredArea = Math.max(((plat[k] && plat[k].area) || 0) + ((fb[k] && fb[k].area) || 0), SPARSE_PLATEAU_AREA_FLOOR);
    if (o.area / coveredArea < SPARSE_AREA_RATIO) continue;             // 面積比は解消済み
    if ((platSub[k] || 0) >= 2) { granularityOnlyKeys.push(k); continue; } // 大 PLATEAU footprint が実際に覆っている（centroid が隣 cell）
    if (coveredCount >= 3) { granularityOnlyKeys.push(k); continue; }   // 建物多数あり＝視覚的に充足（granularity 差）
    residualKeys.push(k); residualOsmBuildings += o.count;
  }
  const residualSparseClusters = clusterKeys(residualKeys, cellM);

  // ── OSM dense / PLATEAU sparse の「見落とし」= preSparse かつ fallback が 1 件も入らなかった cell ──
  //   ただし、大 PLATEAU footprint が実際にその cell を覆っている（plateauSubCells >= 2）場合や
  //   全 OSM 建物が PLATEAU の duplicate だったケースは「見落とし」ではない。
  let missedSparseCells = 0;
  const missedCellList = [];
  for (const k of preSparse) if (!fb[k] || fb[k].count === 0) {
    if ((platSub[k] || 0) >= 2) continue;
    const o = osm[k]; const covered = ((plat[k] && plat[k].area) || 0);
    if (o && o.area / Math.max(covered, SPARSE_PLATEAU_AREA_FLOOR) >= SPARSE_AREA_RATIO && o.count >= SPARSE_MIN_OSM_COUNT) { missedSparseCells++; missedCellList.push(k); }
  }

  // ── visual gap cluster（coverage audit の post-fallback 残余） ──
  const visualGapClusters = covAudit ? (covAudit.gapClusters.list || []).map((c) => ({
    id: c.id, ward: c.ward, center: c.center, areaKm2: c.areaKm2, roadLengthKm: c.roadLengthKm,
    likelyCause: c.likelyCause, osmDenseGapCells: c.osmDenseGapCells, wardEdgeDistM: c.wardEdgeDistM,
  })) : [];
  const causeBreakdown = {};
  for (const c of visualGapClusters) { const key = c.likelyCause.split('（')[0].split('(')[0].trim().slice(0, 40); causeBreakdown[key] = (causeBreakdown[key] || 0) + 1; }

  // ── tile completeness / runtime missing ──
  let expectedTiles = 0, presentTiles = 0;
  for (const d of root.datasets) {
    const dir = path.join(path.dirname(ROOT_MANIFEST), d.id);
    const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    for (const t of (man.tiles || [])) { expectedTiles++; if (fs.existsSync(path.join(dir, `tile_${t.tx}_${t.tz}.json`))) presentTiles++; }
  }
  const runtimeMissing = expectedTiles - presentTiles;

  const report = {
    generatedAt: new Date().toISOString(),
    method: '100m cell の footprint 面積 coverage で PLATEAU / +fallback / OSM を比較。sparse-mismatch は fallback 前後で residual を測る。',
    cellM,
    footprintAreaCoverage: {
      plateauOnly: +(covBefore / cells).toFixed(4),
      plateauPlusFallback: +(covAfter / cells).toFixed(4),
      osmReference: +(covOsm / cells).toFixed(4),
      cells,
    },
    fallbackAdded: fbReport.reasonCounts || { hole: fbReport.stats.inPlateauHole, 'sparse-mismatch': fbReport.stats.sparseMismatch },
    duplicatesRejected: fbReport.duplicatesRejected ?? fbReport.stats.dupRejected ?? 0,
    sparseMismatch: {
      thresholds: { areaRatio: SPARSE_AREA_RATIO, minOsmCount: SPARSE_MIN_OSM_COUNT },
      cellsBeforeFallback: preSparse.size,
      residualCells: residualKeys.length,
      residualClusters: residualSparseClusters.length,
      residualOsmBuildings,
      granularityOnlyCells: granularityOnlyKeys.length,
      granularityNote: 'granularityOnly は fallback 後に建物 3 棟以上あるが OSM の 1 ポリゴン面積が大きい cell（市場/アーケード等。視覚的には建物あり＝欠落ではない）',
      missedCells: missedSparseCells,
      missedCellList,
      residualClusterList: residualSparseClusters.slice(0, 20),
    },
    sparseMismatchClusters: residualSparseClusters.slice(0, 40),
    visualGapClusters,
    causeBreakdown,
    runtimeMissing,
    tileCompleteness: { expectedTiles, presentTiles },
    remainingExplained: {
      visualGapClusters: visualGapClusters.length,
      unexplained: covAudit ? covAudit.gapClusters.unexplained : null,
      allHaveCause: visualGapClusters.every((c) => c.likelyCause),
    },
    RESULT: (residualKeys.length === 0 && missedSparseCells === 0 && runtimeMissing === 0
      && (!covAudit || covAudit.gapClusters.unexplained === 0)) ? 'PASS' : 'REVIEW',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[building-visual-gap] footprint 面積 coverage: PLATEAU ' + (report.footprintAreaCoverage.plateauOnly * 100).toFixed(1) + '% → +fallback ' + (report.footprintAreaCoverage.plateauPlusFallback * 100).toFixed(1) + '% (OSM ref ' + (report.footprintAreaCoverage.osmReference * 100).toFixed(1) + '%)');
  console.log('  fallback added: ' + JSON.stringify(report.fallbackAdded) + '  duplicatesRejected ' + report.duplicatesRejected);
  console.log('  sparse-mismatch: before ' + preSparse.size + ' cell → residual ' + residualKeys.length + ' cell / ' + residualSparseClusters.length + ' cluster / missed ' + missedSparseCells);
  console.log('  visual gap cluster: ' + visualGapClusters.length + ' (unexplained ' + report.remainingExplained.unexplained + ')  causes: ' + JSON.stringify(causeBreakdown));
  console.log('  runtime missing tiles: ' + runtimeMissing);
  console.log('保存:', toProjectRelativePath(REPORT), '  RESULT:', report.RESULT);
  if (report.RESULT !== 'PASS') process.exitCode = 1;
}

main().catch((e) => { console.error('[building-visual-gap] 失敗:', e && e.stack || e); process.exit(1); });
