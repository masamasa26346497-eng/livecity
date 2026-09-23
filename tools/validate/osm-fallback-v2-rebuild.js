#!/usr/bin/env node
// tools/validate/osm-fallback-v2-rebuild.js
// [Mission 32O §23/§25] OSM fallback V2 再選定の検証。
//   plateauV2Mutation = 0 / plateauCanonicalIdPreserved = true
//   oldFallbackNotUsedInV2Runtime = true / duplicateOverlapMeasured = true
//   newFallbackSelectedAgainstCorrectedV2 = true
//   productionModified = false / protectedModified = false
//   → OSM_FALLBACK_V2_REBUILD_SUCCESS / OSM_FALLBACK_V2_REBUILD_FAILED
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  report: P('data', 'reports', 'osm-fallback-v2-rebuild.json'),
  build: P('data', 'reports', 'osm-fallback-v2-build.json'),
  out: P('data', 'reports', 'osm-fallback-v2-rebuild-validation.json'),
  v2: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-corrected'),
  merged: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  fallback: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osm-fallback'),
  candidates: P('data', 'processed', 'osaka-city', 'osm-fallback-v2', 'candidates.json'),
  builder: P('tools', 'build-osm-fallback-v2.js'),
  html: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  publicNear: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'near', 'buildings', 'manifest.json'),
};
// 32N の V1 / 旧 V2 公開物が残っていること（§20: V1 は保持）
const KEEP = ['public/map-data/osaka-city/derived/near/buildings/manifest.json', 'public/map-data/osaka-city/derived-v2-corrected/near/buildings/manifest.json'];
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
function gitClean(rel) {
  try { return execFileSync('git', ['status', '--porcelain', '--', rel], { cwd: resolveProjectPath('.'), encoding: 'utf-8' }).trim() === ''; } catch { return null; }
}

// 成功判定の許容値
export const LIMITS = Object.freeze({
  maxOverlapAfterExcludingAmbiguous: 50,   // §15「ほぼ 0」
  maxCoverageLossPoint: 0.02,              // §16 fixture ごとの OSM 被覆率の低下（割合）
});

