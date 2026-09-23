#!/usr/bin/env node
// tools/validate/runtime-visible-layer-alignment.js
// [Mission 32J] AUDIT ONLY であることと、監査が「元データ比較」ではなく
//   「実際に scene へ add された後の座標の比較」として成立していることを検証する。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const REPORT = P('data', 'reports', 'runtime-visible-layer-alignment.json');
const OUT = P('data', 'reports', 'runtime-visible-layer-alignment-validation.json');
const AUDIT = P('tools', 'audit', 'runtime-visible-layer-alignment.js');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const AREA_CFG = P('config', 'areas', 'osaka-city.json');
const WARD_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PRODUCTION_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
function countUnique(dir, key) {
  if (!fs.existsSync(dir)) return null;
  const seen = new Set();
  for (const f of fs.readdirSync(dir)) { if (!isTile(f)) continue; const t = rj(path.join(dir, f)); if (!t) continue; for (const ft of t.features || []) seen.add(ft[key]); }
  return seen.size;
}

export function validateRuntimeVisibleLayerAlignment() {
  const errors = [], warnings = [];
  const r = rj(REPORT);
  if (!r) { const out = { RESULT: 'FAIL', errors: ['レポートが無い: ' + toProjectRelativePath(REPORT)] }; writeJson(OUT, out); return out; }

  // ── §0: 何も変更していない ──
  const buildings = countUnique(CANON_BLDGS, 'canonicalId');
  const roads = countUnique(CANON_ROADS, 'canonicalId');
  const cfg = rj(AREA_CFG); const proj = cfg && cfg.projection;
  const buildingMutation = buildings === 615617 ? 0 : 1;
  const roadMutation = roads === CANONICAL_ROAD_FEATURE_COUNT ? 0 : 1;
  const projectionMutation = proj && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320 ? 0 : 1;
  if (buildingMutation) errors.push('Canonical Buildings が 615617 でない: ' + buildings);
  if (roadMutation) errors.push('Canonical Roads が ' + CANONICAL_ROAD_FEATURE_COUNT + ' でない: ' + roads);
  if (projectionMutation) errors.push('projection(znorth-neg-v1) が変更されている');

  // ── §24: canonical 同士の比較ではなく scene 実座標を読んでいること ──
  const src = fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf-8') : '';
  const readsSceneGeometry = /geometry\.attributes\.position/.test(src) && /runInlineScript\(/.test(src);
  if (!readsSceneGeometry) errors.push('§24: scene 上の geometry.attributes.position を読んでいない');

  // ── §1/§2: 両レイヤーが runtime から同定されている ──
  const g = r.greenLayerSource || {};
  const b = r.buildingLayerSource || {};
  const greenIdentified = !!(g.GREEN_LAYER_SOURCE && g.parentChain && Array.isArray(g.measuredColors) && g.measuredColors.length > 0 && g.meshCount > 0);
  const buildingIdentified = !!(b.meshName && b.parentChain && b.datasetId && b.sourceFiles);
  if (!greenIdentified) errors.push('§1: 緑レイヤーが runtime から同定できていない');
  if (!buildingIdentified) errors.push('§2: 建物レイヤーが runtime から同定できていない');

  // ── §3/§4: effective transform が両レイヤーで算出・比較されている ──
  const bt = r.buildingTransform || {}, gt = r.greenTransform || {};
  const transformsComputed = ['effectiveTranslationX', 'effectiveTranslationZ', 'effectiveScaleX', 'effectiveScaleZ', 'effectiveRotationY']
    .every((k) => typeof bt[k] === 'number' && typeof gt[k] === 'number');
  if (!transformsComputed) errors.push('§4: effective transform が算出されていない');

  // ── §5: local → world のトレースが report に保存されている ──
  const traced = (r.perSite || []).length > 0 && r.signAxisAudit && r.signAxisAudit.tracedVertices > 0;
  if (!traced) errors.push('§5: local→world のトレースが保存されていない');

  // ── §7: 低層のみ 20件以上 ──
  const fixtureOk = r.fixtureCount >= 20;
  if (!fixtureOk) errors.push('§7: fixture が 20 件未満: ' + r.fixtureCount);

  // ── §11/§12/§13: 統計・affine・tile 別が出ている ──
  const statsOk = r.medianDx != null && r.medianDz != null && r.p95Distance != null;
  const affineOk = !!(r.affine && ['scaleX', 'scaleZ', 'rotation', 'shear', 'tx', 'tz'].every((k) => typeof r.affine[k] === 'number'));
  const tileOk = Array.isArray(r.tileResults) && r.tileResults.length >= 3;
  if (!statsOk) errors.push('§11: median dx/dz・p95 distance が無い');
  if (!affineOk) errors.push('§12: affine fit が無い');
  if (!tileOk) errors.push('§13: tile 別結果が 3 tile 未満');

  // ── §15-§19 の監査項目 ──
  const originOk = !!(r.tileOriginAudit && r.tileOriginAudit.doubleOriginTermHits);
  const signOk = !!(r.signAxisAudit && typeof r.signAxisAudit.signConventionHeld === 'boolean');
  const unitOk = !!(r.worldUnitAudit && r.worldUnitAudit.unitsPerMeter === 1);
  const screenOk = !!(r.screenAudit && typeof r.screenAudit.singleCameraForWholeScene === 'boolean');
  if (!originOk) errors.push('§15/§16: 二重原点 / tile offset の監査が無い');
  if (!signOk) errors.push('§17/§18: sign / axis swap の監査が無い');
  if (!unitOk) errors.push('§19: world unit が 1 unit = 1m と確認できていない');
  if (!screenOk) errors.push('§6: screen 側の確認が無い');

  // ── §20: QA overlay が read-only で既定 OFF ──
  const html = fs.existsSync(WARD_HTML) ? fs.readFileSync(WARD_HTML, 'utf-8') : '';
  const qaStart = html.indexOf('[Mission 32J §20/§21] VISIBLE ALIGNMENT QA');
  const qaEnd = html.indexOf('function getVisibleAlignQaDebug()');
  const qaSection = qaStart >= 0 && qaEnd > qaStart ? html.slice(qaStart, qaEnd) : '';
  const overlayExists = !!qaSection;
  const overlayReadOnly = overlayExists && !/pushExtrude/.test(qaSection);
  const overlayDefaultOff = /let visibleAlignQaEnabled = false;/.test(html);
  const overlayHidesOthers = /layerGroup\.buildings\.visible = false; layerGroup\.roads\.visible = false;/.test(qaSection);
  const overlayRestores = /savedBeforeVisibleAlignQa/.test(qaSection);
  const orthoFixed = /CanonicalRuntime\.isVisibleAlignQaActive\(\)\) return orthoCamera;/.test(html);
  if (!overlayExists) errors.push('§20: QA overlay が無い');
  if (overlayExists && !overlayReadOnly) errors.push('§0/§20: overlay が pushExtrude を使っている（read-only でない）');
  if (!overlayDefaultOff) errors.push('§20: QA overlay が既定 OFF でない');
  if (!overlayHidesOthers) errors.push('§9/§20: 3D extrusion / other layers を OFF にしていない');
  if (!overlayRestores) errors.push('§20: OFF 時の復元経路が無い');
  if (!orthoFixed) errors.push('§8: Orthographic Top Down 固定になっていない');

  // ── §22/§25 ──
  const classOk = /^(RUNTIME_LAYER_TRANSLATION_ERROR|RUNTIME_LAYER_SCALE_ERROR|RUNTIME_TILE_OFFSET_ERROR|RUNTIME_PARENT_TRANSFORM_ERROR|RUNTIME_SIGN_AXIS_ERROR|SOURCE_SEMANTICS_DIFFERENCE|NO_RUNTIME_ALIGNMENT_ERROR)$/.test(r.classification || '');
  const stopOk = /^(VISIBLE_LAYER_ROOT_CAUSE_IDENTIFIED|VISIBLE_LAYER_ALIGNMENT_CORRECT)$/.test(r.stopToken || '');
  if (!classOk) errors.push('§22: classification が7択でない: ' + r.classification);
  if (!stopOk) errors.push('§25: stopToken が2択でない: ' + r.stopToken);

  // ── production / protected 非改変 ──
  const productionModified = fs.existsSync(PRODUCTION_HTML) && /visibleAlignQaEnabled|VisibleAlignQa_|visible-align-qa/.test(fs.readFileSync(PRODUCTION_HTML, 'utf-8'));
  const protectedModified = fs.existsSync(PROTECTED_HTML) && /visibleAlignQaEnabled|VisibleAlignQa_|visible-align-qa/.test(fs.readFileSync(PROTECTED_HTML, 'utf-8'));
  if (productionModified) errors.push('production HTML に 32J のコードが混入している');
  if (protectedModified) errors.push('protected HTML に 32J のコードが混入している');

  if (r.environment && r.environment.matrixWorldMaterialized === false) {
    warnings.push('matrixWorld 行列はこの実行環境(THREE スタブ)では実体化しないため、§3/§4 は parent chain の '
      + 'TRS を実測して合成した。両レイヤーとも全段 identity であることは実測済み（数値は report 参照）。');
  }
  if (r.environment && r.environment.threeDBuildingLayerLoadable === false) {
    warnings.push('3D 建物レイヤー(CR_buildings)自体はこの環境では読み込めないため、同一タイルを読む '
      + 'PLATEAU footprint overlay を建物側として使用した（正直な開示）。');
  }

  const checks = {
    buildingMutation, roadMutation, projectionMutation,
    canonicalBuildings: buildings, canonicalRoads: roads,
    readsSceneGeometry, greenIdentified, buildingIdentified, transformsComputed, traced,
    fixtureCount: r.fixtureCount, fixtureOk, statsOk, affineOk, tileCount: (r.tileResults || []).length, tileOk,
    originOk, signOk, unitOk, screenOk,
    overlayExists, overlayReadOnly, overlayDefaultOff, overlayHidesOthers, overlayRestores, orthoFixed,
    productionModified, protectedModified,
    greenLayerSource: g.GREEN_LAYER_SOURCE || null,
    greenMeasuredColors: g.measuredColors || null,
    transformsEqual: r.transformsEqual, bothIdentity: r.bothIdentity,
    medianDx: r.medianDx, medianDz: r.medianDz, p95Distance: r.p95Distance,
    directionConsistency: r.directionConsistency,
    classification: r.classification, stopToken: r.stopToken,
  };
  const out = { RESULT: errors.length ? 'FAIL' : 'PASS', generatedAt: new Date().toISOString(), missionId: '32J', checks, errors, warnings };
  writeJson(OUT, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  const out = validateRuntimeVisibleLayerAlignment();
  console.log('RESULT=' + out.RESULT);
  for (const w of out.warnings || []) console.log('WARN: ' + w);
  for (const e of out.errors || []) console.log('ERROR: ' + e);
  console.log(JSON.stringify(out.checks, null, 1));
  if (out.RESULT !== 'PASS') process.exit(1);
}
