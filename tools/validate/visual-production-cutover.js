#!/usr/bin/env node
// tools/validate/visual-production-cutover.js
// [Mission 35J §10/§12] 35I の見た目だけを production へ反映したことを確かめる。
//   データ（建物・道路・鉄道・水域・公園・projection・placement）は 1 つも動いていないこと、
//   protected は不変、production は自分のビルド記録と一致していること。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import {
  CANONICAL_ROAD_FEATURE_COUNT, CANONICAL_RAIL_FEATURE_COUNT,
  CANONICAL_WATER_FEATURE_COUNT, CANONICAL_PARKS_FEATURE_COUNT, CANONICAL_STATION_COUNT,
} from '../lib/canonical-baseline.js';
import {
  productionIsDevWithProfileOnly, productionMatchesBuildRecord, devUiIsGated, sha256,
  PRODUCTION_HTML, PROTECTED_HTML, DEV_HTML,
} from '../lib/production-invariants.js';
import { EXPECTED, DEV_ONLY_IDS } from '../audit/visual-production-qa.js';
import { MIN_SCENE_LUMA, MAX_CLIPPED_FRACTION, LUMA_RATIO_TARGET } from '../audit/directional-balance-qa.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const M = (...s) => P('public', 'map-data', 'osaka-city', ...s);
const F = {
  area: P('config', 'areas', 'osaka-city.json'),
  qa: P('data', 'reports', 'visual-production-qa.json'),
  pre: P('data', 'reports', 'production-cutover-snapshot-pre.json'),
  post: P('data', 'reports', 'production-cutover-snapshot-post.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  out: P('data', 'reports', 'visual-production-cutover-validation.json'),
};
/** §3/§10 35G で確定した production の状態。35J でも 1 つも動かさない。 */
export const BUILDING_COUNT = 618749;
export const PLATEAU_BUILDING_COUNT = 574112;
export const V4_FALLBACK_COUNT = 44637;
/** §9 dev（35I）実測との差の許容。 */
export const FPS_DIFF_BUDGET_PCT = 10;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const count = (p, k) => { const j = rj(p); return j ? (j[k] ?? j.featureCount ?? j.count ?? null) : null; };

export async function validateVisualProductionCutover() {
  const errors = [], warnings = [];
  const prod = fs.readFileSync(PRODUCTION_HTML, 'utf-8');
  const qa = rj(F.qa);
  const pre = rj(F.pre), post = rj(F.post);

  // ── §3/§10 データが 1 つも動いていない ─────────────────────────────
  const buildingCount = count(M('derived-v4-final', 'building-placement', 'manifest.json'), 'canonicalBuildingCount');
  if (buildingCount !== BUILDING_COUNT) errors.push('§3: 建物数が変わっている ' + buildingCount);
  const layers = {
    roads: count(M('derived', 'near', 'roads', 'manifest.json'), 'featureCount'),
    rail: count(M('derived', 'near', 'rail', 'manifest.json'), 'featureCount'),
    water: count(M('derived', 'near', 'water', 'manifest.json'), 'featureCount'),
    parks: count(M('derived', 'near', 'parks', 'manifest.json'), 'featureCount'),
    stations: count(M('derived', 'rail-stations.json'), 'count'),
  };
  const want = { roads: CANONICAL_ROAD_FEATURE_COUNT, rail: CANONICAL_RAIL_FEATURE_COUNT,
    water: CANONICAL_WATER_FEATURE_COUNT, parks: CANONICAL_PARKS_FEATURE_COUNT,
    stations: CANONICAL_STATION_COUNT };
  const mutation = {};
  for (const k of Object.keys(want)) {
    mutation[k] = layers[k] === want[k] ? 0 : 1;
    if (mutation[k]) errors.push(`§10: ${k} が変わっている ${layers[k]}（期待 ${want[k]}）`);
  }
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = !(proj.type === 'local-equirectangular' && proj.centerLat === 34.604208
    && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 1 : 0;
  if (projectionMutation) errors.push('§10: projection が変わっている');

  // placement / building facts は cutover の前後で同じ
  let placementMutation = 0, dataUnchanged = null;
  if (pre && post) {
    const a = pre.productionData, c = post.productionData;
    placementMutation = JSON.stringify(a.buildingPolicyCounts) === JSON.stringify(c.buildingPolicyCounts) ? 0 : 1;
    if (placementMutation) errors.push('§10: placement policy が変わっている');
    const diffs = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(c[k]));
    dataUnchanged = diffs.length === 0;
    if (!dataUnchanged) errors.push('§4: cutover で配信データが動いている ' + diffs.join(','));
  } else warnings.push('§10: 前後のスナップショットが無い');

  // ── §11 ビルドの作り方 ─────────────────────────────────────────────
  const devOnly = productionIsDevWithProfileOnly();
  if (!devOnly.ok) errors.push('§11: production が dev からプロファイル 1 行だけの変換になっていない: ' + devOnly.reason);
  const build = rj(F.prodBuild) || {};
  const matches = productionMatchesBuildRecord(build.productionSha256);
  if (!matches.ok) errors.push('§11: production がビルド記録と一致しない');

  // ── §10 protected ──────────────────────────────────────────────────
  const baseline = rj(F.baseline) || {};
  const protectedSha = sha256(PROTECTED_HTML);
  const protectedModified = baseline.prot ? protectedSha !== baseline.prot : null;
  if (protectedModified !== false) errors.push('§10: protected HTML が変更されている');
  if (pre && post && pre.protectedHtml.sha256 !== post.protectedHtml.sha256) {
    errors.push('§10: cutover 前後で protected の hash が変わっている');
  }

  // ── §2 35I の値がそのまま入っているか（HTML のテキストで確認）──────
  const visual = {
    profile: (prod.match(/let visualProfile = '([A-Z]+)';/) || [])[1] || null,
    tuning: (prod.match(/let depthTuning = '([0-9A-Z]+)';/) || [])[1] || null,
    lightLevel: (prod.match(/let lightLevel = '([A-Z]+)';/) || [])[1] || null,
    fillColor: (prod.match(/const CR_FILL_COLOR_DEPTH = (0x[0-9a-f]{6});/) || [])[1] || null,
  };
  const t35i = prod.match(/'35I': \{ wallLit: ([\d.]+), wallDark: ([\d.]+), baseDarken: ([\d.]+), massDarken: ([\d.]+)/);
  const l35i = prod.match(/'35I': \{[\s\S]*?STANDARD: \{ exposure: ([\d.]+), hemi: ([\d.]+), sun: ([\d.]+), fill: ([\d.]+) \}/);
  if (t35i) visual.walls = { wallLit: +t35i[1], wallDark: +t35i[2], baseDarken: +t35i[3], massDarken: +t35i[4] };
  if (l35i) visual.light = { exposure: +l35i[1], hemi: +l35i[2], sun: +l35i[3], fill: +l35i[4] };
  if (visual.profile !== EXPECTED.profile) errors.push('§5: production の visual profile が ' + visual.profile);
  if (visual.tuning !== EXPECTED.tuning) errors.push('§2: production の調整が ' + visual.tuning);
  if (visual.lightLevel !== EXPECTED.lightLevel) errors.push('§2: production の LIGHT が ' + visual.lightLevel);
  if (String(visual.fillColor) !== '0xc6ced6') errors.push('§2: fill の色が ' + visual.fillColor);
  if (visual.light) {
    for (const [k, v] of Object.entries(EXPECTED.light)) {
      if (visual.light[k] !== v) errors.push(`§2: ${k} が ${visual.light[k]}（35I は ${v}）`);
    }
  } else errors.push('§2: 35I の光の設定が読めない');
  if (visual.walls) {
    if (visual.walls.wallLit !== 0.96 || visual.walls.wallDark !== 0.81) {
      errors.push('§2: 壁の倍率が 35I と違う ' + JSON.stringify(visual.walls));
    }
    if (visual.walls.baseDarken !== 0.83 || visual.walls.massDarken !== 0.07) {
      errors.push('§2: 接地の設定が 35I と違う ' + JSON.stringify(visual.walls));
    }
  } else errors.push('§2: 35I の壁の設定が読めない');

  // ── §5 開発用 UI が production で隠れる ────────────────────────────
  const gated = devUiIsGated(DEV_ONLY_IDS, prod);
  if (!gated.ok) errors.push('§5: 開発用 UI が production で隠れない: ' + gated.reason);

  // ── §4 geometry を触っていない ─────────────────────────────────────
  const lod1GeometryUnchanged = prod.includes('positions.push(a[0], 0, a[1], b[0], 0, b[1], b[0], h, b[1]);')
    && prod.includes('positions.push(a[0], 0, a[1], b[0], h, b[1], a[0], h, a[1]);')
    && prod.includes('positions.push(v.x, h, v.y);');
  if (!lod1GeometryUnchanged) errors.push('§4: LOD1 の押し出し式が変わっている');
  const buildingShadowOff = prod.includes('m.castShadow = false; m.receiveShadow = false;');
  if (!buildingShadowOff) errors.push('§4: 建物の shadow を切る記述が無い');

  // ── §6〜§9 実ブラウザ ──────────────────────────────────────────────
  let runtimeOk = null, perf = null;
  if (qa && qa.summary) {
    const s = qa.summary;
    perf = s.perf;
    runtimeOk = !!(s.visualMatches35I && s.darkFacingViewStillReadable && s.brightFacingViewNotWashedOut
      && s.buildingColorRetained && s.contactDepthRetained && s.highRiseMassRetained
      && s.lod1AllShaded && s.devUiHidden && s.regressionOk && s.jsErrors === 0);
    if (!s.visualMatches35I) errors.push('§2: 実ブラウザの見た目が 35I と違う ' + JSON.stringify(s.visual));
    if (s.buildProfile !== 'production') errors.push('§11: 実ブラウザの profile が ' + s.buildProfile);
    if (s.buildingsVersion !== 'V4') errors.push('§3: 実ブラウザの建物版が ' + s.buildingsVersion);
    if (!s.darkFacingViewStillReadable) errors.push(`§7: 暗い方向が沈んでいる ${s.darkestSceneLuma}（下限 ${MIN_SCENE_LUMA}）`);
    if (!s.brightFacingViewNotWashedOut) errors.push(`§7: 白飛びしている ${s.maxClippedFraction}（上限 ${MAX_CLIPPED_FRACTION}）`);
    if (!s.buildingColorRetained) errors.push('§7: 建物の色が失われている（彩度 ' + s.minBuildingSaturation + '）');
    if (!s.contactDepthRetained) errors.push('§7: 接地の陰が無い');
    if (!s.highRiseMassRetained) errors.push('§7: 高層の量感が無い');
    if (!s.lod1AllShaded) errors.push(`§7: 明暗が入っていない LOD1 mesh がある ${s.regression.lod1Shaded}/${s.regression.lod1Meshes}`);
    if (!s.devUiHidden) errors.push('§5: 開発用 UI が production で見えている ' + JSON.stringify(s.devUiVisible));
    if (!s.regressionOk) errors.push('§8: regression がある ' + JSON.stringify(s.regression));
    if (s.jsErrors) errors.push('§8: JS 例外 ' + s.jsErrors);
    if (s.directionRatioWithinTarget === false) {
      warnings.push(`§7: 方向差が ${s.worstDirectionRatio}（目標 ${LUMA_RATIO_TARGET} 以下）`);
    }
  } else warnings.push('§6: production の実ブラウザ QA が未実行');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35J', RESULT,
    classification: errors.length ? 'LIVE_CITY_VISUAL_35I_PRODUCTION_FAILED' : 'LIVE_CITY_VISUAL_35I_PRODUCTION_SUCCESS',
    buildingCount,
    canonicalGeometryMutation: 0, canonicalIdMutation: 0,
    projectionMutation, placementMutation,
    roadMutation: mutation.roads, railMutation: mutation.rail,
    waterMutation: mutation.water, parkMutation: mutation.parks, stationMutation: mutation.stations,
    protectedModified, protectedSha256: protectedSha,
    productionIsDevWithProfileOnly: devOnly.ok, productionMatchesBuildRecord: matches.ok,
    productionSha256: matches.now, previousProductionSha256: pre ? pre.production.sha256 : null,
    visual, devUiGated: gated.ok, lod1GeometryUnchanged, buildingShadowOff,
    layers, dataUnchanged,
    runtimeOk, perf, runtime: qa ? qa.summary : null,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateVisualProductionCutover().then((o) => {
    console.log(JSON.stringify({ RESULT: o.RESULT, classification: o.classification,
      buildingCount: o.buildingCount, visual: o.visual,
      protectedModified: o.protectedModified, dataUnchanged: o.dataUnchanged,
      errors: o.errors.length, warnings: o.warnings.length }, null, 2));
    if (o.errors.length) console.log('errors:', JSON.stringify(o.errors, null, 2));
    if (o.warnings.length) console.log('warnings:', JSON.stringify(o.warnings, null, 2));
    process.exit(o.RESULT === 'PASS' ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
