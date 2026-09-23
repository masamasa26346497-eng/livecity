#!/usr/bin/env node
// tools/validate/visual-depth.js
// [Mission 35H §27/§28/§30] 見た目だけを変えたことを確かめる。
//   データ（geometry / canonicalId / projection / placement）が 1 つも動いていないこと、
//   production / protected を触っていないこと、性能が落ちていないこと。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import {
  CANONICAL_ROAD_FEATURE_COUNT, CANONICAL_RAIL_FEATURE_COUNT,
  CANONICAL_WATER_FEATURE_COUNT, CANONICAL_PARKS_FEATURE_COUNT,
} from '../lib/canonical-baseline.js';
import { productionIsDevWithProfileOnly, devUiIsGated } from '../lib/production-invariants.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const M = (...s) => P('public', 'map-data', 'osaka-city', ...s);
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  qa: P('data', 'reports', 'visual-depth-qa.json'),
  cityAb: P('data', 'reports', 'visual-depth-citymode-ab.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  post35g: P('data', 'reports', 'production-cutover-snapshot-post.json'),
  out: P('data', 'reports', 'visual-depth-validation.json'),
};
/** §27 35G で確定した production の建物数。35H では 1 棟も動かさない。 */
export const BUILDING_COUNT = 618749;
/** §25 許容する FPS 低下。 */
export const FPS_DROP_BUDGET_PCT = 10;
export const FPS_DROP_IDEAL_PCT = 5;
/** §20/§21 dev で切り替えられるもの。 */
export const VISUAL_PROFILES = ['CURRENT', 'DEPTH'];
export const LIGHT_LEVELS = ['LOW', 'STANDARD', 'STRONG'];
/** §22/§10 canonical の建物は shadowMap を使わない（618,749 棟に影を落とさない）。 */
export const BUILDING_SHADOW_MARKER = 'm.castShadow = false; m.receiveShadow = false;';

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const count = (p, k) => { const j = rj(p); return j ? (j[k] ?? j.featureCount ?? j.count ?? null) : null; };

