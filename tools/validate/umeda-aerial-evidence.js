#!/usr/bin/env node
// tools/validate/umeda-aerial-evidence.js
// [Mission 35B §11/§12] 今回の調査が仕様どおりか検証する。
//   - §11 屋根 geometry を作っていない / quality gate を下げていない
//   - §2 Web タイルの zoom ではなく、成果のヘッダから GSD を出している
//   - §3 A/B/C/D で分類している
//   - §9/§10 ground truth 678 棟を使い、解像度の崖と必要最低 GSD を出している
//   - dev / production / protected を変更していない
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { GSD_CLASS, classifyGsd } from '../audit/umeda-aerial-source-probe.js';
import { JOHNSON, GSD_STEPS } from '../lib/roof-detectability.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  availability: P('data', 'reports', 'umeda-aerial-availability.json'),
  catalog: P('data', 'reports', 'gsi-photo-layer-catalog.json'),
  ortho: P('data', 'reports', 'umeda-ortho-source-catalog.json'),
  resExp: P('data', 'reports', 'umeda-roof-resolution-experiment.json'),
  scanStereo: P('data', 'reports', 'umeda-stereo-and-scan-analysis.json'),
  roofs: P('public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json'),
  build35a: P('data', 'reports', 'umeda-inferred-roof-build.json'),
  val35a: P('data', 'reports', 'umeda-inferred-roof-validation.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  out: P('data', 'reports', 'umeda-aerial-evidence-validation.json'),
};
/** §11 35A の品質基準。35B はこれを下げてはならない。 */
export const QUALITY_GATE_35A = { roofTypeAccuracy: 0.85, ridgeMedianDeg: 10, roofIoUMedian: 0.85 };
/** §11 35B は屋根を 1 棟も増やしてはならない。 */
export const EXPECTED_GENERATED_ROOFS = 1;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };

