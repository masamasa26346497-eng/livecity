#!/usr/bin/env node
// tools/validate/building-map-scale-audit.js
// [Mission 31G-SCALE-AUDIT §24] 測定専用ミッションの検証。geometry/coordinate/road が一切変更
//   されていないこと、および測定自体が実際に行われた(捏造でない)ことを確認する。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const CANON_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const AUDIT_REPORT = P('data', 'reports', 'building-map-scale-audit.json');
const REPORT = P('data', 'reports', 'building-map-scale-audit-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;
const MIN_HIGH_MATCHES = 2000; // FIX22と同じ「最低数千棟」下限（§9相当の基準を流用）

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};

  const audit = rj(AUDIT_REPORT);
  checks.auditReportExists = !!audit;
  if (!audit) { errors.push('building-map-scale-audit.json が無い（先に tools/audit/building-map-scale-audit.js）'); return finish(errors, warns, checks); }

  checks.matchedCountSufficient = (audit.matchedCount || 0) >= MIN_HIGH_MATCHES;
  if (!checks.matchedCountSufficient) errors.push('HIGH match件数が下限(' + MIN_HIGH_MATCHES + ')未満: ' + audit.matchedCount);

  checks.runtimeScaleMeasured = !!(audit.validatorFlags && audit.validatorFlags.runtimeScaleMeasured);
  checks.parentScaleMeasured = !!(audit.validatorFlags && audit.validatorFlags.parentScaleMeasured);
  checks.affineMeasured = !!(audit.validatorFlags && audit.validatorFlags.affineMeasured);
  checks.footprintDimensionMeasured = !!(audit.validatorFlags && audit.validatorFlags.footprintDimensionMeasured);
  for (const k of ['runtimeScaleMeasured', 'parentScaleMeasured', 'affineMeasured', 'footprintDimensionMeasured']) {
    if (!checks[k]) errors.push(k + ' が false（§24 必須測定項目）');
  }

  checks.classificationPresent = typeof audit.classification === 'string' && audit.classification.length > 0;
  const VALID_CLASS = ['BUILDING_SIZE_CORRECT', 'BUILDING_FOOTPRINT_OVERSIZED', 'BUILDING_FOOTPRINT_UNDERSIZED',
    'RUNTIME_SCALE_ERROR', 'MAP_SCALE_ERROR', 'ANISOTROPIC_SCALE_ERROR', 'SOURCE_SEMANTICS_DIFFERENCE'];
  checks.classificationValid = VALID_CLASS.includes(audit.classification);
  if (!checks.classificationValid) errors.push('classification が §20 の分類リストに無い値: ' + audit.classification);

  checks.correctionNotApplied = !!(audit.recommendedCorrection && audit.recommendedCorrection.appliedToRuntime === false);
  if (audit.recommendedCorrection && audit.recommendedCorrection.applicable && audit.recommendedCorrection.appliedToRuntime !== false) {
    errors.push('§0/§21 違反疑い: correction candidate が Runtime へ適用されたと記録されている');
  }

  // ── §7/§9: runtime scale が「触られていない」ことの直接証跡 ──
  const rt = audit.runtime && audit.runtime.audit;
  checks.noNonSpriteScaleMutation = !!rt && Array.isArray(rt.nonSpriteScaleAssignments) && rt.nonSpriteScaleAssignments.length === 0;
  if (!checks.noNonSpriteScaleMutation) errors.push('非spriteのscale代入がruntimeコードに検出された（§7/§9の前提が崩れている）');

  // ── production / protected 不変・geometry不変（測定ミッションなので当然0のはず）──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0 禁止）');

  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED);
  let geometryMutation = 0, roadMutation = 0;
  if (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) { geometryMutation++; errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount)); }
  if (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) { roadMutation++; errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount)); }
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) { roadMutation++; errors.push('refined-road-surface.json indexedCount 変化: ' + (refined && refined.indexedCount)); }
  checks.geometryMutation = geometryMutation;
  checks.roadMutation = roadMutation;
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';
  checks.coordinateMutation = (/geoToLocal|geoToThree/.test(html) && !/135\.52502/.test(html)) ? 1 : 0;
  if (checks.coordinateMutation) errors.push('projection定数(135.52502)が見つからない（coordinate mutationの疑い）');

  return finish(errors, warns, checks, audit);
}

async function finish(errors, warns, checks, audit) {
  const report = {
    generatedAt: new Date().toISOString(),
    checks,
    classification: audit ? audit.classification : null,
    footprintSummary: audit ? { areaRatioMedian: audit.footprint.areaRatioMedian, linearScaleMedian: audit.footprint.linearScaleMedian } : null,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[building-map-scale-audit-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[building-map-scale-audit-validate] 失敗:', e && e.stack || e); process.exit(1); });
