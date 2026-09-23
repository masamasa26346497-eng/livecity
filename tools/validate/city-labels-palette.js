#!/usr/bin/env node
// tools/validate/city-labels-palette.js
// [Mission 33A] 地名・駅名・主要施設ラベル + 配色改善の検証。
//   labelDataReady / labelsVisibleAtAllSites / labelOverlapPairs / paletteBrighter / paletteMoreVivid
//   buildingGeometryMutation = 0 / roadV3Mutation = 0 / projectionMutation = 0 / placementMutation = 0
//   productionModified = false / protectedModified = false（33A は development のみ）
//   → CITY_LABELS_PALETTE_SUCCESS / CITY_LABELS_PALETTE_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  qa: P('data', 'reports', 'city-label-palette-qa.json'),
  places: P('public', 'map-data', 'osaka-city', 'derived', 'place-labels.json'),
  landmarks: P('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'),
  stations: P('public', 'map-data', 'osaka-city', 'derived', 'rail-stations.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  cutoverBuild: P('data', 'reports', 'production-cutover-build.json'),
  canonManifest: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'),
  out: P('data', 'reports', 'city-labels-palette-validation.json'),
};
const FROZEN_BUILDINGS = [
  'data/processed/osaka-city/canonical/buildings-v2-osmv2/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/near/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/mid/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/far/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/building-placement/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/building-ward-index.json',
];
const ROAD_V3 = ['data/processed/osaka-city/derived/road-visual-v3', 'public/map-data/osaka-city/derived/road-visual-v3'];
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function newestMtime(dir) {
  let m = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const q = path.join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newestMtime(q) : fs.statSync(q).mtimeMs);
  }
  return m;
}
function gitClean(rel) {
  try { return execFileSync('git', ['status', '--porcelain', '--', rel], { cwd: resolveProjectPath('.'), encoding: 'utf-8' }).trim() === ''; } catch { return null; }
}

