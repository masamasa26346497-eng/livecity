#!/usr/bin/env node
// tools/validate/alignment-reset.js
// [Mission 31G-ALIGNMENT-RESET §35] Scene Root 構造分離 + GSI Road Edge Authoritative Layer +
//   Reference Alignment Mode の静的+データ検証。§0遵守: 読み取り専用（geometry/projectionを変更しない）。
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
const GSI_EDGE_MANIFEST = P('data', 'processed', 'osaka-city', 'derived', 'gsi-road-edge', 'manifest.json');
const PUB_GSI_EDGE_MANIFEST = P('public', 'map-data', 'osaka-city', 'derived', 'gsi-road-edge', 'manifest.json');
const ALIGNMENT_RESET_REPORT = P('data', 'reports', 'alignment-reset.json');
const REPORT = P('data', 'reports', 'alignment-reset-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';

  // ── §3/§35: canonicalRoot / legacyRoot / debugRoot が定義され scene へ add されている ──
  checks.canonicalRootExists = /const canonicalRoot = new THREE\.Group\(\); canonicalRoot\.name = 'canonicalRoot';/.test(html);
  checks.legacyRootExists = /const legacyRoot = new THREE\.Group\(\); legacyRoot\.name = 'legacyRoot';/.test(html);
  checks.debugRootExists = /const debugRoot = new THREE\.Group\(\); debugRoot\.name = 'debugRoot';/.test(html);
  checks.uiRootExists = /const uiRoot = new THREE\.Group\(\); uiRoot\.name = 'uiRoot';/.test(html);
  for (const [k, v] of Object.entries({ canonicalRootExists: checks.canonicalRootExists, legacyRootExists: checks.legacyRootExists, debugRootExists: checks.debugRootExists, uiRootExists: checks.uiRootExists })) {
    if (!v) errors.push(k + ' が false（scene root 定義が見つからない）');
  }

  // ── §4/§35: legacy content は legacyRoot 経由（scene.add直書きが残っていないか）──
  const directLegacyPatterns = [
    /scene\.add\(gnd\);/, // 旧ground
    /scene\.add\(new THREE\.LineSegments\(eg, rdLineMat\)\);/, // 旧tran道路エッジ
    // RoadLayer/StreetscapeLayer/BuildingTileLayer 等の代表的な group scene.add直書き（legacyRoot化済みなら一致しない）
    /group\.name = 'CityBuildingLOD'; scene\.add\(group\);/,
  ];
  let directLegacySceneAdd = 0;
  for (const re of directLegacyPatterns) if (re.test(html)) directLegacySceneAdd++;
  checks.directLegacySceneAdd = directLegacySceneAdd;
  if (directLegacySceneAdd > 0) errors.push('legacy content が scene へ直接 add されている箇所を検出: ' + directLegacySceneAdd + ' 件（legacyRoot.add() へ移行すべき）');

  // ── §3: toggleOldLayers が legacyRoot.visible / canonicalRoot.visible を構造的に切り替えている ──
  checks.toggleOldLayersControlsRoots = /legacyRoot\.visible = !hidden;/.test(html) && /canonicalRoot\.visible = !!hidden;/.test(html);
  if (!checks.toggleOldLayersControlsRoots) errors.push('toggleOldLayers() が legacyRoot/canonicalRoot.visible を切り替えていない（構造的な最終防御が欠落）');

  // ── §8/§9/§10/§27: GSI Road Edge が authoritative outline として tile 化・配信されている ──
  const gsiManifest = rj(GSI_EDGE_MANIFEST);
  checks.gsiRoadEdgeTiled = !!gsiManifest && gsiManifest.tileCount > 0;
  checks.gsiRoadEdgeFeatureCount = gsiManifest ? gsiManifest.distinctFeatureCount : null;
  checks.gsiRoadEdgeCoordinateConvention = !!gsiManifest && gsiManifest.coordinateConvention === 'znorth-neg-v1';
  if (!checks.gsiRoadEdgeTiled) errors.push('GSI Road Edge のタイル化データが無い（先に tools/build-gsi-road-edge-tiles.js）');
  const pubGsiManifest = rj(PUB_GSI_EDGE_MANIFEST);
  checks.gsiRoadEdgePublished = !!pubGsiManifest && pubGsiManifest.tileCount === (gsiManifest && gsiManifest.tileCount);
  if (!checks.gsiRoadEdgePublished) errors.push('GSI Road Edge tile が public へ未配信、または processed 側と件数不一致');

  // ── §31: 1 road = 1 mesh 禁止（tile 単位で LineSegments へ merge している）──
  checks.gsiRoadEdgeTileMerged = /const geo = new THREE\.BufferGeometry\(\);\s*\n\s*geo\.setAttribute\('position', new THREE\.BufferAttribute\(new Float32Array\(pos\), 3\)\);\s*\n\s*const curColor/.test(html);
  if (!checks.gsiRoadEdgeTileMerged) warns.push('GSI Road Edge の tile-merge 実装パターンが変更されている可能性（要目視確認）');

  // ── §15-17: Reference Alignment Mode + 真の OrthographicCamera ──
  checks.orthoCameraExists = /const orthoCamera = new THREE\.OrthographicCamera\(/.test(html);
  checks.referenceAlignmentModeExists = /function setReferenceAlignment\(active, siteId\)/.test(html);
  checks.referenceSitesCount = (html.match(/REFERENCE_SITES = \[/) || []).length > 0
    ? (JSON.stringify([...html.matchAll(/\{ id: '(\w+)', name: '([^']+)'/g)]).match(/id:/g) || []).length
    : 0;
  const expectedSiteIds = ['umeda', 'nakanoshima', 'honmachi', 'namba', 'tennoji', 'sumiyoshi'];
  checks.allSixSitesPresent = expectedSiteIds.every((id) => html.includes("id: '" + id + "'"));
  if (!checks.orthoCameraExists) errors.push('orthoCamera(THREE.OrthographicCamera) が定義されていない（§16/§17: parallax排除には真の直交投影が必要）');
  if (!checks.referenceAlignmentModeExists) errors.push('setReferenceAlignment() が定義されていない');
  if (!checks.allSixSitesPresent) errors.push('§18 の6地点(梅田/中之島/本町/難波/天王寺/住吉)が REFERENCE_SITES に揃っていない');

  // ── §20: 唯一の RoadLayer(Legacy) は Canonical mode で描画に参加しない（legacyRoot.visible=false で保証）──
  checks.legacyRoadLayerStructurallyIsolated = /legacyRoot\.add\(group\);/.test(html) && /const RoadLayer = \(function\(\)\{/.test(html);
  if (!checks.legacyRoadLayerStructurallyIsolated) warns.push('RoadLayer の legacyRoot 経由が確認できない（要目視）');

  // ── §26: FIX24 の buildings near tolerance=0 を維持（本ミッションでbuildingを一切動かしていない再確認）──
  const nearBldgManifest = rj(P('data', 'processed', 'osaka-city', 'derived', 'near', 'buildings', 'manifest.json'));
  checks.fix24NearExactPreserved = !!nearBldgManifest && nearBldgManifest.simplificationToleranceM === 0;
  if (!checks.fix24NearExactPreserved) errors.push('FIX24 の near tolerance=0(exact canonical footprint) が失われている');

  // ── production / protected 不変 ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0 禁止）');

  // ── geometry 不変（canonical building/road count・refined-road-surface不変）──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED);
  let geometryMutation = 0;
  if (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) { geometryMutation++; errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount)); }
  if (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) { geometryMutation++; errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount)); }
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) { geometryMutation++; errors.push('refined-road-surface.json indexedCount 変化: ' + (refined && refined.indexedCount)); }
  checks.buildingGeometryMutation = (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) ? 1 : 0;
  checks.roadGeometryMutation = (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) ? 1 : 0;
  checks.projectionMutation = /geoToLocal|geoToThree/.test(html) && !/135\.52502/.test(html) ? 1 : 0;
  if (checks.projectionMutation) errors.push('projection定数(135.52502等)が見つからない（projection式が変更された疑い）');
  checks.geometryMutation = geometryMutation;

  // ── §34: alignment-reset.json レポートの存在確認 ──
  const alignReport = rj(ALIGNMENT_RESET_REPORT);
  checks.alignmentResetReportExists = !!alignReport;
  checks.alignmentResetReportHasSixSites = !!alignReport && Array.isArray(alignReport.buildingVsGsiRoadEdge) && alignReport.buildingVsGsiRoadEdge.length === 6;
  if (!checks.alignmentResetReportExists) warns.push('alignment-reset.json が無い（先に tools/audit/alignment-reset.js）');
  else if (!checks.alignmentResetReportHasSixSites) errors.push('alignment-reset.json の buildingVsGsiRoadEdge が6地点そろっていない');

  return finish(errors, warns, checks);
}

async function finish(errors, warns, checks) {
  const report = {
    generatedAt: new Date().toISOString(),
    checks,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[alignment-reset-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[alignment-reset-validate] 失敗:', e && e.stack || e); process.exit(1); });
