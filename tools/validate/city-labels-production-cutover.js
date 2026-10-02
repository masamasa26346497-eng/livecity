#!/usr/bin/env node
// tools/validate/city-labels-production-cutover.js
// [Mission 33B §25] ラベル + 明るい配色の production cutover 検証。
//   productionIsGeneratedFromDev / productionBuildProfile
//   productionLabelsActive / productionLabelCounts / labelSevereOverlaps = 0 / labelToggleWorks
//   productionPalette（33A の値と一致）/ productionDefaultBuildingMode = V2_NEW_OSM / roadMode = ROAD_V3
//   rawGsiEdge = false / legacyResidual = 0 / v1ProductionFetch = 0 / oldOsmProductionFetch = 0
//   pickingRegression = false / searchRegression = false / fakeValuesInCard = 0
//   protectedModified = false / buildingGeometryMutation = 0 / roadV3Mutation = 0 / projectionMutation = 0
//   → CITY_LABELS_PALETTE_PRODUCTION_SUCCESS / CITY_LABELS_PALETTE_PRODUCTION_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { buildProductionHtml } from '../build-production-html.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  prod: P('public', 'osaka_3d_buildings.html'),
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  qa: P('data', 'reports', 'city-labels-production-qa.json'),
  devQa: P('data', 'reports', 'city-label-palette-qa.json'),
  build: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  canonManifest: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'),
  places: P('public', 'map-data', 'osaka-city', 'derived', 'place-labels.json'),
  anchors: P('public', 'map-data', 'osaka-city', 'derived', 'map-label-anchors.json'),
  stations: P('public', 'map-data', 'osaka-city', 'derived', 'rail-stations.json'),
  landmarks: P('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'),
  out: P('data', 'reports', 'city-labels-production-cutover-validation.json'),
};
const FROZEN_BUILDINGS = [
  'data/processed/osaka-city/canonical/buildings-v2-osmv2/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/near/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/mid/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/far/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/building-placement/manifest.json',
];
const ROAD_V3 = ['data/processed/osaka-city/derived/road-visual-v3', 'public/map-data/osaka-city/derived/road-visual-v3'];
// 33A で確定した配色（production だけ別の値にしない）
export const PALETTE_33A = [
  /const MS_BG_NEUTRAL = 0xf6f7f3;/,
  /water: 0x63bfe4, waterHarbor: 0x55a9d0,/,
  /parkReal: 0x9bd589, parkGreen: 0x8fcd7b, grass: 0xc9e7b6,/,
  /railMajor: 0x49546a, railUrban: 0x4f5f9e, railLocal: 0x69717f,/,
  /road: 0x979ea9,/,
  /const CR_USAGE_WHITEN = \{ far: 0\.46, mid: 0\.20, near: 0\.06 \};/,
  /const CR_VIVID = \{ sat: 1\.24, light: 1\.03 \};/,
  /const CR_STYLE = \{ exposure: 0\.93, hemi: 0\.74, sun: 1\.28, fill: 0\.26 \};/,
];
// 33A で確定したラベル挙動（production だけ件数・しきい値を変えない）
export const LABEL_RULES_33A = [
  /const DENSITY_CAP = \{ far: 18, mid: 36, near: 58 \};/,
  /const GRID = \{ cols: 6, rows: 4, perCell: 3 \};/,
  /const THROTTLE_MS = 200;/,
  // [Mission 33D §15] ランドマークの優先度は名前や importance ではなく **tier** で決めるよう変わった。
  //   [Mission 35G] この規則はそれ以降 dev と一致しなくなっていたが、production が 32U 版で
  //   凍結されていたためこの検査だけが古い production を見て通り続けていた（cutover で表面化）。
  //   守りたいのは「ランドマークが最優先、その中で段階がある」ことなので、今の式で見る。
  /const rank = item\.kind === 'landmark' \? \(item\.tier === 'S' \? 0 : item\.tier === 'A' \? 2\.5 : 3\)/,
  /const hits = \(c, q\) => Math\.abs\(c\.sx - q\.sx\) < \(c\.hw \+ q\.hw\) && Math\.abs\(c\.sy - q\.sy\) < \(c\.hh \+ q\.hh\);/,
];
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function git(args) { try { return execFileSync('git', args, { cwd: resolveProjectPath('.'), encoding: 'utf-8' }).trim(); } catch { return null; } }
function newestMtime(dir) {
  let m = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const q = path.join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newestMtime(q) : fs.statSync(q).mtimeMs);
  }
  return m;
}

