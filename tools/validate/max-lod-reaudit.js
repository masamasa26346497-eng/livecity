#!/usr/bin/env node
// tools/validate/max-lod-reaudit.js
// [Mission 34D §42] 24 区 max LOD 再監査の検証。
//   all24WardsAudited / buildingPartAudited / xlinkAudited / schemaVariantsAudited
//   zoneVIIUsed=false / canonicalBuildingCount=574112 / osmFallbackCount=26652 / totalBuildingCount=600764
//   fabricatedHighLod=0 / highestValidExteriorLodSelected=true
//   buildingPositionMutation=0 / roadMutation=0 / projectionMutation=0 / placementMutation=0
//   productionModified=false / protectedModified=false
//   → OSAKA_24WARD_MAX_LOD_AUDIT_SUCCESS / OSAKA_24WARD_MAX_LOD_AUDIT_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { stripComments } from './max-plateau-lod.js';
import { WARDS_24 } from '../audit/max-lod-reaudit.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  inventory: P('data', 'reports', 'plateau-source-inventory.json'),
  reaudit: P('data', 'reports', 'max-lod-reaudit.json'),
  matrix: P('data', 'reports', 'max-lod-coverage-matrix.json'),
  build: P('data', 'reports', 'plateau-high-lod-build.json'),
  runtime: P('data', 'reports', 'max-lod-runtime-qa.json'),
  canonManifest: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'),
  fallbackManifest: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osm-fallback', 'manifest.json'),
  highManifest: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high', 'manifest.json'),
  reasons: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high', 'high-lod-reasons.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  placement: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement', 'manifest.json'),
  roadV3: P('public', 'map-data', 'osaka-city', 'derived', 'road-visual-v3'),
  out: P('data', 'reports', 'max-lod-reaudit-validation.json'),
};
// §1/§2 変えてはいけない数
export const FIXED = { canonicalPlateau: 574112, osmFallback: 26652, total: 600764 };
// §41 前回の採用数
export const PREVIOUS = { lod2: 10208, lod3: 15, total: 10223 };
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function newestMtime(dir) {
  let m = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const q = path.join(dir, e.name);
      m = Math.max(m, e.isDirectory() ? newestMtime(q) : fs.statSync(q).mtimeMs);
    }
  } catch { return 0; }
  return m;
}

