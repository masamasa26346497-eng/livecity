#!/usr/bin/env node
// tools/validate/alignment-visibility-final.js
// [Mission ALIGNMENT-VISIBILITY-FINAL §20] PLATEAU footprint(cyan)/GSI Building Outline(magenta)の
//   独立 overlay 生成・Y/renderOrder分離・dedicated material・picking停止・データ可用性を静的+データで
//   検証する。実機的な「count > 0」等の動的検証は tests/alignment-visibility-final.test.js（harness）側。
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
const GSI_BLD_TILES_MANIFEST = P('data', 'processed', 'osaka-city', 'derived', 'gsi-building-outline', 'manifest.json');
const PUB_GSI_BLD_TILES_MANIFEST = P('public', 'map-data', 'osaka-city', 'derived', 'gsi-building-outline', 'manifest.json');
const NEAR_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'derived', 'near', 'buildings', 'manifest.json');
const REPORT = P('data', 'reports', 'alignment-visibility-final-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';

  // ── §2/§3: PLATEAU footprint / GSI Building Outline が独立生成（旧matched-pairs流用ではない）──
  checks.plateauFootprintIndependentSource = /const PLATEAU_FP_BASE = BASE \+ '\/near\/buildings';/.test(html);
  checks.gsiBuildingOutlineIndependentSource = /const GSI_BLD_BASE = BASE \+ '\/gsi-building-outline';/.test(html);
  checks.refreshReferenceOverlaysExists = /async function refreshReferenceOverlays\(site\)/.test(html);
  if (!checks.plateauFootprintIndependentSource) errors.push('PLATEAU footprint が独立ソース(near/buildings)から生成されていない');
  if (!checks.gsiBuildingOutlineIndependentSource) errors.push('GSI Building Outline が独立ソース(gsi-building-outline tiles)から生成されていない');
  if (!checks.refreshReferenceOverlaysExists) errors.push('refreshReferenceOverlays() が定義されていない');

  // ── §5/§6: Y offset / renderOrder 分離 ──
  checks.yOffsetSeparated = /const Y_REF_PLATEAU = 0\.25;/.test(html) && /const Y_REF_GSI_BLD = 0\.30;/.test(html);
  checks.renderOrderSeparated = /const REN_REF_PLATEAU = REN\.building \+ 30;/.test(html) && /const REN_REF_GSI_BLD = REN\.building \+ 40;/.test(html);
  if (!checks.yOffsetSeparated) errors.push('Y offset(road<plateau<gsiBld)が分離されていない');
  if (!checks.renderOrderSeparated) errors.push('renderOrder(road<plateau<gsiBld)が分離されていない');

  // ── §7/§8: 専用 material（depthTest/Write off・通常 Map material と非共有）──
  checks.dedicatedMaterials = /const REF_PLATEAU_MAT = new THREE\.LineBasicMaterial\(\{ color: 0x00e5ff, transparent: true, opacity: 0\.95, depthTest: false, depthWrite: false \}\);/.test(html)
    && /const REF_GSI_BLD_MAT = new THREE\.LineBasicMaterial\(\{ color: 0xff00d4, transparent: true, opacity: 0\.95, depthTest: false, depthWrite: false \}\);/.test(html);
  if (!checks.dedicatedMaterials) errors.push('Reference専用の dedicated material(色/depth設定)が見つからない');

  // ── §14: picking(hover/click)停止 ──
  checks.pickingDisabledOnClick = /if \(typeof CanonicalRuntime !== 'undefined' && CanonicalRuntime\.isReferenceAlignmentActive && CanonicalRuntime\.isReferenceAlignmentActive\(\)\) return;/.test(html);
  checks.pickingDisabledOnHover = /Reference Alignment 中は建物hoverを完全停止/.test(html);
  checks.propertyCardHiddenOnEnter = /function hideNormalUiForReference_\(hide\)/.test(html);
  if (!checks.pickingDisabledOnClick) errors.push('Reference Alignment 中の click picking 停止ガードが見つからない');
  if (!checks.pickingDisabledOnHover) errors.push('Reference Alignment 中の hover 停止ガードが見つからない');
  if (!checks.propertyCardHiddenOnEnter) errors.push('property card 非表示処理が見つからない');

  // ── §1/§13/§17: overlay counts + legend + numerical stats の UI ──
  checks.overlayCountsUiExists = /reference-alignment-counts/.test(html) && /PLATEAU footprints/.test(html);
  checks.legendUiExists = /reference-alignment-legend/.test(html) && /GSI Road Edge/.test(html);
  checks.zeroCountShowsError = /\[ERROR\]/.test(html) && /errColor/.test(html);
  if (!checks.overlayCountsUiExists) errors.push('overlay counts の UI 表示が見つからない');
  if (!checks.legendUiExists) errors.push('3色legendのUI表示が見つからない');
  if (!checks.zeroCountShowsError) warns.push('0件時のERROR表示ロジックが見つからない（要確認）');

  // ── §11/§12: データ可用性（city-wide、梅田等の座標を含むtileが実在するか）──
  const gsiBldManifest = rj(GSI_BLD_TILES_MANIFEST);
  checks.gsiBuildingOutlineTiled = !!gsiBldManifest && gsiBldManifest.tileCount > 0 && gsiBldManifest.distinctFeatureCount > 500000;
  if (!checks.gsiBuildingOutlineTiled) errors.push('GSI Building Outline のタイル化データが無い、または件数が想定(50万超)を大幅に下回る');
  const pubGsiBldManifest = rj(PUB_GSI_BLD_TILES_MANIFEST);
  checks.gsiBuildingOutlinePublished = !!pubGsiBldManifest && pubGsiBldManifest.tileCount === (gsiBldManifest && gsiBldManifest.tileCount);
  if (!checks.gsiBuildingOutlinePublished) errors.push('GSI Building Outline tile が public へ未配信、または processed 側と件数不一致');
  const nearBldgManifest = rj(NEAR_BLDG_MANIFEST);
  checks.plateauFootprintSourceAvailable = !!nearBldgManifest && nearBldgManifest.featureCount === EXPECT_BLDG_FEATURES && nearBldgManifest.simplificationToleranceM === 0;
  if (!checks.plateauFootprintSourceAvailable) errors.push('PLATEAU footprint のソース(near/buildings exact)が想定と異なる');

  // ── production / protected 不変 ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0 禁止）');

  // ── geometry / coordinate 不変 ──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED);
  let geometryMutation = 0, coordinateMutation = 0;
  if (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) { geometryMutation++; errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount)); }
  if (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) { geometryMutation++; errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount)); }
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) { geometryMutation++; errors.push('refined-road-surface.json indexedCount 変化: ' + (refined && refined.indexedCount)); }
  checks.geometryMutation = geometryMutation;
  checks.projectionMutation = /geoToLocal|geoToThree/.test(html) && !/135\.52502/.test(html) ? 1 : 0;
  if (checks.projectionMutation) { coordinateMutation++; errors.push('projection定数(135.52502等)が見つからない（projection式が変更された疑い）'); }
  checks.coordinateMutation = coordinateMutation;

  return finish(errors, warns, checks);
}

async function finish(errors, warns, checks) {
  const report = {
    generatedAt: new Date().toISOString(),
    checks,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    note: '実機的なcount>0・orthographic=true・visible3DBuildings=0・propertyPopupVisible=false等の' +
      '動的検証は tests/alignment-visibility-final.test.js（harness）側で実施する。',
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[alignment-visibility-final-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[alignment-visibility-final-validate] 失敗:', e && e.stack || e); process.exit(1); });
