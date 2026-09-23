#!/usr/bin/env node
// tools/validate/map-side-root-cause-audit.js
// [Mission 32D §35-37] MAP-SIDE ROOT CAUSE AUDIT の静的+データ検証。
//   Building(PLATEAU/GSI/Canonical/Visual)は完全READ ONLY。今回は補正をしない監査ミッションのため、
//   buildingMutation系は「何も変更されていない」ことだけを確認する（新規補正が0件であることの確認）。
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
const AUDIT_REPORT = P('data', 'reports', 'map-side-root-cause-audit.json');
const MAP_AUDIT_DIR = P('data', 'processed', 'osaka-city', 'map-audit');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';

  // ── §33/§35: Building/Canonical 不変 ──
  const bm = rj(CANON_BLDG_MANIFEST), rm = rj(CANON_ROADS_MANIFEST), refined = rj(REFINED);
  checks.buildingMutation = (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) ? 1 : 0;
  checks.canonicalRoadMutation = (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) ? 1 : 0;
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) checks.canonicalRoadMutation = 1;
  if (checks.buildingMutation) errors.push('canonical buildings featureCount 変化(§0/§33違反): ' + (bm && bm.featureCount));
  if (checks.canonicalRoadMutation) errors.push('canonical roads / refined-road-surface が変化');

  // ── §37: buildingScaleMutation / buildingPositionMutation（本ミッションはBuilding非変更のはずなので0）──
  const buildSrcFiles = ['tools/build-visual-buildings.js', 'tools/build-umeda-visual-building-poc.js'];
  let buildingScaleMutation = 0, buildingPositionMutation = 0;
  for (const f of buildSrcFiles) {
    const p = P(...f.split('/'));
    if (!fs.existsSync(p)) continue;
    const mtime = fs.statSync(p).mtimeMs;
    const auditMtime = fs.existsSync(P('tools', 'audit', 'map-side-root-cause-audit.js')) ? fs.statSync(P('tools', 'audit', 'map-side-root-cause-audit.js')).mtimeMs : 0;
    // 32D開始以降にbuilding builderへ変更が入っていないか（タイムスタンプの粗いガード。§0の意図確認用）
    if (mtime > auditMtime + 60000) { warns.push(f + ' がmap-side-root-cause-audit.js作成後に更新されている（要確認）'); }
  }
  checks.buildingScaleMutation = buildingScaleMutation;
  checks.buildingPositionMutation = buildingPositionMutation;

  // ── §35: Map Audit report の存在・必須フィールド確認 ──
  const auditReport = rj(AUDIT_REPORT);
  checks.mapLayerProvenanceComplete = !!auditReport && !!auditReport.provenanceCounts && !!auditReport.gsiRoadEdge && !!auditReport.fix13 && !!auditReport.plateauTran && !!auditReport.osm && !!auditReport.block;
  if (!checks.mapLayerProvenanceComplete) errors.push('map-side-root-cause-audit.json のprovenance必須フィールドが揃っていない');

  checks.unknownVisibleMapObjects = auditReport && auditReport.provenanceCounts ? (auditReport.provenanceCounts.UNKNOWN || 0) : 999;
  if (checks.unknownVisibleMapObjects !== 0) errors.push('UNKNOWN provenance のmap-side objectが残っている: ' + checks.unknownVisibleMapObjects);

  checks.runtimeMapScaleMeasured = !!auditReport && !!auditReport.runtimeTransformAudit && Array.isArray(auditReport.runtimeTransformAudit.targetsChecked) && auditReport.runtimeTransformAudit.targetsChecked.length > 0;
  if (!checks.runtimeMapScaleMeasured) errors.push('runtimeTransformAudit が測定されていない');
  if (auditReport && auditReport.runtimeTransformAudit && auditReport.runtimeTransformAudit.nonUnitScaleAssignments && auditReport.runtimeTransformAudit.nonUnitScaleAssignments.length > 0) {
    errors.push('非1のscale代入が検出された: ' + JSON.stringify(auditReport.runtimeTransformAudit.nonUnitScaleAssignments));
  }

  checks.projectionAuditComplete = !!auditReport && !!auditReport.projectionAudit && !!auditReport.projectionAudit.datasets && Object.keys(auditReport.projectionAudit.datasets).length >= 4;
  if (!checks.projectionAuditComplete) errors.push('projectionAudit が4データセット分揃っていない');
  if (auditReport && auditReport.projectionAudit && auditReport.projectionAudit.coordinateConventionConsistent === false) {
    errors.push('coordinateConvention が dataset間で不整合');
  }

  checks.blockSemanticsExplicit = !!auditReport && !!auditReport.block && auditReport.block.officialName === 'ROAD_ENCLOSED_BLOCK';
  if (!checks.blockSemanticsExplicit) errors.push('§23: block の正式名称がROAD_ENCLOSED_BLOCKと明示されていない');

  checks.classificationPresent = !!auditReport && Array.isArray(auditReport.classification) && auditReport.classification.length > 0;
  if (!checks.classificationPresent) errors.push('classification が空');

  // ── §30: 今回は補正しない。build script内にbuilding warp/clip/correctionコードが無いことを確認 ──
  const auditSrc = fs.existsSync(P('tools', 'audit', 'map-side-root-cause-audit.js')) ? fs.readFileSync(P('tools', 'audit', 'map-side-root-cause-audit.js'), 'utf-8') : '';
  checks.correctionAppliedThisMission = /applyCorrection|correctBuilding|warpBuilding|clipBuilding/i.test(auditSrc) ? 1 : 0;
  if (checks.correctionAppliedThisMission) errors.push('§30違反疑い: 本ミッションのスクリプトに補正コードが見つかった');

  // ── runtime: [MAP AUDIT] トグルの存在・既定OFF確認 ──
  checks.mapAuditRuntimeToggleExists = /async function setMapAuditMode\(enabled, region\)/.test(html) && /let mapAuditEnabled = false;/.test(html);
  if (!checks.mapAuditRuntimeToggleExists) errors.push('[MAP AUDIT] opt-inトグルが見つからない、またはdefault=falseでない');
  checks.mapAuditDataExists = fs.existsSync(path.join(MAP_AUDIT_DIR, 'umeda-map-audit-layers.json')) && fs.existsSync(path.join(MAP_AUDIT_DIR, 'sumiyoshi-map-audit-layers.json'));
  if (!checks.mapAuditDataExists) errors.push('map-audit fixture データファイルが無い');

  // ── production / protected 不変 ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§34 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§34 禁止）');

  return finish(errors, warns, checks, auditReport);
}

async function finish(errors, warns, checks, auditReport) {
  const report = {
    generatedAt: new Date().toISOString(), checks,
    classification: auditReport ? auditReport.classification : null,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  const REPORT_PATH = P('data', 'reports', 'map-side-root-cause-audit-validation.json');
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  await writeJson(REPORT_PATH, report);
  console.log('[map-audit-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT_PATH) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[map-audit-validate] 失敗:', e && e.stack || e); process.exit(1); });
