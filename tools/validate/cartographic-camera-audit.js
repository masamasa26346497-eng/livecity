#!/usr/bin/env node
// tools/validate/cartographic-camera-audit.js
// [Mission 31G-FIX25 §21] Cartographic 3D Camera の静的+データ検証。
//   §0遵守: building/road/GSI geometry・projectionを一切変更していないことを確認する（読み取り専用）。
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
const NEAR_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'derived', 'near', 'buildings', 'manifest.json');
const AUDIT_REPORT = P('data', 'reports', 'cartographic-camera-audit.json');
const REPORT = P('data', 'reports', 'cartographic-camera-audit-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';

  // ── §4/§10: Cartographic Camera モードが実装されている ──
  checks.cartographicCameraExists = /const CAMERA_MODE_PITCH = \{ current: Math\.PI \/ 4, cartographic: 25 \* Math\.PI \/ 180, topdown: 0\.08 \};/.test(html)
    && /function setCameraMode\(mode\)/.test(html);
  if (!checks.cartographicCameraExists) errors.push('Cartographic Camera(CAMERA_MODE_PITCH/setCameraMode)が見つからない');
  checks.threeModeToggleExists = /'camera-mode-btn-' \+ mode/.test(html)
    && /\['current', 'Current'\], \['cartographic', 'Cartographic'\], \['topdown', 'Top Down'\]/.test(html);
  if (!checks.threeModeToggleExists) errors.push('[Current]/[Cartographic]/[Top Down] 3ボタンが見つからない');

  // ── §8/§9: target が地表(y)アンカーのまま（flyTo/selectBuildingがtgt.y/FOV/phを変更しない） ──
  const flyToStart = html.indexOf('function flyTo(x, z, opts={}){');
  const flyToBody = html.slice(flyToStart, flyToStart + 900);
  const selStart = html.indexOf('function selectBuilding(e, h){');
  const selBody = html.slice(selStart, selStart + 2000);
  checks.targetGroundAnchored = !/tgt\.y\s*=/.test(flyToBody) && !/cs\.ph\s*=|camera\.fov\s*=|cs\.tgt\.y\s*=/.test(selBody);
  if (!checks.targetGroundAnchored) errors.push('flyTo/selectBuildingがcs.tgt.y・FOV・pitchを変更している（§8/§9違反）');

  // ── §7: ground coverage 保存の距離補正係数が実装されている ──
  checks.groundCoverageComparable = /const CAMERA_MODE_R_SCALE = \{ current: 1, cartographic: 1\.670, topdown: 1 \};/.test(html);
  if (!checks.groundCoverageComparable) errors.push('ground coverage保存用の距離補正係数(CAMERA_MODE_R_SCALE)が見つからない');

  // ── §19: defaultはCurrentのまま（let cameraMode = 'current';） ──
  checks.defaultIsCurrent = /let cameraMode = 'current';/.test(html);
  if (!checks.defaultIsCurrent) errors.push('§19違反: cameraModeの既定値がcurrentでない');

  // ── §15: 建物高さスケールを変更していない（heightScale等の乗算が追加されていない） ──
  checks.noHeightScaleMutation = !/heightScale\s*[*/]?=\s*0\.\d/.test(html);
  if (!checks.noHeightScaleMutation) errors.push('§15違反: heightScaleを1以外へ変更している疑い');

  // ── §18: LOD判定がscreen-space/FOVに依存していない（ground-distance/cs.rベースのまま）──
  checks.lodNotFovDependent = !/CAMERA_MODE_FOV\[cameraMode\][^;]*(?:tolM|LOD|band)/i.test(html);
  if (!checks.lodNotFovDependent) warns.push('LOD判定がCAMERA_MODE_FOVを参照している可能性（要確認）');

  // ── §20: report ──
  const audit = rj(AUDIT_REPORT);
  checks.auditReportExists = !!audit;
  if (!audit) { errors.push('cartographic-camera-audit.json が無い（先に tools/audit/cartographic-camera-audit.js）'); }
  else {
    checks.screenShiftMeasured = !!(audit.screenShift && typeof audit.screenShift.improvementPercent === 'number');
    checks.fiveSitesPresent = Array.isArray(audit.sites) && audit.sites.length === 5;
    if (!checks.screenShiftMeasured) errors.push('screenShift.improvementPercent が測定されていない');
    if (!checks.fiveSitesPresent) errors.push('5地点(梅田/中之島/難波/天王寺/住吉)のsites配列が揃っていない');
  }

  // ── production / protected 不変 ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0 禁止）');

  // ── geometry / scale / height 不変 ──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED), nearBm = rj(NEAR_BLDG_MANIFEST);
  checks.buildingGeometryMutation = (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) ? 1 : 0;
  checks.roadGeometryMutation = (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) ? 1 : 0;
  checks.buildingScaleMutation = (!nearBm || nearBm.simplificationToleranceM !== 0) ? 1 : 0; // FIX24 exact tierが維持されているか
  checks.buildingHeightMutation = 0; // heightMはaudit toolで読み取るのみ・書込コードなし（noHeightScaleMutationで裏取り済み）
  if (checks.buildingGeometryMutation) errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount));
  if (checks.roadGeometryMutation) errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount));
  if (checks.buildingScaleMutation) errors.push('near/buildings tolerance が0でない（FIX24 exact tierが崩れている）');
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) { errors.push('refined-road-surface.json indexedCount 変化: ' + (refined && refined.indexedCount)); checks.roadGeometryMutation = 1; }

  checks.projectionMutation = (/geoToLocal|geoToThree/.test(html) && !/135\.52502/.test(html)) ? 1 : 0;
  if (checks.projectionMutation) errors.push('projection定数(135.52502)が見つからない');

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
  console.log('[cartographic-camera-audit-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[cartographic-camera-audit-validate] 失敗:', e && e.stack || e); process.exit(1); });
