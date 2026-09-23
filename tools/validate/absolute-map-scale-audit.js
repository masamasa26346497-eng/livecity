#!/usr/bin/env node
// tools/validate/absolute-map-scale-audit.js
// [Mission 32L] AUDIT ONLY であることと、§1-§18 の測定が揃っていることを検証する。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const REPORT = P('data', 'reports', 'absolute-map-scale-audit.json');
const OUT = P('data', 'reports', 'absolute-map-scale-audit-validation.json');
const AUDIT = P('tools', 'audit', 'absolute-map-scale-audit.js');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const AREA_CFG = P('config', 'areas', 'osaka-city.json');
const WARD_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PRODUCTION_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
function countUnique(dir) {
  if (!fs.existsSync(dir)) return null;
  const seen = new Set();
  for (const f of fs.readdirSync(dir)) { if (!isTile(f)) continue; const t = rj(path.join(dir, f)); if (!t) continue; for (const ft of t.features || []) seen.add(ft.canonicalId); }
  return seen.size;
}

export async function validateAbsoluteMapScaleAudit() {
  const errors = [], warnings = [];
  const r = rj(REPORT);
  if (!r) { const out = { RESULT: 'FAIL', errors: ['レポートが無い: ' + toProjectRelativePath(REPORT)] }; await writeJson(OUT, out); return out; }

  // §0 不変
  const buildings = countUnique(CANON_BLDGS), roads = countUnique(CANON_ROADS);
  const proj = (rj(AREA_CFG) || {}).projection;
  const buildingMutation = buildings === 615617 ? 0 : 1;
  const roadMutation = roads === CANONICAL_ROAD_FEATURE_COUNT ? 0 : 1;
  const projectionMutation = proj && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320 ? 0 : 1;
  if (buildingMutation) errors.push('Canonical Buildings が 615617 でない: ' + buildings);
  if (roadMutation) errors.push('Canonical Roads が ' + CANONICAL_ROAD_FEATURE_COUNT + ' でない: ' + roads);
  if (projectionMutation) errors.push('projection が変更されている');

  // §14 nearest-edge を使っていない
  const src = fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf-8') : '';
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const usesNearestEdge = /nearestGreen|nearestEdge|distPointToSegment/.test(code);
  if (usesNearestEdge) errors.push('§14 違反: nearest-edge 比較を使っている');

  // §1/§2
  const cpOk = r.controlPointCount >= 20;
  if (!cpOk) errors.push('§1: control point が 20 未満');
  const bandKeys = ['50-100m', '100-250m', '250-500m', '500-1000m', '1000-3000m'];
  const bandsOk = bandKeys.every((k) => r.distanceBands && r.distanceBands[k] && r.distanceBands[k].count > 0);
  if (!bandsOk) errors.push('§2: 全距離帯のペアが揃っていない');

  // §3 map pipeline の実証
  const mapVerified = !!(r.mapPipelineVerification && r.mapPipelineVerification.verified);
  if (!mapVerified) errors.push('§3: Map 側変換が equirect であることを実測で確認できていない');

  // §4/§5/§6/§7
  const scaleFieldsOk = ['scaleX', 'scaleZ', 'medianRatio', 'p95Ratio'].every((k) => typeof (r.building || {})[k] === 'number' && typeof (r.map || {})[k] === 'number');
  const relOk = ['buildingVsMapX', 'buildingVsMapZ', 'medianRatio'].every((k) => typeof (r.relative || {})[k] === 'number');
  const diagOk = typeof (r.relative || {}).diagonal === 'number';
  if (!scaleFieldsOk) errors.push('§18: building/map の scaleX/scaleZ/medianRatio/p95Ratio が揃っていない');
  if (!relOk) errors.push('§5/§6: relative の X/Z/median が無い');
  if (!diagOk) errors.push('§7: 対角線方向の測定が無い');

  // §9/§10/§11
  const bboxOk = r.buildingBboxSanity && r.buildingBboxSanity.sampleCount >= 30;
  if (!bboxOk) errors.push('§9: 低層建物 bbox が 30 棟未満');
  if (!r.roadWidthSanity) warnings.push('§10: road width が取得できていない');
  if (!r.cityBlockSanity) warnings.push('§11: city block が取得できていない');

  // §15/§16
  const umedaOk = r.umeda && r.umeda.count >= 10;
  const sumiOk = r.sumiyoshi && r.sumiyoshi.count >= 10;
  if (!umedaOk) errors.push('§15: 梅田のペアが 10 未満');
  if (!sumiOk) errors.push('§16: 住吉のペアが 10 未満');

  // §12/§13 ruler
  const html = fs.existsSync(WARD_HTML) ? fs.readFileSync(WARD_HTML, 'utf-8') : '';
  const rulerExists = /const SCALE_RULER_M = 100;/.test(html) && /id = 'scale-ruler-toggle';/.test(html);
  const rulerOrtho = /CanonicalRuntime\.isScaleRulerActive\(\)\) return orthoCamera;/.test(html);
  const rulerDefaultOff = /let scaleRulerEnabled = false;/.test(html);
  if (!rulerExists) errors.push('§13: 100m ruler が無い');
  if (!rulerOrtho) errors.push('§12: ruler 表示中に Orthographic 固定になっていない');
  if (!rulerDefaultOff) errors.push('ruler が既定 OFF でない');

  // §17
  const classOk = /^(ABSOLUTE_SCALE_MATCH|BUILDING_SCALE_TOO_LARGE|BUILDING_SCALE_TOO_SMALL|MAP_SCALE_TOO_LARGE|MAP_SCALE_TOO_SMALL|ANISOTROPIC_SCALE_ERROR|RUNTIME_SCALE_ERROR)$/.test(r.classification || '');
  if (!classOk) errors.push('§17: classification が 7 択でない');
  if (r.stopToken !== 'ABSOLUTE_SCALE_AUDIT_COMPLETE') errors.push('§20: stopToken が違う');

  // 回転の発見は必ず報告されていること（scale 分類で隠さない）
  const rotationReported = !!(r.rotationFinding && typeof r.rotationFinding.rotationDeg === 'number');
  if (!rotationReported) errors.push('affine の回転成分が報告されていない');
  if (rotationReported && Math.abs(r.rotationFinding.rotationDeg) > 0.1) {
    warnings.push('縮尺は一致しているが、Map frame と Building frame の間に ' + r.rotationFinding.rotationDeg
      + '° の回転がある（梅田で約 ' + Math.round(r.rotationFinding.displacementAtUmedaM) + ' m の変位）。今回は修正していない。');
  }

  // production / protected
  const marks = /SCALE_RULER_M|scale-ruler-toggle|ScaleRuler100m/;
  const productionModified = fs.existsSync(PRODUCTION_HTML) && marks.test(fs.readFileSync(PRODUCTION_HTML, 'utf-8'));
  const protectedModified = fs.existsSync(PROTECTED_HTML) && marks.test(fs.readFileSync(PROTECTED_HTML, 'utf-8'));
  if (productionModified) errors.push('production HTML に混入');
  if (protectedModified) errors.push('protected HTML に混入');

  const checks = {
    buildingMutation, roadMutation, projectionMutation, canonicalBuildings: buildings, canonicalRoads: roads,
    usesNearestEdge, controlPointCount: r.controlPointCount, pairCount: r.pairCount, bandsOk, mapVerified,
    scaleFieldsOk, relOk, diagOk, bboxOk: !!bboxOk, umedaPairs: r.umeda && r.umeda.count, sumiyoshiPairs: r.sumiyoshi && r.sumiyoshi.count,
    rulerExists, rulerOrtho, rulerDefaultOff,
    relativeMedian: r.relative && r.relative.medianRatio,
    rotationDeg: rotationReported ? r.rotationFinding.rotationDeg : null,
    classification: r.classification, stopToken: r.stopToken,
    productionModified, protectedModified,
  };
  const out = { RESULT: errors.length ? 'FAIL' : 'PASS', generatedAt: new Date().toISOString(), missionId: '32L', checks, errors, warnings };
  await writeJson(OUT, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateAbsoluteMapScaleAudit().then((out) => {
    console.log('RESULT=' + out.RESULT);
    for (const w of out.warnings || []) console.log('WARN: ' + w);
    for (const e of out.errors || []) console.log('ERROR: ' + e);
    console.log(JSON.stringify(out.checks, null, 1));
    process.exitCode = out.RESULT === 'PASS' ? 0 : 1;
  });
}
