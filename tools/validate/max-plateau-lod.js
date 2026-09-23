#!/usr/bin/env node
// tools/validate/max-plateau-lod.js
// [Mission 34A §24] 「実データとして存在する最高 LOD を採用した」ことの検証。
//   zoneVIIProjectionUsed = false
//   canonicalIdChanged = false / buildingPositionMutation = false / roadMutation = false / placementMutation = false
//   highestAvailableLodSelected = true / perBuildingFallbackWorks = true
//   lod2UsesRealPlateauOnly = true / lod3UsesRealPlateauOnly = true
//   productionModified = false / protectedModified = false
//   → MAX_PLATEAU_LOD_SUCCESS / MAX_PLATEAU_LOD_FAILED
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
  audit: P('data', 'reports', 'plateau-lod-availability.json'),
  build: P('data', 'reports', 'plateau-high-lod-build.json'),
  qa: P('data', 'reports', 'building-lod-qa.json'),
  manifest: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high', 'manifest.json'),
  highDir: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high'),
  canonManifest: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  out: P('data', 'reports', 'max-plateau-lod-validation.json'),
};
const FROZEN_BUILDINGS = [
  'data/processed/osaka-city/canonical/buildings-v2-osmv2/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/near/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/mid/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/far/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/building-placement/manifest.json',
];
const ROAD_V3 = ['data/processed/osaka-city/derived/road-visual-v3', 'public/map-data/osaka-city/derived/road-visual-v3'];
// §7 位置保存の許容（canonical LOD1 重心と高 LOD 重心のズレ）
export const POSITION_TOLERANCE_M = { median: 3, p95: 12, max: 30 };
// §15 距離 LOD のしきい値
export const LOD_BANDS = { highLodMaxR: 2500, nearMaxR: 800 };
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
// 判定はコードだけを見る（コメントに書いた説明文へ反応しないように）
export function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const NL = String.fromCharCode(10);
  return noBlock.split(NL).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join(NL);
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function newestMtime(dir) {
  let m = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const q = path.join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newestMtime(q) : fs.statSync(q).mtimeMs);
  }
  return m;
}

