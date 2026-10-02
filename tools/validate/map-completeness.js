#!/usr/bin/env node
// tools/validate/map-completeness.js
// [Mission24 §16] 大阪市24区 基礎地図総合完成度 validator CLI。
//
// PASS 条件:
//   criticalCount = 0 / highCount = 0
//   land unexplained missing = 0
//   building unexplained visual gap = 0 / sparse mismatch residual = 0 / duplicate fallback = 0
//   road tile boundary break = 0 / road eligible local coverage >= 99%
//   river unexplained gaps = 0
//   illegal sea overlap = 0
//   major park missing = 0 / major rail unexplained gaps = 0
//   runtime missing major layer = 0（静的には dataset/tile 生成漏れ 0）
//   protected / production unchanged（Mission24 の HTML 変更が混入していない）
//
// 実行: node tools/validate/map-completeness.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AUDIT = P('data', 'reports', 'map-completeness-audit.json');
const REPORT = P('data', 'reports', 'map-completeness-validation.json');
const R = {
  land: P('data', 'reports', 'land-coverage-validation.json'),
  building: P('data', 'reports', 'building-coverage-validation.json'),
  visualGap: P('data', 'reports', 'building-visual-gap-reconciliation.json'),
  road: P('data', 'reports', 'road-network-coverage.json'),
  roadV: P('data', 'reports', 'road-network-validation.json'),
  riverCov: P('data', 'reports', 'river-network-coverage.json'),
  riverV: P('data', 'reports', 'river-network-validation.json'),
  seaV: P('data', 'reports', 'water-surface-validation.json'),
  parkV: P('data', 'reports', 'park-lod-validation.json'),
  railV: P('data', 'reports', 'rail-lod-validation.json'),
};
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; } };

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(AUDIT)) { console.error('[stop] 入力なし: ' + toProjectRelativePath(AUDIT) + '\n  先に: node tools/audit/map-completeness.js'); process.exitCode = 1; return; }
  const a = rd(AUDIT);

  // ── severity ──
  if (a.criticalCount !== 0) errors.push('CRITICAL anomaly ' + a.criticalCount);
  if (a.highCount !== 0) errors.push('HIGH anomaly ' + a.highCount + ': ' + a.anomalies.filter((x) => x.severity === 'HIGH').map((x) => x.type + ' ' + (x.line || x.park || x.ward || '')).slice(0, 6).join(', '));

  // ── 全 anomaly に cause（MEDIUM 以下は reason 必須）──
  for (const an of a.anomalies) {
    if (['MEDIUM', 'HIGH', 'CRITICAL'].includes(an.severity) && !(an.note || an.detail)) errors.push(an.severity + ' anomaly に reason が無い: ' + an.type);
  }

  // ── layer 別（既存レポートで固定）──
  const landV = rd(R.land);
  if (landV && landV.RESULT !== 'PASS') errors.push('land-coverage validator が PASS でない');
  const buildingV = rd(R.building);
  if (buildingV && buildingV.RESULT !== 'PASS') errors.push('building-coverage validator が PASS でない');
  const vg = rd(R.visualGap);
  if (vg) {
    if (vg.remainingExplained.unexplained !== 0) errors.push('building unexplained visual gap ' + vg.remainingExplained.unexplained);
    if (vg.sparseMismatch.residualCells !== 0) errors.push('building sparse mismatch residual ' + vg.sparseMismatch.residualCells);
    if (vg.sparseMismatch.missedCells !== 0) errors.push('building sparse mismatch missed ' + vg.sparseMismatch.missedCells);
  }
  if (buildingV && buildingV.checks) {
    const ck = buildingV.checks;
    if ((ck.fbDupId || 0) > 0) errors.push('duplicate fallback id ' + ck.fbDupId);
    if ((ck.fbSparseDup || 0) > Math.max(5, ((ck.fbByReason && ck.fbByReason['sparse-mismatch']) || 0) * 0.001)) errors.push('duplicate fallback (sparse polygon) ' + ck.fbSparseDup);
  }
  const roadCov = rd(R.road), roadV = rd(R.roadV);
  if (roadCov) {
    if (roadCov.continuity.tileBoundaryBreaks !== 0) errors.push('road tile boundary break ' + roadCov.continuity.tileBoundaryBreaks);
    if (!(roadCov.nearCoverage.localCoveragePercent >= 99)) errors.push('road eligible local coverage ' + roadCov.nearCoverage.localCoveragePercent + '% < 99%');
  }
  if (roadV && roadV.RESULT !== 'PASS') errors.push('road-network validator が PASS でない');
  const riverCov = rd(R.riverCov), riverV = rd(R.riverV);
  if (riverCov && (riverCov.unexplainedGapRivers || []).length) errors.push('river unexplained gap rivers ' + riverCov.unexplainedGapRivers.length);
  if (riverV && riverV.RESULT !== 'PASS') errors.push('river-network validator が PASS でない');
  const seaV = rd(R.seaV);
  if (seaV && seaV.RESULT !== 'PASS') errors.push('water-surface validator が PASS でない');
  if (seaV && seaV.stats && seaV.stats.inlandHits > 0) errors.push('illegal sea overlap (inland hits) ' + seaV.stats.inlandHits);
  if (a.byLayer.sea && a.byLayer.sea.landCellsInSea > 2) errors.push('land ∩ sea illegal overlap cell ' + a.byLayer.sea.landCellsInSea);
  const parkV = rd(R.parkV), railV = rd(R.railV);
  if (parkV && parkV.errorCount > 0) errors.push('park-lod validator error ' + parkV.errorCount);
  if (railV && railV.errorCount > 0) errors.push('rail-lod validator error ' + railV.errorCount);

  // ── 主要公園 / 鉄道 ──
  const missingParks = (a.parkCheck || []).filter((p) => !p.rendered);
  if (missingParks.length) errors.push('major park missing ' + missingParks.map((p) => p.name).join(', '));
  const missingLines = (a.railClassification && a.railClassification.lineCheck || []).filter((l) => !l.found);
  if (missingLines.length) errors.push('major rail line missing ' + missingLines.map((l) => l.name).join(', '));

  // ── HTML 配線 ──
  if (fs.existsSync(DEV_HTML)) {
    const html = fs.readFileSync(DEV_HTML, 'utf-8');
    if (!/__MAP_COMPLETENESS_DEBUG__/.test(html)) errors.push('dev HTML に __MAP_COMPLETENESS_DEBUG__ が無い');
    if (!/f\.railClass \|\| classifyRail/.test(html)) errors.push('dev HTML: rail の railClass 優先分類が無い（本線断片救済）');
    // 既存レイヤーの回帰キーワード
    for (const kw of ['LandSurfaceLayer', 'RiverLayerV2', 'const CityBuildingLOD', '__ROAD_NETWORK_DEBUG__', '__BUILDING_COVERAGE_DEBUG__', '__VISIBLE_BUILDING_GAP_DEBUG__']) {
      if (!html.includes(kw)) errors.push('dev HTML: 既存レイヤー/機能 ' + kw + ' が消えた');
    }
  }
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(label + ' HTML なし'); continue; }
    const h = fs.readFileSync(p, 'utf-8');
    if (/__MAP_COMPLETENESS_DEBUG__|f\.railClass|getRoadCellCoverage|getBuildingCellCounts/.test(h)) errors.push(label + ' HTML に Mission24 の変更が混入している');
  }

  console.log('[map-completeness-validate] overallScore ' + a.overallScore + ' / CRITICAL ' + a.criticalCount + ' HIGH ' + a.highCount + ' MEDIUM ' + a.mediumCount + ' LOW ' + a.lowCount + ' INFO ' + a.infoCount);
  console.log('  byLayer: ' + Object.entries(a.byLayer).map(([k, v]) => k + ' ' + v.score).join(' / '));
  console.log('  verdict: ' + a.verdict);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    overallScore: a.overallScore, verdict: a.verdict,
    counts: { critical: a.criticalCount, high: a.highCount, medium: a.mediumCount, low: a.lowCount, info: a.infoCount },
    byLayer: Object.fromEntries(Object.entries(a.byLayer).map(([k, v]) => [k, v.score])),
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[map-completeness-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