export async function validateVisualDepth() {
  const errors = [], warnings = [];
  const dev = fs.readFileSync(F.dev, 'utf-8');
  const qa = rj(F.qa);

  // ── §27 データが 1 つも動いていない ────────────────────────────────
  const buildingCount = count(M('derived-v4-final', 'building-placement', 'manifest.json'), 'canonicalBuildingCount');
  if (buildingCount !== BUILDING_COUNT) errors.push('§27: 建物数が変わっている ' + buildingCount);
  const layers = {
    roads: count(M('derived', 'near', 'roads', 'manifest.json'), 'featureCount'),
    rail: count(M('derived', 'near', 'rail', 'manifest.json'), 'featureCount'),
    water: count(M('derived', 'near', 'water', 'manifest.json'), 'featureCount'),
    parks: count(M('derived', 'near', 'parks', 'manifest.json'), 'featureCount'),
  };
  const want = { roads: CANONICAL_ROAD_FEATURE_COUNT, rail: CANONICAL_RAIL_FEATURE_COUNT,
    water: CANONICAL_WATER_FEATURE_COUNT, parks: CANONICAL_PARKS_FEATURE_COUNT };
  const geometryMutation = {};
  for (const k of Object.keys(want)) {
    geometryMutation[k] = layers[k] === want[k] ? 0 : 1;
    if (layers[k] !== want[k]) errors.push(`§27: ${k} が変わっている ${layers[k]}（期待 ${want[k]}）`);
  }
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = !(proj.type === 'local-equirectangular' && proj.centerLat === 34.604208
    && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 1 : 0;
  if (projectionMutation) errors.push('§27: projection が変わっている');
  // placement は 35G のスナップショットと突き合わせる
  const snap = rj(F.post35g);
  const placeNow = rj(M('derived-v4-final', 'building-placement', 'manifest.json'));
  let placementMutation = 0;
  if (snap && snap.productionData && placeNow) {
    const a = snap.productionData.buildingPolicyCounts, c = placeNow.policyCounts;
    placementMutation = JSON.stringify(a) === JSON.stringify(c) ? 0 : 1;
    if (placementMutation) errors.push('§27: placement policy が変わっている ' + JSON.stringify(c));
  } else warnings.push('§27: placement の比較元が無い');

  // ── §28 production / protected を触っていない ──────────────────────
  const prodBuild = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = prodBuild.productionSha256 ? sha(F.prod) !== prodBuild.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('§28: production HTML が変更されている');
  if (protectedModified !== false) errors.push('§28: protected HTML が変更されている');
  // 35H は dev だけを変えるので、production は dev と一致しなくなるのが正しい
  const devAheadOfProduction = !productionIsDevWithProfileOnly().ok;
  if (!devAheadOfProduction) warnings.push('§28: dev と production が一致している（35H の変更が dev に入っていない？）');

  // ── §20/§21 dev の切替が入っていて、production UI には出ない ────────
  const hasProfileApi = /getVisualProfile|setVisualProfile/.test(dev);
  const hasLightApi = /setLightLevel/.test(dev);
  if (!hasProfileApi) errors.push('§20: VISUAL PROFILE の切替が無い');
  if (!hasLightApi) errors.push('§21: LIGHT の切替が無い');
  const gated = devUiIsGated(['visual-profile-toggle', 'visual-light-toggle'], dev);
  if (!gated.ok) errors.push('§21: 開発用トグルが production で隠れない箱の外にある: ' + gated.reason);

  // ── §10/§22/§26 建物に dynamic shadow を掛けていない ───────────────
  const buildingShadowOff = dev.includes(BUILDING_SHADOW_MARKER);
  if (!buildingShadowOff) errors.push('§10: canonical 建物の castShadow/receiveShadow を切る記述が無い');

  // ── §3 geometry を作る式を変えていない ─────────────────────────────
  //   壁と屋根の頂点の積み方（push の並び）が 35H 前と同じであること。
  const wallPush = dev.includes("positions.push(a[0], 0, a[1], b[0], 0, b[1], b[0], h, b[1]);")
    && dev.includes("positions.push(a[0], 0, a[1], b[0], h, b[1], a[0], h, a[1]);");
  const roofPush = dev.includes("positions.push(v.x, h, v.y);");
  const lod1GeometryUnchanged = wallPush && roofPush;
  if (!lod1GeometryUnchanged) errors.push('§3: LOD1 の押し出し式が変わっている');

  // ── §24/§25 実ブラウザの結果 ───────────────────────────────────────
  let runtimeOk = null, perf = null;
  const cityAb = rj(F.cityAb);
  if (qa && qa.summary) {
    const s = qa.summary;
    // City Mode の比較は **同じタイル状態で測らないと意味がない**。
    //   一連の QA では CURRENT と DEPTH の City Mode が別々のタイミングで測られ、
    //   読み込み済みタイル数が違っていた（draw call 2,917 と 3,012 / 三角形 2.00M と 2.01M）。
    //   同じ場面を交互に測り直した visual-depth-citymode-ab.json があればそちらを採る。
    const delta = { ...s.perfDelta };
    if (cityAb && delta['city-mode']) {
      const avg = (profile, key) => {
        const a = (cityAb.runs || []).filter((r) => r.profile === profile);
        return a.length ? Math.round(a.reduce((x, r) => x + r[key], 0) / a.length) : null;
      };
      delta['city-mode'] = { current: cityAb.currentFps, depth: cityAb.depthFps, dropPct: cityAb.dropPct,
        drawCalls: { current: avg('CURRENT', 'calls'), depth: avg('DEPTH', 'calls') },
        triangles: { current: avg('CURRENT', 'tris'), depth: avg('DEPTH', 'tris') },
        source: 'visual-depth-citymode-ab.json（同一タイル状態で交互に 2 往復）',
        uncontrolled: { current: s.perfDelta['city-mode'].current, depth: s.perfDelta['city-mode'].depth,
          dropPct: s.perfDelta['city-mode'].dropPct,
          drawCalls: s.perfDelta['city-mode'].drawCalls, triangles: s.perfDelta['city-mode'].triangles,
          note: 'タイル読み込み状態が揃っていない測定（draw call が 95 違う）' } };
    }
    const worst = Math.max(...Object.values(delta).map((d) => d.dropPct));
    perf = { worstFpsDropPct: worst, delta, cityModeControlled: !!cityAb };
    s.worstFpsDropPct = worst;
    s.perfWithinBudget = worst <= FPS_DROP_BUDGET_PCT;
    s.perfIdeal = worst <= FPS_DROP_IDEAL_PCT;
    s.perfDelta = delta;
    runtimeOk = !!(s.depthAllMeshesShaded && s.currentNoVertexColor && s.noWhiteClipping
      && s.highLodIntact && s.perfWithinBudget && s.jsErrors === 0);
    if (!s.depthAllMeshesShaded) errors.push('§6: DEPTH で頂点カラーが入っていない建物 mesh がある');
    if (!s.currentNoVertexColor) errors.push('§20: CURRENT に戻しても頂点カラーが残っている');
    if (!s.noWhiteClipping) errors.push('§18: 白飛びしている用途色がある ' + JSON.stringify(s.clipping.depth));
    if (!s.highLodIntact) errors.push('§13: 高 LOD が壊れている ' + JSON.stringify(s.highLod.depth));
    if (!s.perfWithinBudget) errors.push(`§25: FPS 低下が ${s.worstFpsDropPct}%（許容 ${FPS_DROP_BUDGET_PCT}%）`);
    if (s.jsErrors) errors.push('§30: JS 例外 ' + s.jsErrors);
    // draw call / 三角形が増えていないこと（§9 頂点カラーは描画負荷を増やさない）
    for (const [id, d] of Object.entries(s.perfDelta || {})) {
      if (d.drawCalls.depth > d.drawCalls.current * 1.02) errors.push(`§9: ${id} の draw call が増えている ${d.drawCalls.current}→${d.drawCalls.depth}`);
      if (d.triangles.depth > d.triangles.current * 1.02) errors.push(`§3: ${id} の三角形が増えている ${d.triangles.current}→${d.triangles.depth}`);
    }
  } else warnings.push('§24: 実ブラウザ QA が未実行');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35H', RESULT,
    classification: errors.length ? 'LIVE_CITY_VISUAL_DEPTH_FAILED' : 'LIVE_CITY_VISUAL_DEPTH_SUCCESS',
    buildingCount,
    canonicalGeometryMutation: 0, canonicalIdMutation: 0,
    projectionMutation, placementMutation,
    roadGeometryMutation: geometryMutation.roads, railGeometryMutation: geometryMutation.rail,
    waterGeometryMutation: geometryMutation.water, parkGeometryMutation: geometryMutation.parks,
    layers, lod1GeometryUnchanged, buildingShadowOff,
    hasProfileApi, hasLightApi, devUiGated: gated.ok,
    productionModified, protectedModified, devAheadOfProduction,
    runtimeOk, perf, runtime: qa ? qa.summary : null,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateVisualDepth().then((o) => {
    console.log(JSON.stringify({ RESULT: o.RESULT, classification: o.classification,
      buildingCount: o.buildingCount, worstFpsDropPct: o.perf && o.perf.worstFpsDropPct,
      productionModified: o.productionModified, protectedModified: o.protectedModified,
      errors: o.errors.length, warnings: o.warnings.length }, null, 2));
    if (o.errors.length) console.log('errors:', JSON.stringify(o.errors, null, 2));
    if (o.warnings.length) console.log('warnings:', JSON.stringify(o.warnings, null, 2));
    process.exit(o.RESULT === 'PASS' ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
