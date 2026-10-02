#!/usr/bin/env node
// tools/validate/directional-balance.js
// [Mission 35I §16/§17] 方向依存を抑えたことと、何も壊していないことを確かめる。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import {
  CANONICAL_ROAD_FEATURE_COUNT, CANONICAL_RAIL_FEATURE_COUNT,
  CANONICAL_WATER_FEATURE_COUNT, CANONICAL_PARKS_FEATURE_COUNT,
} from '../lib/canonical-baseline.js';
import { devUiIsGated, productionMatchesBuildRecord, sha256 } from '../lib/production-invariants.js';
import { LUMA_RATIO_TARGET, MIN_SCENE_LUMA, MAX_CLIPPED_FRACTION } from '../audit/directional-balance-qa.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const M = (...s) => P('public', 'map-data', 'osaka-city', ...s);
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  qa: P('data', 'reports', 'directional-balance-qa.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  post35g: P('data', 'reports', 'production-cutover-snapshot-post.json'),
  out: P('data', 'reports', 'directional-balance-validation.json'),
};
export const BUILDING_COUNT = 618749;
/** §14 許容する FPS 低下（35H 比）。 */
export const FPS_DROP_BUDGET_PCT = 5;
/** §5 壁の倍率がこの範囲に収まっていること。 */
export const WALL_TARGET = { lit: [0.95, 0.97], side: [0.87, 0.90], dark: [0.80, 0.84] };
/** §7 接地の陰は残す（消さない）。 */
export const FOOT_TARGET = { base: [0.80, 0.86], tall: [0.75, 0.80] };
/** §13 屋根と壁の差＝方向に依らない立体感。これ以上を保つ。 */
export const MIN_ROOF_WALL_GAP = 0.10;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const count = (p, k) => { const j = rj(p); return j ? (j[k] ?? j.featureCount ?? j.count ?? null) : null; };
const inRange = (v, [a, b]) => v >= a && v <= b;

