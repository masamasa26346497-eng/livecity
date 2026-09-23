#!/usr/bin/env node
// tools/validate/umeda-ground-footprint-audit.js
// [Mission 32G §21] GROUND FOOTPRINT ROOT AUDIT の検証。今回はAUDIT ONLYのため、
//   「何も変更していないこと」と「必要な追跡・確認が実際に行われたこと」を検証する。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const CANON_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const ROAD_V2_MANIFEST = P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v2', 'manifest.json');
const LAND_BLOCK_BLOCKS = P('data', 'processed', 'osaka-city', 'visual-land-block-poc', 'umeda', 'blocks.json');
const PROJECTION_CONFIG = P('config', 'areas', 'osaka-city.json');
const REPORT = P('data', 'reports', 'umeda-ground-footprint-audit.json');

const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;
const EXPECT_ROAD_V2_UNIQUE = 169468;
const EXPECT_LAND_BLOCK_COUNT = 178;

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';
  const report = rj(REPORT);

  // ── §0/§21: 何も変更していないこと ──
  const bm = rj(CANON_BLDG_MANIFEST), rm = rj(CANON_ROADS_MANIFEST), refined = rj(REFINED);
  checks.buildingMutation = (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) ? 1 : 0;
  if (checks.buildingMutation) errors.push('canonical buildings featureCount 変化(§0違反): ' + (bm && bm.featureCount));
  checks.roadMutation = (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) ? 1 : 0;
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) checks.roadMutation = 1;
  const roadV2m = rj(ROAD_V2_MANIFEST);
  if (!roadV2m || roadV2m.uniqueFeatureCount !== EXPECT_ROAD_V2_UNIQUE) checks.roadMutation = 1;
  if (checks.roadMutation) errors.push('canonical roads / refined-road-surface / ROAD V2 が変化(§0違反)');
  const lb = rj(LAND_BLOCK_BLOCKS);
  checks.landBlockMutation = (!lb || lb.count !== EXPECT_LAND_BLOCK_COUNT) ? 1 : 0;
  if (checks.landBlockMutation) errors.push('Visual Land Block(32F成果物)が変化(§0違反): ' + (lb && lb.count));
  const proj = rj(PROJECTION_CONFIG);
  checks.projectionMutation = (!proj || proj.projection.centerLon !== 135.52502 || proj.projection.centerLat !== 34.604208) ? 1 : 0;
  if (checks.projectionMutation) errors.push('projection定数が変化(§0違反)');

  // ── §21: 追跡・確認が実際に行われたこと ──
  checks.sourceGeometryTraced = !!(report && report.sourceAvailability && report.sourceAvailability.converterLogic
    && report.sourceAvailability.converterLogic.priorityCommentFound === true
    && report.sourceAvailability.rawCityGmlAvailability);
  if (!checks.sourceGeometryTraced) errors.push('§2: PLATEAU source geometryの追跡結果が報告に無い');

  const grep = report && report.sourceAvailability && report.sourceAvailability.rawCityGmlAvailability
    ? report.sourceAvailability.rawCityGmlAvailability.sumiyoshiRawGrepCounts : null;
  checks.groundSurfaceChecked = !!(grep && typeof grep.GroundSurface === 'number');
  if (!checks.groundSurfaceChecked) errors.push('§4: GroundSurfaceの実在確認が行われていない');
  checks.roofEdgeChecked = !!(grep && typeof grep.lod0RoofEdge === 'number' && typeof grep.RoofSurface === 'number');
  if (!checks.roofEdgeChecked) errors.push('§6: RoofEdge/RoofSurfaceの実在確認が行われていない');

  checks.runtimeSourceIdentified = !!(report && report.currentFootprintSource
    && ['LOD0_FOOTPRINT', 'GROUND_SURFACE', 'ROOF_EDGE', 'LOD1_HORIZONTAL_FACE', 'SOLID_PROJECTION', 'OTHER'].includes(report.currentFootprintSource.classification));
  if (!checks.runtimeSourceIdentified) errors.push('§3: 現在のRuntime footprint sourceが特定・分類されていない');

  // ── §16/§22: 集計と最終判定の存在 ──
  checks.sampleCountAtLeast30 = !!(report && report.sampleCount >= 30);
  if (!checks.sampleCountAtLeast30) errors.push('§1: sampleが30棟に満たない: ' + (report && report.sampleCount));
  checks.finalClassificationValid = !!(report && ['GROUND_FOOTPRINT_SEMANTICS_ERROR', 'CURRENT_FOOTPRINT_IS_CORRECT', 'SPECIAL_STRUCTURE_DOMINANT', 'SOURCE_CONFLICT'].includes(report.finalClassification));
  if (!checks.finalClassificationValid) errors.push('§22: 最終判定が4択のいずれでもない: ' + (report && report.finalClassification));
  checks.controlGroupPresent = !!(report && report.comparison && report.comparison.controlGroup && report.comparison.controlGroup.count > 0);
  if (!checks.controlGroupPresent) errors.push('対照群(control group)が無い＝sample固有の性質か全域の傾向かを区別できない');
  checks.discriminationLimitationDisclosed = !!(report && report.discriminationLimitation && report.discriminationLimitation.note);
  if (!checks.discriminationLimitationDisclosed) errors.push('判別限界(H1/H2を区別できない点)が開示されていない');

  // ── §14: QA overlayがread-onlyであること(building geometryを作り変えていない) ──
  checks.qaOverlayReadOnly = /function buildGroundFpQaMeshes\(\)/.test(html)
    && !/buildGroundFpQaMeshes[\s\S]{0,1500}pushExtrude/.test(html);
  if (!checks.qaOverlayReadOnly) errors.push('§14 QA overlayがbuilding geometryを再構築している疑い');
  checks.qaOverlayDefaultOff = /let groundFpQaEnabled = false;/.test(html);
  if (!checks.qaOverlayDefaultOff) errors.push('§14 QA overlayが既定OFFでない');

  // ── §production protection ──
  const baseline = rj(BASELINE);
  const curProd = sha(PROD), curProt = sha(PROT);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている');
  if (checks.protectedModified) errors.push('protected HTML が変更されている');

  const out = {
    generatedAt: new Date().toISOString(), checks,
    finalClassification: report ? report.finalClassification : null,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  const REPORT_PATH = P('data', 'reports', 'umeda-ground-footprint-audit-validation.json');
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  await writeJson(REPORT_PATH, out);
  console.log('[ground-fp-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT_PATH) + '  RESULT: ' + out.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[ground-fp-validate] 失敗:', e && e.stack || e); process.exit(1); });
