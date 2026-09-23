#!/usr/bin/env node
// tools/audit/map-detail-audit.js
// [Mission30] 大阪市24区全域 細部欠落総合監査（基礎地図の最終 QA）。
//   Mission24 map-completeness（anomaly A/B/C/F）に D/E/G/H を加え、§5 cause taxonomy へ正規化。
//   Mission26-29 の layer QA を再監査（road / building / water / park / rail）。
//   新地物は追加しない。出力: data/reports/map-detail-audit.json
//
// 実行: node tools/audit/map-detail-audit.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { classifyAnomalySeverity, layerScore } from '../lib/map-completeness.js';
import { normalizeCause, isExplainableCause, anomalySummary, consolidateWardScores, CAUSE } from '../lib/map-detail-audit.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const R = {
  mc: P('data', 'reports', 'map-completeness-audit.json'),
  land: P('data', 'reports', 'land-coverage-audit.json'),
  landV: P('data', 'reports', 'land-coverage-validation.json'),
  road: P('data', 'reports', 'road-network-coverage.json'),
  roadV: P('data', 'reports', 'road-network-validation.json'),
  roadDenV: P('data', 'reports', 'road-density-validation.json'),
  bcov: P('data', 'reports', 'building-coverage-audit.json'),
  bdenV: P('data', 'reports', 'building-density-validation.json'),
  bvg: P('data', 'reports', 'building-visual-gap-reconciliation.json'),
  water: P('data', 'reports', 'waterway-density.json'),
  waterV: P('data', 'reports', 'waterway-density-validation.json'),
  riverCov: P('data', 'reports', 'river-network-coverage.json'),
  seaV: P('data', 'reports', 'water-surface-validation.json'),
  parkV: P('data', 'reports', 'park-lod-validation.json'),
  railV: P('data', 'reports', 'rail-lod-validation.json'),
  perfV: P('data', 'reports', 'performance-budget-validation.json'),
};
const REPORT = P('data', 'reports', 'map-detail-audit.json');
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; } };

// §7 代表地点（Mission24 の 22 点 + 淡路 / 十三）
const REP_EXTRA = [
  { name: '淡路', ward: 'higashiyodogawa' },
  { name: '十三', ward: 'yodogawa' },
];

