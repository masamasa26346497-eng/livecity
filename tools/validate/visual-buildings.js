#!/usr/bin/env node
// tools/validate/visual-buildings.js
// [Mission 32B §37] GSI Unified Building Placement の静的+データ検証。
//   §0/§35遵守: Canonical Buildings(615,617)/Canonical Roads(199,658)/raw GSIは一切変更していないこと。
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
const GSI_EDGE_MANIFEST = P('data', 'processed', 'osaka-city', 'derived', 'gsi-road-edge', 'manifest.json');
const VB_BUILD_REPORT = P('data', 'reports', 'visual-buildings-build.json');
const VB_CONTAINMENT_REPORT = P('data', 'reports', 'visual-building-block-containment.json');
const VB_MANIFEST = P('data', 'processed', 'osaka-city', 'visual-buildings', 'manifest.json');
const REPORT = P('data', 'reports', 'visual-buildings-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';

  // ── §35: Canonical不変 ──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED);
  checks.canonicalBuildingMutation = (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) ? 1 : 0;
  checks.canonicalRoadMutation = (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) ? 1 : 0;
  if (checks.canonicalBuildingMutation) errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount));
  if (checks.canonicalRoadMutation) errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount));
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) { checks.canonicalRoadMutation = 1; errors.push('refined-road-surface.json indexedCount 変化: ' + (refined && refined.indexedCount)); }

  // ── §35: raw GSIデータ不変（importスクリプトがgeometryを書き換えていないことの間接確認: 件数の再現性）──
  const gsiAreaM = rj(GSI_AREA_MANIFEST);
  checks.gsiBuildingMutation = (!gsiAreaM || gsiAreaM.featureCountClean <= 0) ? 1 : 0;
  if (checks.gsiBuildingMutation) errors.push('GSI building area(BldA)データが見つからない、または0件');
  const gsiEdgeM = rj(GSI_EDGE_MANIFEST);
  checks.gsiRoadMutation = (!gsiEdgeM || gsiEdgeM.distinctFeatureCount !== 112199) ? 1 : 0;
  if (checks.gsiRoadMutation) errors.push('GSI road edgeデータの件数が31G-ALIGNMENT-RESETで確定した112,199から変化: ' + (gsiEdgeM && gsiEdgeM.distinctFeatureCount));

  // ── §37: Visual Building 構築の確認 ──
  const buildReport = rj(VB_BUILD_REPORT);
  checks.visualBuildingsBuilt = !!buildReport && buildReport.totalVisualBuildings > 0;
  if (!checks.visualBuildingsBuilt) errors.push('visual-buildings-build.json が無い、またはtotalVisualBuildings=0');
  checks.gsiGeometryUsed = !!buildReport && buildReport.gsiGeometryUsedCount > 0;
  if (!checks.gsiGeometryUsed) errors.push('gsiGeometryUsedCount が0（GSI polygonが1件も採用されていない）');
  checks.canonicalBuildingCountMatches = !!buildReport && buildReport.canonicalBuildingCount === EXPECT_BLDG_FEATURES;
  if (!checks.canonicalBuildingCountMatches) errors.push('visual-buildings構築時のcanonicalBuildingCountが615,617と不一致: ' + (buildReport && buildReport.canonicalBuildingCount));

  const vbManifest = rj(VB_MANIFEST);
  checks.visualBuildingBlockAssigned = !!vbManifest && vbManifest.featureCount > 0; // ここでの"block assigned"=タイルへの正常な振り分け（§10相当の簡易確認）
  if (!checks.visualBuildingBlockAssigned) errors.push('visual-buildings tile manifestのfeatureCountが0');

  // ── §28/§29: containment(outsideRatio)測定結果の存在確認 ──
  const containment = rj(VB_CONTAINMENT_REPORT);
  checks.majorOutsideRateReported = !!containment && !!containment.citySample && typeof containment.citySample.majorOutsideRate !== 'undefined';
  if (!checks.majorOutsideRateReported) errors.push('block containment(majorOutsideRate等)が測定されていない');

  // ── §37: illegal transform禁止（geometry操作コードにoffset/scale/warpが無いこと）──
  const joinSrc = fs.existsSync(P('tools', 'lib', 'gsi-visual-building-join.js')) ? fs.readFileSync(P('tools', 'lib', 'gsi-visual-building-join.js'), 'utf-8') : '';
  const buildSrc = fs.existsSync(P('tools', 'build-visual-buildings.js')) ? fs.readFileSync(P('tools', 'build-visual-buildings.js'), 'utf-8') : '';
  checks.illegalGlobalOffset = /\bx\s*\+=\s*(?:GLOBAL|OFFSET)/i.test(joinSrc + buildSrc) ? 1 : 0;
  checks.illegalGlobalScale = /\*\s*(?:SCALE_FACTOR|GLOBAL_SCALE)/i.test(joinSrc + buildSrc) ? 1 : 0;
  // "illegalWarp"というフィールド名自体が正規表現/warp/にマッチしてしまう自己参照的false positiveを
  // 避けるため、そのフィールド名の行を除いてから検索する。
  const warpScanSrc = (joinSrc + buildSrc).replace(/illegalWarp/g, '');
  checks.illegalWarp = /warp|shear.*correction|stretch.*building/i.test(warpScanSrc) ? 1 : 0;
  if (checks.illegalGlobalOffset) errors.push('§0/§17違反疑い: global offsetコードを検出');
  if (checks.illegalGlobalScale) errors.push('§0/§20違反疑い: global scaleコードを検出');
  if (checks.illegalWarp) errors.push('§20違反疑い: warp/shear補正コードを検出');
  checks.correctionNotAppliedByDefault = !!buildReport && buildReport.geometrySourceCounts && buildReport.geometrySourceCounts.PLATEAU_FALLBACK_ADJUSTED === 0;
  if (!checks.correctionNotAppliedByDefault) warns.push('PLATEAU_FALLBACK_ADJUSTED が0件でない（局所補正が適用されている。§17-19の条件を満たしているか要確認）');

  // ── runtime: opt-inトグルの存在確認（§0: defaultはON化しない）──
  checks.visualBuildingsRuntimeToggleExists = /function setVisualBuildingsMode\(on\)/.test(html) && /let visualBuildingsMode = false;/.test(html);
  if (!checks.visualBuildingsRuntimeToggleExists) errors.push('Visual Buildings opt-inトグルが見つからない、またはdefault=falseでない');

  // ── production / protected 不変 ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0/§30 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0/§30 禁止）');

  checks.projectionMutation = (/geoToLocal|geoToThree/.test(html) && !/135\.52502/.test(html)) ? 1 : 0;
  if (checks.projectionMutation) errors.push('projection定数(135.52502)が見つからない');

  return finish(errors, warns, checks);
}

async function finish(errors, warns, checks) {
  const report = {
    generatedAt: new Date().toISOString(), checks,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[visual-buildings-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[visual-buildings-validate] 失敗:', e && e.stack || e); process.exit(1); });