export async function validateCityLabelsProductionCutover() {
  const errors = [], warnings = [];
  const qa = rj(F.qa);
  const after = qa && qa.phases ? qa.phases.after : null;
  const before = qa && qa.phases ? qa.phases.before : null;
  if (!after) {
    const out = { RESULT: 'FAIL', classification: 'CITY_LABELS_PALETTE_PRODUCTION_FAILED', errors: ['city-labels-production-qa.json（phase=after）が無い'] };
    await writeJson(F.out, out); return out;
  }
  const prod = fs.readFileSync(F.prod, 'utf-8');

  // ── §1/§2 ビルド方式 ──
  const build = buildProductionHtml({ check: true });
  const productionIsGeneratedFromDev = build.identical;
  if (!productionIsGeneratedFromDev) errors.push('§1: production が dev からの生成結果と一致しない（手編集の疑い）');
  const productionBuildProfile = /const LIVECITY_BUILD_PROFILE = 'production';/.test(prod);
  if (!productionBuildProfile) errors.push("§2: production のビルドプロファイルが 'production' でない");
  const rec = rj(F.build) || {};
  const buildRecordMatches = rec.productionSha256 === sha(F.prod) && rec.devSha256 === sha(F.dev);
  if (!buildRecordMatches) errors.push('§1: ビルド記録（production-cutover-build.json）が現物と一致しない');

  // ── §5/§6/§7 ラベルのルールを production だけ変えていない ──
  const labelRulesSame = LABEL_RULES_33A.every((re) => re.test(prod));
  if (!labelRulesSame) errors.push('§5/§6: 33A のラベル規則（上限・グリッド・優先度・衝突）が production で変わっている');
  const productionPalette = PALETTE_33A.every((re) => re.test(prod));
  if (!productionPalette) errors.push('§8: 33A の配色が production に入っていない');
  // §4 旧 StationLabelLayer は通常表示で使わない（コードは残す）
  const legacyStationLayerKept = /const StationLabelLayer = \(function \(\) \{/.test(prod) && /window\.__STATION_LABEL_DEBUG__/.test(prod);
  const legacyStationLayerOff = !/^StationLabelLayer\.show\(\);/m.test(prod);
  if (!legacyStationLayerKept) errors.push('§4: 旧 StationLabelLayer のコード / debug API が消えている');
  if (!legacyStationLayerOff) errors.push('§4: 旧 StationLabelLayer が通常表示で有効になっている');

  // ── §3/§13 ラベルが production の通常表示で出ている ──
  const sites = after.sites || [];
  const labelCounts = sites.map((s) => ({
    site: s.site, siteName: s.siteName,
    total: s.labels.city ? s.labels.city.visible : 0,
    landmark: s.labels.city ? s.labels.city.visibleLandmarks : 0,
    station: s.labels.city ? s.labels.city.visibleStations : 0,
    place: s.labels.city ? s.labels.city.visiblePlaces : 0,
    ward: s.labels.city ? s.labels.city.visibleWards : 0,
    park: s.labels.city ? s.labels.city.visibleParks : 0,
    overlapPairs: s.labels.overlapPairs, severeOverlaps: s.labels.severeOverlaps, tooSmall: s.labels.tooSmallLabels,
  }));
  const productionLabelsActive = sites.length === 6 && sites.every((s) => s.labels.city && s.labels.city.loaded)
    && labelCounts.every((c) => c.total >= 1);
  if (!productionLabelsActive) errors.push('§3: production でラベルが出ていない地点がある ' + JSON.stringify(labelCounts.map((c) => [c.site, c.total])));
  const richSites = labelCounts.filter((c) => c.station >= 1 && (c.place + c.landmark) >= 1);
  if (richSites.length < 5) errors.push('§3: 駅名 + 地名/施設が揃う地点が 5 未満 ' + JSON.stringify(labelCounts.map((c) => [c.site, c.station, c.place, c.landmark])));
  const labelSevereOverlaps = Math.max(
    ...labelCounts.map((c) => c.severeOverlaps || 0),
    (after.cityMode && after.cityMode.labels.severeOverlaps) || 0,
  );
  if (labelSevereOverlaps > 0) errors.push('§16: 文字が読めない完全重複がある: ' + labelSevereOverlaps);
  const nearViewOverlaps = Math.max(...labelCounts.map((c) => c.overlapPairs || 0));
  if (nearViewOverlaps > 2) errors.push('§5: 近景でラベルが重なっている（最大 ' + nearViewOverlaps + ' 組）');
  const cityModeOverlaps = (after.cityMode && after.cityMode.labels.overlapPairs) || 0;
  if (cityModeOverlaps > 12) warnings.push('§16: City Mode のラベル接触が多い: ' + cityModeOverlaps + ' 組');
  const lt = after.layerToggles || {};
  // 型別の件数で確かめる（OFF でその型が 0 になり、ON で戻る）
  const labelToggleWorks = ['placeLabels', 'railStations', 'landmarkLabels'].every((k) => {
    const t = lt[k];
    if (!t || typeof t !== 'object' || !t.type) return false;
    return t.before[t.type] > 0 && t.off[t.type] === 0 && t.on[t.type] === t.before[t.type];
  });
  if (!labelToggleWorks) errors.push('§13: レイヤーパネルの 地名 / 駅名 / 施設名 トグルが効いていない ' + JSON.stringify(lt));

  // ── §22 runtime configuration ──
  const self = after.finalSelfCheck || (after.startup && after.startup.selfCheck) || {};
  const productionDefaultBuildingMode = self.buildingMode || null;
  const productionRoadMode = self.roadMode || null;
  const productionRawGsiEdge = self.rawGsiEdge === true;
  const productionBuildingCount = self.buildingCount != null ? self.buildingCount : null;
  if (productionDefaultBuildingMode !== 'V2_NEW_OSM') errors.push('§22: building mode が V2_NEW_OSM でない: ' + productionDefaultBuildingMode);
  if (productionRoadMode !== 'ROAD_V3') errors.push('§22: road mode が ROAD_V3 でない: ' + productionRoadMode);
  if (productionRawGsiEdge) errors.push('§22: raw GSI edge が ON');
  if (productionBuildingCount !== 600764) errors.push('§9: building count が 600,764 でない: ' + productionBuildingCount);
  const legacyResidual = Math.max(
    (after.startup && after.startup.residual) || 0,
    ...sites.map((s) => s.residual || 0),
    (after.cityMode && after.cityMode.residual) || 0,
  );
  if (legacyResidual !== 0) errors.push('§22: legacy residual が 0 でない: ' + legacyResidual);

  // ── §12 開発用 UI は出ない / 通常 UI は残る ──
  const ui = after.finalUi || after.startup.ui || { devOnly: {}, userUi: {} };
  const visibleDevPanels = Object.entries(ui.devOnly).filter(([, v]) => v === 'visible').map(([k]) => k);
  if (visibleDevPanels.length) errors.push('§12: 開発用パネルが production で見えている ' + JSON.stringify(visibleDevPanels));
  const missingUserUi = Object.entries(ui.userUi).filter(([, v]) => v === 'absent').map(([k]) => k);
  if (missingUserUi.length) errors.push('§12: 通常 UI が欠けている ' + JSON.stringify(missingUserUi));

  // ── §19 当たり判定・検索の回帰 ──
  const picks = sites.filter((s) => s.picking);
  const pickingRegression = picks.length < 6 || picks.some((s) => !s.picking.pickedExpected || s.picking.hover !== 'block' || s.picking.cardDisplay !== 'block');
  if (pickingRegression) errors.push('§19: ラベル追加後に hover / クリックが壊れている ' + JSON.stringify(picks.map((s) => [s.site, s.picking.hover, s.picking.pickedExpected])));
  const searchRegression = !after.search || after.search.msgShown === true || after.search.distanceM > 50;
  if (searchRegression) errors.push('§19: 検索が壊れている ' + JSON.stringify(after.search));
  // §21 property card に仮値が出ていない
  const fakeValuesInCard = picks.reduce((n, s) => n + ((s.picking.fakeValues || []).length), 0);
  if (fakeValuesInCard) errors.push('§21: property card に仮値表示がある ' + JSON.stringify(picks.map((s) => [s.site, s.picking.fakeValues])));
  const townSectionShown = picks.some((s) => s.picking.townSectionVisible);
  if (townSectionShown) errors.push('§21: 未対応の町丁目セクションが出ている');

  // ── §23 fetch 監査 ──
  const fa = after.fetchAudit || { forbidden: [] };
  const forbidden = Object.fromEntries((fa.forbidden || []).map((f) => [f.id, f.count]));
  const v1ProductionFetch = (forbidden['v1-buildings'] || 0) + (forbidden['v1-building-placement'] || 0) + ((fa.namespaceCounters || {}).V1 || 0);
  const oldOsmProductionFetch = (forbidden['old-osm-buildings'] || 0) + ((fa.namespaceCounters || {}).V2 || 0);
  const rawGsiEdgeFetch = forbidden['raw-gsi-road-edge'] || 0;
  if (v1ProductionFetch) errors.push('§23: V1 building fetch が発生: ' + v1ProductionFetch);
  if (oldOsmProductionFetch) errors.push('§23: 旧 OSM fallback fetch が発生: ' + oldOsmProductionFetch);
  if (rawGsiEdgeFetch) errors.push('§23: raw GSI edge fetch が発生: ' + rawGsiEdgeFetch);
  if (!(fa.v2nBuildingRequests > 0)) errors.push('§23: V2_NEW_OSM の building fetch が 0');
  if (!(fa.labelDataRequests > 0)) errors.push('§3: ラベルデータを取得していない');

  // ── §9/§10/§11 データ不変 ──
  const missionStart = Date.parse(qa.phases.before ? qa.phases.before.generatedAt : after.generatedAt) - 6 * 3600 * 1000;
  const touched = FROZEN_BUILDINGS.filter((r) => { try { return fs.statSync(P(r)).mtimeMs > missionStart; } catch { return true; } });
  const buildingGeometryMutation = touched.length + ((rj(F.canonManifest) || {}).featureCount === 600764 ? 0 : 1);
  if (buildingGeometryMutation) errors.push('§9: 建物データが変わっている ' + JSON.stringify(touched));
  const roadV3Mutation = ROAD_V3.filter((d) => newestMtime(P(d)) > missionStart).length;
  if (roadV3Mutation) errors.push('§10: ROAD V3 の出力が変わっている');
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = (proj.type === 'local-equirectangular' && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 0 : 1;
  if (projectionMutation) errors.push('§9: projection が変わっている');

  // ── §24 protected ──
  const baseline = rj(F.baseline) || {};
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (protectedModified !== false) errors.push('§24: protected HTML が変更されている');

  // ── §17 性能（33A development の実測と比較）──
  const devPerf = rj(F.devQa);
  const devAfter = devPerf && devPerf.runs && devPerf.runs.after ? devPerf.runs.after.performance : null;
  const perf = after.performance || [];
  const umeda = perf.find((p) => p.site === 'umeda');
  if (devAfter && umeda && umeda.fpsAverage < devAfter.fpsAverage * 0.85) {
    warnings.push(`§17: 梅田の FPS が 33A development より 15% 以上低い（${devAfter.fpsAverage} → ${umeda.fpsAverage}）`);
  }
  if (perf.length < 4) errors.push('§17: 性能計測が 4 条件そろっていない');

  // ── §26 rollback ──
  const rollback = {
    productionTrackedInGit: git(['ls-files', '--', 'public/osaka_3d_buildings.html']) === 'public/osaka_3d_buildings.html',
    headCommitBlob: git(['rev-parse', 'HEAD:public/osaka_3d_buildings.html']),
    headCommit: git(['rev-parse', 'HEAD']),
    previousProductionSha256: rec.previousProductionSha256 || null,
    command: 'git checkout -- public/osaka_3d_buildings.html',
  };
  if (!rollback.productionTrackedInGit || !rollback.headCommitBlob) errors.push('§26: git から production を戻せることを確認できない');

  const labelData = {
    places: (rj(F.places) || { places: [] }).places.length,
    wards: ((rj(F.anchors) || {}).wards || []).length,
    parks: ((rj(F.anchors) || {}).parks || []).length,
    stations: ((rj(F.stations) || {}).stations || []).length,
    landmarks: ((rj(F.landmarks) || {}).landmarks || []).length,
  };

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '33B', RESULT,
    classification: errors.length ? 'CITY_LABELS_PALETTE_PRODUCTION_FAILED' : 'CITY_LABELS_PALETTE_PRODUCTION_SUCCESS',
    productionIsGeneratedFromDev, productionBuildProfile, buildRecordMatches,
    productionLabelsActive, labelCounts, labelData,
    labelSevereOverlaps, nearViewOverlaps, cityModeOverlaps, labelToggleWorks,
    labelRulesSame, productionPalette, legacyStationLayerKept, legacyStationLayerOff,
    productionDefaultBuildingMode, productionBuildingCount, productionRoadMode, productionRawGsiEdge, legacyResidual,
    pickingRegression, searchRegression, fakeValuesInCard,
    v1ProductionFetch, oldOsmProductionFetch, rawGsiEdgeFetch,
    buildingGeometryMutation, roadV3Mutation, projectionMutation, protectedModified,
    performance: perf, devReference33A: devAfter,
    comparison: qa.comparison || null,
    hashes: { production: sha(F.prod), dev: sha(F.dev), protectedNow: sha(F.prot), protectedBaseline: baseline.prot || null },
    rollback, errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateCityLabelsProductionCutover().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
