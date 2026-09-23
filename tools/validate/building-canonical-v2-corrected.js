#!/usr/bin/env node
// tools/validate/building-canonical-v2-corrected.js
// [Mission 32N §26] Corrected Building Canonical V2 の検証。
//   canonicalV1Mutation=0 / canonicalV2Count=615617 / canonicalIdPreserved=true
//   zone7UsedInCorrectedPipeline=false / commonCoordinateSystemUsed=true
//   rawLatLonTruthUsed=true / inverseDerivedTruthUsed=false
//   wardReassignedFromCorrectedCoordinates=true
//   productionModified=false / protectedModified=false
//   加えて §30 の成功条件を判定し、CORRECTED_BUILDING_CANONICAL_SUCCESS / FAILED を出す。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  report: P('data', 'reports', 'building-canonical-v2-corrected.json'),
  build: P('data', 'reports', 'canonical-building-v2-build.json'),
  out: P('data', 'reports', 'building-canonical-v2-corrected-validation.json'),
  v1: P('data', 'processed', 'osaka-city', 'canonical', 'buildings'),
  v2: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-corrected'),
  v1PublicNear: P('public', 'map-data', 'osaka-city', 'derived', 'near', 'buildings'),
  v2DerivedNear: P('data', 'processed', 'osaka-city', 'derived-v2-corrected', 'near', 'buildings'),
  v2PublicNear: P('public', 'map-data', 'osaka-city', 'derived-v2-corrected', 'near', 'buildings'),
  v2PublicPlacement: P('public', 'map-data', 'osaka-city', 'derived-v2-corrected', 'building-placement', 'manifest.json'),
  v2PublicWardIndex: P('public', 'map-data', 'osaka-city', 'derived-v2-corrected', 'building-ward-index.json'),
  builder: P('tools', 'build-canonical-buildings-v2-corrected.js'),
  sidecars: P('tools', 'build-buildings-v2-corrected-sidecars.js'),
  coordLib: P('tools', 'lib', 'livecity-coordinate-system.js'),
  derivedTool: P('tools', 'build-derived-geometry.js'),
  html: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  area: P('config', 'areas', 'osaka-city.json'),
};
const PRODUCTION = 'public/osaka_3d_buildings.html';
const PROTECTED = 'public/osaka_3d_buildings.fullward-v3.html';
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const ids = (dir) => { const s = new Set(); for (const f of fs.readdirSync(dir)) { if (!isTile(f)) continue; const t = rj(path.join(dir, f)); for (const ft of (t && t.features) || []) s.add(ft.canonicalId); } return s; };
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function gitClean(rel) {
  try { return execFileSync('git', ['status', '--porcelain', '--', rel], { cwd: resolveProjectPath('.'), encoding: 'utf-8' }).trim() === ''; }
  catch { return null; }
}