export async function validateCityLabelsPalette() {
  const errors = [], warnings = [];
  const qa = rj(F.qa);
  const html = fs.readFileSync(F.dev, 'utf-8');
  // mission 開始時刻の基準: 32U の cutover build（これ以降に建物データが変わっていないこと）
  const missionStart = Date.parse((rj(F.cutoverBuild) || {}).generatedAt || new Date().toISOString());

  // ── 変更禁止（建物 / ROAD V3 / 投影 / placement）──
  const touched = FROZEN_BUILDINGS.filter((r) => { try { return fs.statSync(P(r)).mtimeMs > missionStart; } catch { return true; } });
  const buildingCount = (rj(F.canonManifest) || {}).featureCount;
  const buildingGeometryMutation = touched.length + (buildingCount === 600764 ? 0 : 1);
  if (buildingGeometryMutation) errors.push('§制約: 建物データ（V2 / OSM fallback V2 / placement / ward index）が変わっている ' + JSON.stringify(touched));
  const roadV3Mutation = ROAD_V3.filter((d) => newestMtime(P(d)) > missionStart).length;
  if (roadV3Mutation) errors.push('§制約: ROAD V3 の出力が変わっている');
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = (proj.type === 'local-equirectangular' && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 0 : 1;
  if (projectionMutation) errors.push('§制約: projection / origin が変わっている');

  // ── production / protected は触らない（33A は development のみ）──
  const baseline = rj(F.baseline) || {};
  const build = rj(F.cutoverBuild) || {};
  const productionModified = build.productionSha256 ? sha(F.prod) !== build.productionSha256 : (gitClean('public/osaka_3d_buildings.html') === false);
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : (gitClean('public/osaka_3d_buildings.fullward-v3.html') === false);
  if (productionModified) errors.push('§進め方: production HTML が変更されている（33A は development のみ）');
  if (protectedModified) errors.push('§制約: protected HTML が変更されている');

  // ── ラベルデータ ──
  const places = rj(F.places), landmarks = rj(F.landmarks), stations = rj(F.stations);
  const placeCount = places ? (places.places || []).length : 0;
  const landmarkCount = landmarks ? (landmarks.landmarks || []).length : 0;
  const stationCount = stations ? (stations.stations || []).length : 0;
  const labelDataReady = placeCount > 100 && landmarkCount > 0 && stationCount > 200;
  if (!labelDataReady) errors.push(`ラベルデータが足りない（地名 ${placeCount} / ランドマーク ${landmarkCount} / 駅 ${stationCount}）`);
  const placeBboxOk = !places || (places.places || []).every((p) => Number.isFinite(p.x) && Number.isFinite(p.z)
    && p.x >= -16900 - 2000 && p.x <= 7100 + 2000 && p.z >= -18600 - 2000 && p.z <= 2300 + 2000 && p.name && !/�/.test(p.name));
  if (!placeBboxOk) errors.push('地名ラベルに範囲外 / 文字化けがある');

  // ── HTML 実装（ラベル層 + 配色 v2）──
  const hasLayer = /const CityLabelLayer = \(function \(\) \{/.test(html);
  const hasPriority = /優先順位: ランドマーク > 区名\/駅 > 地名 > 公園/.test(html) && /const rank = item\.kind === 'landmark'/.test(html);
  const hasCollision = /const hits = \(c, q\) =>/.test(html) && /const DENSITY_CAP = \{ far: \d+, mid: \d+, near: \d+ \};/.test(html);
  const hasLazySprite = /function getSprite\(item\)/.test(html) && /texCache\.has\(key\)/.test(html);
  const hasThrottle = /const THROTTLE_MS = 200;/.test(html) && /if \(!dirty && key === lastKey\) return;/.test(html);
  const hasToggle = /window\.__CITY_LABEL_TOGGLE__/.test(html) && /key: 'placeLabels'/.test(html) && /key: 'landmarkLabels'/.test(html);
  const labelImplementationOk = hasLayer && hasPriority && hasCollision && hasLazySprite && hasThrottle && hasToggle;
  if (!labelImplementationOk) errors.push('ラベル層の実装が不足 ' + JSON.stringify({ hasLayer, hasPriority, hasCollision, hasLazySprite, hasThrottle, hasToggle }));

  const paletteChanged = /const MS_BG_NEUTRAL = 0xf6f7f3;/.test(html)
    && /water: 0x63bfe4, waterHarbor: 0x55a9d0,/.test(html)
    && /parkReal: 0x9bd589, parkGreen: 0x8fcd7b, grass: 0xc9e7b6,/.test(html)
    && /const CR_USAGE_WHITEN = \{ far: 0\.46, mid: 0\.20, near: 0\.06 \};/.test(html)
    && /const CR_VIVID = \{ sat: 1\.24, light: 1\.03 \};/.test(html)
    && /const CR_STYLE = \{ exposure: 0\.93, hemi: 0\.74, sun: 1\.28, fill: 0\.26 \};/.test(html);
  if (!paletteChanged) errors.push('配色 v2 の定数が入っていない');
  // 建物 geometry に触れていないこと（形状・高さ・位置に関わる関数は変更しない）
  const geometryUntouched = /pushExtrude\(byCat\.get\(cat\), f\.geometryType, f\.coordinates, h\);/.test(html)
    && /const h = Math\.max\(2, \+a\.heightM \|\| 6\);/.test(html);
  if (!geometryUntouched) errors.push('建物 geometry の組み立てが変わっている');

  // ── 実ブラウザ QA ──
  let labelsVisibleAtAllSites = null, labelOverlapPairs = null, paletteBrighter = null, paletteMoreVivid = null, perf = null, sites = [], sitesWithoutRichLabels = [];
  if (!qa) {
    warnings.push('city-label-palette-qa.json が無い（実ブラウザ確認をしていない）');
  } else {
    sites = (qa.comparison || []).map((c) => ({
      site: c.site, siteName: c.siteName,
      luminance: c.luminance, saturation: c.saturation,
      labels: c.labelsAfter, names: (c.labelsAfter && c.labelsAfter.names) || [],
    }));
    const after = qa.runs && qa.runs.after ? qa.runs.after.sites : [];
    // 6 地点すべてで何らかのラベルが出ていること。加えて、データのある地点では駅名 + 地名/施設が出ること。
    //   （大阪市北部は OSM 抽出の範囲外で place / station ノードが無く、区名・公園名しか出せない）
    const labelCount = (s) => (s.labels && s.labels.city) ? s.labels.city.visible : 0;
    const richSites = after.filter((s) => s.labels && s.labels.city && s.labels.city.visibleStations >= 1
      && (s.labels.city.visiblePlaces + s.labels.city.visibleLandmarks) >= 1);
    sitesWithoutRichLabels = after.filter((s) => !richSites.includes(s)).map((s) => s.site);
    labelsVisibleAtAllSites = after.length === 6 && after.every((s) => labelCount(s) >= 1) && richSites.length >= 5;
    if (!labelsVisibleAtAllSites) errors.push('ラベルが出ていない地点がある ' + JSON.stringify(after.map((s) => [s.site, labelCount(s), s.labels && s.labels.city && s.labels.city.visibleStations])));
    if (sitesWithoutRichLabels.length) warnings.push('地名・駅名の元データが無く、区名/公園名だけの地点: ' + JSON.stringify(sitesWithoutRichLabels) + '（OSM 抽出の北端 34.735° より北）');
    labelOverlapPairs = after.reduce((m, s) => Math.max(m, s.labels ? s.labels.overlapPairs : 0), 0);
    if (labelOverlapPairs > 2) errors.push(`ラベルが重なっている（最大 ${labelOverlapPairs} 組）`);
    paletteBrighter = (qa.comparison || []).every((c) => c.luminance.after >= c.luminance.before);
    paletteMoreVivid = (qa.comparison || []).every((c) => c.saturation.after >= c.saturation.before);
    if (!paletteBrighter) errors.push('明るくなっていない地点がある ' + JSON.stringify((qa.comparison || []).map((c) => [c.site, c.luminance.before, c.luminance.after])));
    if (!paletteMoreVivid) warnings.push('彩度が上がっていない地点がある ' + JSON.stringify((qa.comparison || []).map((c) => [c.site, c.saturation.before, c.saturation.after])));
    const residualMax = after.reduce((m, s) => Math.max(m, s.residual || 0), 0);
    if (residualMax !== 0) errors.push('legacy residual が 0 でない: ' + residualMax);
    if ((qa.runs.after.errors || []).length) errors.push('ブラウザ例外が出ている ' + JSON.stringify(qa.runs.after.errors.slice(0, 3)));
    perf = { before: qa.runs.before.performance, after: qa.runs.after.performance };
    if (perf.before && perf.after && perf.after.fpsAverage < perf.before.fpsAverage * 0.9) {
      warnings.push(`ラベル追加で FPS が 10% 以上落ちている（${perf.before.fpsAverage} → ${perf.after.fpsAverage}）`);
    }
  }

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '33A', RESULT,
    classification: errors.length ? 'CITY_LABELS_PALETTE_FAILED' : 'CITY_LABELS_PALETTE_SUCCESS',
    labelDataReady, placeCount, landmarkCount, stationCount, placeBboxOk,
    labelImplementationOk, paletteChanged, geometryUntouched,
    labelsVisibleAtAllSites, labelOverlapPairs, sitesWithoutRichLabels, paletteBrighter, paletteMoreVivid,
    buildingGeometryMutation, roadV3Mutation, projectionMutation,
    productionModified, protectedModified,
    performance: perf, sites, errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateCityLabelsPalette().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
