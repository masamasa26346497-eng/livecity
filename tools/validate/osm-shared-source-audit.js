#!/usr/bin/env node
// tools/validate/osm-shared-source-audit.js
// [Mission 35F §15] 共有 OSM source の監査と、影響のあったレイヤーだけの再生成を検証する。
//   buildingV4DevDefault / productionBuildingCount / road35EStatePreserved
//   projectionMutation / canonicalBuildingMutation / roadV3LogicMutation
//   duplicateRail/Water/ParkIncrease = 0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from '../lib/canonical-baseline.js';
import { ROAD_V3_MARKERS } from './north-road-recovery.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  inventory: P('data', 'reports', 'osm-source-dependency-inventory.json'),
  coverage: P('data', 'reports', 'osm-shared-source-coverage.json'),
  rebuild: P('data', 'reports', 'osm-shared-source-rebuild.json'),
  runtimeQa: P('data', 'reports', 'osm-shared-source-runtime-qa.json'),
  canonRoads: P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'),
  refined: P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json'),
  v4: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-final', 'manifest.json'),
  v2nPlacement: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement', 'manifest.json'),
  rail: P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'manifest.json'),
  stations: P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'stations.json'),
  water: P('data', 'processed', 'osaka-city', 'canonical', 'water', 'manifest.json'),
  parks: P('data', 'processed', 'osaka-city', 'canonical', 'parks', 'manifest.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  out: P('data', 'reports', 'osm-shared-source-audit-validation.json'),
};
/** §15 production が読む建物数。今回も変えない。 */
export const PRODUCTION_BUILDING_COUNT = 600764;
/** §15 35E で作った道路の状態。rollback していないこと。 */
export const ROAD_35E = {
  canonicalRoads: CANONICAL_ROAD_FEATURE_COUNT,
  refinedIndexed: REFINED_ROAD_SURFACE_INDEXED_COUNT,
};
/** canonical buildings（V1 系）。今回触らない。 */
export const CANONICAL_BUILDING_V1 = 615617;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };

