#!/usr/bin/env node
// tools/validate/building-exact-near-alignment.js
// [Mission 31G-FIX24 §30] Building Ground-Anchor Final Fix の静的+データ検証。
//   §0遵守: building/road geometry・projectionを一切変更していないことを確認する（読み取り専用）。
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
const PUB_NEAR_BLDG_MANIFEST = P('public', 'map-data', 'osaka-city', 'derived', 'near', 'buildings', 'manifest.json');
const ALIGNMENT_REPORT = P('data', 'reports', 'building-exact-near-alignment.json');
const REPORT = P('data', 'reports', 'building-exact-near-alignment-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';

  // ── §1/§30: near buildings tier が canonical exact footprint（tolM=0）を使っている ──
  const nearManifest = rj(NEAR_BLDG_MANIFEST);
  checks.nearUsesExactCanonicalFootprint = !!nearManifest && nearManifest.simplificationToleranceM === 0;
  checks.nearSimplificationTolerance = nearManifest ? nearManifest.simplificationToleranceM : null;
  if (!checks.nearUsesExactCanonicalFootprint) errors.push('derived/near/buildings の simplificationToleranceM が 0 でない: ' + (nearManifest && nearManifest.simplificationToleranceM));
  checks.nearFeatureCountMatchesCanonical = !!nearManifest && nearManifest.featureCount === EXPECT_BLDG_FEATURES;
  if (!checks.nearFeatureCountMatchesCanonical) errors.push('derived/near/buildings の featureCount が canonical と一致しない（completeness崩壊の疑い）: ' + (nearManifest && nearManifest.featureCount));

  // ── public への反映確認（runtimeが実際にfetchするpath）──
  const pubNearManifest = rj(PUB_NEAR_BLDG_MANIFEST);
  checks.publicNearMatchesProcessed = !!pubNearManifest && pubNearManifest.simplificationToleranceM === 0
    && pubNearManifest.generatedAt === (nearManifest && nearManifest.generatedAt);
  if (!checks.publicNearMatchesProcessed) errors.push('public/map-data の near/buildings manifest が processed 側と同期していない（build-derived-public.js の再実行が必要な疑い）');

  // ── §20: road/water/park/rail の near tier は変更していない（tolM=2 のまま）──
  const roadNear = rj(P('data', 'processed', 'osaka-city', 'derived', 'near', 'roads', 'manifest.json'));
  checks.roadNearToleranceUnchanged = !!roadNear && roadNear.simplificationToleranceM === 2;
  if (!checks.roadNearToleranceUnchanged) errors.push('roads の near tier tolerance が変更されている（buildings以外は変更禁止・§20）: ' + (roadNear && roadNear.simplificationToleranceM));

  // ── §9/§10: extrusion（pushExtrude）の base/top xz 完全一致を静的に確認 ──
  const peStart = html.indexOf('function pushExtrude(positions, geometryType, coordinates, h)');
  const peEnd = html.indexOf('\n  function meshFromPositions', peStart);
  const peBody = (peStart >= 0 && peEnd > peStart) ? html.slice(peStart, peEnd) : '';
  checks.baseTopXZMismatch = /positions\.push\(a\[0\], 0, a\[1\], b\[0\], 0, b\[1\], b\[0\], h, b\[1\]\);/.test(peBody)
    && /positions\.push\(a\[0\], 0, a\[1\], b\[0\], h, b\[1\], a\[0\], h, a\[1\]\);/.test(peBody) ? 0 : 1;
  if (checks.baseTopXZMismatch) errors.push('pushExtrude() の壁生成でbase/topのx/zが一致しない疑い（§9/§10）');

  // ── §11: building group に不要な position offset が追加されていない ──
  checks.unexpectedBuildingXZTransform = /g\.position\.[xz]\s*=\s*[1-9]/.test(peBody) ? 1 : 0;
  if (checks.unexpectedBuildingXZTransform) warns.push('buildGroup付近でgroup.position.x/zへの非ゼロ代入を検出（意図確認要）');

  // ── §29/§33: building-exact-near-alignment.json の実測結果 ──
  const align = rj(ALIGNMENT_REPORT);
  if (!align) {
    warns.push('building-exact-near-alignment.json が無い（先に tools/audit/building-exact-near-alignment.js）');
  } else {
    checks.fixApplied = !!align.fixApplied;
    checks.exactRuntimeZeroDeviation = !!align.exactRuntime
      && align.exactRuntime.medianEdgeDeviation === 0 && align.exactRuntime.p95EdgeDeviation === 0 && align.exactRuntime.maxEdgeDeviation === 0;
    if (align.fixApplied && !checks.exactRuntimeZeroDeviation) errors.push('fixApplied=trueなのにexactRuntimeのedge deviationが0でない（near tierがcanonicalと完全一致していない）');
  }

  // ── production / protected 不変 ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0/§24 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0/§24 禁止）');

  // ── geometry 不変（canonical building/road count・FIX13 refined不変。projection式は grep で不変確認）──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED);
  let geometryMutation = 0;
  if (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) { geometryMutation++; errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount)); }
  if (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) { geometryMutation++; errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount)); }
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) { geometryMutation++; errors.push('refined-road-surface.json indexedCount 変化: ' + (refined && refined.indexedCount)); }
  checks.buildingGeometryMutation = (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) ? 1 : 0;
  checks.roadGeometryMutation = (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) ? 1 : 0;

  // projection式（geoToThree/znorth-neg-v1の定数）が変更されていないことを確認
  checks.projectionMutation = /geoToLocal|geoToThree/.test(html) && !/135\.52502/.test(html) ? 1 : 0;
  if (checks.projectionMutation) errors.push('projection定数(135.52502等)が見つからない（projection式が変更された疑い）');

  checks.geometryMutation = geometryMutation;

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
  console.log('[building-exact-near-alignment-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[building-exact-near-alignment-validate] 失敗:', e && e.stack || e); process.exit(1); });