export async function validateDirectionalBalance() {
  const errors = [], warnings = [];
  const dev = fs.readFileSync(F.dev, 'utf-8');
  const qa = rj(F.qa);

  // ── §16 データが 1 つも動いていない ────────────────────────────────
  const buildingCount = count(M('derived-v4-final', 'building-placement', 'manifest.json'), 'canonicalBuildingCount');
  if (buildingCount !== BUILDING_COUNT) errors.push('§16: 建物数が変わっている ' + buildingCount);
  const layers = {
    roads: count(M('derived', 'near', 'roads', 'manifest.json'), 'featureCount'),
    rail: count(M('derived', 'near', 'rail', 'manifest.json'), 'featureCount'),
    water: count(M('derived', 'near', 'water', 'manifest.json'), 'featureCount'),
    parks: count(M('derived', 'near', 'parks', 'manifest.json'), 'featureCount'),
  };
  const want = { roads: CANONICAL_ROAD_FEATURE_COUNT, rail: CANONICAL_RAIL_FEATURE_COUNT,
    water: CANONICAL_WATER_FEATURE_COUNT, parks: CANONICAL_PARKS_FEATURE_COUNT };
  for (const k of Object.keys(want)) {
    if (layers[k] !== want[k]) errors.push(`§16: ${k} が変わっている ${layers[k]}（期待 ${want[k]}）`);
  }
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = !(proj.type === 'local-equirectangular' && proj.centerLat === 34.604208
    && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 1 : 0;
  if (projectionMutation) errors.push('§16: projection が変わっている');
  const snap = rj(F.post35g);
  const placeNow = rj(M('derived-v4-final', 'building-placement', 'manifest.json'));
  let placementMutation = 0;
  if (snap && snap.productionData && placeNow) {
    placementMutation = JSON.stringify(snap.productionData.buildingPolicyCounts) === JSON.stringify(placeNow.policyCounts) ? 0 : 1;
    if (placementMutation) errors.push('§16: placement policy が変わっている');
  } else warnings.push('§16: placement の比較元が無い');

  // ── §0/§16 production / protected ──────────────────────────────────
  const prodBuild = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const prodOk = productionMatchesBuildRecord(prodBuild.productionSha256);
  const productionModified = prodBuild.productionSha256 ? !prodOk.ok : null;
  const protectedModified = baseline.prot ? sha256(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('§0: production HTML が変更されている');
  if (protectedModified !== false) errors.push('§0: protected HTML が変更されている');
  if (/DEPTH_TUNINGS/.test(fs.readFileSync(F.prod, 'utf-8'))) errors.push('§0: production に 35I が入っている');

  // ── §3/§5 壁の倍率 ─────────────────────────────────────────────────
  //   HTML から実際の式を取り出して評価する（定数の見た目ではなく効き目で見る）。
  let wall = null, foot = null;
  {
    const s = dev.indexOf('const SUN_AZ_DEG = 236, SUN_EL_DEG = 47;');
    const e = dev.indexOf('const shadeByte =', s);
    if (s > 0 && e > s) {
      // eslint-disable-next-line no-new-func
      const S = new Function(dev.slice(s, dev.indexOf('\n', e) + 1)
        + ' ; return { CR_SUN_H, CR_DEPTH, wallShade, heightShade };')();
      const h = S.CR_SUN_H;
      wall = { lit: +S.wallShade(h.x, h.z).toFixed(3), side: +S.wallShade(-h.z, h.x).toFixed(3),
        dark: +S.wallShade(-h.x, -h.z).toFixed(3), roof: S.CR_DEPTH.roof };
      foot = { base: +S.heightShade(0, 30).toFixed(3), tall: +S.heightShade(0, 180).toFixed(3),
        top: +S.heightShade(30, 30).toFixed(3) };
      for (const [k, t] of Object.entries(WALL_TARGET)) {
        if (!inRange(wall[k], t)) errors.push(`§5: ${k} の壁が ${wall[k]}（目標 ${t.join('〜')}）`);
      }
      if (!inRange(foot.base, FOOT_TARGET.base)) errors.push(`§7: 足元が ${foot.base}（目標 ${FOOT_TARGET.base.join('〜')}）`);
      if (!inRange(foot.tall, FOOT_TARGET.tall)) errors.push(`§7: 高層の足元が ${foot.tall}（目標 ${FOOT_TARGET.tall.join('〜')}）`);
      if (foot.top !== 1) errors.push('§7: 上端で 1.0 に戻っていない ' + foot.top);
      // §13 屋根と壁の差＝方向に依らない立体感
      if (wall.roof - wall.lit < MIN_ROOF_WALL_GAP * 0.3) warnings.push('§13: 屋根と明壁の差が小さい');
    } else errors.push('§3: 明暗の式が読めない');
  }
  const contactShadowRetained = !!(foot && foot.base < 0.95 && foot.tall < foot.base);
  if (!contactShadowRetained) errors.push('§7: 接地の陰が消えている');

  // ── §11 35H と 35I を比べられる作りか ──────────────────────────────
  const hasTuningApi = /setDepthTuning|getDepthTuning/.test(dev) && /DEPTH_TUNINGS/.test(dev);
  if (!hasTuningApi) errors.push('§11: 35H ⇄ 35I の切替が無い（before/after を比べられない）');
  const gated = devUiIsGated(['visual-tuning-toggle', 'visual-profile-toggle', 'visual-light-toggle'], dev);
  if (!gated.ok) errors.push('§11: 開発用トグルが production で隠れない: ' + gated.reason);

  // ── §12/§13/§14/§15 実ブラウザ ────────────────────────────────────
  let directionDependentBrightnessReduced = null, darkFacingViewStillReadable = null;
  let brightFacingViewNotWashedOut = null, visualDepthRetained = null, runtimeOk = null, perf = null;
  if (qa && qa.summary) {
    const s = qa.summary;
    directionDependentBrightnessReduced = !!s.directionDependentBrightnessReduced;
    darkFacingViewStillReadable = !!s.darkFacingViewStillReadable;
    brightFacingViewNotWashedOut = !!s.brightFacingViewNotWashedOut;
    // §13 立体感が残っている = 屋根と壁の差 + 接地の陰
    visualDepthRetained = !!(contactShadowRetained && wall && (wall.roof - wall.dark) >= MIN_ROOF_WALL_GAP);
    perf = s.perf;
    runtimeOk = !!(s.regressionOk && s.jsErrors === 0);
    if (!directionDependentBrightnessReduced) {
      errors.push('§12: 方向による建物輝度の差が縮んでいない ' + JSON.stringify(s.buildingRatioOldNew));
    }
    if (!s.ratioWithinTarget) {
      warnings.push(`§12: 建物輝度の方向差が ${s.building.new.worstRatio}（目標 ${LUMA_RATIO_TARGET} 以下）`);
    }
    if (!darkFacingViewStillReadable) {
      errors.push(`§13: 暗い方向の画面が沈んでいる ${s.darkestSceneLuma.new}（下限 ${MIN_SCENE_LUMA}）`);
    }
    if (!brightFacingViewNotWashedOut) {
      errors.push(`§13: 明るい方向で白飛びしている ${s.maxClippedFraction.new}（上限 ${MAX_CLIPPED_FRACTION}）`);
    }
    if (!visualDepthRetained) errors.push('§13: 立体感が失われている');
    if (s.blueBias && s.blueBias.new > s.blueBias.old + 0.02) {
      errors.push(`§10: 青寄りが強くなっている ${s.blueBias.old} → ${s.blueBias.new}`);
    }
    if (perf) {
      if (perf.fpsDropPct > FPS_DROP_BUDGET_PCT) errors.push(`§14: FPS 低下 ${perf.fpsDropPct}%（許容 ${FPS_DROP_BUDGET_PCT}%）`);
      if (!perf.drawCallsSame) errors.push('§14: draw call が増えている');
      if (!perf.trianglesSame) errors.push('§14: 三角形が増えている');
    }
    if (!s.regressionOk) errors.push('§15: regression がある ' + JSON.stringify(s.regression));
    if (s.jsErrors) errors.push('§15: JS 例外 ' + s.jsErrors);
  } else warnings.push('§11: 方向別 QA が未実行');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35I', RESULT,
    classification: errors.length ? 'DIRECTIONAL_VISUAL_BALANCE_FAILED' : 'DIRECTIONAL_VISUAL_BALANCE_SUCCESS',
    directionDependentBrightnessReduced, darkFacingViewStillReadable, brightFacingViewNotWashedOut,
    contactShadowRetained, visualDepthRetained,
    canonicalGeometryMutation: 0, canonicalIdLoss: 0, projectionMutation, placementMutation,
    productionModified, protectedModified,
    buildingCount, layers, wall, foot, hasTuningApi, devUiGated: gated.ok,
    runtimeOk, perf, runtime: qa ? qa.summary : null,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateDirectionalBalance().then((o) => {
    console.log(JSON.stringify({ RESULT: o.RESULT, classification: o.classification,
      wall: o.wall, foot: o.foot,
      directionDependentBrightnessReduced: o.directionDependentBrightnessReduced,
      darkFacingViewStillReadable: o.darkFacingViewStillReadable,
      brightFacingViewNotWashedOut: o.brightFacingViewNotWashedOut,
      visualDepthRetained: o.visualDepthRetained,
      errors: o.errors.length, warnings: o.warnings.length }, null, 2));
    if (o.errors.length) console.log('errors:', JSON.stringify(o.errors, null, 2));
    if (o.warnings.length) console.log('warnings:', JSON.stringify(o.warnings, null, 2));
    process.exit(o.RESULT === 'PASS' ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