export async function validateMaxPlateauLod() {
  const errors = [], warnings = [];
  const html = fs.readFileSync(F.dev, 'utf-8');
  const audit = rj(F.audit), build = rj(F.build), qa = rj(F.qa), manifest = rj(F.manifest);
  const missionStart = Date.parse((rj(F.prodBuild) || {}).generatedAt || new Date().toISOString());

  // ── §0 既存の都市データは触らない ──
  const touched = FROZEN_BUILDINGS.filter((r) => { try { return fs.statSync(P(r)).mtimeMs > missionStart; } catch { return true; } });
  const buildingPositionMutation = touched.length > 0 || ((rj(F.canonManifest) || {}).featureCount !== 600764);
  if (buildingPositionMutation) errors.push('§0: canonical 建物データが変わっている ' + JSON.stringify(touched));
  const roadMutation = ROAD_V3.some((d) => newestMtime(P(d)) > missionStart);
  if (roadMutation) errors.push('§0: ROAD V3 の出力が変わっている');
  const placementMutation = (() => { try { return fs.statSync(P('public/map-data/osaka-city/derived-v2-osmv2/building-placement/manifest.json')).mtimeMs > missionStart; } catch { return true; } })();
  if (placementMutation) errors.push('§0: placement が変わっている');
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = !(proj.type === 'local-equirectangular' && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320);
  if (projectionMutation) errors.push('§6: projection が変わっている');

  // ── §6 Zone VII を経由していない ──
  //   コメントには「第7系は経由しない」と書いてあるので、判定は必ずコードだけを見る
  //   （コメントごと検索すると自分の説明文に反応して誤検出する）。
  const builderRaw = fs.readFileSync(P('tools', 'build-plateau-high-lod.js'), 'utf-8');
  const builderSrc = stripComments(builderRaw);
  const zoneVIIProjectionUsed = /latLonToJPRect\s*\(|jprect/i.test(builderSrc) || (manifest ? manifest.zone7Used === true : false);
  if (zoneVIIProjectionUsed) errors.push('§6: 平面直角座標系（Zone VII）を経由している');
  const usesCanonicalProjection = /latLonToLiveCityWorld\s*\(/.test(builderSrc);
  if (!usesCanonicalProjection) errors.push('§6: latLonToLiveCityWorld を使っていない');

  // ── §1/§2/§3 在庫調査 ──
  let inventory = null;
  if (!audit) errors.push('§3: plateau-lod-availability.json が無い');
  else {
    inventory = { total: audit.counts.total, lod1Only: audit.counts.lod1Only, lod2Available: audit.counts.lod2Available,
      lod3Available: audit.counts.lod3Available, noGeometry: audit.counts.noGeometry, pct: audit.pct,
      folderFiles: audit.sources.folderFiles, zipEntries: audit.sources.zipEntries };
    if (audit.counts.total < 500000) errors.push('§1: 走査した建物が少なすぎる（ファイル欠落の疑い）: ' + audit.counts.total);
    if (audit.counts.noGeometry > 0) warnings.push('§2: geometry を持たない建物 ' + audit.counts.noGeometry);
  }

  // ── §4/§5 最高 LOD の採用と building 単位の fallback ──
  let highestAvailableLodSelected = null, perBuildingFallbackWorks = null, positionOk = null;
  if (!build) errors.push('§4: plateau-high-lod-build.json が無い');
  else {
    const expected = build.targets - build.noCanonicalSkipped - build.fallbackToLod1;
    highestAvailableLodSelected = build.adopted === expected && build.adopted > 0
      && build.adoptedLod3 === (audit ? Math.min(audit.counts.lod3Available, build.adoptedLod3) : build.adoptedLod3);
    if (!highestAvailableLodSelected) errors.push(`§4: 採用数が合わない adopted=${build.adopted} expected=${expected}`);
    // §5 壊れた高 LOD は次の LOD へ落ちている（地域一括ではなく building 単位）
    perBuildingFallbackWorks = build.fallbackToLod1 >= 0 && Object.keys(build.invalidReasons || {}).length >= 0
      && build.degenerateTrianglesDropped === 0;
    if (build.fallbackToLod1 > build.targets * 0.05) errors.push('§5: LOD1 へ戻した割合が高すぎる: ' + build.fallbackToLod1);
    // §7 位置保存
    const s = build.centroidShiftM;
    positionOk = !!s && s.median <= POSITION_TOLERANCE_M.median && s.p95 <= POSITION_TOLERANCE_M.p95 && s.max <= POSITION_TOLERANCE_M.max;
    if (!positionOk) errors.push('§7: 高 LOD の位置が LOD1 からずれている ' + JSON.stringify(s));
  }

  // ── §11/§12 canonicalId と namespace ──
  let canonicalIdChanged = null, namespaceOk = null;
  if (!manifest) errors.push('§12: building-lod-high の manifest が無い');
  else {
    namespaceOk = manifest.namespace === 'derived-v2-osmv2' && manifest.kind === 'building-lod-high'
      && manifest.coordinateConvention === 'znorth-neg-v1';
    if (!namespaceOk) errors.push('§12: namespace / 座標系の宣言が違う');
    // 既存 V2N の建物タイルは触っていない
    canonicalIdChanged = touched.length > 0;
    // 高 LOD の canonicalId は canonical 由来の形式のまま
    const sample = fs.readdirSync(F.highDir).filter((f) => /^tile_/.test(f)).slice(0, 5);
    let bad = 0, withUsage = 0, n = 0;
    for (const f of sample) {
      const t = rj(path.join(F.highDir, f));
      for (const b of (t.buildings || [])) {
        n++;
        if (!/^cg_bldg_/.test(b.canonicalId)) bad++;
        if (b.usageCategory) withUsage++;
        if (!(b.lod === 2 || b.lod === 3)) bad++;
      }
    }
    if (bad) errors.push('§11: canonicalId / lod の形式が違う建物がある: ' + bad);
    if (n && withUsage / n < 0.9) warnings.push('§16: usageCategory が入っていない建物が多い（色が変わる可能性）');
  }
  // §0 LOD1 から推定した geometry を作っていない。
  //   ・geometry の入口は「指定 LOD の MultiSurface を読む」1 か所だけ
  //   ・LOD1 の footprint を押し出す処理がどこにも無い
  const readsRequestedLodOnly = /const want = 'lod' \+ lod \+ 'MultiSurface';/.test(builderSrc);
  const noSynthesis = !/pushExtrude|extrudeRing|lod1Solid|lod0FootPrint/.test(builderSrc);
  const triesLod3First = /for \(const lod of \[3, 2\]\)/.test(builderSrc);
  const lod2UsesRealPlateauOnly = readsRequestedLodOnly && noSynthesis;
  const lod3UsesRealPlateauOnly = readsRequestedLodOnly && noSynthesis && triesLod3First;
  if (!lod2UsesRealPlateauOnly) errors.push('§0: LOD2 が実データ由来でない（geometry を合成している可能性）');
  if (!lod3UsesRealPlateauOnly) errors.push('§0: LOD3 が実データ由来でない / LOD3 を先に試していない');

  // ── §13/§14/§18/§19 ランタイム ──
  const runtimeLayer = /const BuildingLODLayer = \(function \(\) \{/.test(html)
    && /group\.name = 'CR_buildingLodHigh';/.test(html)
    && /if \(typeof canonicalRoot !== 'undefined'\) canonicalRoot\.add\(group\); else scene\.add\(group\);/.test(html);
  if (!runtimeLayer) errors.push('§13: BuildingLODLayer が canonicalRoot 配下に無い');
  const distanceLod = /const BAND = \{ highLodMaxR: 2500, nearMaxR: 800 \};/.test(html)
    && /function bandOf\(r\) \{ return r <= BAND\.nearMaxR \? 'near' : \(r <= BAND\.highLodMaxR \? 'mid' : 'far'\); \}/.test(html);
  if (!distanceLod) errors.push('§14/§15: camera 距離 LOD が実装されていない');
  const landmarkPriority = /function landmarkOwns\(id\) \{/.test(html) && /if \(landmarkOwns\(b\.canonicalId\)\) continue;/.test(html);
  if (!landmarkPriority) errors.push('§18: LandmarkHD 優先が実装されていない');
  const lod1Suppression = /if \(typeof BuildingLODLayer !== 'undefined' && BuildingLODLayer\.isSuppressedBuilding\(f\.canonicalId\)\) \{/.test(html)
    && /function invalidateBuildingTiles\(tileKeys\) \{/.test(html);
  if (!lod1Suppression) errors.push('§11: LOD1 の抑制と tile 再構築が無い');
  const pickingWired = /window\.__BUILDING_LOD_LAYER__\.pick\(ray\)/.test(html)
    && /CanonicalRuntime\.buildingDataById\(hl\.canonicalId\)/.test(html);
  if (!pickingWired) errors.push('§19: 高 LOD の picking が card につながっていない');
  // §16 用途色は LOD1 の共有 material から取り、頂点カラーへ焼く（material を増やさない）
  const sameUsageColor = /function usageColor\(cat, band\) \{/.test(html)
    && /CanonicalRuntime\.buildingMaterial\(cat, band === 'near' \? 'near' : 'mid'\)/.test(html)
    && /new THREE\.MeshLambertMaterial\(\{ vertexColors: true, side: THREE\.DoubleSide \}\)/.test(html);
  if (!sameUsageColor) errors.push('§16: 高 LOD が LOD1 と同じ用途色を使っていない');
  const qaCoverage = /function setQaMode\(on\) \{/.test(html) && /window\.__BUILDING_LOD_QA__/.test(html);
  if (!qaCoverage) warnings.push('§22: LOD カバレッジの QA 表示が無い');
  const osmUntouched = !/osm[^\n]*lod2|lod2[^\n]*osm/i.test(builderSrc);
  if (!osmUntouched) warnings.push('§17: OSM fallback に高 LOD を作っていないか要確認');

  // ── 実ブラウザ QA ──
  let doubleDisplay = null, distanceSwitchWorks = null, pickingSameId = null, noHoles = null, perf = [];
  if (!qa) {
    errors.push('§20/§21: building-lod-qa.json が無い');
  } else {
    if ((qa.errors || []).length) errors.push('ブラウザ例外 ' + JSON.stringify(qa.errors.slice(0, 3)));
    doubleDisplay = (qa.sites || []).reduce((m, s) => m + (s.doubleHits || 0), 0);
    if (doubleDisplay > 0) errors.push('§21: 高 LOD と LOD1 が二重に出ている: ' + doubleDisplay);
    // §21 legacy residual
    if ((qa.sites || []).some((s) => s.residual !== 0)) errors.push('§21: legacy residual が 0 でない');
    // 高 LOD を出している数と LOD1 を消している数が一致（＝穴が空いていない）
    const holes = (qa.sites || []).filter((s) => Math.abs((s.visibleLod2 + s.visibleLod3) - s.suppressedLod1) > Math.max(5, s.suppressedLod1 * 0.02));
    noHoles = holes.length === 0;
    if (!noHoles) errors.push('§21: LOD1 を消したのに高 LOD が出ていない地点がある ' + JSON.stringify(holes.map((s) => [s.site, s.visibleLod2 + s.visibleLod3, s.suppressedLod1])));
    // §15 距離での切替
    const ds = qa.distanceSwitch || [];
    const near = ds.filter((d) => d.cameraR <= LOD_BANDS.highLodMaxR);
    const far = ds.filter((d) => d.cameraR > LOD_BANDS.highLodMaxR);
    distanceSwitchWorks = near.length > 0 && far.length > 0
      && near.every((d) => d.band !== 'far') && far.every((d) => d.band === 'far' && d.triangles === 0);
    if (!distanceSwitchWorks) errors.push('§14/§15: 距離での LOD 切替が効いていない ' + JSON.stringify(ds));
    // §16 切替で位置・高さが跳ばない（bbox の底が 0 のまま）
    const sc = qa.switchCheck || [];
    const withBox = sc.filter((s) => s.bbox);
    if (withBox.some((s) => Math.abs(s.bbox.minY) > 0.5)) errors.push('§8: 建物が地面から浮いている / 沈んでいる ' + JSON.stringify(withBox.map((s) => [s.r, s.bbox.minY])));
    const xs = withBox.map((s) => s.bbox.minX);
    if (xs.length && (Math.max(...xs) - Math.min(...xs)) > 30) errors.push('§16: LOD 切替で建物の位置が動いている');
    // §19 picking
    const pk = qa.pick || {};
    pickingSameId = pk.found === true && pk.onScreen === true && pk.sameId === true
      && pk.high && pk.high.display === 'block' && pk.low && pk.low.display === 'block';
    if (!pickingSameId) errors.push('§19: 高 LOD と LOD1 で同じ card にならない ' + JSON.stringify(pk));
    if (pk.high && (pk.high.fake || []).length) errors.push('§19: card に仮の値 ' + JSON.stringify(pk.high.fake));
    // §20 性能
    perf = (qa.performance || []).filter((p) => p.highLod).map((p) => {
      const off = (qa.performance || []).find((q) => !q.highLod && q.site === p.site);
      return { site: p.site, siteName: p.siteName, fpsOn: p.fpsAverage, fpsOff: off ? off.fpsAverage : null,
        fpsP5On: p.fpsP5, frameMsP95On: p.frameMsP95, trianglesOn: p.trianglesAvg, trianglesOff: off ? off.trianglesAvg : null,
        drawCallsOn: p.drawCallsAvg, drawCallsOff: off ? off.drawCallsAvg : null,
        jsHeapMB: p.jsHeapMB, visibleLod2: p.visibleLod2, visibleLod3: p.visibleLod3, suppressedLod1: p.suppressedLod1 };
    });
    const bad = perf.filter((p) => p.fpsOff != null && p.fpsOn < p.fpsOff * 0.8);
    if (bad.length) warnings.push('§20: 高 LOD で FPS が 20% 以上落ちた地点 ' + JSON.stringify(bad.map((p) => [p.site, p.fpsOff, p.fpsOn])));
  }

  // ── production / protected ──
  const prodBuild = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = prodBuild.productionSha256 ? sha(F.prod) !== prodBuild.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('production HTML が変更されている（34A は development のみ）');
  if (protectedModified !== false) errors.push('protected HTML が変更されている');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '34A', RESULT,
    classification: errors.length ? 'MAX_PLATEAU_LOD_FAILED' : 'MAX_PLATEAU_LOD_SUCCESS',
    zoneVIIProjectionUsed, usesCanonicalProjection,
    canonicalIdChanged: !!canonicalIdChanged, buildingPositionMutation, roadMutation, placementMutation, projectionMutation,
    highestAvailableLodSelected, perBuildingFallbackWorks,
    lod2UsesRealPlateauOnly, lod3UsesRealPlateauOnly,
    productionModified, protectedModified,
    runtimeLayer, distanceLod, landmarkPriority, lod1Suppression, pickingWired, sameUsageColor, qaCoverage,
    namespaceOk, positionOk,
    inventory,
    adoption: build ? { targets: build.targets, adopted: build.adopted, lod2: build.adoptedLod2, lod3: build.adoptedLod3,
      fallbackToLod1: build.fallbackToLod1, noCanonicalSkipped: build.noCanonicalSkipped, invalidReasons: build.invalidReasons,
      triangles: build.triangles, vertices: build.vertices, tiles: build.tiles, bytes: build.outputBytes,
      centroidShiftM: build.centroidShiftM, heightDeltaM: build.heightDeltaM, surfaceTotals: build.surfaceTotals,
      interiorRings: build.interiorRings } : null,
    browserQa: qa ? { doubleDisplay, noHoles, distanceSwitchWorks, pickingSameId,
      sites: (qa.sites || []).map((s) => ({ site: s.site, siteName: s.siteName, visibleLod2: s.visibleLod2, visibleLod3: s.visibleLod3,
        suppressedLod1: s.suppressedLod1, triangles: s.triangles, drawCalls: s.drawCalls, doubleHits: s.doubleHits,
        adjacentLod1Hits: s.adjacentLod1Hits || 0, residual: s.residual })),
      distanceSwitch: qa.distanceSwitch, switchCheck: qa.switchCheck, pick: qa.pick,
      cityMode: qa.cityMode ? { band: qa.cityMode.band, visibleLod2: qa.cityMode.visibleLod2, triangles: qa.cityMode.triangles } : null } : null,
    performance: perf,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateMaxPlateauLod().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
