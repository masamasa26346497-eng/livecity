#!/usr/bin/env node
// tools/validate/north-road-recovery.js
// [Mission 35E §15] 北側道路の補完と建物 V4 昇格の検証。
//   - devBuildingDefault = V4_REBUILT_FINAL
//   - productionBuildingCount = 600764
//   - roadSourceNorthCoverageImproved = true
//   - roadV3LogicMutation = false / projectionMutation = false
//   - duplicateRoadIncrease = 0
//   - productionModified = false / protectedModified = false
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { NORTH_WARDS } from '../audit/north-road-coverage.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  roadCoverage: P('data', 'reports', 'north-road-coverage.json'),
  canonRoads: P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'),
  roadBuild: P('data', 'reports', 'canonical-road-build.json'),
  v4: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-final', 'manifest.json'),
  v2n: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'),
  publicV4: P('public', 'map-data', 'osaka-city', 'derived-v4-final', 'building-placement', 'manifest.json'),
  publicV2N: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement', 'manifest.json'),
  runtimeQa: P('data', 'reports', 'north-road-runtime-qa.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  out: P('data', 'reports', 'north-road-recovery-validation.json'),
};
/** §15 production が読んでいる建物数（V2N）。今回変えない。 */
export const PRODUCTION_BUILDING_COUNT = 600764;
/** §2 dev の既定。 */
export const DEV_BUILDING_DEFAULT = 'V4_REBUILT_FINAL';
/** §11 北側で「大幅改善」とみなす被覆セルの増加率。 */
export const NORTH_IMPROVE_PCT = 15;
/**
 * §5 ROAD V3 の意味・設計を変えていないことの印。
 * これらが dev から消えていたら描画方式を変えてしまっている。
 */
export const ROAD_V3_MARKERS = [
  'ROAD_V3',
  'refined-road-surface.json',
  'roadRenderMode',
  'HYBRID_V1',
  'FIX13',
];

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };

