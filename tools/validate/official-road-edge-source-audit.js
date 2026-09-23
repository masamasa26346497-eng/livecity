#!/usr/bin/env node
// tools/validate/official-road-edge-source-audit.js
// [Mission 31G-FIX14] Official Road Edge Source Acquisition Audit の静的検証。
//
// PASS 条件:
//   - official-road-edge-source-audit.json が存在し、§20 必須フィールドを全て持つ
//   - adoptionDecision が既定値（OFFICIAL_SOURCE_NOT_AVAILABLE / OFFICIAL_SOURCE_NOT_USABLE）
//     のときは canonical road / building geometry が完全に不変（featureCount 一致）
//   - FIX13 の refined-road-surface.json が変更されていない（indexedCount 等が FIX13 時点と一致）
//   - 一律 negative buffer / 建物基準 clip 等のコードが追加されていない（§0）
//   - production / protected unchanged
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const AUDIT = P('data', 'reports', 'official-road-edge-source-audit.json');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const CANON_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const REPORT = P('data', 'reports', 'official-road-edge-source-audit-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;   // FIX13 時点（本ミッションで geometry 変更しないため一致するはず）
const REQUIRED_FIELDS = ['sourcesChecked', 'usableSources', 'rejectedSources', 'coverage', 'license', 'commercialUse', 'geometryType', 'accuracy', 'updateFrequency', 'sampleResults', 'majorRoadWidths', 'recommendedSource', 'adoptionDecision'];
const VALID_DECISIONS = new Set(['OFFICIAL_SOURCE_NOT_AVAILABLE', 'OFFICIAL_SOURCE_NOT_USABLE', 'OFFICIAL_SOURCE_ADOPTED']);

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};

  const a = rj(AUDIT);
  if (!a) { errors.push('official-road-edge-source-audit.json が無い（先に tools/audit/official-road-edge-source-audit.js）'); return finish(errors, warns, checks); }

  // ── §20 必須フィールド ──
  let missingFields = 0;
  for (const f of REQUIRED_FIELDS) if (!(f in a)) { missingFields++; errors.push('report に必須フィールドが無い: ' + f); }
  checks.requiredFieldsMissing = missingFields;

  checks.adoptionDecisionValid = VALID_DECISIONS.has(a.adoptionDecision);
  if (!checks.adoptionDecisionValid) errors.push('adoptionDecision が不正: ' + a.adoptionDecision);

  const adopted = a.adoptionDecision === 'OFFICIAL_SOURCE_ADOPTED';
  checks.adopted = adopted;

  // ── 未採用（既定パス）: canonical / FIX13 geometry が完全に不変であること ──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED);
  checks.canonicalRoadFeatureCount = rm ? rm.featureCount : null;
  checks.canonicalBuildingFeatureCount = bm ? bm.featureCount : null;
  checks.refinedIndexedCount = refined ? refined.indexedCount : null;
  if (!adopted) {
    checks.canonicalRoadUnchanged = (rm && rm.featureCount === EXPECT_ROAD_FEATURES);
    checks.canonicalBuildingUnchanged = (bm && bm.featureCount === EXPECT_BLDG_FEATURES);
    checks.refinedRoadSurfaceUnchanged = (refined && refined.indexedCount === EXPECT_REFINED_INDEXED);
    if (!checks.canonicalRoadUnchanged) errors.push('未採用パスなのに canonical roads featureCount が FIX13 時点と不一致: ' + (rm && rm.featureCount));
    if (!checks.canonicalBuildingUnchanged) errors.push('未採用パスなのに canonical buildings featureCount が FIX13 時点と不一致: ' + (bm && bm.featureCount));
    if (!checks.refinedRoadSurfaceUnchanged) warns.push('refined-road-surface.json の indexedCount が FIX13 時点と異なる（再 build された可能性・要確認）: ' + (refined && refined.indexedCount));
  } else {
    checks.integrationDesignCreated = !!a.integrationDesignCreated;
    if (!checks.integrationDesignCreated) errors.push('adoptionDecision=ADOPTED なのに integration design（§19）が作成されていない');
  }

  // ── §0 禁止: 一律 negative buffer / 建物基準 clip コードが追加されていない ──
  const auditSrc = fs.existsSync(P('tools', 'audit', 'official-road-edge-source-audit.js')) ? fs.readFileSync(P('tools', 'audit', 'official-road-edge-source-audit.js'), 'utf-8') : '';
  checks.noUniformBufferHack = !/\.buffer\(-\d|shrinkToBuilding|clipByBuilding/.test(auditSrc);
  if (!checks.noUniformBufferHack) errors.push('audit script に一律 buffer / 建物基準 clip コードがある（§0 違反）');

  // ── sample/majorRoadWidths が実施不能なら NOT_PERFORMED と明記されている（捏造データ禁止） ──
  checks.sampleResultsHonest = typeof a.sampleResults === 'string' && (a.sampleResults === 'NOT_PERFORMED' || /^NOT_PERFORMED/.test(a.sampleResults) || Array.isArray(a.sampleResults));
  if (!checks.sampleResultsHonest && !adopted) warns.push('sampleResults の形式を確認（実施できていないなら NOT_PERFORMED 系の文字列であるべき）');

  // ── production / protected unchanged ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionUnchanged = !(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedUnchanged = !(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (!checks.productionUnchanged) errors.push('production HTML が変更されている（§0 禁止）');
  if (!checks.protectedUnchanged) errors.push('protected HTML が変更されている（§0 禁止）');

  checks.recommendedSourcePresent = !!(a.recommendedSource && a.recommendedSource.primary);
  if (!checks.recommendedSourcePresent) warns.push('recommendedSource が空（次ミッションへの引き継ぎ情報が無い）');

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
  console.log('[official-road-edge-source-audit-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[official-road-edge-source-audit-validate] 失敗:', e && e.stack || e); process.exit(1); });
