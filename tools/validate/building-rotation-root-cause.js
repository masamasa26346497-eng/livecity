#!/usr/bin/env node
// tools/validate/building-rotation-root-cause.js
// [Mission 32M §27] AUDIT ONLY であることと、原因特定が独立 truth で行われたことを検証する。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const REPORT = P('data', 'reports', 'building-rotation-root-cause.json');
const OUT = P('data', 'reports', 'building-rotation-root-cause-validation.json');
const AUDIT = P('tools', 'audit', 'building-rotation-root-cause.js');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const AREA_CFG = P('config', 'areas', 'osaka-city.json');
const BLDG_CFG = P('data', 'buildings', 'coordinate-config.json');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
function countUnique(dir) {
  if (!fs.existsSync(dir)) return null;
  const seen = new Set();
  for (const f of fs.readdirSync(dir)) { if (!isTile(f)) continue; const t = rj(path.join(dir, f)); if (!t) continue; for (const ft of t.features || []) seen.add(ft.canonicalId); }
  return seen.size;
}

export async function validateBuildingRotationRootCause() {
  const errors = [], warnings = [];
  const r = rj(REPORT);
  if (!r) { const out = { RESULT: 'FAIL', errors: ['レポートが無い: ' + toProjectRelativePath(REPORT)] }; await writeJson(OUT, out); return out; }

  const buildings = countUnique(CANON_BLDGS), roads = countUnique(CANON_ROADS);
  const proj = (rj(AREA_CFG) || {}).projection;
  const bcfg = rj(BLDG_CFG) || {};
  const buildingMutation = buildings === 615617 ? 0 : 1;
  const roadMutation = roads === CANONICAL_ROAD_FEATURE_COUNT ? 0 : 1;
  const projectionMutation = proj && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320 ? 0 : 1;
  const buildingConfigMutation = bcfg.jprectZone === 7 && bcfg.localOrigin && bcfg.localOrigin.projectedE === -150573.671 ? 0 : 1;
  if (buildingMutation) errors.push('Canonical Buildings が 615617 でない: ' + buildings);
  if (roadMutation) errors.push('Canonical Roads が ' + CANONICAL_ROAD_FEATURE_COUNT + ' でない: ' + roads);
  if (projectionMutation) errors.push('projection が変更されている');
  if (buildingConfigMutation) errors.push('coordinate-config.json が変更されている（監査対象を書き換えてはいけない）');

  // §11/§12: truth の方針
  const src = fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf-8') : '';
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const rawLatLonUsedAsTruth = !!(r.truthPolicy && r.truthPolicy.rawLatLonUsedAsTruth) && /rawBuildingRings\(/.test(code);
  // canonical 座標を lat/lon へ逆変換する関数（toLatLon / worldInv）を truth 作りに使っていないこと
  const inverseDerivedTruthUsed = /worldInv\(|toLatLon\(|lonOf\(c[XZ]|latOf\(c[XZ]/.test(code) || !!(r.truthPolicy && r.truthPolicy.inverseDerivedTruthUsed);
  if (!rawLatLonUsedAsTruth) errors.push('§12: 生 lat/lon を truth にしていない');
  if (inverseDerivedTruthUsed) errors.push('§11: canonical から逆算した lat/lon を truth に使っている');

  // §8/§9
  const required = ['A_raw_latlon_to_map', 'B_projected_zone7', 'C1_jsonl', 'C2_wardDataset', 'C3_canonical', 'D_derivedNear', 'E_runtime'];
  const measured = new Map((r.stageMeasurements || []).map((s) => [s.stage, s]));
  const rotationMeasuredAtEachStage = required.every((k) => measured.has(k) && typeof measured.get(k).rotationDeg === 'number');
  const firstBadStageIdentified = typeof r.firstBadStage === 'string' && required.includes(r.firstBadStage) && typeof r.ROTATION_FIRST_APPEARS_AT === 'string';
  if (!rotationMeasuredAtEachStage) errors.push('§8: 全段階で回転を測れていない: ' + required.filter((k) => !measured.has(k) || typeof measured.get(k).rotationDeg !== 'number').join(','));
  if (!firstBadStageIdentified) errors.push('§9: first bad stage が特定されていない');
  const runtimeIdentity = !!(r.stageTransitions && r.stageTransitions.D_to_E_runtime && r.stageTransitions.D_to_E_runtime.identity);
  if (!runtimeIdentity) errors.push('§8 E: runtime の頂点同一性が確認できていない');

  // §5/§6/§13/§15/§16/§17/§20/§21/§22
  const need = {
    zoneVIConvergence: r.zoneVIConvergence && typeof r.zoneVIConvergence.atLiveCityOriginDeg === 'number',
    zoneVIIConvergence: r.zoneVIIConvergence && typeof r.zoneVIIConvergence.atLiveCityOriginDeg === 'number',
    rotationDirection: typeof r.rotationDirection === 'string' && /CLOCKWISE/.test(r.rotationDirection),
    bestFitRotationCenter: r.bestFitRotationCenter && Array.isArray(r.bestFitRotationCenter.world),
    byWard: Array.isArray(r.byWard) && r.byWard.length === 24,
    layerComparison: Array.isArray(r.layerComparison) && ['road', 'rail', 'water', 'park', 'boundary'].every((k) => r.layerComparison.some((l) => l.layer.startsWith(k))),
    sourceConfigUsed: Array.isArray(r.sourceConfigUsed) && r.sourceConfigUsed.every((c) => /USED|UNUSED|DEPRECATED/.test(c.status)),
    predictedCorrection: r.predictedCorrection && ['osmOverlapBefore', 'osmOverlapAfter', 'roadOverlapBefore', 'roadOverlapAfter', 'waterOverlapBefore', 'waterOverlapAfter'].every((k) => typeof r.predictedCorrection[k] === 'number'),
    rebuildScope: r.rebuildScope && Array.isArray(r.rebuildScope.mustRegenerate) && r.rebuildScope.mustRegenerate.length > 0,
    canonicalIdPreservation: r.canonicalIdPreservation && typeof r.canonicalIdPreservation.preservable === 'boolean',
  };
  for (const [k, ok] of Object.entries(need)) if (!ok) errors.push('必須項目が不足: ' + k);

  // §23 過補正
  if (r.predictedCorrection && r.predictedCorrection.overCorrectionCheck && r.predictedCorrection.overCorrectionCheck.sumiyoshiWorsened) {
    warnings.push('§23: 住吉で補正後に OSM 被覆が悪化する予測');
  }

  // §25/§28
  const classOk = /^(BUILDING_PROJECTION_BASIS_ROTATION|PLANE_RECTANGULAR_CONVERGENCE_ERROR|WRONG_ZONE_ERROR|AXIS_ORIENTATION_ERROR|LEGACY_BUILD_PIPELINE_ERROR|ROTATION_IS_NOT_SYSTEMATIC|UNKNOWN_ROTATION_SOURCE)$/.test(r.classification || '');
  const stopOk = /^(BUILDING_ROTATION_ROOT_CAUSE_IDENTIFIED|BUILDING_ROTATION_ROOT_CAUSE_UNRESOLVED)$/.test(r.stopToken || '');
  if (!classOk) errors.push('§25: classification が 7 択でない');
  if (!stopOk) errors.push('§28: stopToken が 2 択でない');

  const checks = {
    buildingMutation, roadMutation, projectionMutation, buildingConfigMutation,
    canonicalBuildings: buildings, canonicalRoads: roads,
    rawLatLonUsedAsTruth, inverseDerivedTruthUsed,
    rotationMeasuredAtEachStage, firstBadStageIdentified, runtimeIdentity,
    ...need,
    observedRotationDeg: r.observedRotationDeg, firstBadStage: r.firstBadStage,
    classification: r.classification, stopToken: r.stopToken,
  };
  const out = { RESULT: errors.length ? 'FAIL' : 'PASS', generatedAt: new Date().toISOString(), missionId: '32M', checks, errors, warnings };
  await writeJson(OUT, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateBuildingRotationRootCause().then((out) => {
    console.log('RESULT=' + out.RESULT);
    for (const w of out.warnings || []) console.log('WARN: ' + w);
    for (const e of out.errors || []) console.log('ERROR: ' + e);
    console.log(JSON.stringify(out.checks, null, 1));
    process.exitCode = out.RESULT === 'PASS' ? 0 : 1;
  });
}
