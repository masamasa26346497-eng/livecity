#!/usr/bin/env node
// tools/validate/pre-production-cleanup.js
// [Mission 32Q §16/§19] PRE-PRODUCTION CLEANUP の検証。
//   buildingV2Mutation = 0 / roadV3Mutation = 0 / projectionMutation = 0
//   legacyResidual = 0 / visibleLegacyObjects = 0
//   propertyAreaHardcodeRemoved = true / suppress2Reviewed = true
//   productionModified = false / protectedModified = false
//   → PRE_PRODUCTION_CLEANUP_SUCCESS / PRE_PRODUCTION_CLEANUP_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  html: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  qa: P('data', 'reports', 'pre-production-cleanup-qa.json'),
  probeBefore: P('data', 'reports', 'legacy-residual-probe-before.json'),
  probeAfter: P('data', 'reports', 'legacy-residual-probe-after.json'),
  overrides: P('data', 'processed', 'osaka-city', 'v2-final', 'placement-overrides.json'),
  placementManifest: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement', 'manifest.json'),
  placementReport: P('data', 'reports', 'v2-placement-policy.json'),
  wardIndex: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-ward-index.json'),
  o2build: P('data', 'reports', 'osm-fallback-v2-build.json'),
  out: P('data', 'reports', 'pre-production-cleanup-validation.json'),
};
// 変更してはいけない成果物（mission 開始時刻より後に更新されていないこと）
const FROZEN = [
  'data/processed/osaka-city/canonical/buildings-v2-osmv2/manifest.json',
  'data/processed/osaka-city/canonical/buildings-v2-corrected/manifest.json',
  'data/processed/osaka-city/canonical/buildings-v2-osm-fallback/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/near/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/mid/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/far/buildings/manifest.json',
];
const ROAD_V3 = ['data/processed/osaka-city/derived/road-visual-v3/manifest.json', 'public/map-data/osaka-city/derived/road-visual-v3/manifest.json'];
const ROAD_V3_TILE_DIRS = ['data/processed/osaka-city/derived/road-visual-v3/tiles', 'public/map-data/osaka-city/derived/road-visual-v3/tiles'];
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const mtime = (rel) => { try { return fs.statSync(P(rel)).mtimeMs; } catch { return null; } };
function gitClean(rel) {
  try { return execFileSync('git', ['status', '--porcelain', '--', rel], { cwd: resolveProjectPath('.'), encoding: 'utf-8' }).trim() === ''; } catch { return null; }
}