export async function validateOsmSharedSourceAudit() {
  const errors = [], warnings = [];
  const inv = rj(F.inventory), cov = rj(F.coverage), reb = rj(F.rebuild), rq = rj(F.runtimeQa);
  const devHtml = fs.readFileSync(F.dev, 'utf-8');

  // ── §15 建物 V4 が dev の既定 ───────────────────────────────────────
  const m = devHtml.match(/let buildingsVersion = '([A-Z0-9]+)';/);
  const buildingV4DevDefault = !!(m && m[1] === 'V4');
  if (!buildingV4DevDefault) errors.push('§15: dev の既定が V4 でない: ' + (m && m[1]));

  // ── §13/§15 production の建物は 600,764 のまま ─────────────────────
  const pp = rj(F.v2nPlacement);
  const productionBuildingCount = pp ? pp.canonicalBuildingCount : null;
  if (productionBuildingCount !== PRODUCTION_BUILDING_COUNT) {
    errors.push('§13: production が読む建物数が変わっている ' + productionBuildingCount);
  }
  const prodHtml = (() => { try { return fs.readFileSync(F.prod, 'utf-8'); } catch { return ''; } })();
  const pv = prodHtml.match(/let buildingsVersion = '([A-Z0-9]+)';/);
  if (pv && pv[1] !== 'V2N') errors.push('§13: production の建物版が変わっている ' + pv[1]);
  if (/derived-v4-final/.test(prodHtml)) errors.push('§13: production に V4 が入っている');

  // ── §13/§15 35E の道路状態を rollback していない ───────────────────
  const cr = rj(F.canonRoads), rf = rj(F.refined);
  const roadsNow = cr ? cr.featureCount : null;
  const refinedNow = rf ? rf.indexedCount : null;
  const road35EStatePreserved = roadsNow === ROAD_35E.canonicalRoads && refinedNow === ROAD_35E.refinedIndexed;
  if (!road35EStatePreserved) {
    errors.push(`§13: 35E の道路状態が保たれていない roads=${roadsNow} refined=${refinedNow}`);
  }
  const roadSourcePbf = inv ? (inv.layers.find((l) => l.id === 'roads') || {}).sourcePbf : null;
  if (roadSourcePbf !== 'osaka-full-coverage.osm.pbf') errors.push('§13: 道路の source が広域 PBF でない ' + roadSourcePbf);

  // ── §15 ROAD V3 の設計・projection・canonical building を変えていない ─
  const missingMarkers = ROAD_V3_MARKERS.filter((x) => !devHtml.includes(x));
  const roadV3LogicMutation = missingMarkers.length > 0;
  if (roadV3LogicMutation) errors.push('§15: ROAD V3 の印が消えている ' + missingMarkers.join(','));
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = !(proj.type === 'local-equirectangular' && proj.centerLat === 34.604208
    && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320);
  if (projectionMutation) errors.push('§15: projection が変わっている');
  const v4 = rj(F.v4);
  const canonicalBuildingMutation = !(v4 && v4.featureCount === 618749);
  if (canonicalBuildingMutation) errors.push('§15: 建物 canonical が変わっている ' + (v4 && v4.featureCount));

  // ── §1/§5 監査して、影響のあったものだけ直したか ────────────────────
  let auditedLayers = null, rebuiltLayers = null, untouchedLayers = null;
  if (cov) {
    auditedLayers = cov.kinds.length;
    const flagged = cov.kinds.filter((k) => k.needsRebuild).map((k) => k.id);
    rebuiltLayers = reb ? reb.rebuilt : null;
    untouchedLayers = reb ? reb.untouched : null;
    if (!cov.kinds.every((k) => k.truncationSignal)) errors.push('§3: 北/南の比較が無い');
    if (reb) {
      // 影響が無いレイヤーを作り直していないこと（§5）
      const notFlagged = cov.kinds.filter((k) => !k.needsRebuild).map((k) => k.id);
      for (const r of (reb.rebuilt || [])) {
        if (notFlagged.includes(r)) errors.push('§5: 影響が無いのに作り直している: ' + r);
      }
      if (!reb.rebuilt || !reb.rebuilt.length) warnings.push('§5: 作り直したレイヤーが無い');
    } else warnings.push('§5: 再生成レポートが無い');
    if (!flagged.length) warnings.push('§3: 切断の影響を受けたレイヤーが 1 つも無い（前提を見直す）');
  } else errors.push('§3: coverage 監査レポートが無い');

  // ── §10 重複していないか ───────────────────────────────────────────
  const dup = reb && reb.duplicates ? reb.duplicates : null;
  const duplicateRailIncrease = dup ? dup.rail : null;
  const duplicateWaterIncrease = dup ? dup.water : null;
  const duplicateParkIncrease = dup ? dup.parks : null;
  for (const [k, v] of [['rail', duplicateRailIncrease], ['water', duplicateWaterIncrease], ['park', duplicateParkIncrease]]) {
    if (v == null) warnings.push('§10: ' + k + ' の重複確認が無い');
    else if (v !== 0) errors.push('§10: ' + k + ' に重複が増えている ' + v);
  }

  // ── §11/§14 実ブラウザ ─────────────────────────────────────────────
  let runtimeOk = null;
  if (rq) {
    runtimeOk = !!(rq.summary && rq.summary.regressionOk && rq.summary.jsErrors === 0
      && rq.summary.allSitesHaveLayers);
    if (!rq.summary.allSitesHaveLayers) errors.push('§11: レイヤーが出ていない地点がある');
    if (!rq.summary.regressionOk) errors.push('§14: regression がある ' + JSON.stringify(rq.summary.regression));
    if (rq.summary.jsErrors) warnings.push('§14: JS 例外 ' + rq.summary.jsErrors);
  } else warnings.push('§11: 実ブラウザ QA が未実行');

  // ── §13 production / protected ─────────────────────────────────────
  const prodBuild = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = prodBuild.productionSha256 ? sha(F.prod) !== prodBuild.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('§13: production HTML が変更されている');
  if (protectedModified !== false) errors.push('§13: protected HTML が変更されている');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35F', RESULT,
    classification: errors.length ? 'OSM_SHARED_SOURCE_AUDIT_FAILED' : 'OSM_SHARED_SOURCE_AUDIT_SUCCESS',
    buildingV4DevDefault, productionBuildingCount,
    road35EStatePreserved, roadState: { canonicalRoads: roadsNow, refinedIndexed: refinedNow, sourcePbf: roadSourcePbf },
    projectionMutation, canonicalBuildingMutation, roadV3LogicMutation,
    duplicateRailIncrease, duplicateWaterIncrease, duplicateParkIncrease,
    auditedLayers, rebuiltLayers, untouchedLayers,
    layerCounts: { rail: (rj(F.rail) || {}).featureCount ?? null,
      stations: (rj(F.stations) || {}).count ?? null,
      water: (rj(F.water) || {}).featureCount ?? null,
      parks: (rj(F.parks) || {}).featureCount ?? null },
    inventory: inv ? { stillOnOldPbf: inv.stillOnOldPbf, alreadyOnWidePbf: inv.alreadyOnWidePbf,
      notOsmDependent: inv.notOsmDependent } : null,
    truncation: cov ? cov.kinds.map((k) => ({ id: k.id, north: k.truncationSignal.northGainPct,
      south: k.truncationSignal.southGainPct, affected: k.truncatedInOldPbf })) : null,
    runtimeOk, runtime: rq ? rq.summary : null,
    productionModified, protectedModified,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateOsmSharedSourceAudit().then((o) => {
    console.log(JSON.stringify(o, null, 2));
    process.exit(o.RESULT === 'PASS' ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