export async function validateUmedaAerialEvidence() {
  const errors = [], warnings = [];
  const avail = rj(F.availability), cat = rj(F.catalog), ortho = rj(F.ortho);
  const res = rj(F.resExp), ss = rj(F.scanStereo);

  // ── §11 屋根を増やしていない ────────────────────────────────────────
  const roofs = rj(F.roofs);
  const roofCount = roofs ? (roofs.buildings || []).length : null;
  const geometryUnchanged = roofCount === EXPECTED_GENERATED_ROOFS;
  if (!geometryUnchanged) errors.push(`§11: 推定屋根の数が 35A の ${EXPECTED_GENERATED_ROOFS} から変わっている: ${roofCount}`);
  const b35 = rj(F.build35a);
  if (b35 && b35.stats && b35.stats.generated !== EXPECTED_GENERATED_ROOFS) {
    errors.push('§11: 35A のビルド結果が変わっている generated=' + b35.stats.generated);
  }

  // ── §11 quality gate を下げていない ────────────────────────────────
  const v35 = rj(F.val35a);
  const q = v35 && v35.evaluation ? v35.evaluation.quality : null;
  const qualityGateUnchanged = !!(q && q.roofTypeAccuracy === QUALITY_GATE_35A.roofTypeAccuracy
    && q.ridgeMedianDeg === QUALITY_GATE_35A.ridgeMedianDeg && q.roofIoUMedian === QUALITY_GATE_35A.roofIoUMedian);
  if (!qualityGateUnchanged) errors.push('§11: 35A の品質基準が変わっている ' + JSON.stringify(q));

  // ── §2 Web zoom ではなくヘッダから GSD を出している ─────────────────
  const headerDerived = !!(ortho && [...(ortho.osakaCityPhoto || []), ...(ortho.plateauOrtho || [])]
    .some((r) => r.ok && r.header && r.header.pixelScaleX != null));
  if (!headerDerived) errors.push('§2: 成果のヘッダ（ModelPixelScale）から GSD を出した記録が無い');
  const tileProbed = !!(avail && avail.imageLayersProbed > 0 && avail.images.some((i) => i.zooms && i.zooms.length));
  if (!tileProbed) errors.push('§2: Web タイル側の実測（配信されている最大 zoom）が無い');

  // ── §3 A/B/C/D 分類 ────────────────────────────────────────────────
  const classesUsed = new Set();
  for (const r of [...((ortho && ortho.osakaCityPhoto) || []), ...((ortho && ortho.plateauOrtho) || [])]) {
    if (r.gsdClass) classesUsed.add(r.gsdClass);
  }
  for (const i of ((avail && avail.images) || [])) if (i.gsdClass) classesUsed.add(i.gsdClass);
  const classified = classesUsed.size > 0 && [...classesUsed].every((c) => GSD_CLASS.some((g) => g.cls === c));
  if (!classified) errors.push('§3: A/B/C/D の分類が付いていない');

  // ── §4 梅田 coverage ───────────────────────────────────────────────
  const coverage = ortho ? {
    osakaCityYears: (ortho.osakaCityPhoto || []).filter((r) => r.ok).length,
    osakaCityYearsTotal: (ortho.osakaCityPhoto || []).length,
    plateauYearsWithOrtho: (ortho.plateauOrtho || []).filter((r) => r.orthoUrl).length,
    gsiLayersServed: avail ? avail.imageLayersServed : null,
    bestGsdM: ortho.bestGsdM, bestGsdClass: ortho.bestGsdClass,
    anyClassAorB: ortho.anyClassAorB,
  } : null;
  if (!coverage) errors.push('§4: coverage の記録が無い');

  // ── §9/§10 実験 ────────────────────────────────────────────────────
  const experimentOk = !!(res && res.evaluated > 0 && res.sweeps && res.sweeps.delineation
    && res.cliff && res.minimumGsdM);
  if (!experimentOk) errors.push('§10: 解像度スイープの結果が無い');
  if (res) {
    if (res.evaluated !== res.groundTruthCount) warnings.push(`§9: ground truth ${res.groundTruthCount} のうち ${res.evaluated} 棟だけ評価`);
    if (res.method.thresholdsPx.detection !== JOHNSON.detection) errors.push('§10: 判定の閾値が記録と違う');
    const missing = GSD_STEPS.filter((g) => !res.gsdSteps.includes(g));
    if (missing.length) errors.push('§10: 測っていない解像度がある ' + missing.join(','));
    for (const need of [0.20, 0.25, 0.40, 0.60]) {
      if (!res.gsdSteps.includes(need)) errors.push('§10: 指定された ' + need + 'm を測っていない');
    }
  }
  // §9 の 4 指標
  const metricsNeeded = ['roofFamily', 'ridge', 'penthouse', 'multiLevel'];
  const metricsOk = !!(res && metricsNeeded.every((m) => res.byMetric && res.byMetric[m]));
  if (!metricsOk) errors.push('§9: 4 つの指標（roof family / ridge / penthouse / multi-level）が揃っていない');

  // ── §5 400dpi を鵜呑みにしていない ─────────────────────────────────
  const scanOk = !!(ss && ss.scan && ss.scan.table && ss.scan.table.length
    && ss.scan.dpiNeededForGsd020);
  if (!scanOk) errors.push('§5: 撮影縮尺からの地上画素寸法の計算が無い');
  // §6 ステレオ
  const stereoOk = !!(ss && ss.stereo && ss.stereo.baseHeightRatio > 0 && ss.stereo.capability);
  if (!stereoOk) errors.push('§6: ステレオ復元の評価が無い');

  // ── §12 推奨最低 GSD ───────────────────────────────────────────────
  const recommendedMinGsdM = res ? res.minimumGsdM['0.95'] : null;
  if (recommendedMinGsdM == null) errors.push('§12: 推奨する最低 GSD が決まっていない');
  const recommendedClass = classifyGsd(recommendedMinGsdM);

  // ── dev / production / protected ───────────────────────────────────
  const prodBuild = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = prodBuild.productionSha256 ? sha(F.prod) !== prodBuild.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('§12: production HTML が変更されている');
  if (protectedModified !== false) errors.push('§12: protected HTML が変更されている');
  // 35B は調査のみ。dev の描画にも手を入れていないこと
  const devHtml = fs.readFileSync(F.dev, 'utf-8');
  const devTouched = /Mission ?35B|35B/.test(devHtml);
  if (devTouched) errors.push('§11: dev HTML に 35B の変更が入っている（今回は調査のみ）');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35B', RESULT,
    classification: errors.length ? 'UMEDA_AERIAL_EVIDENCE_AUDIT_FAILED' : 'UMEDA_AERIAL_EVIDENCE_AUDIT_SUCCESS',
    geometryUnchanged, generatedRoofs: roofCount, qualityGateUnchanged, qualityGate: q,
    headerDerivedGsd: headerDerived, tileProbed, classified,
    coverage, experimentOk, metricsOk, scanOk, stereoOk,
    devTouched, productionModified, protectedModified,
    findings: {
      bestAvailableGsdM: ortho ? ortho.bestGsdM : null,
      bestAvailableGsdClass: ortho ? ortho.bestGsdClass : null,
      anyClassAorBAvailable: ortho ? ortho.anyClassAorB : null,
      gsiMaxServedZoom: avail ? Math.max(...(avail.images || []).filter((i) => i.available).map((i) => i.maxServedZoom)) : null,
      gsiBestGsdM: avail ? avail.bestGsdM : null,
      resolutionCliff: res ? res.cliff : null,
      recommendedMinimumGsdM: recommendedMinGsdM,
      recommendedMinimumGsdClass: recommendedClass,
      stereoGsdMeetingHeightNeeds: ss ? ss.stereo.gsdMeetingAllHeightNeeds : null,
      classAorBAt400dpi: ss ? ss.scan.classAorBAt400dpi : null,
    },
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateUmedaAerialEvidence().then((o) => {
    console.log(JSON.stringify(o, null, 2));
    process.exit(o.RESULT === 'PASS' ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
