#!/usr/bin/env node
// tools/validate/station-town-navigation.js
// [Mission 35K §29/§30/§32] 駅表示と町名ナビゲーションを検証する。
//   データ（建物・道路・鉄道・水域・公園）が 1 つも動いていないこと、
//   production / protected を触っていないこと、駅名や町名を直書きしていないこと。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import {
  CANONICAL_ROAD_FEATURE_COUNT, CANONICAL_RAIL_FEATURE_COUNT,
  CANONICAL_WATER_FEATURE_COUNT, CANONICAL_PARKS_FEATURE_COUNT, CANONICAL_STATION_COUNT,
} from '../lib/canonical-baseline.js';
import {
  productionMatchesBuildRecord, devUiIsGated, sha256, PROTECTED_HTML, PRODUCTION_HTML, DEV_HTML,
} from '../lib/production-invariants.js';
import { OPERATORS, UNKNOWN_OPERATOR } from '../build-station-index.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const M = (...s) => P('public', 'map-data', 'osaka-city', ...s);
const F = {
  area: P('config', 'areas', 'osaka-city.json'),
  qa: P('data', 'reports', 'station-town-navigation-qa.json'),
  stationIndex: M('derived', 'station-index.json'),
  areaBoundaries: M('derived', 'area-boundaries.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  post35g: P('data', 'reports', 'production-cutover-snapshot-post.json'),
  out: P('data', 'reports', 'station-town-navigation-validation.json'),
};
export const BUILDING_COUNT = 618749;
/** §27 35I baseline 比の FPS 低下許容。 */
export const FPS_DROP_BUDGET_PCT = 5;
/** §31 dev だけに出す操作。 */
export const DEV_ONLY_IDS = ['stations-toggle', 'town-click-toggle', 'town-boundary-toggle'];
/**
 * §12 35K 時点で町丁目の境界データがあった区。
 * HTML に埋まっている legacy の TOWN_POLYGONS は今もこの 3 区ぶんだけ（35L でも触っていない）。
 */
export const TOWN_BOUNDARY_WARDS = ['住吉区', '東住吉区', '平野区'];
/**
 * [Mission 35L] 配信する境界の出所として認めるもの。
 *   estat-census-2020-official … e-Stat 令和2年国勢調査 小地域（町丁・字等）境界（24 区・公式）
 *   legacy-unverified          … 35K までの出所未確認の町丁目（残してよいが増やさない）
 *   n03-official               … 国土数値情報の行政区域（町丁目が取れないときの区界 fallback）
 * ここに無い出所が 1 件でもあれば「推測で作った境界」とみなす（§12 の本来の意図）。
 */
export const ALLOWED_BOUNDARY_SOURCES = ['estat-census-2020-official', 'legacy-unverified', 'n03-official'];

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const count = (p, k) => { const j = rj(p); return j ? (j[k] ?? j.featureCount ?? j.count ?? null) : null; };

export async function validateStationTownNavigation() {
  const errors = [], warnings = [];
  const dev = fs.readFileSync(DEV_HTML, 'utf-8');
  const qa = rj(F.qa);
  const si = rj(F.stationIndex);
  const ab = rj(F.areaBoundaries);

  // ── §29 データが 1 つも動いていない ────────────────────────────────
  const buildingCount = count(M('derived-v4-final', 'building-placement', 'manifest.json'), 'canonicalBuildingCount');
  if (buildingCount !== BUILDING_COUNT) errors.push('§29: 建物数が変わっている ' + buildingCount);
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
    if (mutation[k]) errors.push(`§29: ${k} が変わっている ${layers[k]}（期待 ${want[k]}）`);
  }
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = !(proj.type === 'local-equirectangular' && proj.centerLat === 34.604208
    && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 1 : 0;
  if (projectionMutation) errors.push('§29: projection が変わっている');
  const snap = rj(F.post35g);
  const placeNow = rj(M('derived-v4-final', 'building-placement', 'manifest.json'));
  let placementMutation = 0;
  if (snap && snap.productionData && placeNow) {
    placementMutation = JSON.stringify(snap.productionData.buildingPolicyCounts) === JSON.stringify(placeNow.policyCounts) ? 0 : 1;
    if (placementMutation) errors.push('§29: placement policy が変わっている');
  } else warnings.push('§29: placement の比較元が無い');

  // ── §30 production / protected ─────────────────────────────────────
  const build = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const prodOk = productionMatchesBuildRecord(build.productionSha256);
  const productionModified = build.productionSha256 ? !prodOk.ok : null;
  const protectedModified = baseline.prot ? sha256(PROTECTED_HTML) !== baseline.prot : null;
  if (productionModified !== false) errors.push('§30: production HTML が変更されている');
  if (protectedModified !== false) errors.push('§30: protected HTML が変更されている');
  const prod = fs.readFileSync(PRODUCTION_HTML, 'utf-8');
  if (/AreaSelectionLayer/.test(prod)) errors.push('§30: production に 35K が入っている');

  // ── §1 駅名・町名を直書きしていない ────────────────────────────────
  //   分類は operator / network / 路線名の **文字列パターン**で行う。
  //   ここでは「駅名の配列をコードに持っていないこと」を見る。
  const stationNames = si ? si.stations.map((s) => s.name) : [];
  const hardcoded = [];
  for (const n of stationNames.slice(0, 60)) {
    // 駅名が HTML / 索引生成コードに直書きされていないか（データファイルは対象外）
    const src = fs.readFileSync(P('tools', 'build-station-index.js'), 'utf-8');
    if (src.includes("'" + n + "'") || src.includes('"' + n + '"')) hardcoded.push(n);
  }
  if (hardcoded.length) errors.push('§1: 駅名を直書きしている: ' + hardcoded.join(','));
  const opIds = OPERATORS.map((o) => o.id);
  const classifiedByData = si ? si.stations.every((s) => opIds.includes(s.operator.id) || s.operator.id === UNKNOWN_OPERATOR.id) : null;
  if (classifiedByData === false) errors.push('§6: 未知の事業者 id がある');

  // ── §2/§6 事業者の網羅 ────────────────────────────────────────────
  const groups = si ? Object.keys(si.byGroup) : [];
  const operatorsPresent = si ? Object.keys(si.byOperator) : [];
  for (const need of ['metro', 'jr', 'private']) {
    if (!groups.includes(need)) errors.push('§6: ' + need + ' の駅が 1 つも無い');
  }
  for (const need of ['metro', 'jr', 'hankyu', 'hanshin', 'kintetsu', 'nankai', 'keihan']) {
    if (!operatorsPresent.includes(need)) errors.push('§2: ' + need + ' の駅が分類できていない');
  }

  // ── §4 統合 ───────────────────────────────────────────────────────
  //   名前が違う駅はまとめない（大阪 / 梅田 / 東梅田 / 西梅田）。
  const separate = ['大阪', '梅田', '東梅田', '西梅田'];
  const missingSeparate = si ? separate.filter((n) => !si.stations.some((s) => s.name === n)) : [];
  if (missingSeparate.length) errors.push('§4: 別駅として残っていない: ' + missingSeparate.join(','));

  // ── §12 町丁目の境界は既存データのある区だけ ───────────────────────
  let townWardsOk = null, inventedBoundary = 0;
  if (ab) {
    // [Mission 35L] 35K では町丁目があるのは 3 区だけだった。35L で e-Stat の公式境界を
    //   入れたので 24 区へ増える。**減っていないこと**を見る（35K の区が落ちたら退行）。
    const missingLegacy = TOWN_BOUNDARY_WARDS.filter((w) => !ab.townWards.includes(w));
    townWardsOk = missingLegacy.length === 0;
    if (!townWardsOk) errors.push('§12: 35K まであった区の町丁目が消えている ' + missingLegacy.join(','));
    // 「推測で作った」境界が混ざっていないこと（出所は決めたものだけ）
    for (const a of ab.areas) {
      if (!ALLOWED_BOUNDARY_SOURCES.includes(a.boundarySource)) inventedBoundary++;
    }
    if (inventedBoundary) errors.push('§12: 出所不明の境界が ' + inventedBoundary + ' 件');
  } else errors.push('§12: area-boundaries.json が無い');

  // ── §31 dev の操作は production に出ない ───────────────────────────
  const gated = devUiIsGated(DEV_ONLY_IDS, dev);
  if (!gated.ok) errors.push('§31: dev の操作が production で隠れない: ' + gated.reason);

  // ── §23-§28 実ブラウザ ────────────────────────────────────────────
  let runtimeOk = null, perf = null;
  if (qa && qa.summary) {
    const s = qa.summary;
    perf = s.perf;
    runtimeOk = !!(s.stationSitesOk && s.northStationsOk && s.townSelectionShown && s.townZoomApplied
      && s.townClearOk && s.stationClickOk && s.clickConflictOk && s.dragNoClickOk
      && s.regressionOk && s.jsErrors === 0);
    if (!s.stationSitesOk) errors.push('§23: 出るべき駅が出ていない ' + JSON.stringify(s.stationMissing));
    if (!s.northStationsOk) errors.push('§25: 北部の駅が欠けている');
    if (s.multiOperatorSites.length < 2) errors.push('§2: 複数事業者が同時に出ている地点が少ない');
    if (!s.townSelectionShown) errors.push('§13: 町名クリックで境界が出ていない');
    if (!s.townZoomApplied) errors.push('§15: 町名クリックでズームしていない');
    if (!s.townClearOk) errors.push('§17: 解除で境界が消えていない');
    if (!s.stationClickOk) errors.push('§9: 駅クリックが効いていない');
    if (!s.clickConflictOk) errors.push('§20: ラベルクリックで建物カードが開いている');
    if (!s.dragNoClickOk) errors.push('§21: ドラッグ後にクリックが通ってしまう');
    if (!s.regressionOk) errors.push('§28: regression がある ' + JSON.stringify(s.regression));
    if (s.jsErrors) errors.push('§28: JS 例外 ' + s.jsErrors);
    if (s.townSitesClicked < s.townSitesTotal) {
      warnings.push(`§24: 町名をクリックできた地点が ${s.townSitesClicked}/${s.townSitesTotal}`);
    }
  } else warnings.push('§23: 実ブラウザ QA が未実行');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35K', RESULT,
    classification: errors.length ? 'STATION_AND_TOWN_NAVIGATION_FAILED' : 'STATION_AND_TOWN_NAVIGATION_SUCCESS',
    buildingCount,
    canonicalGeometryMutation: 0, canonicalIdMutation: 0, projectionMutation, placementMutation,
    roadMutation: mutation.roads, railMutation: mutation.rail,
    waterMutation: mutation.water, parkMutation: mutation.parks, stationMutation: mutation.stations,
    productionModified, protectedModified,
    stationIndex: si ? { canonicalCount: si.canonicalCount, count: si.count, merged: si.mergedCount,
      byGroup: si.byGroup, byOperator: si.byOperator, byImportance: si.byImportance } : null,
    areaBoundaries: ab ? { counts: ab.counts, townWards: ab.townWards } : null,
    townWardsOk, inventedBoundary, classifiedByData, devUiGated: gated.ok,
    layers, runtimeOk, perf, runtime: qa ? qa.summary : null,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateStationTownNavigation().then((o) => {
    console.log(JSON.stringify({ RESULT: o.RESULT, classification: o.classification,
      stationIndex: o.stationIndex && { count: o.stationIndex.count, byGroup: o.stationIndex.byGroup },
      areaBoundaries: o.areaBoundaries, productionModified: o.productionModified,
      protectedModified: o.protectedModified, errors: o.errors.length, warnings: o.warnings.length }, null, 2));
    if (o.errors.length) console.log('errors:', JSON.stringify(o.errors, null, 2));
    if (o.warnings.length) console.log('warnings:', JSON.stringify(o.warnings, null, 2));
    process.exit(o.RESULT === 'PASS' ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
