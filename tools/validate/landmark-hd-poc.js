#!/usr/bin/env node
// tools/validate/landmark-hd-poc.js
// [Mission 33E 検証項目] ランドマーク高精細レイヤー（PoC: 大阪城）の検証。
//   layerSeparated / configComplete / provenanceOk
//   hdMoreDetailedThanLod1 = true / doubleDisplayCount = 0 / distanceSwitchWorks = true
//   pickingWorks = true / cardFakeValues = 0
//   buildingMutation = 0 / roadMutation = 0 / projectionMutation = 0
//   productionModified = false / protectedModified = false
//   → LANDMARK_HD_POC_SUCCESS / LANDMARK_HD_POC_FAILED
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
  models: P('public', 'map-data', 'osaka-city', 'landmarks', 'landmark-models.json'),
  scan: P('data', 'reports', 'osaka-castle-source-scan.json'),
  qa: P('data', 'reports', 'landmark-hd-qa.json'),
  build: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  canonManifest: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'),
  out: P('data', 'reports', 'landmark-hd-poc-validation.json'),
};
const FROZEN_BUILDINGS = [
  'data/processed/osaka-city/canonical/buildings-v2-osmv2/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/near/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/mid/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/far/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/building-placement/manifest.json',
];
const ROAD_V3 = ['data/processed/osaka-city/derived/road-visual-v3', 'public/map-data/osaka-city/derived/road-visual-v3'];
// §2 設定ファイルに必ず入っている項目
export const REQUIRED_CONFIG_FIELDS = ['landmarkId', 'name', 'anchor', 'extent', 'sourceType', 'swapRadiusM', 'visibleDistanceM', 'parts'];
// LOD1 の箱（8 頂点の押し出し = 側面 16 + 上面 8 程度）に対して、HD がどれだけ細かいか（§検証 1）
export const LOD1_TRIANGLE_BASELINE = 24;
export const MIN_DETAIL_RATIO = 10;
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