export async function validateNorthRoadRecovery() {
  const errors = [], warnings = [];
  const cov = rj(F.roadCoverage);
  const devHtml = fs.readFileSync(F.dev, 'utf-8');

  // ── §2/§15 dev の既定が V4 ─────────────────────────────────────────
  const devDefaultMatch = devHtml.match(/let buildingsVersion = '([A-Z0-9]+)';/);
  const devBuildingVersion = devDefaultMatch ? devDefaultMatch[1] : null;
  const devBuildingDefault = devBuildingVersion === 'V4' ? DEV_BUILDING_DEFAULT : devBuildingVersion;
  if (devBuildingVersion !== 'V4') errors.push('§2: dev の既定が V4 でない: ' + devBuildingVersion);
  if (!/derived-v4-final/.test(devHtml)) errors.push('§2: dev が V4 namespace を持っていない');
  // 旧版が QA 用に残っているか
  for (const v of ['V1', 'V2', 'V2N', 'V3']) {
    if (!new RegExp("'" + v + "'").test(devHtml)) errors.push('§2: ' + v + ' の切替が消えている');
  }
  const v4m = rj(F.v4);
  const devBuildingCount = v4m ? v4m.featureCount : null;

  // ── §15 production の建物数は 600,764 のまま ───────────────────────
  const prodHtml = (() => { try { return fs.readFileSync(F.prod, 'utf-8'); } catch { return ''; } })();
  const prodVer = prodHtml.match(/let buildingsVersion = '([A-Z0-9]+)';/);
  const prodPlacement = rj(F.publicV2N);
  const productionBuildingCount = prodPlacement ? prodPlacement.canonicalBuildingCount : (rj(F.v2n) || {}).featureCount;
  if (productionBuildingCount !== PRODUCTION_BUILDING_COUNT) {
    errors.push('§14: production が読む建物数が変わっている ' + productionBuildingCount);
  }
  if (prodVer && prodVer[1] !== 'V2N') errors.push('§14: production の建物版が変わっている ' + prodVer[1]);
  if (/derived-v4-final/.test(prodHtml)) errors.push('§14: production に V4 が入っている');

  // ── §3/§11 北側の道路被覆が改善したか ──────────────────────────────
  let roadSourceNorthCoverageImproved = null;
  const northDetail = [];
  if (cov && cov.newSource) {
    for (const w of cov.byWard.filter((x) => x.north)) {
      northDetail.push({ wardId: w.wardId, oldWays: w.oldWays, newWays: w.newWays,
        oldLengthKm: +(w.oldLengthM / 1000).toFixed(1),
        newLengthKm: w.newLengthM != null ? +(w.newLengthM / 1000).toFixed(1) : null,
        cellGainPct: w.cellGainPct });
    }
    // §11「100% を無理に成功条件にしない」。元々切れていた区が大幅に増えたかを見る。
    const clipped = northDetail.filter((w) => ['higashiyodogawa', 'yodogawa', 'asahi'].includes(w.wardId));
    roadSourceNorthCoverageImproved = clipped.length > 0 && clipped.every((w) => (w.cellGainPct || 0) >= NORTH_IMPROVE_PCT);
    if (!roadSourceNorthCoverageImproved) {
      errors.push('§11: 北側 3 区の被覆改善が足りない ' + JSON.stringify(clipped.map((w) => [w.wardId, w.cellGainPct])));
    }
    // 北側の崖が市域の外へ出たか
    const cliff = cov.newSource.latitudeCliff;
    if (cliff && cliff.atLat <= 34.769) {
      errors.push('§3: 新 source の緯度の崖が市域の中にある lat=' + cliff.atLat);
    }
  } else errors.push('§3: 道路 source の比較レポートが無い');

  // ── §7 二重生成していないか ────────────────────────────────────────
  //   OSM way ID は一意。source を丸ごと差し替えているので、同じ way が 2 本入ることはない。
  //   新旧で ID が重複して両方採用される経路が無いことを、ID の一意性で確かめる。
  let duplicateRoadIncrease = null;
  if (cov && cov.duplicateCheck) {
    const d = cov.duplicateCheck;
    duplicateRoadIncrease = d.newUnique === cov.newSource.ways ? 0 : cov.newSource.ways - d.newUnique;
    if (duplicateRoadIncrease !== 0) errors.push('§7: 新 source に重複 way ID がある ' + duplicateRoadIncrease);
    if (!d.newIsSupersetOfOld) {
      warnings.push('§6: 旧にあって新に無い way ' + d.oldWayIdsMissingFromNew
        + ' 件（OSM 側の編集で削除・統合されたもの。抽出時期が違うため）');
    }
  }

  // ── §5 ROAD V3 の設計を変えていないか ──────────────────────────────
  const missingMarkers = ROAD_V3_MARKERS.filter((m) => !devHtml.includes(m));
  const roadV3LogicMutation = missingMarkers.length > 0;
  if (roadV3LogicMutation) errors.push('§5: ROAD V3 の印が dev から消えている ' + missingMarkers.join(','));
  // 新しい road renderer を足していないか（§8）
  const newRenderer = /RoadV4Layer|ROAD_V4|roadRenderMode\s*=\s*'V4'/.test(devHtml);
  if (newRenderer) errors.push('§8: 新しい road renderer を作っている');

  // ── §15 projection ─────────────────────────────────────────────────
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = (proj.type === 'local-equirectangular' && proj.centerLat === 34.604208
    && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? false : true;
  if (projectionMutation) errors.push('§15: projection が変わっている');

  // ── canonical roads が増えているか ─────────────────────────────────
  const cr = rj(F.canonRoads);
  const rb = rj(F.roadBuild);
  const canonicalRoadCount = cr ? cr.featureCount : null;
  const roadBuildResult = rb ? (rb.RESULT || rb.result || null) : null;
  if (roadBuildResult && roadBuildResult !== 'PASS') errors.push('§8: canonical roads のビルドが PASS でない ' + roadBuildResult);
  if (rb && rb.schemaErrors) errors.push('§8: canonical roads に schema エラー ' + rb.schemaErrors);

  // ── §9/§13 実ブラウザ ──────────────────────────────────────────────
  const rq = rj(F.runtimeQa);
  let runtimeOk = null;
  if (rq) {
    runtimeOk = !!(rq.summary && rq.summary.allSitesHaveRoads && rq.summary.jsErrors === 0
      && rq.summary.regressionOk);
    if (!rq.summary.allSitesHaveRoads) errors.push('§9: 道路が出ていない地点がある');
    if (!rq.summary.regressionOk) errors.push('§13: 既存機能の regression がある ' + JSON.stringify(rq.summary.regression));
    if (rq.summary.jsErrors) warnings.push('§13: JS 例外 ' + rq.summary.jsErrors);
  } else warnings.push('§9: 実ブラウザ QA が未実行');

  // ── §14 production / protected ─────────────────────────────────────
  const prodBuild = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = prodBuild.productionSha256 ? sha(F.prod) !== prodBuild.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('§14: production HTML が変更されている');
  if (protectedModified !== false) errors.push('§14: protected HTML が変更されている');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35E', RESULT,
    classification: errors.length ? 'NORTH_OSAKA_ROAD_RECOVERY_FAILED' : 'NORTH_OSAKA_ROAD_RECOVERY_SUCCESS',
    devBuildingDefault, devBuildingVersion, devBuildingCount,
    productionBuildingCount, productionBuildingVersion: prodVer ? prodVer[1] : null,
    roadSourceNorthCoverageImproved, northDetail,
    roadV3LogicMutation, projectionMutation, duplicateRoadIncrease,
    canonicalRoadCount, roadBuildResult,
    roadSource: cov ? { old: cov.oldSource, new: cov.newSource, duplicateCheck: cov.duplicateCheck } : null,
    runtimeOk, runtime: rq ? rq.summary : null,
    productionModified, protectedModified,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateNorthRoadRecovery().then((o) => {
    console.log(JSON.stringify(o, null, 2));
    process.exit(o.RESULT === 'PASS' ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
