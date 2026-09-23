#!/usr/bin/env node
// tools/validate/umeda-inferred-roof.js
// [Mission 35A §35] 梅田 推定屋根 PoC の検証。
//   realLodUnmodified / fabricatedPlateauLod2=false / inferredRoofClearlySeparated
//   canonicalIdMutation=0 / footprintMutation=0 / projectionMutation=0
//   highConfidenceOnlyForNormalDisplay / productionModified=false / protectedModified=false
//   → UMEDA_INFERRED_ROOF_POC_SUCCESS / UMEDA_INFERRED_ROOF_POC_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { stripComments } from './max-plateau-lod.js';
import { UMEDA } from '../audit/umeda-roof-evidence.js';
import { pointInRing, distToRing, GUARD, NO_GEOMETRY_TYPES, NEEDS_IMAGERY_TYPES } from '../build-umeda-inferred-roof.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  evidence: P('data', 'reports', 'umeda-roof-evidence.json'),
  groundTruth: P('data', 'reports', 'umeda-roof-groundtruth.json'),
  evaluation: P('data', 'reports', 'umeda-roof-evaluation.json'),
  build: P('data', 'reports', 'umeda-inferred-roof-build.json'),
  qa: P('data', 'reports', 'umeda-inferred-roof-qa.json'),
  roofs: P('data', 'processed', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json'),
  manifest: P('data', 'processed', 'osaka-city', 'derived-umeda-inferred-roof', 'manifest.json'),
  publicManifest: P('public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'manifest.json'),
  canonDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  canonManifest: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'),
  highManifest: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high', 'manifest.json'),
  highBuild: P('data', 'reports', 'plateau-high-lod-build.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  out: P('data', 'reports', 'umeda-inferred-roof-validation.json'),
};
// §1 実 LOD の数（34D 確定値）。推定で増減してはならない。
export const REAL_LOD = { lod2: 10208, lod3: 15, total: 10223 };
export const TOTAL_BUILDINGS = 600764;
// §1 命名。UI で推定を「LOD2」と称してはならない。
export const REQUIRED_NAMES = ['PLATEAU_LOD3', 'PLATEAU_LOD2', 'INFERRED_ROOF', 'PLATEAU_LOD1'];
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export async function validateUmedaInferredRoof() {
  const errors = [], warnings = [];
  const raw = fs.readFileSync(F.dev, 'utf-8');
  const html = stripComments(raw);
  const ev = rj(F.evidence), gt = rj(F.groundTruth), evalR = rj(F.evaluation), build = rj(F.build), qa = rj(F.qa);
  const roofs = rj(F.roofs), manifest = rj(F.manifest);

  // ── §1 実 LOD を変えていない ────────────────────────────────────────
  const hm = rj(F.highManifest) || {};
  const hb = rj(F.highBuild) || {};
  const realLodUnmodified = hm.lod2Count === REAL_LOD.lod2 && hm.lod3Count === REAL_LOD.lod3
    && hm.buildingCount === REAL_LOD.total && hb.adopted === REAL_LOD.total;
  if (!realLodUnmodified) errors.push('§1: 実 PLATEAU LOD の数が変わっている ' + JSON.stringify({ lod2: hm.lod2Count, lod3: hm.lod3Count, total: hm.buildingCount }));

  // ── §1 推定を実 LOD2 として出していない ─────────────────────────────
  let fabricatedPlateauLod2 = false;
  const inferredIds = new Set(((roofs && roofs.buildings) || []).map((b) => b.canonicalId));
  // 高 LOD データセットに推定の棟が混ざっていないこと
  try {
    const hdir = path.dirname(F.highManifest);
    for (const f of fs.readdirSync(hdir)) {
      if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
      for (const b of ((rj(path.join(hdir, f)) || {}).buildings || [])) {
        if (inferredIds.has(b.canonicalId)) { fabricatedPlateauLod2 = true; break; }
      }
    }
  } catch { /* noop */ }
  if (fabricatedPlateauLod2) errors.push('§1: 推定屋根の棟が実 LOD2 のデータセットに入っている');
  // 実 LOD を持つ棟を推定対象にしていないこと
  if (build && build.stats && build.stats.targets != null && ev) {
    if (build.stats.targets !== ev.umeda.lod1OnlyTargets) errors.push('§3: 対象が「LOD1 のみ」と一致しない');
  }

  // ── §1/§22 推定と実物がはっきり分かれている ────────────────────────
  const separateNamespace = !!(manifest && manifest.namespace === 'derived-umeda-inferred-roof'
    && manifest.representation === 'INFERRED_ROOF' && manifest.warning);
  const provenanceOk = ((roofs && roofs.buildings) || []).every((b) => b.geometrySource === 'PLATEAU_LOD1'
    && b.representation === 'INFERRED_ROOF' && b.roofSource && b.roofInferenceMethod
    && b.roofInferenceConfidence && b.roofType && b.generationVersion);
  const runtimeNames = REQUIRED_NAMES.every((n) => html.includes(n));
  // 通常表示で「LOD2」と偽らない: 推定レイヤーは実 LOD2 の material / カウンタを使わない
  const noLod2Label = !/INFERRED_ROOF[^\n]*LOD2 として/.test(html);
  const inferredRoofClearlySeparated = !!(separateNamespace && provenanceOk && runtimeNames && noLod2Label);
  if (!separateNamespace) errors.push('§1: 推定屋根が別 namespace / 表示名で分かれていない');
  if (!provenanceOk) errors.push('§22: provenance の必須項目が足りない');
  if (!runtimeNames) errors.push('§1: 命名（PLATEAU_LOD2 / INFERRED_ROOF 等）が runtime に無い');

  // ── §9 通常表示は HIGH だけ ─────────────────────────────────────────
  const confs = ((roofs && roofs.buildings) || []).map((b) => b.roofInferenceConfidence);
  const highConfidenceOnlyForNormalDisplay = confs.every((c) => c === 'HIGH');
  if (!highConfidenceOnlyForNormalDisplay) errors.push('§9: HIGH 以外の推定屋根を出している ' + JSON.stringify(confs));
  const buildEnforces = /if \(inf\.confidence !== 'HIGH'\)/.test(stripComments(fs.readFileSync(P('tools', 'build-umeda-inferred-roof.js'), 'utf-8')));
  if (!buildEnforces) errors.push('§9: ビルド側で HIGH 以外を除く処理が無い');

  // ── §14/§15 footprint と高さを壊していない ──────────────────────────
  let footprintMutation = 0, heightViolations = 0, outsideFootprint = 0;
  const canonById = new Map();
  if (roofs && roofs.buildings && roofs.buildings.length) {
    const TILE = 500;
    for (let tx = Math.floor((UMEDA.x - UMEDA.radiusM) / TILE); tx <= Math.floor((UMEDA.x + UMEDA.radiusM) / TILE); tx++) {
      for (let tz = Math.floor((UMEDA.z - UMEDA.radiusM) / TILE); tz <= Math.floor((UMEDA.z + UMEDA.radiusM) / TILE); tz++) {
        const doc = rj(path.join(F.canonDir, `tile_${tx}_${tz}.json`));
        const attrs = (rj(path.join(F.canonDir, 'attributes', `tile_${tx}_${tz}.json`)) || {}).attributes || {};
        for (const ft of ((doc && doc.features) || [])) {
          if (!inferredIds.has(ft.canonicalId)) continue;
          canonById.set(ft.canonicalId, { ring: ft.coordinates && ft.coordinates[0], heightM: (attrs[ft.canonicalId] || {}).heightM ?? null });
        }
      }
    }
    for (const b of roofs.buildings) {
      const cn = canonById.get(b.canonicalId);
      if (!cn || !cn.ring) { footprintMutation++; continue; }
      // §14 推定側が持つ fp は canonical と同一（丸め 0.01m まで）
      const same = cn.ring.length === b.fp.length && cn.ring.every((q, i) =>
        Math.abs(q[0] - b.fp[i][0]) < 0.011 && Math.abs(q[1] - b.fp[i][1]) < 0.011);
      if (!same) footprintMutation++;
      // §15 全高が canonical の高さを超えない
      if (cn.heightM != null && b.ridgeY > cn.heightM + 0.02) heightViolations++;
      // §14/§30 頂点が footprint の外へ出ていない
      for (let i = 0; i < b.positions.length; i += 3) {
        const x = b.positions[i], y = b.positions[i + 1], z = b.positions[i + 2];
        if (y < 0 || (cn.heightM != null && y > cn.heightM + 0.02)) { heightViolations++; break; }
        if (!pointInRing(x, z, cn.ring) && distToRing(x, z, cn.ring) > GUARD.footprintEpsM) { outsideFootprint++; break; }
      }
    }
  }
  if (footprintMutation) errors.push('§14: footprint が canonical と違う ' + footprintMutation);
  if (heightViolations) errors.push('§15: 全高を超えている / 負の高さ ' + heightViolations);
  if (outsideFootprint) errors.push('§14: 屋根が footprint の外へ出ている ' + outsideFootprint);

  // ── canonicalId / projection ────────────────────────────────────────
  const canonManifest = rj(F.canonManifest) || {};
  const canonicalIdMutation = (canonManifest.featureCount === TOTAL_BUILDINGS) ? 0 : 1;
  if (canonicalIdMutation) errors.push('§1: canonical 建物数が変わっている ' + canonManifest.featureCount);
  // 推定側の canonicalId は canonical に存在するものだけ
  let unknownId = 0;
  for (const id of inferredIds) if (!canonById.has(id)) unknownId++;
  if (unknownId) errors.push('§1: canonical に無い canonicalId を使っている ' + unknownId);
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = (proj.type === 'local-equirectangular' && proj.centerLat === 34.604208
    && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 0 : 1;
  if (projectionMutation) errors.push('§1: projection が変わっている');

  // ── §6 証拠が無いものを無理に作っていない ───────────────────────────
  let noEvidenceGenerated = 0;
  if (build && build.stats) {
    const gen = build.stats.generated || 0;
    const withEvidence = (build.stats.byEvidence || {})['osm-roof-shape'] || 0;
    if (gen > withEvidence) { noEvidenceGenerated = gen - withEvidence; errors.push('§6: 証拠の数より多く生成している'); }
  }

  // ── §23/§24 ランタイム ──────────────────────────────────────────────
  const priorityOk = /INFERRED_ROOF（推定屋根）を出している棟も LOD1 の箱を出さない/.test(raw)
    && raw.indexOf('__INFERRED_ROOF_LAYER__.isSuppressedBuilding') > raw.indexOf('BuildingLODLayer.isSuppressedBuilding(f.canonicalId)');
  if (!priorityOk) errors.push('§23/§24: 実 LOD より後ろで INFERRED_ROOF を判定していない');
  let runtime = null;
  if (!qa) warnings.push('§28: umeda-inferred-roof-qa.json が無い（実ブラウザ確認が未実行）');
  else {
    runtime = qa.summary;
    if (!qa.summary.suppressionOk) errors.push('§24: 推定屋根と LOD1 が二重表示になっている');
    if (!qa.summary.cardOk) errors.push('§24: 推定屋根の棟で card を引けない');
    if (!qa.summary.inspectSaysInferred) errors.push('§27: クリック診断が「推定」と返していない');
    if (qa.summary.jsErrors) warnings.push('ランタイムで JS 例外 ' + qa.summary.jsErrors);
  }

  // ── §33 production / protected ──────────────────────────────────────
  const prodBuild = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = prodBuild.productionSha256 ? sha(F.prod) !== prodBuild.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('§33: production HTML が変更されている');
  if (protectedModified !== false) errors.push('§33: protected HTML が変更されている');
  const prodHtml = (() => { try { return fs.readFileSync(F.prod, 'utf-8'); } catch { return ''; } })();
  if (/__INFERRED_ROOF__|INFERRED_ROOF/.test(prodHtml)) errors.push('§33: production に推定屋根が入っている');

  if (!ev) errors.push('§5: umeda-roof-evidence.json が無い');
  if (!gt) errors.push('§10: umeda-roof-groundtruth.json が無い');
  if (!evalR) errors.push('§12: umeda-roof-evaluation.json が無い');

  // §13 の品質目標は「作ったものが正しいか」の目標であって、合否の条件ではない（§32）。
  //   満たせなかったこと自体は隠さず記録する。満たせない限り生成しない、が §6 の設計。
  const qualityGate = evalR ? {
    met: !!(evalR.meetsQuality && evalR.meetsQuality.highConfidenceOnly),
    highConfidenceExactAccuracy: evalR.evaluation.highConfidenceOnly.exactAccuracy,
    highConfidenceFamilyAccuracy: evalR.evaluation.highConfidenceOnly.familyAccuracy,
    judgedInValidation: evalR.evaluation.validation.n - evalR.evaluation.validation.unknown,
    validationCoverage: evalR.evaluation.validation.coverage,
    note: '目標未達のため、証拠のある棟以外は生成していない（§6）。coverage は合否条件ではない（§32）。',
  } : null;
  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35A', RESULT,
    classification: errors.length ? 'UMEDA_INFERRED_ROOF_POC_FAILED' : 'UMEDA_INFERRED_ROOF_POC_SUCCESS',
    qualityGate,
    realLodUnmodified, fabricatedPlateauLod2, inferredRoofClearlySeparated,
    canonicalIdMutation, footprintMutation, projectionMutation,
    highConfidenceOnlyForNormalDisplay,
    productionModified, protectedModified,
    area: UMEDA,
    evidence: ev ? { aerialImageryFiles: ev.aerialImagery.filesFound, umeda: ev.umeda,
      gsiOutlineInUmeda: ev.gsiBuildingOutline.inUmeda,
      osmRoofTagsInUmeda: ev.osmRoofTags.inUmeda, osmRoofShapeInUmeda: ev.osmRoofTags.roofShapeInUmeda } : null,
    groundTruth: gt ? { count: gt.groundTruthCount, byRoofType: gt.byRoofType, split: gt.split } : null,
    evaluation: evalR ? { evidenceCounts: evalR.evidenceCounts, confidenceCounts: evalR.confidenceCounts,
      validation: evalR.evaluation.validation, highConfidenceOnly: evalR.evaluation.highConfidenceOnly,
      meetsQuality: evalR.meetsQuality, quality: evalR.quality } : null,
    generation: build ? build.stats : null,
    guards: { footprintMutation, heightViolations, outsideFootprint, noEvidenceGenerated },
    runtime, priorityOk,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateUmedaInferredRoof().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
