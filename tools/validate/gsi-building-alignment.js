#!/usr/bin/env node
// tools/validate/gsi-building-alignment.js
// [Mission 31G-FIX20 §27] GSI Building Alignment Ground Truth の静的検証。
//
// PASS 条件（§27）:
//   rawMutation=0 / canonicalBuildingMutation=0 / canonicalRoadMutation=0 / fakeMatch=0 /
//   crsMismatchUntracked=0 / runtimeMagicOffset=0 / lowConfidenceUsedForCalibration=0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const RAW_DIR = P('data', 'raw', 'gsi', 'building-outline');
const RAW_HASH_RECORD = P('data', 'reports', 'baselines', 'gsi-building-outline-raw-hashes.json');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const CANON_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const ALIGNMENT_REPORT = P('data', 'reports', 'gsi-building-alignment.json');
const REPORT = P('data', 'reports', 'gsi-building-alignment-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const ALLOWED_CLASSIFICATIONS = new Set(['SYSTEMATIC_BUILDING_SHIFT_CONFIRMED', 'DATUM_TRANSFORM_REQUIRED', 'NO_SYSTEMATIC_BUILDING_SHIFT', 'INSUFFICIENT_MATCHING_DATA']);

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

function hashRawDir() {
  const out = {};
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[toProjectRelativePath(p)] = sha(p);
    }
  };
  walk(RAW_DIR);
  return out;
}