export async function validateLandmarkHdPoc() {
  const errors = [], warnings = [];
  const html = fs.readFileSync(F.dev, 'utf-8');
  const models = rj(F.models);
  const qa = rj(F.qa);
  const scan = rj(F.scan);
  const missionStart = Date.parse((rj(F.build) || {}).generatedAt || new Date().toISOString());

  // ── 最重要原則: 通常の都市データは触らない ──
  const touched = FROZEN_BUILDINGS.filter((r) => { try { return fs.statSync(P(r)).mtimeMs > missionStart; } catch { return true; } });
  const buildingMutation = touched.length + ((rj(F.canonManifest) || {}).featureCount === 600764 ? 0 : 1);
  if (buildingMutation) errors.push('建物データが変わっている ' + JSON.stringify(touched));
  const roadMutation = ROAD_V3.filter((d) => newestMtime(P(d)) > missionStart).length;
  if (roadMutation) errors.push('ROAD V3 の出力が変わっている');
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = (proj.type === 'local-equirectangular' && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 0 : 1;
  if (projectionMutation) errors.push('projection が変わっている');

  const buildRec = rj(F.build) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = buildRec.productionSha256 ? sha(F.prod) !== buildRec.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('production HTML が変更されている（33E は development のみ）');
  if (protectedModified !== false) errors.push('protected HTML が変更されている');

  // ── §1 専用レイヤーが独立していること ──
  const layerSeparated = /const LandmarkHDLayer = \(function \(\) \{/.test(html)
    && /group\.name = 'LandmarkHDLayer';/.test(html)
    && /if \(typeof canonicalRoot !== 'undefined'\) canonicalRoot\.add\(group\);/.test(html)
    && /const LandmarkLayer = \(function \(\) \{/.test(html);   // 旧レイヤーは消さない
  if (!layerSeparated) errors.push('§1: 独立レイヤーが canonicalRoot 配下に無い / 旧 LandmarkLayer が消えている');
  const runtimeOwnerTagged = /tagRuntimeOwnerRecursive\(group, RUNTIME_OWNER\.CANONICAL\)/.test(html);
  if (!runtimeOwnerTagged) errors.push('§1: runtime owner のタグ付けが無い');
  // §3 抑制は「描くかどうか」だけで、canonical geometry/placement は触らない
  const suppressionIsRenderOnly = /if \(typeof LandmarkHDLayer !== 'undefined' && LandmarkHDLayer\.isSuppressedBuilding\(f\.canonicalId\)\) \{/.test(html)
    && /landmarkHdFp\.set\(f\.canonicalId/.test(html)
    && /function invalidateLandmarkHdTiles\(\) \{/.test(html);
  if (!suppressionIsRenderOnly) errors.push('§3: 建物抑制の実装（描画時のみ / footprint 保持 / tile 作り直し）が無い');
  // §5 UI
  const uiToggle = /landmarkHdBtn\.id = 'landmark-hd-toggle';/.test(html) && /'\[LANDMARK HD\] '/.test(html);
  if (!uiToggle) errors.push('§5: [LANDMARK HD] トグルが無い');
  // §6 picking
  const pickingWired = /window\.__LANDMARK_HD_LAYER__\.pick\(ray\)/.test(html)
    && /CanonicalRuntime\.buildingDataById\(lm\.canonicalId\)/.test(html);
  if (!pickingWired) errors.push('§6: HD の picking が property card へつながっていない');
  // HTML にランドマーク名や寸法をハードコードしていないこと（設定は JSON 側）
  const noHardcodedLandmark = !/['"]大阪城['"]/.test(html.slice(html.indexOf('const LandmarkHDLayer'), html.indexOf('const CanonicalRuntime')));
  if (!noHardcodedLandmark) errors.push('§2: HTML にランドマーク名がハードコードされている');

  // ── §2 設定ファイル ──
  let configComplete = false, provenanceOk = false, detailRatio = null, castle = null;
  if (!models) errors.push('§2: landmark-models.json が無い');
  else {
    const lms = models.landmarks || [];
    configComplete = lms.length > 0 && lms.every((l) => REQUIRED_CONFIG_FIELDS.every((k) => l[k] !== undefined && l[k] !== null));
    if (!configComplete) errors.push('§2: 設定の必須項目が欠けている');
    castle = lms.find((l) => l.landmarkId === 'osaka-castle') || null;
    if (!castle) errors.push('§2: 大阪城の設定が無い');
    else {
      // §7 出所がデータ自身に入っていること（どこまで実データかを後から追える）
      const s = castle.sources || {};
      provenanceOk = !!(s.footprint && s.footprint.source === 'osm' && s.footprint.id
        && s.totalHeightM && s.totalHeightM.canonicalId && Number.isFinite(s.totalHeightM.value)
        && s.stylized && typeof s.stylized.note === 'string');
      if (!provenanceOk) errors.push('§7: モデルの出所（実データ / 様式化）が設定に入っていない');
      // 高さは canonical の実測値と一致していること（勝手な数値を作っていない）
      const keep = ((scan || {}).canonicalBuildings || {}).keepCandidates || [];
      if (keep.length && castle.heights.totalM !== keep[0].heightM) errors.push('§4: 全高が canonical 実測値と違う');
      if (keep.length && castle.pickCanonicalId !== keep[0].canonicalId) errors.push('§6: pickCanonicalId が天守棟と違う');
      const tri = (castle.parts || []).reduce((s2, p) => s2 + (p.triangleCount || 0), 0);
      detailRatio = +(tri / LOD1_TRIANGLE_BASELINE).toFixed(1);
    }
  }
  const hdMoreDetailedThanLod1 = detailRatio !== null && detailRatio >= MIN_DETAIL_RATIO;
  if (!hdMoreDetailedThanLod1) errors.push('§検証: HD が LOD1 より明確に高精細でない（比 ' + detailRatio + '）');

  // ── 実ブラウザ QA ──
  let doubleDisplayCount = null, distanceSwitchWorks = null, pickingWorks = null, cardFakeValues = null, perf = [];
  if (!qa) {
    errors.push('§検証: landmark-hd-qa.json が無い');
  } else {
    if ((qa.errors || []).length) errors.push('ブラウザ例外 ' + JSON.stringify(qa.errors.slice(0, 3)));
    // 二重表示: HD ON のとき天守の真上から撃った ray が HD に当たり、通常建物には当たらないこと
    const onHits = ((qa.on || {}).double || {}).topDownHits || [];
    const firstOn = onHits[0] ? onHits[0].name : '';
    const hdFirst = /^LandmarkHD_/.test(firstOn);
    const crBuildingInOn = onHits.filter((h) => h.root === 'CanonicalRuntimeRoot').length;
    doubleDisplayCount = crBuildingInOn;
    if (!hdFirst) errors.push('§3: HD ON なのに天守の最前面が HD モデルでない: ' + firstOn);
    if (doubleDisplayCount > 0) errors.push('§3: HD と LOD1 が二重に出ている: ' + doubleDisplayCount);
    const sup = ((qa.on || {}).hd || {}).suppressedBuildings || [];
    if (sup.length !== 1) errors.push('§3: 抑制した棟数が 1 でない: ' + sup.length);
    // HD OFF では従来の建物が戻ること
    const offHits = ((qa.off || {}).double || {}).topDownHits || [];
    if (offHits.some((h) => /^LandmarkHD_/.test(h.name))) errors.push('§5: HD OFF なのに HD モデルが残っている');
    if (((((qa.off || {}).hd || {}).suppressedBuildings) || []).length) errors.push('§5: HD OFF なのに建物を抑制したまま');
    // §検証 見た目が明確に変わる（色数が増える）
    const onColors = ((qa.on || {}).pixels || {}).distinctColors || 0;
    const offColors = ((qa.off || {}).pixels || {}).distinctColors || 0;
    if (!(onColors > offColors)) warnings.push('§検証: HD ON/OFF で画面の色数が増えていない ' + onColors + ' / ' + offColors);
    // legacy residual
    if ((qa.on || {}).residual !== 0 || (qa.off || {}).residual !== 0) errors.push('legacy residual が 0 でない');
    // §3 距離による切替
    const ds = qa.distanceSwitch || [];
    const vis = castle ? castle.visibleDistanceM : 2600;
    const near = ds.filter((d) => d.cameraR <= vis);
    const far = ds.filter((d) => d.cameraR > vis);
    distanceSwitchWorks = near.length > 0 && far.length > 0 && near.every((d) => d.hdVisible === true) && far.every((d) => d.hdVisible === false);
    if (!distanceSwitchWorks) errors.push('§3: camera 距離での切替が効いていない ' + JSON.stringify(ds));
    // 遠景では抑制も解除されていること（従来建物が戻る）
    if (far.some((d) => d.suppressed > 0)) errors.push('§3: 遠景で建物を抑制したままになっている');
    // §6 picking
    const pk = qa.pick || {};
    pickingWorks = pk.onScreen === true && pk.cardDisplay === 'block' && pk.hover === 'block' && pk.matchesPickCanonicalId === true;
    if (!pickingWorks) errors.push('§6: HD をクリックしても card が正しく出ない ' + JSON.stringify(pk));
    cardFakeValues = (pk.fakeValues || []).length;
    if (cardFakeValues > 0) errors.push('§6: card に仮の値が出ている ' + JSON.stringify(pk.fakeValues));
    if (castle && pk.title && !pk.title.includes(castle.name)) warnings.push('§6: card の見出しにランドマーク名が出ていない: ' + pk.title);
    // §7 性能（HD ON / OFF）
    perf = (qa.performance || []).filter((p) => p.hd).map((p) => {
      const off = (qa.performance || []).find((q) => !q.hd && q.site === p.site);
      return { site: p.site, siteName: p.siteName,
        fpsOn: p.fpsAverage, fpsOff: off ? off.fpsAverage : null,
        drawCallsOn: p.drawCallsAvg, drawCallsOff: off ? off.drawCallsAvg : null,
        trianglesOn: p.trianglesAvg, trianglesOff: off ? off.trianglesAvg : null };
    });
    const bad = perf.filter((p) => p.fpsOff != null && p.fpsOn < p.fpsOff * 0.9);
    if (bad.length) warnings.push('§7: HD ON で FPS が 10% 以上落ちた地点 ' + JSON.stringify(bad.map((p) => [p.site, p.fpsOff, p.fpsOn])));
    // HD 対象外の地点では描画コストが増えていないこと
    const unrelated = perf.filter((p) => p.site !== 'osakacastle' && p.drawCallsOff != null);
    if (unrelated.some((p) => p.drawCallsOn !== p.drawCallsOff)) errors.push('§7: HD 対象外の地点で draw call が変わっている');
  }

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '33E', RESULT,
    classification: errors.length ? 'LANDMARK_HD_POC_FAILED' : 'LANDMARK_HD_POC_SUCCESS',
    layerSeparated, runtimeOwnerTagged, suppressionIsRenderOnly, uiToggle, pickingWired, noHardcodedLandmark,
    configComplete, provenanceOk, hdMoreDetailedThanLod1, detailRatio, lod1TriangleBaseline: LOD1_TRIANGLE_BASELINE,
    doubleDisplayCount, distanceSwitchWorks, pickingWorks, cardFakeValues,
    buildingMutation, roadMutation, projectionMutation, productionModified, protectedModified,
    castle: castle ? {
      landmarkId: castle.landmarkId, name: castle.name, anchor: castle.anchor, extent: castle.extent,
      heights: castle.heights, swapRadiusM: castle.swapRadiusM, visibleDistanceM: castle.visibleDistanceM,
      pickCanonicalId: castle.pickCanonicalId, suppressBuildingIds: castle.suppressBuildingIds,
      triangles: (castle.parts || []).reduce((s, p) => s + p.triangleCount, 0),
      parts: (castle.parts || []).map((p) => ({ material: p.material, triangles: p.triangleCount })),
      sources: castle.sources,
    } : null,
    distanceSwitch: qa ? qa.distanceSwitch : null,
    pick: qa ? qa.pick : null,
    performance: perf,
    visual: qa ? { onColors: ((qa.on || {}).pixels || {}).distinctColors, offColors: ((qa.off || {}).pixels || {}).distinctColors,
      onTopDownHits: ((qa.on || {}).double || {}).topDownHits, offTopDownHits: ((qa.off || {}).double || {}).topDownHits,
      shots: [(qa.on || {}).shot, (qa.off || {}).shot].concat((qa.views || []).map((v) => v.shot)).filter(Boolean) } : null,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateLandmarkHdPoc().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
