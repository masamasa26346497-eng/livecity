#!/usr/bin/env node
// tools/validate/v4-production-cutover.js
// [Mission 35G §11/§12] production を V4 へ昇格した結果を検証する。
//   canonicalPlateauGeometryMutation / existingCanonicalIdLoss / projectionMutation
//   roadV3LogicMutation / duplicate*Increase / protectedModified
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import {
  CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT,
  CANONICAL_RAIL_FEATURE_COUNT, CANONICAL_WATER_FEATURE_COUNT,
  CANONICAL_PARKS_FEATURE_COUNT, CANONICAL_STATION_COUNT,
} from '../lib/canonical-baseline.js';
import { ROAD_V3_MARKERS } from './north-road-recovery.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const M = (...s) => P('public', 'map-data', 'osaka-city', ...s);
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  pre: P('data', 'reports', 'production-cutover-snapshot-pre.json'),
  post: P('data', 'reports', 'production-cutover-snapshot-post.json'),
  inventory: P('data', 'reports', 'production-shared-data-inventory.json'),
  qa: P('data', 'reports', 'v4-production-qa.json'),
  dup: P('data', 'reports', 'shared-layer-duplicate-audit.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  canonV2N: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  canonV4: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-final'),
  out: P('data', 'reports', 'v4-production-cutover-validation.json'),
};
/** §12 cutover 後の production が読むべき建物数。 */
export const PRODUCTION_BUILDING_COUNT_AFTER = 618749;
/** cutover 前（35F まで）の production 建物数。 */
export const PRODUCTION_BUILDING_COUNT_BEFORE = 600764;
/** 35D が足した棟数。 */
export const RECOVERED_BUILDINGS = 17985;
/** PLATEAU canonical の棟数（V2N / V4 で変わってはいけない）。 */
export const PLATEAU_BUILDING_COUNT = 574112;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };

/**
 * §11 既存 canonicalId が V4 で失われていないか、
 * かつ PLATEAU の geometry が書き換わっていないかを **実データで** 確かめる。
 * 全 60 万件の geometry 比較は重いので、タイル単位で全件 id を突き合わせ、
 * geometry は決定的に選んだ標本で厳密比較する。
 */
export function compareCanonicalSets(dirOld, dirNew, sampleEveryNth = 37) {
  const tiles = fs.readdirSync(dirOld).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f)).sort();
  let oldIds = 0, lost = 0, added = 0, sampled = 0, geomDiff = 0;
  const lostSamples = [], geomSamples = [];
  let n = 0;
  for (const f of tiles) {
    const a = rj(path.join(dirOld, f)); if (!a) continue;
    const b = rj(path.join(dirNew, f)) || { features: [] };
    const bm = new Map();
    for (const ft of (b.features || [])) bm.set(ft.canonicalId, ft);
    for (const ft of (a.features || [])) {
      oldIds++;
      const t = bm.get(ft.canonicalId);
      if (!t) { lost++; if (lostSamples.length < 20) lostSamples.push(ft.canonicalId); continue; }
      if ((n++ % sampleEveryNth) !== 0) continue;
      sampled++;
      if (JSON.stringify(t.coordinates) !== JSON.stringify(ft.coordinates)) {
        geomDiff++; if (geomSamples.length < 20) geomSamples.push(ft.canonicalId);
      }
    }
  }
  // 新しい側は **新しい側のタイル全部** を数える。
  //   古い側のタイル名で回すと、V4 で増えた北側のタイル（V2N に無い）を数え落とす。
  //   建物はタイルを跨がない（1 棟 1 タイル）ので、行数と一意 id が一致するはず＝
  //   ここが食い違えば重複。
  let newRows = 0;
  const newIdSet = new Set();
  for (const f of fs.readdirSync(dirNew).filter((x) => /^tile_-?\d+_-?\d+\.json$/.test(x))) {
    const b = rj(path.join(dirNew, f)); if (!b) continue;
    const a = rj(path.join(dirOld, f)) || { features: [] };
    const am = new Set((a.features || []).map((x) => x.canonicalId));
    for (const ft of (b.features || [])) {
      newRows++; newIdSet.add(ft.canonicalId);
      if (!am.has(ft.canonicalId)) added++;
    }
  }
  return { oldIds, newIds: newIdSet.size, newRows, duplicateRows: newRows - newIdSet.size,
    lost, added, sampled, geomDiff, lostSamples, geomSamples };
}

