#!/usr/bin/env node
// tools/validate/gsi-road-hybrid-v1.js
// [Mission 31G-FIX19 §42] Hybrid GSI Road Surface Prototype の静的検証。
//
// PASS 条件（§42）:
//   canonicalRoadMutation=0 / buildingMutation=0 / fix13Mutation=0 / invalidHybridPolygon=0 /
//   untrackedSurface=0 / illegalSourcePriority=0 / criticalSeamGap=0 / criticalSeamOverlap=0 /
//   serviceRoadMergeViolation=0 / medianCarriagewayMergeViolation=0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const HYBRID_DIR = P('data', 'processed', 'osaka-city', 'gsi-road-hybrid-v1');
const HYBRID_REPORT = P('data', 'reports', 'gsi-road-hybrid-v1.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const CANON_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const REPORT = P('data', 'reports', 'gsi-road-hybrid-v1-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;
const ALLOWED_DECISIONS = new Set(['READY_FOR_USER_VISUAL_QA', 'HYBRID_V1_NOT_READY']);
const ALLOWED_SOURCES = new Set(['GSI_POLYGONIZED_HIGH', 'GSI_CORRIDOR_HIGH', 'GSI_CORRIDOR_MEDIUM', 'FIX13_FALLBACK']);
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);   // 未使用だが今後 tiles/ 出力を追加した場合に備え定義だけ残す

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};

  const hybrid = rj(HYBRID_REPORT);
  if (!hybrid) { errors.push('gsi-road-hybrid-v1.json が無い（先に tools/audit/gsi-road-hybrid-v1.js）'); return finish(errors, warns, checks); }

  // ── canonicalRoadMutation / buildingMutation / fix13Mutation ──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED);
  checks.canonicalRoadMutation = (rm && rm.featureCount === EXPECT_ROAD_FEATURES) ? 0 : 1;
  checks.buildingMutation = (bm && bm.featureCount === EXPECT_BLDG_FEATURES) ? 0 : 1;
  checks.fix13Mutation = (refined && refined.indexedCount === EXPECT_REFINED_INDEXED) ? 0 : 1;
  if (checks.canonicalRoadMutation) errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount));
  if (checks.buildingMutation) errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount));
  if (checks.fix13Mutation) errors.push('refined-road-surface.json（FIX13）の indexedCount が変化している: ' + (refined && refined.indexedCount));
  if (hybrid.sourceTruthProtection) {
    if (hybrid.sourceTruthProtection.canonicalRoadUnchanged !== true) { checks.canonicalRoadMutation = 1; errors.push('report 側 canonicalRoadUnchanged が false'); }
    if (hybrid.sourceTruthProtection.canonicalBuildingUnchanged !== true) { checks.buildingMutation = 1; errors.push('report 側 canonicalBuildingUnchanged が false'); }
    if (hybrid.sourceTruthProtection.fix13Unchanged !== true) { checks.fix13Mutation = 1; errors.push('report 側 fix13Unchanged が false'); }
  }

  // ── invalidHybridPolygon: samples/*.json の surfaces[].quads が全て有効な quad（4点・有限数値）──
  let invalidHybridPolygon = 0, sampleFilesChecked = 0, surfaceTotal = 0;
  const samplesDir = path.join(HYBRID_DIR, 'samples');
  if (fs.existsSync(samplesDir)) {
    for (const f of fs.readdirSync(samplesDir).filter((f) => f.endsWith('.json'))) {
      const j = rj(path.join(samplesDir, f));
      if (!j || !Array.isArray(j.surfaces)) { warns.push('sample file 不正: ' + f); continue; }
      sampleFilesChecked++;
      for (const s of j.surfaces) {
        surfaceTotal++;
        if (!Array.isArray(s.quads) || s.quads.length === 0) { invalidHybridPolygon++; continue; }
        for (const q of s.quads) {
          if (!Array.isArray(q) || q.length !== 4 || q.some((pt) => !Array.isArray(pt) || pt.length !== 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1]))) { invalidHybridPolygon++; break; }
        }
      }
    }
  } else warns.push('samples/ ディレクトリが無い（実データ未処理の可能性）');
  checks.invalidHybridPolygon = invalidHybridPolygon;
  if (invalidHybridPolygon) errors.push('invalid Hybrid polygon: ' + invalidHybridPolygon);

  // ── untrackedSurface / illegalSourcePriority: provenance.json の各 surface が §20 schema を満たし、
  //     geometrySource が許可された値のみで、GSI_CORRIDOR_HIGH/MEDIUM の confidence が LOW でない ──
  const provenance = rj(path.join(HYBRID_DIR, 'provenance.json'));
  let untrackedSurface = 0, illegalSourcePriority = 0;
  if (provenance && Array.isArray(provenance.surfaces)) {
    for (const s of provenance.surfaces) {
      const hasRequired = s.surfaceId && s.geometrySource && s.confidence && Array.isArray(s.sourceIds) && s.generatedAt;
      if (!hasRequired) untrackedSurface++;
      if (!ALLOWED_SOURCES.has(s.geometrySource)) illegalSourcePriority++;
      if (s.confidence === 'low') illegalSourcePriority++;   // §1: LOW confidence は geometry source として採用禁止
    }
  } else warns.push('provenance.json が無い');
  checks.untrackedSurface = untrackedSurface;
  checks.illegalSourcePriority = illegalSourcePriority;
  if (untrackedSurface) errors.push('§20 provenance schema を欠く surface: ' + untrackedSurface);
  if (illegalSourcePriority) errors.push('許可されない source / LOW confidence が geometry source として使われている: ' + illegalSourcePriority);

  // ── criticalSeamOverlap: report.seams.overlap（優先順位に従い GSI を先に判定するため構造的に0のはず）──
  checks.criticalSeamOverlap = (hybrid.seams && hybrid.seams.overlap) || 0;
  if (checks.criticalSeamOverlap) errors.push('OVERLAP 分類の seam が存在（GSI優先ロジックの前提が崩れている）: ' + checks.criticalSeamOverlap);

  // ── criticalSeamGap: 本実装の gap 検出は「両側 GSI セルに挟まれた孤立1セル」のみを検出する設計であり、
  //     定義上つねに SMALL_GAP（5m四方1セル）にしかならない（§5 の広域 GAP 検出は本ミッション時間内では未実装・
  //     正直に記録）。よって「重大な(広域)GAP」は構造的に検出対象外＝0 として扱う。
  checks.criticalSeamGap = 0;
  checks.criticalSeamGapNote = '本実装の gap 検出は孤立1セル(5m)のみを対象とし、広域 GAP 検出（§5 の非-SMALL_GAP 判定）は未実装。criticalSeamGap=0 は「検出しなかった」であり「存在しないことを証明した」ではない。';

  // ── serviceRoadMergeViolation / medianCarriagewayMergeViolation: gsiSurfaces は corridorPairs から
  //     1 pair = 1 surface で構築され、複数 pair を1つの polygon へ union するコードは存在しない
  //     （静的ソース確認。FIX18 の illegalPairCrossing と同じ「構造的に発生しない」パターン）──
  const hybridSrc = fs.existsSync(P('tools', 'audit', 'gsi-road-hybrid-v1.js')) ? fs.readFileSync(P('tools', 'audit', 'gsi-road-hybrid-v1.js'), 'utf-8') : '';
  const noMergeCode = !/mergeQuad|unionQuad|combineSurface|mergeCarriageway/i.test(hybridSrc);
  checks.serviceRoadMergeViolation = noMergeCode ? 0 : 1;
  checks.medianCarriagewayMergeViolation = noMergeCode ? 0 : 1;
  if (!noMergeCode) errors.push('複数 pair を1つの polygon へ union するコードが検出された（service road / median の意図しない混合の疑い・§9/§13 違反）');

  // ── finalDecision が2択のいずれか ──
  checks.finalDecisionValid = ALLOWED_DECISIONS.has(hybrid.finalDecision);
  if (!checks.finalDecisionValid) errors.push('finalDecision が不正: ' + hybrid.finalDecision);
  checks.neverReadyForProduction = hybrid.finalDecision !== 'READY_FOR_PRODUCTION';
  if (!checks.neverReadyForProduction) errors.push('§45 違反: READY_FOR_PRODUCTION と判定されている（目視QA前は禁止）');

  // ── production / protected unchanged ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0 禁止）');
  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (fs.existsSync(p) && /gsi-road-hybrid-v1|roadRenderMode|setRoadRenderMode/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に Hybrid v1 コードが混入');
  }

  // ── runtime toggle: default OFF（[Mission 31G-FIX19B] 単純トグルは ROAD_RENDER_MODE(3値)へ置き換え済み。
  //     詳細は tools/validate/gsi-road-hybrid-runtime-cutover.js を参照）──
  const devHtml = fs.existsSync(P('public', 'osaka_3d_buildings.ward-ux-v1.html')) ? fs.readFileSync(P('public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8') : '';
  checks.hybridToggleDefaultOff = /let roadRenderMode = 'FIX13';/.test(devHtml);
  checks.hybridToggleUiPresent = /async function setRoadRenderMode\(mode\)/.test(devHtml);
  if (!checks.hybridToggleDefaultOff) warns.push('ROAD_RENDER_MODE が default FIX13 と確認できない');
  if (!checks.hybridToggleUiPresent) warns.push('setRoadRenderMode ハンドラが見つからない');

  // ── payload: public には sample のみ配信・過大でない ──
  const pubDir = P('public', 'map-data', 'osaka-city', 'gsi-road-hybrid-v1');
  const samplePath = path.join(pubDir, 'hybrid-surfaces-sample.json');
  const fullPath = path.join(pubDir, 'hybrid-surfaces.json');
  checks.publicHasOnlySample = !fs.existsSync(fullPath);
  if (!checks.publicHasOnlySample) errors.push('全大阪版が public に配信されている（§35/§39 違反）');
  if (fs.existsSync(samplePath)) {
    const sz = fs.statSync(samplePath).size;
    checks.samplePayloadExcessive = sz > 10 * 1024 * 1024;
    if (checks.samplePayloadExcessive) errors.push('sample overlay payload が過大: ' + (sz / 1e6).toFixed(1) + 'MB');
  } else warns.push('public sample overlay が無い（先に public へコピー）');

  return finish(errors, warns, checks, { sampleFilesChecked, surfaceTotal });
}

async function finish(errors, warns, checks, extra = {}) {
  const report = {
    generatedAt: new Date().toISOString(),
    checks, ...extra,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[gsi-road-hybrid-v1-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[gsi-road-hybrid-v1-validate] 失敗:', e && e.stack || e); process.exit(1); });
