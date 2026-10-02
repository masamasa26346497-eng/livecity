#!/usr/bin/env node
// tools/validate/umeda-visual-building-poc.js
// [Mission 32C §37] Umeda GSI Unified Visual Building PoC の静的+データ検証。
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
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const CANON_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const GSI_AREA_MANIFEST = P('data', 'processed', 'osaka-city', 'gsi-building-area', 'manifest.json');
const POC_REPORT = P('data', 'reports', 'umeda-visual-building-poc.json');
const POC_DATA = P('data', 'processed', 'osaka-city', 'visual-buildings-poc', 'umeda', 'umeda-visual-buildings.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;
const EXPECT_GSI_AREA_FEATURES = 571325;

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';

  // ── §35: Canonical/GSI raw 不変 ──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED), gsiAreaM = rj(GSI_AREA_MANIFEST);
  checks.canonicalMutation = (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) ? 1 : 0;
  checks.roadMutation = (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) ? 1 : 0;
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) { checks.roadMutation = 1; errors.push('refined-road-surface.json indexedCount 変化'); }
  checks.gsiRawMutation = (!gsiAreaM || gsiAreaM.featureCountClean !== EXPECT_GSI_AREA_FEATURES) ? 1 : 0;
  if (checks.canonicalMutation) errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount));
  if (checks.roadMutation) errors.push('canonical roads / refined-road-surface が変化');
  if (checks.gsiRawMutation) errors.push('GSI building area(BldA) featureCountClean が31G-32Bで確定した' + EXPECT_GSI_AREA_FEATURES + 'から変化: ' + (gsiAreaM && gsiAreaM.featureCountClean));

  // ── §37: PoC構築の確認 ──
  const pocReport = rj(POC_REPORT);
  checks.visualBuildingsCreated = !!pocReport && pocReport.counts && pocReport.counts.totalVisualBuildings > 0;
  if (!checks.visualBuildingsCreated) errors.push('Umeda visual buildings が0件、またはreportが無い');
  checks.blockAssignmentCreated = !!pocReport && pocReport.blockStats && pocReport.blockStats.totalBlocks > 0;
  if (!checks.blockAssignmentCreated) errors.push('block割当(blockStats)が作られていない');
  checks.pocDataExists = fs.existsSync(POC_DATA);
  if (!checks.pocDataExists) errors.push('umeda-visual-buildings.json が無い');

  // ── §37: illegal transform禁止 ──
  const buildSrc = fs.existsSync(P('tools', 'build-umeda-visual-building-poc.js')) ? fs.readFileSync(P('tools', 'build-umeda-visual-building-poc.js'), 'utf-8') : '';
  checks.globalOffsetApplied = /\bx\s*\+=\s*(?:GLOBAL|OFFSET)\b/i.test(buildSrc) ? 1 : 0;
  checks.globalScaleApplied = /\*\s*(?:SCALE_FACTOR|GLOBAL_SCALE)\b/i.test(buildSrc) ? 1 : 0;
  const warpScan = buildSrc.replace(/warpApplied/g, '');
  checks.warpApplied = /warp|shear.*correction|stretch.*building/i.test(warpScan) ? 1 : 0;
  if (checks.globalOffsetApplied) errors.push('§0違反疑い: global offsetコードを検出');
  if (checks.globalScaleApplied) errors.push('§0違反疑い: global scaleコードを検出');
  if (checks.warpApplied) errors.push('§0違反疑い: warp/shear補正コードを検出');

  // ── §25/§26: property link保持の確認 ──
  const pocData = rj(POC_DATA);
  checks.propertyLinkRetained = !!pocData && pocData.features.every((f) => Array.isArray(f.canonicalIds) && f.canonicalIds.length > 0);
  if (!checks.propertyLinkRetained) errors.push('canonicalIdsを保持していないVisual Buildingがある（property card接続が壊れる）');

  // ── runtime: opt-inトグルの存在・既定OFF確認 ──
  checks.umedaPocRuntimeToggleExists = /async function setUmedaPocMode\(enabled, source\)/.test(html) && /let umedaPocEnabled = false;/.test(html);
  if (!checks.umedaPocRuntimeToggleExists) errors.push('Umeda PoC opt-inトグルが見つからない、またはdefault=falseでない');
  checks.scopedToUmedaBounds = /function umedaPocTileRange\(\)/.test(html);
  if (!checks.scopedToUmedaBounds) errors.push('梅田範囲scoping関数(umedaPocTileRange)が見つからない');

  // ── §27: Block QA overlay（dev専用。必須KPIではないがwarn対象として確認） ──
  checks.blockQaOverlayExists = /async function setBlockQaEnabled\(on\)/.test(html) && fs.existsSync(P('data', 'processed', 'osaka-city', 'visual-buildings-poc', 'umeda', 'block-raster.json'));
  if (!checks.blockQaOverlayExists) warns.push('§27 Block QA overlay が未実装、またはblock-raster.jsonが無い（KPI必須ではないため警告のみ）');

  // ── production / protected 不変 ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0/§30 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0/§30 禁止）');

  checks.projectionMutation = (/geoToLocal|geoToThree/.test(html) && !/135\.52502/.test(html)) ? 1 : 0;
  if (checks.projectionMutation) errors.push('projection定数(135.52502)が見つからない');

  return finish(errors, warns, checks, pocReport);
}

async function finish(errors, warns, checks, pocReport) {
  const report = {
    generatedAt: new Date().toISOString(), checks,
    verdict: pocReport ? pocReport.verdict : null,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(P('data', 'reports')), { recursive: true });
  const REPORT_PATH = P('data', 'reports', 'umeda-visual-building-poc-validation.json');
  await writeJson(REPORT_PATH, report);
  console.log('[umeda-poc-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT_PATH) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[umeda-poc-validate] 失敗:', e && e.stack || e); process.exit(1); });