export async function validateMaxLodReaudit() {
  const errors = [], warnings = [];
  const raw = fs.readFileSync(F.dev, 'utf-8');
  const html = stripComments(raw);
  const inv = rj(F.inventory), ra = rj(F.reaudit), mx = rj(F.matrix), build = rj(F.build), rt = rj(F.runtime);
  const missionStart = Date.parse((rj(F.prodBuild) || {}).generatedAt || new Date().toISOString());

  // ── §14 24 区すべてを監査したか ───────────────────────────────────────
  let all24WardsAudited = false;
  if (!ra) errors.push('§14: max-lod-reaudit.json が無い');
  else {
    const got = Object.keys(ra.byWard || {});
    all24WardsAudited = WARDS_24.every((w) => got.includes(w)) && got.length === 24;
    if (!all24WardsAudited) errors.push('§14: 24 区すべての監査結果が揃っていない: ' + got.length);
  }

  // ── §5/§6/§7 schema / BuildingPart / XLink を見たか ──────────────────
  let buildingPartAudited = false, xlinkAudited = false, schemaVariantsAudited = false;
  if (!inv) errors.push('§3: plateau-source-inventory.json が無い');
  else {
    const t = inv.totals || {};
    // BuildingPart を実際に数えている（0 件でも「数えた」ことが要る）
    buildingPartAudited = !!(typeof t.withBuildingPart === 'number' && typeof t.buildingPartCount === 'number'
      && typeof t.highLodOnlyInPart === "number" && t.lodInPart != null);
    if (!buildingPartAudited) errors.push('§6: BuildingPart の監査結果が無い');
    xlinkAudited = !!(typeof t.withXlink === 'number' && typeof t.noPosList === 'number');
    if (!xlinkAudited) errors.push('§7: XLink の監査結果が無い');
    // §5 LOD 要素を Solid / MultiSurface / Geometry まで数えている
    const el = t.elements || {};
    const need = ['lod1Solid', 'lod2Solid', 'lod2MultiSurface', 'lod3Solid', 'lod3MultiSurface'];
    schemaVariantsAudited = !!(need.every((k) => k in el) && t.lodDirect && t.lodInBounded && t.lodInPart);
    if (!schemaVariantsAudited) errors.push('§5: schema バリエーションの監査結果が足りない');
    // §4 raw source を名前決め打ちで数えていない
    if (!(inv.scan && inv.scan.buildingSources > 0)) errors.push('§3: raw source の走査結果が無い');
  }

  // ── §18 座標系 ───────────────────────────────────────────────────────
  const builderSrc = stripComments(fs.readFileSync(P('tools', 'build-plateau-high-lod.js'), 'utf-8'));
  const zoneVIIUsed = /latLonToJPRect\s*\(|jprect/i.test(builderSrc) || /latLonToJPRect\s*\(/.test(html);
  if (zoneVIIUsed) errors.push('§18: Zone VII を使っている');
  if (!/latLonToLiveCityWorld\s*\(/.test(builderSrc)) errors.push('§18: latLonToLiveCityWorld を使っていない');
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = (proj.type === 'local-equirectangular' && proj.centerLat === 34.604208
    && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320) ? 0 : 1;
  if (projectionMutation) errors.push('§18: projection が変わっている');

  // ── §2 建物総数は変えない ────────────────────────────────────────────
  const canonManifest = rj(F.canonManifest) || {};
  const fbManifest = rj(F.fallbackManifest) || {};
  const totalBuildingCount = canonManifest.featureCount;
  const osmFallbackCount = fbManifest.featureCount;
  const canonicalBuildingCount = (typeof totalBuildingCount === 'number' && typeof osmFallbackCount === 'number')
    ? totalBuildingCount - osmFallbackCount : null;
  if (totalBuildingCount !== FIXED.total) errors.push('§2: 建物総数が 600,764 でない: ' + totalBuildingCount);
  if (osmFallbackCount !== FIXED.osmFallback) errors.push('§2: OSM fallback が 26,652 でない: ' + osmFallbackCount);
  if (canonicalBuildingCount !== FIXED.canonicalPlateau) errors.push('§2: canonical PLATEAU が 574,112 でない: ' + canonicalBuildingCount);

  // ── §26 捏造していない ───────────────────────────────────────────────
  let fabricatedHighLod = null;
  if (/aiRoof|inferRoof|synthes|generateRoof|fromHeight|fromLevels/i.test(builderSrc)) {
    fabricatedHighLod = 1; errors.push('§26: geometry を作っている疑いのあるコードがある');
  } else fabricatedHighLod = 0;
  // 高 LOD は OSM fallback に付けていない
  const hm = rj(F.highManifest) || {};
  if (hm.buildingCount == null) errors.push('§24: building-lod-high の manifest が無い');
  let osmHighLod = 0;
  try {
    const dir = path.dirname(F.highManifest);
    for (const f of fs.readdirSync(dir)) {
      if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
      for (const b of ((rj(path.join(dir, f)) || {}).buildings || [])) if (/^cg_bldg_osm_/.test(b.canonicalId)) osmHighLod++;
    }
  } catch { /* noop */ }
  if (osmHighLod > 0) { fabricatedHighLod += osmHighLod; errors.push('§24: OSM fallback に高 LOD を付けている: ' + osmHighLod); }

  // ── §9/§10/§11 最高の有効 LOD を選んでいる ───────────────────────────
  let highestValidExteriorLodSelected = false;
  if (!build) errors.push('§9: plateau-high-lod-build.json が無い');
  else {
    const okAccounting = build.targets === build.adopted + build.fallbackToLod1 + build.noCanonicalSkipped;
    if (!okAccounting) errors.push('§9: 会計が合わない targets=' + build.targets);
    // LOD3 が完全なら LOD3、そうでなければ LOD2、どちらも駄目なら LOD1
    const lodOrder = /for \(const lod of \[3, 2\]\)/.test(builderSrc);
    if (!lodOrder) errors.push('§9: LOD3 → LOD2 の順で試していない');
    // 完全性の判定を持っている
    const completeness = ra && ra.totals && typeof ra.totals.l2complete === 'number' && typeof ra.totals.l3complete === 'number';
    if (!completeness) errors.push('§10/§11: 完全性の判定結果が無い');
    highestValidExteriorLodSelected = okAccounting && lodOrder && !!completeness;
  }

  // ── §1 既存データを変えない ──────────────────────────────────────────
  const FROZEN = [
    'data/processed/osaka-city/canonical/buildings-v2-osmv2/manifest.json',
    'public/map-data/osaka-city/derived-v2-osmv2/near/buildings/manifest.json',
    'public/map-data/osaka-city/derived-v2-osmv2/mid/buildings/manifest.json',
    'public/map-data/osaka-city/derived-v2-osmv2/far/buildings/manifest.json',
  ];
  const touched = FROZEN.filter((r) => { try { return fs.statSync(P(r)).mtimeMs > missionStart; } catch { return true; } });
  const buildingPositionMutation = touched.length > 0 ? 1 : 0;
  if (buildingPositionMutation) errors.push('§1: canonical 建物データが変わっている ' + JSON.stringify(touched));
  const roadMutation = newestMtime(F.roadV3) > missionStart ? 1 : 0;
  if (roadMutation) errors.push('§1: ROAD V3 が変わっている');
  const placementMutation = (() => { try { return fs.statSync(F.placement).mtimeMs > missionStart ? 1 : 0; } catch { return 1; } })();
  if (placementMutation) errors.push('§1: placement が変わっている');

  // ── §41 前回との比較 ─────────────────────────────────────────────────
  const current = build ? { lod2: build.adoptedLod2, lod3: build.adoptedLod3, total: build.adopted } : null;
  const delta = current ? { lod2: current.lod2 - PREVIOUS.lod2, lod3: current.lod3 - PREVIOUS.lod3, total: current.total - PREVIOUS.total } : null;

  // ── §28/§29/§30/§37 ランタイム ───────────────────────────────────────
  let runtime = null;
  if (!rt) warnings.push('§28: max-lod-runtime-qa.json が無い（実ブラウザ確認が未実行）');
  else {
    runtime = rt.summary;
    if (!rt.summary.suppressMatchAll) errors.push('§28: 高 LOD 表示数と LOD1 抑制数が一致しない');
    if (rt.summary.multiTileBuildings > 0) errors.push('§29: 複数タイルにまたがって描かれている建物がある: ' + rt.summary.multiTileBuildings);
    if (rt.summary.cardMissing > 0) errors.push('§30: card を引けない建物がある: ' + rt.summary.cardMissing);
    if (!rt.summary.pickSameAll) errors.push('§30: クリックで同じ canonicalId へ到達しない');
    if (rt.summary.visualSites < 10) warnings.push('§38: visual QA 地点が 10 未満: ' + rt.summary.visualSites);
    if (rt.errors && rt.errors.length) warnings.push('ランタイムで JS 例外: ' + rt.errors.length);
  }

  // ── §34/§35/§36 dev QA ───────────────────────────────────────────────
  const maxLodQaAvailable = /const MaxLodQaLayer = \(function \(\) \{/.test(html)
    && /window\.__MAX_LOD_QA__/.test(html) && /window\.__MAX_LOD_INSPECT__/.test(html)
    && /maxLodQaBtn\.id = 'max-lod-qa-toggle';/.test(html);
  if (!maxLodQaAvailable) errors.push('§34/§35: MAX LOD QA が揃っていない');
  const reasonsPublished = fs.existsSync(F.reasons);
  if (!reasonsPublished) errors.push('§36: high-lod-reasons.json が配信されていない');
  const prodHtml = (() => { try { return fs.readFileSync(F.prod, 'utf-8'); } catch { return ''; } })();
  if (/__MAX_LOD_QA__|__MAX_LOD_INSPECT__/.test(prodHtml)) errors.push('§34: production に QA モードが入っている');

  // ── §39/§40 production / protected ───────────────────────────────────
  const prodBuild = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = prodBuild.productionSha256 ? sha(F.prod) !== prodBuild.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('§39: production HTML が変更されている');
  if (protectedModified !== false) errors.push('§40: protected HTML が変更されている');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '34D', RESULT,
    classification: errors.length ? 'OSAKA_24WARD_MAX_LOD_AUDIT_FAILED' : 'OSAKA_24WARD_MAX_LOD_AUDIT_SUCCESS',
    all24WardsAudited, buildingPartAudited, xlinkAudited, schemaVariantsAudited,
    zoneVIIUsed,
    canonicalBuildingCount, osmFallbackCount, totalBuildingCount,
    fabricatedHighLod, highestValidExteriorLodSelected,
    buildingPositionMutation, roadMutation, projectionMutation, placementMutation,
    productionModified, protectedModified,
    previous: PREVIOUS, current, delta,
    sourceInventory: inv ? { buildingSources: inv.scan.buildingSources, fileSources: inv.scan.fileSources,
      zipEntrySources: inv.scan.zipEntrySources, uniqueGmlIds: inv.totals.uniqueIds,
      elements: inv.totals.elements, lodPlacement: { direct: inv.totals.lodDirect, inPart: inv.totals.lodInPart, inBounded: inv.totals.lodInBounded },
      withBuildingPart: inv.totals.withBuildingPart, highLodOnlyInPart: inv.totals.highLodOnlyInPart,
      withXlink: inv.totals.withXlink, noPosList: inv.totals.noPosList, byId: inv.byId } : null,
    completeness: ra ? { l2present: ra.totals.l2present, l2complete: ra.totals.l2complete,
      l3present: ra.totals.l3present, l3complete: ra.totals.l3complete,
      chosen1: ra.totals.chosen1, chosen2: ra.totals.chosen2, chosen3: ra.totals.chosen3,
      wardFromAttribute: ra.totals.wardFromAttribute, wardFromPolygon: ra.totals.wardFromPolygon,
      wardUnknown: ra.totals.wardUnknown, spatialRecovered: ra.totals.spatialRecovered } : null,
    adoption: build ? { targets: build.targets, canonMatched: build.canonMatched, adopted: build.adopted,
      lod2: build.adoptedLod2, lod3: build.adoptedLod3, fallbackToLod1: build.fallbackToLod1,
      noCanonicalSkipped: build.noCanonicalSkipped, invalidReasons: build.invalidReasons,
      spatialAdopted: build.spatialAdopted, spatialRejected: build.spatialRejected,
      qualityTiers: build.qualityTiers, roofLevelsMean: build.roofLevelsMean, multiLevelRoofPct: build.multiLevelRoofPct,
      bboxCenterShiftM: build.bboxCenterShiftM, centroidShiftM: build.centroidShiftM } : null,
    wardMatrix: mx ? mx.wards : null,
    areas: mx ? mx.areas : null,
    topDensity: mx ? mx.topDensity : null,
    runtime, maxLodQaAvailable, reasonsPublished,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateMaxLodReaudit().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