export async function validateOsmFallbackV2() {
  const errors = [], warnings = [];
  const r = rj(F.report), b = rj(F.build);
  if (!r || !b) {
    const out = { RESULT: 'FAIL', classification: 'OSM_FALLBACK_V2_REBUILD_FAILED', errors: ['レポートが無い: ' + toProjectRelativePath(r ? F.build : F.report)] };
    await writeJson(F.out, out); return out;
  }
  // ── PLATEAU ──
  const pi = r.plateauIntegrity;
  const plateauV2Mutation = pi.plateauV2Mutation + (pi.v2CanonicalGeneratedAt === pi.v2CanonicalGeneratedAtAtAnalysis ? 0 : 1);
  if (plateauV2Mutation) errors.push('§0/§1: V2 PLATEAU が変わっている ' + JSON.stringify(pi));
  const plateauCanonicalIdPreserved = r.plateauCount === 574112 && pi.plateauMissing === 0 && pi.plateauExtra === 0;
  if (!plateauCanonicalIdPreserved) errors.push('§1/§11: PLATEAU の件数・ID が保たれていない');
  const v2Manifest = rj(path.join(F.v2, 'manifest.json')) || {};
  if (v2Manifest.featureCount !== 615617) errors.push('§20: V2（旧 OSM）canonical が変わっている: ' + v2Manifest.featureCount);

  // ── 選定の基準 ──
  const src = stripComments(fs.readFileSync(F.builder, 'utf-8'));
  const readsV1 = /canonical', 'buildings'\)|'buildings', 'attributes'|map-data', 'osaka-city', 'buildings'|ward-poc-all-buildings|latLonToJPRect/.test(src);
  const cand = rj(F.candidates);
  const mergedManifest = rj(path.join(F.merged, 'manifest.json')) || {};
  const fbManifest = rj(path.join(F.fallback, 'manifest.json')) || {};
  const newFallbackSelectedAgainstCorrectedV2 = !readsV1
    && /buildings-v2-corrected/.test(src) && /plateau-building/.test(src)
    && cand && cand.v2Canonical.generatedAt === v2Manifest.generatedAt
    && fbManifest.usesV1Footprints === false && /V2 PLATEAU/.test(mergedManifest.sources?.OSM_FALLBACK?.selectedAgainst || '');
  if (!newFallbackSelectedAgainstCorrectedV2) errors.push('§3: 新 fallback が V2 PLATEAU だけを基準に選ばれたことを確認できない');
  const usesCommonCoords = /import \{ latLonToLiveCityWorld/.test(fs.readFileSync(F.builder, 'utf-8'));
  if (!usesCommonCoords) errors.push('§3: OSM 座標が共通座標 module で変換されていない');
  if (/fs\.rmSync\(/.test(src)) errors.push('§24: ビルダーに rmSync がある（synced-dir-writer を使うこと）');
  if (!/writeFilesVerified/.test(src)) errors.push('§24: synced-dir-writer を使っていない');
  if (!r.sourceSeparation.consistent) errors.push('§1: fallback 単独 dir と merged の fallback が一致しない');

  // ── 重複・coverage ──
  const k = r.duplicateKpi;
  const duplicateOverlapMeasured = !!(k && k.before && k.after && k.before.overlapBuildings > 0 && typeof k.after.overlapBuildings === 'number');
  if (!duplicateOverlapMeasured) errors.push('§15: 重複 KPI が測られていない');
  if (k.after.excludingAmbiguous > LIMITS.maxOverlapAfterExcludingAmbiguous) errors.push(`§15: AMBIGUOUS 以外の重複が残る: ${k.after.excludingAmbiguous}`);
  if (k.after.areaCovered50 > 0) errors.push('§6: 面積の 50% 以上が PLATEAU と重なる fallback が残る: ' + k.after.areaCovered50);
  for (const [site, v] of Object.entries(r.visualFixtures)) {
    if (v.coverageOfOsmBefore == null) { warnings.push(`§16: ${site} は OSM が無く coverage を比較できない（${v.osmSource}）`); continue; }
    const loss = v.coverageOfOsmBefore - v.coverageOfOsmAfter;
    if (loss > LIMITS.maxCoverageLossPoint) errors.push(`§16: ${site} で OSM 建物の被覆率が ${loss.toFixed(4)} 低下`);
    else if (loss > 0) {
      const by = v.coverageLossByRemovalReasonM2 || {};
      warnings.push(`§16: ${site} で OSM 建物の被覆率が ${loss.toFixed(4)} 低下（許容内。内訳: 重複除外した OSM の PLATEAU からのはみ出し ${by.duplicateOutsidePlateau} m² / PLATEAU 空白地帯でなくなった fallback ${by.notInPlateauGap} m²）`);
    }
    if (v.plateauFallbackDoubleM2.after > v.plateauFallbackDoubleM2.before) errors.push(`§18: ${site} で PLATEAU と fallback の二重面積が増えた`);
  }
  for (const [site, v] of Object.entries(r.picking.fixtures)) {
    if (v.after.pointsHittingMultipleFootprints > v.before.pointsHittingMultipleFootprints) errors.push(`§19: ${site} で duplicate picking が増えた`);
  }
  if (r.picking.newFallbackMissingPropertyFields) errors.push('§19: property card に必要な属性が欠けた fallback がある: ' + r.picking.newFallbackMissingPropertyFields);
  if (r.wardCheck.newFallbackWithoutWard) errors.push('§12: 区が付いていない fallback がある');
  if (r.newTotalBuildingCount !== r.plateauCount + r.newOsmFallbackCount) errors.push('§10: total が PLATEAU + fallback と一致しない');

  // ── runtime ──
  const oldFallbackNotUsedInV2Runtime = r.oldFallbackNotUsedInV2Runtime === true;
  if (!oldFallbackNotUsedInV2Runtime) errors.push('§13: V2N runtime に旧 fallback が混ざる可能性がある ' + JSON.stringify(r.staleInPublic));
  const rt = r.runtime || {};
  // 32O §26 時点では既定 V1。Mission 32P で development 既定を V2N へ昇格した。
  if (rt.defaultVersion !== 'V1' && rt.defaultVersion !== 'V2N') errors.push('§26: 既定の建物版が V1 / V2N 以外: ' + rt.defaultVersion);
  if (!rt.v2n || JSON.stringify(rt.v2n.buildingsGroupScale) !== '[1,1,1]' || JSON.stringify(rt.v2n.buildingsGroupRotation) !== '[0,0,0]' || !rt.v2n.placementManifestLoaded || !rt.v2n.wardIndexLoaded || rt.residualInV2N !== 0) {
    errors.push('§13: V2N の runtime 状態が期待どおりでない ' + JSON.stringify(rt).slice(0, 300));
  }
  const near = rj(F.publicNear);
  if (!near || near.featureCount !== r.newTotalBuildingCount) errors.push('§20: V2N の near 件数が total と一致しない');
  for (const rel of KEEP) if (!fs.existsSync(resolveProjectPath(rel))) errors.push('§20: 既存の公開物が消えている: ' + rel);

  // ── production / protected ──
  const productionModified = gitClean('public/osaka_3d_buildings.html') === false;
  const protectedModified = gitClean('public/osaka_3d_buildings.fullward-v3.html') === false;
  if (productionModified) errors.push('§0: production HTML が変更されている');
  if (protectedModified) errors.push('§0: protected HTML が変更されている');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '32O', RESULT,
    classification: errors.length ? 'OSM_FALLBACK_V2_REBUILD_FAILED' : 'OSM_FALLBACK_V2_REBUILD_SUCCESS',
    plateauV2Mutation, plateauCanonicalIdPreserved,
    oldFallbackNotUsedInV2Runtime, duplicateOverlapMeasured, newFallbackSelectedAgainstCorrectedV2,
    productionModified, protectedModified,
    counts: { plateau: r.plateauCount, oldFallback: r.oldOsmFallbackCount, newFallback: r.newOsmFallbackCount, total: r.newTotalBuildingCount },
    duplicateKpi: { before: k.before.overlapBuildings, after: k.after.overlapBuildings, afterAmbiguous: k.after.ofWhichAmbiguous },
    limits: LIMITS,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateOsmFallbackV2().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