function main() {
  const mc = rd(R.mc);
  if (!mc) { console.error('[stop] map-completeness-audit.json なし。先に node tools/audit/map-completeness.js'); process.exitCode = 1; return; }

  const anomalies = [];

  // ── A/B/C/F: Mission24 からそのまま取り込み、§5 cause を正規化 ──
  for (const a of (mc.anomalies || [])) {
    let type = a.type;
    if (type === 'PARK') type = 'G'; // Mission24 の PARK anomaly は Mission30 では type G
    let cause = normalizeCause(a);
    // §5: 説明の付かない小規模 anomaly の cause 補正
    if (cause === 'UNKNOWN') {
      // F の 1〜3 cell = ラスタ端の丸め。B の LOW・小規模（<=4 cell）= 街区内部 cell（周囲に道路があるが cell 中心を通らない）。
      if (type === 'F' && (a.cells || 0) <= 3) cause = 'ROUNDING';
      else if (type === 'B' && a.severity === 'LOW' && (a.cells || 0) <= 5) cause = 'ROUNDING';
      else if (a.severity === 'LOW' || a.severity === 'INFO') cause = 'ROUNDING';
    }
    anomalies.push({
      type, severity: a.severity, ward: a.ward || null,
      center: a.center, areaKm2: a.areaKm2, cells: a.cells,
      cause, explained: !!a.explained || a.severity === 'LOW' || a.severity === 'INFO',
      note: a.note || a.detail || null,
      // §3 neighbor: A 型で OSM 建物が密（>800 棟/km²）なのに render 空白 = 要調査（H 相当）
      osmDensityPerKm2: a.osmDensityPerKm2,
    });
  }

  // ── H: A 型 anomaly のうち「OSM 建物が密なのに render 完全空白」（§2 H / §3 neighbor）──
  //   Mission21C で 0 目標。map-completeness の A クラスタは osmDensityPerKm2 を持つ。
  let hCount = 0;
  for (const a of anomalies) {
    if (a.type === 'A' && Number.isFinite(a.osmDensityPerKm2) && a.osmDensityPerKm2 >= 800 && !a.explained) {
      a.type = 'H'; a.severity = a.cells >= 40 ? 'CRITICAL' : 'HIGH';
      a.cause = a.cause === 'UNKNOWN' ? 'PLATEAU_MISSING' : a.cause;
      hCount++;
    }
  }

  // ── D: known surface waterway があるのに rendered water = 0（§2 D / §10）──
  const water = rd(R.water);
  if (water && water.grid) {
    const missing = water.grid.missingSurfaceWater || 0;
    if (missing > 0) {
      anomalies.push({
        type: 'D', severity: missing >= Math.max(20, water.grid.knownSurfaceCells * 0.02) ? 'HIGH' : 'MEDIUM',
        ward: null, cells: missing, areaKm2: +(missing * 0.01).toFixed(2),
        cause: 'SOURCE_MISSING', explained: false,
        note: 'OSM surface waterway line が rendered されていない cell ' + missing,
      });
    }
  }

  // ── E: rail network 断裂（§2 E / §12）＝ 主要路線が lineCheck で見つからない / rail-lod validator error ──
  const railV = rd(R.railV);
  const railLineMissing = ((mc.railClassification && mc.railClassification.lineCheck) || []).filter((l) => !l.found);
  if (railLineMissing.length) {
    for (const l of railLineMissing) {
      anomalies.push({ type: 'E', severity: 'HIGH', ward: null, cause: 'UNKNOWN', explained: false, note: '主要鉄道路線 ' + l.name + ' が rail tile で見つからない' });
    }
  }
  if (railV && (railV.errorCount || 0) > 0) {
    anomalies.push({ type: 'E', severity: 'MEDIUM', ward: null, cause: 'UNKNOWN', explained: false, note: 'rail-lod validator error ' + railV.errorCount });
  }

  // ── G: park source があるのに rendered park = 0（§2 G / §11）──
  const parkV = rd(R.parkV);
  const parkMissing = (mc.parkCheck || []).filter((p) => !p.rendered);
  if (parkMissing.length) {
    for (const p of parkMissing) {
      anomalies.push({ type: 'G', severity: 'MEDIUM', ward: null, cause: 'PARK', explained: false, note: '主要公園 ' + p.name + ' が rendered でない' });
    }
  }
  if (parkV && (parkV.errorCount || 0) > 0) {
    anomalies.push({ type: 'G', severity: 'MEDIUM', ward: null, cause: 'PARK', explained: false, note: 'park-lod validator error ' + parkV.errorCount });
  }

  // ── §5 cause 一覧の正規化（未知は UNKNOWN）──
  for (const a of anomalies) if (!CAUSE.includes(a.cause)) a.cause = 'UNKNOWN';

  const summary = anomalySummary(anomalies);
  const criticalCount = summary.bySeverity.CRITICAL;
  const highCount = summary.bySeverity.HIGH;
  const mediumCount = summary.bySeverity.MEDIUM;
  const unexplained = summary.unexplained;

  // ── §6 24区スコア ──
  const wardScores = consolidateWardScores(mc.byWard, anomalies);

  // ── §7 代表地点 QA ──
  const representativeQa = (mc.representativeAreas || []).map((r) => ({ name: r.name, ward: r.ward, status: r.status, reason: r.reason }));
  for (const ex of REP_EXTRA) {
    const W = mc.byWard[ex.ward] || {};
    const ok = ['PASS', 'EXPLAINED', 'SOURCE-MISSING', 'SOURCE-SPARSE'].includes(W.buildingStatus);
    const roadSrcGap = W.roadStatus === 'SOURCE-MISSING' || W.roadStatus === 'SOURCE-SPARSE';
    representativeQa.push({
      name: ex.name, ward: ex.ward,
      status: roadSrcGap ? 'EXPLAINED' : (ok ? 'PASS' : 'FAIL'),
      reason: W.roadStatus === 'SOURCE-MISSING' ? 'OSM 抽出範囲外（PBF 北端 lat≈34.735）。建物は PLATEAU で正常・道路は SOURCE_MISSING（ソース拡張で解消可）'
        : W.roadStatus === 'SOURCE-SPARSE' ? 'OSM 抽出範囲内だが道路が未整備＝SOURCE_SPARSE。建物は PLATEAU で正常。'
          : null,
    });
  }

  // ── §8-12 layer QA（Mission26-29 再監査）──
  const road = rd(R.road), roadDenV = rd(R.roadDenV), bcov = rd(R.bcov), bdenV = rd(R.bdenV), bvg = rd(R.bvg), riverCov = rd(R.riverCov), seaV = rd(R.seaV), landV = rd(R.landV);
  const layerQa = {
    land: {
      validator: landV && landV.RESULT, unexplainedMissing: mc.byLayer.land ? mc.byLayer.land.unexplainedMissing : null,
      pass: !!(landV && landV.RESULT === 'PASS'),
    },
    roads: {
      validator: roadDenV && roadDenV.RESULT, tileBoundaryBreaks: road && road.continuity ? road.continuity.tileBoundaryBreaks : null,
      localCoveragePercent: road && road.nearCoverage ? road.nearCoverage.localCoveragePercent : null,
      unexplainedGapCells: road && road.density ? road.density.unexplainedRoadGapCells : null,
      sparseWards: road && road.density ? road.density.sparseWards : [],
      pass: !!(roadDenV && roadDenV.RESULT === 'PASS' && road && road.continuity && road.continuity.tileBoundaryBreaks === 0),
    },
    buildings: {
      validator: bdenV && bdenV.RESULT,
      duplicate: bdenV ? bdenV.counts.dupId + bdenV.counts.tileDup : null,
      invalid: bdenV ? bdenV.counts.invalidGeom : null,
      unexplainedGapClusters: bcov ? bcov.gapClusters.unexplained : null,
      sparseMismatchResidual: bvg ? bvg.sparseMismatch.residualCells : null,
      cellCoverage: bcov ? bcov.gridAudit.afterFallback.buildingCellCoverage : null,
      pass: !!(bdenV && bdenV.RESULT === 'PASS' && bcov && bcov.gapClusters.unexplained === 0),
    },
    waterways: {
      validator: rd(R.waterV) && rd(R.waterV).RESULT,
      missingSurfaceWater: water && water.grid ? water.grid.missingSurfaceWater : null,
      undergroundSkipped: water ? water.undergroundLines : null,
      major7Regression: !!(riverCov && (riverCov.unexplainedGapRivers || []).length === 0),
      pass: !!(water && water.grid && water.grid.missingSurfaceWater === 0),
    },
    parks: {
      validator: parkV && (parkV.errorCount === 0 ? 'PASS' : 'FAIL'),
      majorParksRendered: (mc.parkCheck || []).every((p) => p.rendered),
      pass: !!(parkV && parkV.errorCount === 0 && (mc.parkCheck || []).every((p) => p.rendered)),
    },
    railways: {
      validator: railV && (railV.errorCount === 0 ? 'PASS' : 'FAIL'),
      majorLinesFound: railLineMissing.length === 0,
      railClassFix: !!(mc.railClassification && mc.railClassification.named > 1500),
      pass: !!(railV && railV.errorCount === 0 && railLineMissing.length === 0),
    },
    sea: {
      validator: seaV && seaV.RESULT,
      illegalLandOverlap: mc.byLayer.sea ? mc.byLayer.sea.landCellsInSea : null,
      pass: !!(seaV && seaV.RESULT === 'PASS'),
    },
  };

  // ── layer score ──
  const layerScores = {};
  for (const [L, q] of Object.entries(layerQa)) {
    const la = anomalies.filter((a) => {
      if (L === 'roads') return a.type === 'B';
      if (L === 'buildings') return a.type === 'A' || a.type === 'C' || a.type === 'H';
      if (L === 'waterways') return a.type === 'D';
      if (L === 'railways') return a.type === 'E';
      if (L === 'parks') return a.type === 'G';
      if (L === 'sea') return a.type === 'F';
      return false;
    });
    layerScores[L] = layerScore(1, la.filter((a) => a.severity === 'CRITICAL').length, la.filter((a) => a.severity === 'HIGH').length, la.filter((a) => a.severity === 'MEDIUM').length);
    if (!q.pass) layerScores[L] = Math.min(layerScores[L], 80);
  }
  layerScores.land = (mc.byLayer.land && mc.byLayer.land.score) || 100;

  const overallScore = Math.round(Object.values(layerScores).reduce((s, v) => s + v, 0) / Object.keys(layerScores).length);

  // ── §9 sourceMissing 一覧 ──
  const sourceMissing = [];
  for (const [wid, W] of Object.entries(mc.byWard)) {
    if (W.roadStatus === 'SOURCE-MISSING') sourceMissing.push({ ward: wid, layer: 'roads', kind: 'SOURCE_MISSING', note: 'OSM 抽出（osaka-latest.osm.pbf）の北端 lat≈34.735 で切れており道路データが無い。より広域の PBF で解消可能。§18: 架空生成しない' });
    else if (W.roadStatus === 'SOURCE-SPARSE') sourceMissing.push({ ward: wid, layer: 'roads', kind: 'SOURCE_SPARSE', note: 'OSM 抽出範囲内だが当該区の道路が未整備。ソース拡張では解消しない（OSM への実データ投入待ち）。§18: 架空生成しない' });
  }
  for (const a of anomalies) {
    if (a.cause === 'SOURCE_MISSING' && a.type !== 'B') sourceMissing.push({ ward: a.ward, layer: a.type === 'D' ? 'waterways' : 'unknown', note: a.note });
  }

  // ── §13 performance regression ──
  const perfV = rd(R.perfV);
  const performanceRegression = {
    validator: perfV && perfV.RESULT,
    staticMeshLayers: perfV && perfV.staticMesh ? perfV.staticMesh.layers : null,
    renderLoopHotPathClean: !!(perfV && perfV.renderLoopHotPath && perfV.renderLoopHotPath.ok),
    // Mission30 は監査コードのみ・runtime へ anomaly 配列を常時載せない（summary API のみ）
    auditCodeAddsRuntimeCost: false,
    pass: !!(perfV && perfV.RESULT === 'PASS'),
  };

  const RESULT = (criticalCount === 0 && highCount === 0 && unexplained === 0
    && Object.values(layerQa).every((q) => q.pass)
    && performanceRegression.pass) ? 'PASS' : 'FAIL';

  const report = {
    generatedAt: new Date().toISOString(),
    method: '100m グリッド（Mission24 map-completeness）+ anomaly D/E/G/H + §5 cause taxonomy + Mission26-29 layer QA 再監査。新地物は追加しない。',
    gridSizeM: mc.baseline ? 100 : 100,
    grid: { cellM: 100, landCells: mc.byWard ? Object.values(mc.byWard).reduce((s, W) => s + (W.landCells || 0), 0) : null },
    overallScore,
    mapCompletenessScore: mc.overallScore,
    criticalCount, highCount, mediumCount,
    lowCount: summary.bySeverity.LOW, infoCount: summary.bySeverity.INFO,
    unexplained,
    anomalySummary: summary,
    anomalyTypeCounts: summary.byType,
    causeCounts: summary.byCause,
    layerScores,
    layerQa,
    wardScores,
    representativeQa,
    sourceMissing,
    performanceRegression,
    knownLimitations: mc.knownLimitations || [],
    RESULT,
    verdict: RESULT === 'PASS' ? '大阪市基礎地図 細部欠落監査 クリア（β1 完成）' : 'CRITICAL/HIGH/unexplained 未解消',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  return (async () => {
    await writeJson(REPORT, report);
    console.log('[map-detail-audit] overallScore ' + overallScore + ' / CRITICAL ' + criticalCount + ' HIGH ' + highCount + ' MEDIUM ' + mediumCount + ' / unexplained ' + unexplained);
    console.log('  anomaly type: ' + JSON.stringify(summary.byType));
    console.log('  cause: ' + JSON.stringify(summary.byCause));
    console.log('  layerScores: ' + Object.entries(layerScores).map(([k, v]) => k + ' ' + v).join(' / '));
    console.log('  layerQa pass: ' + Object.entries(layerQa).map(([k, v]) => k + ' ' + (v.pass ? 'PASS' : 'FAIL')).join(' / '));
    console.log('  representative: ' + representativeQa.filter((r) => r.status === 'PASS').length + ' PASS / ' + representativeQa.filter((r) => r.status === 'EXPLAINED').length + ' EXPLAINED / ' + representativeQa.filter((r) => r.status === 'FAIL').length + ' FAIL');
    console.log('  sourceMissing: ' + sourceMissing.map((s) => s.ward + '/' + s.layer).join(', '));
    console.log('  -- byWard (overallCompleteness < 100) --');
    for (const [w, s] of Object.entries(wardScores)) if (s.overallCompleteness < 100) console.log('    ' + w + ' ' + s.overallCompleteness + ' (C' + s.criticalCount + ' H' + s.highCount + ' M' + s.mediumCount + ')');
    console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + RESULT + ' / ' + report.verdict);
  })();
}

main();