export async function validatePreProductionCleanup() {
  const errors = [], warnings = [];
  const qa = rj(F.qa), before = rj(F.probeBefore), after = rj(F.probeAfter);
  if (!qa || !before || !after) {
    const out = { RESULT: 'FAIL', classification: 'PRE_PRODUCTION_CLEANUP_FAILED', errors: ['QA / probe レポートが無い'] };
    await writeJson(F.out, out); return out;
  }
  const missionStart = Date.parse(before.generatedAt);

  // ── 変更禁止の対象 ──
  const merged = rj(P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json')) || {};
  const o2 = rj(F.o2build) || {};
  const frozenTouched = FROZEN.filter((r) => { const m = mtime(r); return m == null || m > missionStart; });
  const buildingV2Mutation = frozenTouched.length + (merged.featureCount === 600764 && merged.plateauCount === 574112 && merged.fallbackCount === 26652 ? 0 : 1)
    + (o2.canonical && merged.generatedAt === o2.canonical.generatedAt ? 0 : 1);
  if (buildingV2Mutation) errors.push('§0: Building V2 / OSM fallback V2 が変わっている ' + JSON.stringify({ frozenTouched, generatedAt: merged.generatedAt }));
  let roadTouched = ROAD_V3.filter((r) => { const m = mtime(r); return m == null || m > missionStart; }).length;
  for (const d of ROAD_V3_TILE_DIRS) for (const f of fs.readdirSync(P(d))) if (fs.statSync(path.join(P(d), f)).mtimeMs > missionStart) roadTouched++;
  const roadV3Mutation = roadTouched;
  if (roadV3Mutation) errors.push('§0: ROAD V3 geometry が変わっている: ' + roadTouched);
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = proj.type === 'local-equirectangular' && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320 ? 0 : 1;
  if (projectionMutation) errors.push('§0: projection / origin が変わっている');

  // placement 全体は再生成していない（manifest の生成時刻・閾値・overlap 入力は 32P のまま）/ 区割当も不変
  const pm = rj(F.placementManifest) || {}, pr = rj(F.placementReport) || {};
  const placementNotRegenerated = pm.generatedAt === pr.generatedAt && pm.variant === 'v2-final' && pm.individualOverrides && pm.individualOverrides.count === 2;
  if (!placementNotRegenerated) errors.push('§13: placement が再生成された、または個別上書きの記録が無い');
  const pc = pm.policyCounts || {};
  if (pc.DISPLAY + pc.SUPPRESS + pc.REVIEW + pc.EXEMPT !== 600764) errors.push('placement の合計が 600,764 でない');
  const wi = rj(F.wardIndex) || { wards: {} };
  const wardNow = Object.fromEntries(Object.entries(wi.wards).map(([k, v]) => [k, v.buildingCount]));
  const wardBefore = Object.fromEntries(Object.entries((pr.wardIndex || {}).wardCounts || {}).map(([k, v]) => [k, v.buildingCount]));
  const wardAssignmentMutation = JSON.stringify(Object.entries(wardNow).sort()) === JSON.stringify(Object.entries(wardBefore).sort()) ? 0 : 1;
  if (wardAssignmentMutation) errors.push('§0: 区ごとの建物数が変わっている（ward assignment）');

  // ── §1-§5 legacy residual ──
  const states = { startup: qa.startup, ...Object.fromEntries(Object.entries(qa.regression).filter(([, v]) => v && typeof v === 'object' && 'residual' in v)) };
  for (const k of ['startup', 'umedaWard', 'cityMode']) states['probe-' + k] = after[k] ? { residual: after[k].selfCheck.total, visibleLegacyObjects: after[k].visibleLegacyObjects } : null;
  const legacyResidual = Math.max(...Object.values(states).map((s) => (s ? s.residual : 99)));
  const visibleLegacyObjects = Math.max(...Object.values(states).map((s) => (s ? s.visibleLegacyObjects : 99)));
  if (legacyResidual !== 0) errors.push('§5: legacy residual が 0 でない状態がある ' + JSON.stringify(Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v && v.residual]))));
  if (visibleLegacyObjects !== 0) errors.push('§5: 見えている legacy object がある ' + JSON.stringify(Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v && v.visibleLegacyObjects]))));
  const residualBefore = before.startup.selfCheck.total;
  const identified = (before.startup.visibleLegacyList || []).filter((x) => x.countedAsResidual).length === residualBefore;
  if (!identified) errors.push('§1: before の residual を全件特定できていない');
  const toggle = after.legacyToggle || {};
  if (!(toggle.parkingOrSacredUnderLegacyRoot && toggle.legacyRootVisibleWhenLegacy && toggle.backToCanonical && toggle.legacyRootVisibleNow === false)) {
    errors.push('§4: 旧レイヤーが legacyRoot 配下に移っていない、または Legacy 表示で戻らない ' + JSON.stringify(toggle));
  }
  const html = fs.readFileSync(F.html, 'utf-8');
  for (const name of ['ParkingLayer', 'SchoolLayer', 'WaterLayer', 'RooftopLayer']) {
    if (!new RegExp(`group\\.name = '${name}'; tagRuntimeOwnerRecursive\\(group, RUNTIME_OWNER\\.LEGACY\\)`).test(html)) errors.push('§4: ' + name + ' が legacy として登録されていない');
  }
  if (!/group\.name = layerName; tagRuntimeOwnerRecursive\(group, RUNTIME_OWNER\.LEGACY\)/.test(html)) errors.push('§4: Cemetery/Temple が legacy として登録されていない');
  // diagnostic ignore（除外リスト追加）で誤魔化していないこと
  if (/COEXIST_NAME = [^\n]*(Parking|Cemetery|Temple|Rooftop|School)/.test(html)) errors.push('§4: 旧レイヤーを COEXIST（診断除外）に入れている');

  // ── §14 status ──
  const st = (qa.startup.status || []).join('\n') + '\n' + (qa.regression.finalStatus || []).join('\n');
  for (const needle of ['[CANONICAL OK]', 'Buildings: V2 CORRECTED + OSM V2', 'Road: ROAD V3', 'Legacy residual: 0']) {
    if (!st.includes(needle)) errors.push('§14: status に「' + needle + '」が無い');
  }

  // ── §6-§9 property card ──
  const cards = qa.cards || [];
  const propertyAreaHardcodeRemoved = !/pc-title'\)\.textContent = [^\n]*南港南エリア/.test(html)
    && cards.length === 6 && cards.every((c) => c.pickedExpected && c.cardVisible && !c.hardcodedAreaShown && c.areaMatchesData);
  if (!propertyAreaHardcodeRemoved) errors.push('§9: property card の固定表示が残る / 6 地点の確認に失敗 ' + JSON.stringify(cards.map((c) => [c.site, c.title, c.pickedExpected])));
  if (/南港南エリア/.test(html.replace(/\/\/[^\n]*/g, ''))) warnings.push('「南港南エリア」が property card 以外（検索の範囲外メッセージ）に残る（範囲外）');

  // ── §10-§12 SUPPRESS 2 棟 ──
  const ov = rj(F.overrides) || { overrides: [] };
  const A = ov.overrides.find((o) => o.label.startsWith('A')), B = ov.overrides.find((o) => o.label.startsWith('B'));
  const needKeys = ['source', 'areaM2', 'osm', 'gsi', 'waterRatio', 'classification', 'decision'];
  const hasEvidence = (o) => o && needKeys.every((k) => o.evidence && o.evidence[k] != null) && (o.evidence.measuredHeightM !== undefined);
  const sr = qa.suppressReview || {};
  const suppress2Reviewed = !!(A && B && hasEvidence(A) && hasEvidence(B) && A.policy === 'REVIEW' && B.policy === 'SUPPRESS'
    && pc.SUPPRESS === 1 && sr.A && sr.A.visibleAndPickable && sr.B && sr.B.pickedB === false);
  if (!suppress2Reviewed) errors.push('§10-§12: SUPPRESS 2 棟の個別確認が不完全 ' + JSON.stringify({ A: A && A.policy, B: B && B.policy, suppress: pc.SUPPRESS, qaA: sr.A && sr.A.visibleAndPickable, qaB: sr.B && sr.B.pickedB }));

  // ── §15 regression ──
  const reg = qa.regression;
  const regressionOk = reg['version-V1'].version === 'V1' && reg['version-V2'].version === 'V2' && reg['version-V2N'].version === 'V2N'
    && reg.wardKita.ward === 'kita' && reg.cityMode.active === true
    && reg.mapAuditOn.enabled === true && reg.mapAuditOff.enabled === false
    && reg.refAlignOn.active === true && reg.refAlignOff.active === false
    && reg.ruler.on === true && reg.ruler.off === false
    && reg.layers.semantic.normalViewRoadMode === 'ROAD_V3' && reg.layers.semantic.normalViewRawGsiEdge === false
    && Object.values(reg.layers.semantic.layers).every(Boolean)
    && reg.wardKita.meshes.water > 0 && reg.wardKita.meshes.roads > 0 && reg.wardKita.meshes.parks > 0 && reg.wardKita.meshes.rail > 0 && reg.wardKita.meshes.buildings > 0
    && (qa.consoleErrors || []).length === 0;
  if (!regressionOk) errors.push('§15: 回帰確認に失敗');

  // ── production / protected ──
  // [Mission 33B] production は tools/build-production-html.js が生成する成果物。git の汚れではなく
  //   「最後に昇格したビルドと一致するか」で判定する（cutover 後も各 mission の validator を再実行できる）。
  const prodBuildRecord = rj(resolveProjectPath(path.join('data', 'reports', 'production-cutover-build.json')));
  const productionModified = (prodBuildRecord && prodBuildRecord.productionSha256)
    ? crypto.createHash('sha256').update(fs.readFileSync(resolveProjectPath(path.join('public', 'osaka_3d_buildings.html')))).digest('hex') !== prodBuildRecord.productionSha256
    : gitClean('public/osaka_3d_buildings.html') === false;
  const protectedModified = gitClean('public/osaka_3d_buildings.fullward-v3.html') === false;
  if (productionModified) errors.push('§0: production HTML が変更されている');
  if (protectedModified) errors.push('§0: protected HTML が変更されている');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '32Q', RESULT,
    classification: errors.length ? 'PRE_PRODUCTION_CLEANUP_FAILED' : 'PRE_PRODUCTION_CLEANUP_SUCCESS',
    buildingV2Mutation, roadV3Mutation, projectionMutation, wardAssignmentMutation, placementNotRegenerated,
    legacyResidual, visibleLegacyObjects, residualBefore,
    propertyAreaHardcodeRemoved, suppress2Reviewed, regressionOk,
    productionModified, protectedModified,
    placementCounts: pc,
    states: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v && { residual: v.residual, visibleLegacyObjects: v.visibleLegacyObjects }])),
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validatePreProductionCleanup().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
