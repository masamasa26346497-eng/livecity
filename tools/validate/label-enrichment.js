#!/usr/bin/env node
// tools/validate/label-enrichment.js
// [Mission 33C §27] 地名・駅・ランドマーク・河川ラベル拡充の検証。
//   buildingMutation = 0 / roadMutation = 0 / waterMutation = 0 / projectionMutation = 0
//   cityLabelLayerActive = true
//   northStationCoverageImproved = true（＝北部で地名/駅ラベルが出るようになったか）
//   landmarkCountIncreased = true / riverLabelsCreated = true
//   nearOverlapCount = 0 / productionModified = false / protectedModified = false
//   → OSAKA_LABEL_ENRICHMENT_SUCCESS / OSAKA_LABEL_ENRICHMENT_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  qa: P('data', 'reports', 'label-enrichment-qa.json'),
  build: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  canonManifest: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'),
  labelsDir: P('public', 'map-data', 'osaka-city', 'labels'),
  oldLandmarks: P('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'),
  water: P('data', 'processed', 'osaka-city', 'canonical', 'water'),
  out: P('data', 'reports', 'label-enrichment-validation.json'),
};
const FROZEN_BUILDINGS = [
  'data/processed/osaka-city/canonical/buildings-v2-osmv2/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/near/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/mid/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/far/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/building-placement/manifest.json',
];
const ROAD_V3 = ['data/processed/osaka-city/derived/road-visual-v3', 'public/map-data/osaka-city/derived/road-visual-v3'];
// 北部（緯度 34.735 相当 = z < -14550）の地点。ここでラベルが出るようになったかを見る
export const NORTH_SITES = ['shinosaka', 'awaji'];
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

