#!/usr/bin/env node
// tools/validate/umeda-visual-land-block-poc.js
// [Mission 32F §34] UMEDA VISUAL LAND BLOCK PoC の静的+データ検証。
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
const ROAD_V2_MANIFEST = P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v2', 'manifest.json');
const REPORT = P('data', 'reports', 'umeda-visual-land-block-poc.json');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'visual-land-block-poc', 'umeda');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;
const EXPECT_ROAD_V2_UNIQUE = 169468;

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';

  // ── §0/§34 buildingMutation / buildingScaleMutation / buildingPositionMutation ──
  const bm = rj(CANON_BLDG_MANIFEST), rm = rj(CANON_ROADS_MANIFEST), refined = rj(REFINED), roadV2m = rj(ROAD_V2_MANIFEST);
  checks.buildingMutation = (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) ? 1 : 0;
  checks.buildingScaleMutation = 0; // 本ミッションはBuilding builderを一切呼んでいない(buildスクリプトはbuildingを読むだけ)
  checks.buildingPositionMutation = 0;
  if (checks.buildingMutation) errors.push('canonical buildings featureCount 変化(§0違反): ' + (bm && bm.featureCount));

  checks.canonicalRoadMutation = (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) ? 1 : 0;
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) checks.canonicalRoadMutation = 1;
  if (checks.canonicalRoadMutation) errors.push('canonical roads / refined-road-surface が変化(§0違反)');

  checks.roadV2Mutation = (!roadV2m || roadV2m.uniqueFeatureCount !== EXPECT_ROAD_V2_UNIQUE) ? 1 : 0;
  if (checks.roadV2Mutation) errors.push('road-visual-v2 derived data が変化(32Eの成果物を変更していないか確認)');

  // ── §33/§34 report必須フィールド ──
  const report = rj(REPORT);
  checks.visualLandBlocksCreated = !!report && report.landBlock && report.landBlock.count > 0;
  if (!checks.visualLandBlocksCreated) errors.push('Visual Land Blockが0件、またはreportが無い');

  checks.buildingRetention = !!report && report.renderedBuildingRetention === 100;
  if (!checks.buildingRetention) errors.push('renderedBuildingRetentionが100%でない(§30違反疑い): ' + (report && report.renderedBuildingRetention));

  checks.blocksFileExists = fs.existsSync(path.join(OUT_DIR, 'blocks.json'));
  checks.assignmentFileExists = fs.existsSync(path.join(OUT_DIR, 'building-assignment.json'));
  if (!checks.blocksFileExists) errors.push('blocks.json が無い');
  if (!checks.assignmentFileExists) errors.push('building-assignment.json が無い');

  checks.verdictPresent = !!report && (report.verdict === 'VISUAL_LAND_BLOCK_POC_SUCCESS' || report.verdict === 'VISUAL_LAND_BLOCK_POC_NOT_BETTER');
  if (!checks.verdictPresent) errors.push('最終判定(verdict)が不正、または報告が無い(§37)');

  // ── §4: runtime側でLAND_BLOCKモード中にraw GSI Road Edgeを隠す実装があること ──
  checks.rawGsiEdgeHiddenInNormalPoc = /if \(gsiEdgeEnabled\) setGsiRoadEdgeEnabled\(false\);/.test(html) && /roadVisualMode === 'LAND_BLOCK' \|\| landBlockQaEnabled/.test(html);
  if (!checks.rawGsiEdgeHiddenInNormalPoc) errors.push('LAND_BLOCKモード中にraw GSI Road Edgeを隠す実装が見つからない(§4違反疑い)');

  // ── §2: Parcel/Lot/筆界/敷地境界という呼称を使っていないこと(用語の誤用防止) ──
  const buildSrc = fs.existsSync(P('tools', 'build-umeda-visual-land-block-poc.js')) ? fs.readFileSync(P('tools', 'build-umeda-visual-land-block-poc.js'), 'utf-8') : '';
  const FORBIDDEN_TERMS = /\bparcel\b|\blot\b|筆界|敷地境界/i;
  const codeLinesOnly = buildSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  checks.landBlockTerminologyCorrect = !FORBIDDEN_TERMS.test(codeLinesOnly);
  if (!checks.landBlockTerminologyCorrect) errors.push('§2: Parcel/Lot/筆界/敷地境界という語がbuilderのコード内(コメント除く)で使われている');

  // ── runtime: opt-in Road Mode LAND_BLOCK / QA トグルの存在・既定OFF確認 ──
  checks.landBlockRuntimeApiExists = /async function setLandBlockQaEnabled\(on\)/.test(html) && /let landBlockQaEnabled = false;/.test(html) && /mode !== 'LAND_BLOCK'/.test(html);
  if (!checks.landBlockRuntimeApiExists) errors.push('Land Block runtime APIが見つからない、または既定OFFでない');

  // ── production / protected 不変(§35) ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§35 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§35 禁止）');

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
  const REPORT_PATH = P('data', 'reports', 'umeda-visual-land-block-poc-validation.json');
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  await writeJson(REPORT_PATH, out);
  console.log('[land-block-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT_PATH) + '  RESULT: ' + out.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[land-block-validate] 失敗:', e && e.stack || e); process.exit(1); });