async function main() {
  const errors = [], warns = [];
  const checks = {};

  // ── rawMutation ──
  const curRawHashes = hashRawDir();
  const rawBaseline = rj(RAW_HASH_RECORD);
  let rawMutation = 0;
  if (!rawBaseline) {
    fs.mkdirSync(path.dirname(RAW_HASH_RECORD), { recursive: true });
    fs.writeFileSync(RAW_HASH_RECORD, JSON.stringify({ recordedAt: new Date().toISOString(), hashes: curRawHashes }, null, 2));
    warns.push('gsi-building-outline-raw-hashes.json baseline を新規記録した（次回から差分検出）');
  } else {
    const prev = rawBaseline.hashes || {};
    for (const [f, h] of Object.entries(prev)) if (curRawHashes[f] !== undefined && curRawHashes[f] !== h) rawMutation++;
    if (rawMutation === 0) {
      const merged = { ...prev, ...curRawHashes };
      if (Object.keys(merged).length !== Object.keys(prev).length) {
        fs.writeFileSync(RAW_HASH_RECORD, JSON.stringify({ recordedAt: new Date().toISOString(), hashes: merged }, null, 2));
        warns.push('baseline に新規ファイルの hash を追記した');
      }
    }
  }
  checks.rawMutation = rawMutation;
  if (rawMutation) errors.push('raw GSI building-outline ファイルが変更されている（§0/§5 違反）: ' + rawMutation);

  // ── canonicalBuildingMutation / canonicalRoadMutation ──
  const bm = rj(CANON_BLDG_MANIFEST), rm = rj(CANON_ROADS_MANIFEST);
  checks.canonicalBuildingMutation = (bm && bm.featureCount === EXPECT_BLDG_FEATURES) ? 0 : 1;
  checks.canonicalRoadMutation = (rm && rm.featureCount === EXPECT_ROAD_FEATURES) ? 0 : 1;
  if (checks.canonicalBuildingMutation) errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount));
  if (checks.canonicalRoadMutation) errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount));

  // ── fakeMatch: report の内容が RESULT/classification と整合しているか（捏造・非現実的値の検出） ──
  const align = rj(ALIGNMENT_REPORT);
  let fakeMatch = 0;
  if (!align) {
    warns.push('gsi-building-alignment.json が無い（先に tools/audit/gsi-building-alignment.js）');
  } else {
    if (align.RESULT === 'GSI_BUILDING_OUTLINE_RAW_DATA_MISSING' || align.RESULT === 'NO_PLATEAU_BUILDINGS_NEAR_GSI_COVERAGE') {
      if (align.outlineCount) fakeMatch++;
      if (align.matching && (align.matching.high || align.matching.medium || align.matching.low)) fakeMatch++;
      if (align.alignment) fakeMatch++;
      if (align.classification !== 'INSUFFICIENT_MATCHING_DATA') fakeMatch++;
    } else if (align.RESULT === 'GSI_BUILDING_ALIGNMENT_MEASURED' || align.RESULT === 'CITYWIDE_GSI_BUILDING_COVERAGE_INSUFFICIENT') {
      // [Mission 31G-FIX22 §3] CITYWIDE_GSI_BUILDING_COVERAGE_INSUFFICIENT は「city-wide結論を保留」した
      // だけで、実測できた範囲の classification/統計自体は GSI_BUILDING_ALIGNMENT_MEASURED と同じ整合性を
      // 満たすべきなので、同じチェックを適用する（§0: 捏造・非現実的値の検出）。
      if (!ALLOWED_CLASSIFICATIONS.has(align.classification)) { fakeMatch++; errors.push('不正な classification: ' + align.classification); }
      if (align.alignment) {
        const a = align.alignment;
        if (a.medianDistance != null && (a.medianDistance < 0 || a.medianDistance > 1000)) { fakeMatch++; errors.push('非現実的な medianDistance: ' + a.medianDistance); }
      }
      if (align.iouBefore != null && (align.iouBefore < 0 || align.iouBefore > 1)) { fakeMatch++; errors.push('IoU が0-1範囲外: ' + align.iouBefore); }
      if (align.iouCandidateAfter != null && (align.iouCandidateAfter < 0 || align.iouCandidateAfter > 1)) { fakeMatch++; errors.push('candidate IoU が0-1範囲外: ' + align.iouCandidateAfter); }
      const total = (align.matching.high || 0) + (align.matching.medium || 0) + (align.matching.low || 0) + (align.matching.unmatched || 0);
      if (total === 0) { fakeMatch++; errors.push('matching 内訳が全0（データがあるのに0件は不自然）'); }
      if (align.RESULT === 'CITYWIDE_GSI_BUILDING_COVERAGE_INSUFFICIENT' && align.citywideCoverage && align.citywideCoverage.sufficient) {
        fakeMatch++; errors.push('RESULT=CITYWIDE_GSI_BUILDING_COVERAGE_INSUFFICIENT なのに citywideCoverage.sufficient=true（矛盾）');
      }
    }
  }
  checks.fakeMatch = fakeMatch;

  // ── crsMismatchUntracked: 第6/7系等への強制変換をしていない（既存 transform lib を静的確認）──
  const transformSrc = fs.existsSync(P('tools', 'lib', 'gsi-road-edge-transform.js')) ? fs.readFileSync(P('tools', 'lib', 'gsi-road-edge-transform.js'), 'utf-8') : '';
  const forcesZone67 = /jprectZone\s*:\s*[67]|第[67]系|force.*(zone|crs)/i.test(transformSrc) && !/非対応|強制変換しない/.test(transformSrc);
  checks.crsMismatchUntracked = forcesZone67 ? 1 : 0;
  if (forcesZone67) errors.push('gsi-road-edge-transform.js(building importで再利用) が第6/7系への強制変換を含む疑い（§3/§4 違反）');
  const importScript = fs.existsSync(P('tools', 'import-gsi-building-outline.js')) ? fs.readFileSync(P('tools', 'import-gsi-building-outline.js'), 'utf-8') : '';
  if (!/classifyCrs/.test(importScript) || !/crsUnsupportedCount/.test(importScript)) { checks.crsMismatchUntracked = 1; errors.push('import-gsi-building-outline.js が CRS 非対応 feature を記録していない疑い'); }

  // ── runtimeMagicOffset: dev HTML に建物座標への手動 offset hack が無い（§19 禁止） ──
  const devHtml = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';
  const magicOffsetRe = /buildingGroup\.position\.[xz]\s*\+=|BLDGS.*\.forEach[\s\S]{0,120}\.fp\[[^\]]+\]\[0\]\s*\+=|__BUILDING_ALIGNMENT_OFFSET__/;
  checks.runtimeMagicOffset = magicOffsetRe.test(devHtml) ? 1 : 0;
  if (checks.runtimeMagicOffset) errors.push('runtime に建物座標への magic offset hack の疑いがあるコードを検出（§19 違反）');

  // ── lowConfidenceUsedForCalibration: 統計・回帰・candidate補正が HIGH match のみを使っている（静的確認）──
  const auditSrc = fs.existsSync(P('tools', 'audit', 'gsi-building-alignment.js')) ? fs.readFileSync(P('tools', 'audit', 'gsi-building-alignment.js'), 'utf-8') : '';
  const usesHighOnly = /summarizeTranslation\(highMatches\)/.test(auditSrc) && /spatialRegression\(highMatches\)/.test(auditSrc);
  checks.lowConfidenceUsedForCalibration = usesHighOnly ? 0 : 1;
  if (!usesHighOnly) errors.push('統計/回帰が highMatches（MATCH_HIGHのみ）以外から計算されている疑い（§8 違反）');

  // ── production / protected unchanged ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0 禁止）');
  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (fs.existsSync(p) && /gsi-building-outline|BuildingAlignment|__BUILDING_ALIGNMENT/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に GSI Building Alignment コードが混入');
  }

  // ── runtime toggle: default OFF ──
  checks.buildingAlignmentToggleDefaultOff = /let buildingAlignmentVisible = false;/.test(devHtml);
  checks.topDownToggleExists = /toggleTopDownAlignment|topDownAlignment/.test(devHtml);
  if (!checks.buildingAlignmentToggleDefaultOff) warns.push('[Building Alignment] toggle が default OFF と確認できない');
  if (!checks.topDownToggleExists) warns.push('[Top Down Alignment] トグルが見つからない');

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
  console.log('[gsi-building-alignment-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[gsi-building-alignment-validate] 失敗:', e && e.stack || e); process.exit(1); });