export async function validateLabelEnrichment() {
  const errors = [], warnings = [];
  const qa = rj(F.qa);
  const after = qa && qa.phases ? qa.phases.after : null;
  const before = qa && qa.phases ? qa.phases.before : null;
  const html = fs.readFileSync(F.dev, 'utf-8');
  const missionStart = Date.parse((rj(F.build) || {}).generatedAt || new Date().toISOString());

  // ── §0 変更禁止（建物 / 道路 / 水域 / 投影） ──
  const touched = FROZEN_BUILDINGS.filter((r) => { try { return fs.statSync(P(r)).mtimeMs > missionStart; } catch { return true; } });
  const buildingMutation = touched.length + ((rj(F.canonManifest) || {}).featureCount === 600764 ? 0 : 1);
  if (buildingMutation) errors.push('§0: 建物データが変わっている ' + JSON.stringify(touched));
  const roadMutation = ROAD_V3.filter((d) => newestMtime(P(d)) > missionStart).length;
  if (roadMutation) errors.push('§0: ROAD V3 の出力が変わっている');
  const waterMutation = newestMtime(F.water) > missionStart ? 1 : 0;
  if (waterMutation) errors.push('§0: canonical water が変わっている');
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = (proj.type === 'local-equirectangular' && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 0 : 1;
  if (projectionMutation) errors.push('§0: projection が変わっている');

  // ── §32 production / protected は触らない ──
  const buildRec = rj(F.build) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = buildRec.productionSha256 ? sha(F.prod) !== buildRec.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('§32: production HTML が変更されている（33C は development のみ）');
  if (protectedModified !== false) errors.push('§0: protected HTML が変更されている');

  // ── §26 データセット ──
  const places = rj(path.join(F.labelsDir, 'place-labels.json'));
  const landmarks = rj(path.join(F.labelsDir, 'landmark-labels.json'));
  const rivers = rj(path.join(F.labelsDir, 'river-labels.json'));
  const stations = rj(path.join(F.labelsDir, 'station-labels.json'));
  const oldLandmarks = rj(F.oldLandmarks);
  const datasetsPresent = !!(places && landmarks && rivers && stations);
  if (!datasetsPresent) errors.push('§26: labels/ のデータセットが揃っていない');
  const counts = {
    places: places ? places.places.length : 0,
    placesBySource: places ? places.counts.bySource : null,
    landmarks: landmarks ? landmarks.landmarks.length : 0,
    landmarksByTier: landmarks ? landmarks.counts.byTier : null,
    rivers: rivers ? rivers.rivers.length : 0,
    riversByImportance: rivers ? rivers.counts.byImportance : null,
    stations: stations ? stations.stations.length : 0,
    landmarksBefore: oldLandmarks ? (oldLandmarks.landmarks || []).length : 0,
  };
  // §7 provenance
  const provenanceOk = !!places && places.places.every((p) => p.source && p.id && Number.isFinite(p.x) && Number.isFinite(p.z))
    && !!landmarks && landmarks.landmarks.every((l) => l.source && l.sourceId && l.tier && l.zoomBand && Number.isFinite(l.priority))
    && !!rivers && rivers.rivers.every((r) => r.source && Number.isFinite(r.angle) && r.importance);
  if (!provenanceOk) errors.push('§7: provenance（source / sourceId / tier / zoomBand）が揃っていない');
  const landmarkCountIncreased = counts.landmarks > counts.landmarksBefore;
  if (!landmarkCountIncreased) errors.push(`§6: ランドマークが増えていない（${counts.landmarksBefore} → ${counts.landmarks}）`);
  const riverLabelsCreated = counts.rivers > 0 && (counts.riversByImportance || {}).major > 0;
  if (!riverLabelsCreated) errors.push('§10: 河川ラベルが作られていない');
  // 北部の地名が入ったか（データ側）
  const northPlaces = places ? places.places.filter((p) => p.z < -14000) : [];
  const northPlacesCount = northPlaces.length;
  if (northPlacesCount < 10) errors.push('§3: 北部の地名データが不足している: ' + northPlacesCount);
  // 駅はハードコードしていない（canonical と同数）
  const stationsFromCanonical = counts.stations === 233 && stations.stations.every((s) => s.source === 'canonical-rail-stations');
  if (!stationsFromCanonical) errors.push('§4: 駅データが canonical 由来でない / 件数が違う');

  // ── HTML 実装 ──
  const cityLabelLayerActive = /const CityLabelLayer = \(function \(\) \{/.test(html)
    && /const RIVER_URL = 'map-data\/osaka-city\/labels\/river-labels\.json';/.test(html)
    && /CityLabelLayer\.show\(\);   \/\/ 通常表示に統合/.test(html);
  if (!cityLabelLayerActive) errors.push('§20: CityLabelLayer が河川データを含めて有効になっていない');
  const tierLod = /if \(item\.kind === 'landmark'\) return item\.tier === 'S' \? true : \(item\.tier === 'A' \? b !== 'far' : b === 'near'\);/.test(html);
  const riverLod = /if \(item\.kind === 'river'\) return item\.importance === 'major'/.test(html);
  const riverRotation = /if \(c\.item\.kind === 'river'\) rec\.sprite\.material\.rotation = screenAngleOf\(c\.item\);/.test(html);
  const cameraMatrixKept = /camera\.updateMatrixWorld\(\);/.test(html);
  if (!tierLod || !riverLod) errors.push('§14: tier / 河川の zoom band が実装されていない');
  if (!riverRotation) errors.push('§11: 河川ラベルが流路に沿っていない');
  if (!cameraMatrixKept) errors.push('§19: camera.updateMatrixWorld() が失われている');
  const legacyStationDormant = !/^StationLabelLayer\.show\(\);/m.test(html) && /if \(allowShow\) scene\.add\(group\);/.test(html);
  if (!legacyStationDormant) errors.push('§20: 旧 StationLabelLayer が休止していない');

  // ── §28 実ブラウザ QA ──
  let nearOverlapCount = null, northStationCoverageImproved = null, sites = [];
  if (!after) {
    errors.push('§28: label-enrichment-qa.json（phase=after）が無い');
  } else {
    sites = after.sites.map((s) => ({
      site: s.site, siteName: s.siteName,
      total: s.labels.city ? s.labels.city.visible : 0,
      place: s.labels.city ? s.labels.city.visiblePlaces : 0,
      station: s.labels.city ? s.labels.city.visibleStations : 0,
      landmark: s.labels.city ? s.labels.city.visibleLandmarks : 0,
      river: s.labels.city ? (s.labels.city.visibleRivers || 0) : 0,
      ward: s.labels.city ? s.labels.city.visibleWards : 0,
      park: s.labels.city ? s.labels.city.visibleParks : 0,
      overlapPairs: s.labels.overlapPairs, severeOverlaps: s.labels.severeOverlaps,
      minLabelPx: s.labels.labelPx ? s.labels.labelPx.min : null,
      residual: s.residual,
    }));
    if (sites.length !== 11) errors.push('§22: QA 地点が 11 か所そろっていない: ' + sites.length);
    nearOverlapCount = sites.reduce((m, s) => Math.max(m, s.overlapPairs || 0), 0);
    if (nearOverlapCount > 0) errors.push('§17: 近景でラベルが重なっている: ' + nearOverlapCount);
    const severe = Math.max(...sites.map((s) => s.severeOverlaps || 0), (after.cityMode && after.cityMode.labels.severeOverlaps) || 0);
    if (severe > 0) errors.push('§17: 完全重複がある: ' + severe);
    const tooSmall = sites.filter((s) => s.minLabelPx !== null && s.minLabelPx < 8);
    if (tooSmall.length) errors.push('§9: 読めない大きさのラベルがある ' + JSON.stringify(tooSmall.map((s) => [s.site, s.minLabelPx])));
    if (sites.some((s) => s.residual !== 0)) errors.push('§0: legacy residual が 0 でない');
    if ((after.errors || []).length) errors.push('§28: ブラウザ例外 ' + JSON.stringify(after.errors.slice(0, 3)));
    // 北部: before（33B production）と after（33C dev）でラベル数を比べる
    const beforeNorth = before ? NORTH_SITES.map((id) => {
      const s = before.sites.find((q) => q.site === id);
      return { site: id, total: s && s.labels.city ? s.labels.city.visible : 0 };
    }) : [];
    const afterNorth = NORTH_SITES.map((id) => {
      const s = after.sites.find((q) => q.site === id);
      return { site: id, total: s && s.labels.city ? s.labels.city.visible : 0, place: s && s.labels.city ? s.labels.city.visiblePlaces : 0 };
    });
    northStationCoverageImproved = afterNorth.every((a) => a.total >= 3 && a.place >= 1)
      && (!beforeNorth.length || afterNorth.reduce((n, a) => n + a.total, 0) > beforeNorth.reduce((n, a) => n + a.total, 0));
    if (!northStationCoverageImproved) errors.push('§3: 北部のラベルが増えていない ' + JSON.stringify({ before: beforeNorth, after: afterNorth }));
    // §25 河川名トグル
    const rt = after.riverToggle;
    const riverToggleWorks = rt && typeof rt === 'object' && rt.before && rt.before.river > 0 && rt.off.river === 0 && rt.on.river === rt.before.river;
    if (!riverToggleWorks) warnings.push('§25: 河川名トグルの確認ができていない ' + JSON.stringify(rt));
    // §21 性能
    const perf = after.performance || [];
    if (perf.length < 4) warnings.push('§21: 性能計測が 4 条件そろっていない');
  }

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '33C', RESULT,
    classification: errors.length ? 'OSAKA_LABEL_ENRICHMENT_FAILED' : 'OSAKA_LABEL_ENRICHMENT_SUCCESS',
    buildingMutation, roadMutation, waterMutation, projectionMutation,
    cityLabelLayerActive, tierLod, riverLod, riverRotation, cameraMatrixKept, legacyStationDormant,
    datasetsPresent, provenanceOk, counts, northPlacesCount,
    landmarkCountIncreased, riverLabelsCreated, stationsFromCanonical,
    northStationCoverageImproved, nearOverlapCount,
    productionModified, protectedModified,
    sites, cityMode: after ? { labels: after.cityMode.labels.city, overlapPairs: after.cityMode.labels.overlapPairs, severeOverlaps: after.cityMode.labels.severeOverlaps, byKind: after.cityMode.labels.byKind } : null,
    performance: after ? after.performance : null,
    riverToggle: after ? after.riverToggle : null,
    comparison: qa ? qa.comparison : null,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateLabelEnrichment().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