export async function validateBuildingCanonicalV2() {
  const errors = [], warnings = [];
  const r = rj(F.report), build = rj(F.build);
  if (!r || !build) {
    const out = { RESULT: 'FAIL', classification: 'CORRECTED_BUILDING_CANONICAL_FAILED', errors: ['レポートが無い: ' + toProjectRelativePath(r ? F.build : F.report)] };
    await writeJson(F.out, out); return out;
  }

  // ── V1 不変・V2 件数・ID ──
  const v1Ids = ids(F.v1), v2Ids = ids(F.v2);
  const v1Manifest = rj(path.join(F.v1, 'manifest.json')) || {};
  const v1Newer = fs.readdirSync(F.v1).filter((f) => fs.statSync(path.join(F.v1, f)).mtimeMs > Date.parse(build.generatedAt)).length;
  const canonicalV1Mutation = (v1Ids.size === 615617 && v1Newer === 0 && v1Manifest.variant !== 'v2-corrected') ? 0 : 1;
  if (canonicalV1Mutation) errors.push(`§1: V1 canonical が変わっている（件数 ${v1Ids.size} / V2 build 以降に更新されたファイル ${v1Newer}）`);
  const canonicalV2Count = v2Ids.size;
  if (canonicalV2Count !== 615617) errors.push('§7: V2 の件数が 615617 でない: ' + canonicalV2Count);
  let missing = 0, extra = 0;
  for (const id of v1Ids) if (!v2Ids.has(id)) missing++;
  for (const id of v2Ids) if (!v1Ids.has(id)) extra++;
  const canonicalIdPreserved = missing === 0 && extra === 0;
  if (!canonicalIdPreserved) errors.push(`§5: canonicalId が一致しない（V2 に無い ${missing} / V2 だけにある ${extra}）`);

  // ── 座標系: 第7系を使っていない・共通 module を使っている ──
  const builderSrc = stripComments(fs.readFileSync(F.builder, 'utf-8'));
  const zone7UsedInCorrectedPipeline = /latLonToJPRect|JPRect|zone\s*[:=]\s*7|convert-plateau-buildings|ward-poc-all-buildings/.test(builderSrc);
  if (zone7UsedInCorrectedPipeline) errors.push('§3: V2 ビルダーが平面直角座標/第7系の経路を参照している');
  const coordSrc = stripComments(fs.readFileSync(F.coordLib, 'utf-8'));
  const commonModuleImported = /import\s*\{[^}]*latLonToLiveCityWorld[^}]*\}\s*from\s*'\.\/lib\/livecity-coordinate-system\.js'/.test(fs.readFileSync(F.builder, 'utf-8'));
  const commonModuleIsEquirect = /local-equirectangular/.test(coordSrc) && !/JPRect|zone/i.test(coordSrc);
  const v2Manifest = rj(path.join(F.v2, 'manifest.json')) || {};
  // 数値でも確認: 他レイヤー（道路/水域/鉄道/区界）と V2 建物が同じ basis（rotation≈0, scale≈1）
  const after = (r.coordinate || {}).rotationAfter || {};
  const basisOk = Math.abs(after.rotationDeg ?? 99) < 0.01 && Math.abs((after.scale ?? 0) - 1) < 1e-4;
  const commonCoordinateSystemUsed = commonModuleImported && commonModuleIsEquirect && v2Manifest.coordinateSystem === 'livecity-equirect-znorth-neg-v1' && basisOk;
  if (!commonCoordinateSystemUsed) errors.push('§4: 共通座標系の使用が確認できない ' + JSON.stringify({ commonModuleImported, commonModuleIsEquirect, manifest: v2Manifest.coordinateSystem, basisOk }));
  // 単純 rotation 補正をしていない（§0）
  const simpleRotationUsed = /rotate\w*\(|0\.93|0\.930|Math\.(cos|sin)\(\s*-?\s*0\.0162/.test(builderSrc);
  if (simpleRotationUsed) errors.push('§0: V2 ビルダーに単純 rotation 補正らしき処理がある');

  // ── truth の出所 ──
  const rt = r.rawTruthError || {};
  const rawLatLonTruthUsed = (rt.matched || 0) > 0 && /生 CityGML/.test(rt.method || '');
  const auditSrc = stripComments(fs.readFileSync(P('tools', 'audit', 'building-canonical-v2-corrected.js'), 'utf-8'));
  const inverseDerivedTruthUsed = /liveCityWorldToLatLon|worldToLatLon|livecity-coordinate-system/.test(auditSrc);
  if (!rawLatLonTruthUsed) errors.push('§8: raw lat/lon truth による検証が無い');
  if (inverseDerivedTruthUsed) errors.push('§8: 評価が逆変換 / ビルダーと同じ変換 module に依存している');
  const rawErrorOk = rt.matched > 0 && rt.unmatched === 0 && rt.maxM != null && rt.maxM <= 0.01 && rt.plateauChecked === 574112;
  if (!rawErrorOk) errors.push('§8: raw truth 誤差が丸め誤差の範囲を超える、または照合漏れがある ' + JSON.stringify({ checked: rt.plateauChecked, unmatched: rt.unmatched, max: rt.maxM }));

  // ── 区 ──
  const w = r.ward || {};
  const wardReassignedFromCorrectedCoordinates = !!(w.reassignedFromCorrectedCoordinates && build.ward && build.ward.assigned > 0 && /representativePoint/.test(builderSrc) && /classifyPointToWard/.test(builderSrc));
  if (!wardReassignedFromCorrectedCoordinates) errors.push('§11: 区の再判定が corrected 座標から行われていない');

  // ── production / protected ──
  const productionModified = gitClean(PRODUCTION) === false;
  const protectedModified = gitClean(PROTECTED) === false;
  if (productionModified) errors.push('§28: production HTML が変更されている');
  if (protectedModified) errors.push('§28: protected HTML が変更されている');

  // ── runtime / 派生 ──
  const html = fs.readFileSync(F.html, 'utf-8');
  // 32N 時点の §31 は「V2 を既定にしない」。Mission 32P で development の既定だけを V2N（V2 + OSM fallback V2）へ
  //   昇格した（production / protected は未変更）ので、V1 / V2N のどちらかであることを確認する。
  const defaultVersion = (html.match(/let buildingsVersion = '([A-Z0-9]+)';/) || [])[1];
  const defaultStillV1 = defaultVersion === 'V1';
  if (defaultVersion !== 'V1' && defaultVersion !== 'V2N') errors.push('§31: 既定の建物版が V1 / V2N（32P で昇格）以外: ' + defaultVersion);
  const rtm = r.runtime || {};
  const runtimeOk = rtm.v2Debug && rtm.v2Debug.version === 'V2' && JSON.stringify(rtm.v2Debug.buildingsGroupScale) === '[1,1,1]'
    && JSON.stringify(rtm.v2Debug.buildingsGroupRotation) === '[0,0,0]' && rtm.v2Debug.placementManifestLoaded && rtm.v2Debug.wardIndexLoaded
    && rtm.residualInV2 === 0 && rtm.backToV1 === 'V1';
  if (!runtimeOk) errors.push('§16/§23: runtime の V1/V2 切替 / scale=1 / rotation=0 / 付帯データ読込が確認できない ' + JSON.stringify(rtm).slice(0, 300));
  const nearOk = r.nearExactCheck && r.nearExactCheck.checked > 0 && r.nearExactCheck.checked === r.nearExactCheck.identical;
  if (!nearOk) errors.push('§13: V2 near(exact) の頂点が V2 canonical と一致しない');
  const v2Published = fs.existsSync(F.v2PublicNear) && fs.existsSync(F.v2PublicPlacement) && fs.existsSync(F.v2PublicWardIndex);
  if (!v2Published) errors.push('§15: V2 の公開物（near tiles / placement / ward index）が揃っていない');
  const v1PublicIntact = fs.existsSync(path.join(F.v1PublicNear, 'manifest.json'));
  if (!v1PublicIntact) errors.push('§14: V1 の公開 derived が消えている');

  // ── §30 成功条件 ──
  const c = r.coordinate || {};
  const osm = r.osmOverlap || {};
  const conds = {
    count615617: canonicalV2Count === 615617,
    idPreserved: canonicalIdPreserved,
    rawConsistent: rawErrorOk,
    rotationNearZero: Math.abs(c.rotationAfter?.rotationDeg ?? 99) < 0.01,
    scaleNearOne: Math.abs((c.scaleAfter ?? 0) - 1) < 1e-4,
    umedaImproved: (osm.umeda?.v2 ?? 0) > (osm.umeda?.v1 ?? 1),
    wardImproved: (w.correctedAccuracy ?? 0) > (w.oldAccuracy ?? 1),
    sumiyoshiNotWorse: (osm.sumiyoshi?.v2 ?? 0) >= (osm.sumiyoshi?.v1 ?? 1),
    noRuntimeRotation: !!runtimeOk,
    productionUntouched: !productionModified && !protectedModified,
  };
  for (const [k, v] of Object.entries(conds)) if (!v) errors.push('§30: 成功条件を満たさない: ' + k);
  // §30 の条件ではないが Visual QA に直結する: V1 基準で選んだ OSM fallback が V2 PLATEAU と重なる（二重建物）
  const fd = r.fallbackDuplicates;
  if (!fd) warnings.push('fallback と V2 PLATEAU の重複が測られていない');
  else if (fd.againstV2Plateau.duplicateAny > fd.againstV1Plateau.duplicateAny) {
    warnings.push(`OSM fallback と PLATEAU の重複が V1 ${fd.againstV1Plateau.duplicateAny} → V2 ${fd.againstV2Plateau.duplicateAny} 棟に増える（件数 615,617 維持のため未除外・要別 mission）`);
  }

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '32N',
    RESULT, classification: errors.length ? 'CORRECTED_BUILDING_CANONICAL_FAILED' : 'CORRECTED_BUILDING_CANONICAL_SUCCESS',
    canonicalV1Mutation, canonicalV2Count, canonicalIdPreserved,
    zone7UsedInCorrectedPipeline, commonCoordinateSystemUsed,
    rawLatLonTruthUsed, inverseDerivedTruthUsed,
    wardReassignedFromCorrectedCoordinates,
    productionModified, protectedModified,
    simpleRotationUsed, defaultBuildingsVersion: defaultVersion || 'unknown', defaultStillV1,
    successConditions: conds,
    fallbackDuplicates: r.fallbackDuplicates ? { v1: r.fallbackDuplicates.againstV1Plateau.duplicateAny, v2: r.fallbackDuplicates.againstV2Plateau.duplicateAny } : null,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateBuildingCanonicalV2().then((o) => {
    console.log(JSON.stringify(o, null, 2));
    process.exit(o.RESULT === 'PASS' ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