export async function validateV4ProductionCutover({ fast = false } = {}) {
  const errors = [], warnings = [];
  const pre = rj(F.pre), post = rj(F.post), inv = rj(F.inventory), qa = rj(F.qa), dup = rj(F.dup);
  const prodHtml = fs.readFileSync(F.prod, 'utf-8');
  const devHtml = fs.readFileSync(F.dev, 'utf-8');

  // ── §12 production の期待状態 ───────────────────────────────────────
  const pv = (prodHtml.match(/let buildingsVersion = '([A-Z0-9]+)';/) || [])[1] || null;
  const profile = (prodHtml.match(/const LIVECITY_BUILD_PROFILE = '(\w+)';/) || [])[1] || null;
  if (pv !== 'V4') errors.push('§12: production の建物版が V4 でない: ' + pv);
  if (profile !== 'production') errors.push('§5: production の build profile が production でない: ' + profile);
  const placement = rj(M('derived-v4-final', 'building-placement', 'manifest.json'));
  const productionBuildingCount = placement ? placement.canonicalBuildingCount : null;
  if (productionBuildingCount !== PRODUCTION_BUILDING_COUNT_AFTER) {
    errors.push('§12: production の建物数が ' + productionBuildingCount);
  }

  // ── §5 HTML は dev からプロファイル 1 行だけ変えたもの ───────────────
  const DEV_LINE = "const LIVECITY_BUILD_PROFILE = 'development';";
  const PROD_LINE = "const LIVECITY_BUILD_PROFILE = 'production';";
  const rebuilt = devHtml.replace(DEV_LINE, PROD_LINE);
  const productionMatchesDev = rebuilt === prodHtml;
  if (!productionMatchesDev) errors.push('§5: production が dev からプロファイル 1 行だけの変換になっていない');

  // ── §11 canonical PLATEAU geometry / canonicalId ───────────────────
  let canonicalPlateauGeometryMutation = null, existingCanonicalIdLoss = null, setCompare = null;
  if (!fast) {
    setCompare = compareCanonicalSets(F.canonV2N, F.canonV4);
    existingCanonicalIdLoss = setCompare.lost;
    canonicalPlateauGeometryMutation = setCompare.geomDiff;
    if (setCompare.lost !== 0) errors.push('§11: 既存 canonicalId が失われている ' + setCompare.lost);
    if (setCompare.geomDiff !== 0) errors.push('§11: 既存 geometry が書き換わっている ' + setCompare.geomDiff);
    if (setCompare.added !== RECOVERED_BUILDINGS) {
      warnings.push(`§11: 足した棟数が ${setCompare.added}（35D の ${RECOVERED_BUILDINGS} と違う）`);
    }
  }

  // ── §11 projection / ROAD V3 ────────────────────────────────────────
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = !(proj.type === 'local-equirectangular' && proj.centerLat === 34.604208
    && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320);
  if (projectionMutation) errors.push('§11: projection が変わっている');
  const missingMarkers = ROAD_V3_MARKERS.filter((x) => !prodHtml.includes(x));
  const roadV3LogicMutation = missingMarkers.length > 0;
  if (roadV3LogicMutation) errors.push('§11: production から ROAD V3 の印が消えている ' + missingMarkers.join(','));

  // ── §11 重複（35F の監査結果をそのまま使う。今回データは作り直していない） ─
  const d = dup && dup.duplicates ? dup.duplicates : null;
  const duplicateRailIncrease = d ? d.rail : null;
  const duplicateWaterIncrease = d ? d.water : null;
  const duplicateParkIncrease = d ? d.parks : null;
  // 建物はタイルを跨がないので、タイル行数と一意 canonicalId 数が一致するはず。
  //   食い違った分が重複（鉄道・水域のようなタイル跨ぎは建物には無い）。
  const duplicateBuildingIncrease = setCompare ? setCompare.duplicateRows : null;
  if (setCompare && productionBuildingCount != null && setCompare.newIds !== productionBuildingCount) {
    errors.push(`§12: canonical の一意 id ${setCompare.newIds} と placement の ${productionBuildingCount} が合わない`);
  }
  for (const [k, v] of [['rail', duplicateRailIncrease], ['water', duplicateWaterIncrease],
    ['park', duplicateParkIncrease], ['building', duplicateBuildingIncrease]]) {
    if (v == null) warnings.push('§11: ' + k + ' の重複確認が無い');
    else if (v !== 0) errors.push('§11: ' + k + ' に重複が増えている ' + v);
  }

  // ── §11 protected ───────────────────────────────────────────────────
  const baseline = rj(F.baseline) || {};
  const protNow = sha(F.prot);
  const protectedModified = baseline.prot ? protNow !== baseline.prot : null;
  if (protectedModified !== false) errors.push('§11: protected HTML が変更されている');
  if (pre && pre.protectedHtml && post && post.protectedHtml
    && pre.protectedHtml.sha256 !== post.protectedHtml.sha256) {
    errors.push('§11: cutover 前後で protected の hash が変わっている');
  }

  // ── §4 building-facts が V4 namespace にあるか ──────────────────────
  const factsTiles = (() => { try { return fs.readdirSync(M('derived-v4-final', 'building-facts')).filter((f) => /^tile_/.test(f)).length; } catch { return 0; } })();
  if (!factsTiles) errors.push('§4: V4 に building-facts が無い（card の高さ・階数が全棟で消える）');

  // ── §6 復旧済みレイヤーが 35F の状態のまま ──────────────────────────
  const layerNow = {
    roads: (rj(M('derived', 'near', 'roads', 'manifest.json')) || {}).featureCount ?? null,
    rail: (rj(M('derived', 'near', 'rail', 'manifest.json')) || {}).featureCount ?? null,
    stations: (rj(M('derived', 'rail-stations.json')) || {}).count ?? null,
    water: (rj(M('derived', 'near', 'water', 'manifest.json')) || {}).featureCount ?? null,
    parks: (rj(M('derived', 'near', 'parks', 'manifest.json')) || {}).featureCount ?? null,
    refinedRoadSurface: (rj(P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json')) || {}).indexedCount ?? null,
  };
  const layerExpect = {
    roads: CANONICAL_ROAD_FEATURE_COUNT, rail: CANONICAL_RAIL_FEATURE_COUNT,
    stations: CANONICAL_STATION_COUNT, water: CANONICAL_WATER_FEATURE_COUNT,
    parks: CANONICAL_PARKS_FEATURE_COUNT, refinedRoadSurface: REFINED_ROAD_SURFACE_INDEXED_COUNT,
  };
  const recoveredLayersPreserved = Object.keys(layerExpect).every((k) => layerNow[k] === layerExpect[k]);
  if (!recoveredLayersPreserved) {
    errors.push('§6: 復旧済みレイヤーが 35F の状態でない ' + JSON.stringify(layerNow));
  }

  // ── §7/§9/§10/§14 実ブラウザ ───────────────────────────────────────
  let runtimeOk = null;
  if (qa && qa.summary) {
    const s = qa.summary;
    runtimeOk = !!(s.buildingsVersion === 'V4' && s.buildProfile === 'production'
      && s.allSitesHaveBuildings && s.allSitesHaveRoads && s.allSitesCardOk
      && s.devUiHidden && s.regressionOk && s.brilliaOk && s.jsErrors === 0);
    if (s.buildingsVersion !== 'V4') errors.push('§12: 実ブラウザの建物版が ' + s.buildingsVersion);
    if (s.buildProfile !== 'production') errors.push('§5: 実ブラウザの profile が ' + s.buildProfile);
    if (!s.allSitesHaveBuildings) errors.push('§7: 建物が出ていない地点がある');
    if (!s.allSitesHaveRoads) errors.push('§7: 道路が出ていない地点がある');
    if (!s.allSitesCardOk) errors.push('§9: property card が出ない地点がある');
    if (!s.devUiHidden) errors.push('§5: 開発用 UI が production で見えている ' + JSON.stringify(s.devUiVisible));
    if (!s.regressionOk) errors.push('§9: regression がある ' + JSON.stringify(s.regression));
    if (!s.brilliaOk) errors.push('§8: Brillia 相当の建物が確認できない');
    if (s.jsErrors) errors.push('§9: JS 例外 ' + s.jsErrors);
    if (!s.sitesWithHeight) errors.push('§4: card に高さが 1 地点も出ていない（facts 未読込の疑い）');
    if (qa.fetchAudit && qa.fetchAudit.v1Buildings) errors.push('§11: V1 建物を読んでいる ' + qa.fetchAudit.v1Buildings);
  } else warnings.push('§14: 実ブラウザ QA が未実行');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35G', RESULT,
    classification: errors.length ? 'CITYWIDE_V4_PRODUCTION_CUTOVER_FAILED' : 'CITYWIDE_V4_PRODUCTION_CUTOVER_SUCCESS',
    productionBuildingsVersion: pv, productionBuildProfile: profile,
    productionBuildingCount,
    productionBuildingCountBefore: pre && pre.productionData ? pre.productionData.buildingCount : null,
    productionMatchesDev,
    canonicalPlateauGeometryMutation, existingCanonicalIdLoss, setCompare,
    projectionMutation, roadV3LogicMutation,
    duplicateBuildingIncrease, duplicateRailIncrease, duplicateWaterIncrease, duplicateParkIncrease,
    protectedModified, protectedSha256: protNow,
    buildingFactsTilesV4: factsTiles,
    recoveredLayersPreserved, layerNow, layerExpect,
    sharedDataInventory: inv ? { shared: inv.shared, separate: inv.separate, devOnly: inv.devOnly } : null,
    runtimeOk, runtime: qa ? qa.summary : null,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateV4ProductionCutover({ fast: process.argv.includes('--fast') }).then((o) => {
    console.log(JSON.stringify({ RESULT: o.RESULT, classification: o.classification,
      buildings: o.productionBuildingCount, before: o.productionBuildingCountBefore,
      idLoss: o.existingCanonicalIdLoss, geomMutation: o.canonicalPlateauGeometryMutation,
      protectedModified: o.protectedModified, errors: o.errors.length, warnings: o.warnings.length }, null, 2));
    if (o.errors.length) console.log('errors:', JSON.stringify(o.errors, null, 2));
    if (o.warnings.length) console.log('warnings:', JSON.stringify(o.warnings, null, 2));
    process.exit(o.RESULT === 'PASS' ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
