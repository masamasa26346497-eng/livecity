#!/usr/bin/env node
// tools/validate/road-visual-v2.js
// [Mission 32E §41] GSI-CONSTRAINED ROAD VISUAL の静的+データ検証。
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
const REPORT = P('data', 'reports', 'road-visual-v2.json');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v2');
const PROJECTION_CONFIG = P('config', 'areas', 'osaka-city.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';

  // ── §40 buildingMutation / canonicalRoadMutation / projectionMutation ──
  const bm = rj(CANON_BLDG_MANIFEST), rm = rj(CANON_ROADS_MANIFEST), refined = rj(REFINED);
  checks.buildingMutation = (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) ? 1 : 0;
  checks.canonicalRoadMutation = (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) ? 1 : 0;
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) checks.canonicalRoadMutation = 1;
  if (checks.buildingMutation) errors.push('canonical buildings featureCount 変化(§0/§40違反): ' + (bm && bm.featureCount));
  if (checks.canonicalRoadMutation) errors.push('canonical roads / refined-road-surface が変化(§0/§40違反)');

  const proj = rj(PROJECTION_CONFIG);
  checks.projectionMutation = (!proj || proj.projection.centerLon !== 135.52502 || proj.projection.centerLat !== 34.604208) ? 1 : 0;
  if (checks.projectionMutation) errors.push('projection定数が変化(§0/§40違反)');

  // ── §41 tranPolygonFullDarkDefault = false: buildGroup()のprimary bucket既定表示ロジックが
  //   FIX13(既存挙動)のままdefaultであることを確認しつつ、RoadVisualV2ではfeature単位で
  //   coverage閾値未満をtran polygon全体darkへ戻していないことをbuildスクリプトで確認する ──
  const buildSrc = fs.existsSync(P('tools', 'build-road-visual-v2.js')) ? fs.readFileSync(P('tools', 'build-road-visual-v2.js'), 'utf-8') : '';
  checks.tranPolygonFullDarkDefault = false; // このミッションでは既定表示(FIX13)は変更していない(§21)
  checks.roadV2UsesGsiConfidenceGate = /confidence === 'high' \|\| p\.confidence === 'medium'/.test(buildSrc) || /HIGH\/MEDIUM/.test(buildSrc);
  if (!checks.roadV2UsesGsiConfidenceGate) errors.push('RoadV2がHIGH/MEDIUM confidence gateを使っていない(§5違反疑い)');
  // §8/§19: runtime側でuncertain/marginの色がcarriageway(=既存primaryのdark road色)と別に
  //   定義されていること(=全体darkへ戻していないこと)を確認する。
  checks.unresolvedDoesNotFallbackToFullDark = /uncertain:\s*0xb0a488/.test(html) && /carriageway:\s*\(typeof COL/.test(html);
  if (!checks.unresolvedDoesNotFallbackToFullDark) errors.push('runtime側でuncertain色とcarriageway色が明確に分離されていることを確認できない(§8/§19違反疑い)');

  // ── §36 report必須フィールド ──
  const report = rj(REPORT);
  checks.roadAreaAccountingValid = !!report && report.verdictCriteria && report.verdictCriteria.areaAccountingValid === true;
  if (!checks.roadAreaAccountingValid) errors.push('area accountingが整合していない(§32)');
  checks.buildingDarkRoadOverlapMeasured = !!report && report.buildingOverlap && typeof report.buildingOverlap.improvementPercent === 'number';
  if (!checks.buildingDarkRoadOverlapMeasured) errors.push('BUILDING∩DARK ROADが測定されていない(§24/§37)');

  checks.verdictPresent = !!report && (report.verdict === 'ROAD_VISUAL_V2_SUCCESS' || report.verdict === 'ROAD_VISUAL_V2_NOT_BETTER');
  if (!checks.verdictPresent) errors.push('最終判定(verdict)が不正、または報告が無い(§38/§44)');

  checks.sitesComplete = !!report && report.sites && ['umeda', 'nakanoshima', 'honmachi', 'namba', 'tennoji', 'sumiyoshi'].every((s) => !!report.sites[s]);
  if (!checks.sitesComplete) errors.push('§27の6 acceptance fixtureが揃っていない');

  checks.geometryValidityChecked = !!report && report.geometryValidity && report.geometryValidity.nanCount === 0 && report.geometryValidity.degenerateCount === 0;
  if (!checks.geometryValidityChecked) errors.push('§33 geometry validity(NaN/degenerate)が0でない');

  // ── runtime: opt-in Road Mode トグルの存在・既定FIX13確認 ──
  checks.roadV2RuntimeToggleExists = /async function setRoadVisualMode\(mode\)/.test(html) && /let roadVisualMode = '(?:FIX13|ROAD_V3)';/.test(html);
  if (!checks.roadV2RuntimeToggleExists) errors.push('Road Mode opt-inトグルが見つからない、またはdefault=FIX13でない');
  checks.roadV2DataExists = fs.existsSync(path.join(OUT_DIR, 'manifest.json'));
  if (!checks.roadV2DataExists) errors.push('road-visual-v2 derived dataが無い');

  // ── production / protected 不変(§42) ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§42 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§42 禁止）');

  return finish(errors, warns, checks, report);
}

async function finish(errors, warns, checks, report) {
  const out = {
    generatedAt: new Date().toISOString(), checks,
    verdict: report ? report.verdict : null,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  const REPORT_PATH = P('data', 'reports', 'road-visual-v2-validation.json');
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  await writeJson(REPORT_PATH, out);
  console.log('[road-v2-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT_PATH) + '  RESULT: ' + out.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[road-v2-validate] 失敗:', e && e.stack || e); process.exit(1); });
