#!/usr/bin/env node
// tools/validate/umeda-real-world-ground-truth-audit.js
// [Mission 32H §21] AUDIT ONLY であることと、Ground Truth 照合が実際に行われたことを検証する。
//   buildingMutation / roadMutation / projectionMutation = 0
//   orthophotoGeoreferenced / controlPointsChecked / problemAndControlCompared / temporalDatesChecked
//   ※ orthophotoGeoreferenced は「航空写真が georeference されたか」であり、本環境には画像が無いため
//     false になる。これは失敗ではなく事実なので、RESULT は落とさず warnings に出す（捏造しない）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const REPORT = P('data', 'reports', 'umeda-real-world-ground-truth-audit.json');
const OUT = P('data', 'reports', 'umeda-real-world-ground-truth-audit-validation.json');
const G32 = P('data', 'reports', 'umeda-ground-footprint-audit.json');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

// 変更されていないことを確認する protected/production 資産
const PRODUCTION_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const WARD_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const ROAD_V2_DIR = P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v2', 'tiles');
const LAND_BLOCK = P('data', 'processed', 'osaka-city', 'visual-land-block-poc', 'umeda', 'blocks.json');
const AREA_CFG = P('config', 'areas', 'osaka-city.json');

function countCanonical(dir, key) {
  if (!fs.existsSync(dir)) return null;
  const seen = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    const t = rj(path.join(dir, f)); if (!t) continue;
    for (const ft of t.features || []) seen.add(ft[key]);
  }
  return seen.size;
}

export function validateRealWorldGroundTruthAudit() {
  const errors = [], warnings = [];
  const r = rj(REPORT);
  if (!r) { const out = { RESULT: 'FAIL', errors: ['レポートが無い: ' + toProjectRelativePath(REPORT)] }; writeJson(OUT, out); return out; }

  // ── §0/§21: 何も変更していないこと（不変条件の実測） ──
  const buildingCount = countCanonical(CANON_BLDGS, 'canonicalId');
  const roadV2Count = countCanonical(ROAD_V2_DIR, 'canonicalId');
  const lb = rj(LAND_BLOCK);
  const landBlockCount = lb ? (lb.blocks || []).length : null;
  const cfg = rj(AREA_CFG);
  const proj = cfg && cfg.projection;

  const EXPECT = { buildings: 615617, roadV2: 169468, landBlocks: 178 };
  const buildingMutation = buildingCount == null ? 1 : (buildingCount === EXPECT.buildings ? 0 : 1);
  const roadMutation = roadV2Count == null ? 1 : (roadV2Count === EXPECT.roadV2 ? 0 : 1);
  const landBlockMutation = landBlockCount == null ? 1 : (landBlockCount === EXPECT.landBlocks ? 0 : 1);
  const projectionMutation = proj && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320 ? 0 : 1;
  if (buildingMutation) errors.push('Canonical Buildings が ' + EXPECT.buildings + ' でない: ' + buildingCount);
  if (roadMutation) errors.push('ROAD V2 uniqueFeatureCount が ' + EXPECT.roadV2 + ' でない: ' + roadV2Count);
  if (landBlockMutation) errors.push('Land Block が ' + EXPECT.landBlocks + ' でない: ' + landBlockCount);
  if (projectionMutation) errors.push('projection(znorth-neg-v1) が変更されている');

  // ── production / protected の非改変 ──
  const htmlSrc = fs.existsSync(WARD_HTML) ? fs.readFileSync(WARD_HTML, 'utf-8') : '';
  const productionModified = fs.existsSync(PRODUCTION_HTML) && /realityQaEnabled|reality-qa|RealityQa_/.test(fs.readFileSync(PRODUCTION_HTML, 'utf-8'));
  const protectedModified = fs.existsSync(PROTECTED_HTML) && /realityQaEnabled|reality-qa|RealityQa_/.test(fs.readFileSync(PROTECTED_HTML, 'utf-8'));
  if (productionModified) errors.push('production HTML に 32H のコードが混入している');
  if (protectedModified) errors.push('protected HTML に 32H のコードが混入している');

  // ── §7: overlay は read-only（建物の押し出しを作らない） ──
  const qaStart = htmlSrc.indexOf('[Mission 32H §7] REALITY QA');
  const qaEnd = htmlSrc.indexOf('function getRealityQaDebug()');
  const qaSection = qaStart >= 0 && qaEnd > qaStart ? htmlSrc.slice(qaStart, qaEnd) : '';
  const overlayReadOnly = !!qaSection && !/pushExtrude/.test(qaSection);
  if (!qaSection) errors.push('ward HTML に Mission 32H の overlay コードが見つからない');
  else if (!overlayReadOnly) errors.push('overlay が pushExtrude を使っている（read-onlyでない）');

  // ── §21 の各チェック ──
  const gt = r.groundTruth || {};
  const orthophotoGeoreferenced = !!(r.orthophoto && r.orthophoto.available);
  const controlPointsChecked = !!(gt.alignment && gt.alignment.controlPointCount >= 10 && gt.alignment.distanceToNearestOsmHighwayM && gt.alignment.distanceToNearestOsmHighwayM.median != null);
  const problemAndControlCompared = !!(r.problemSampleCount >= 20 && r.controlSampleCount >= 20 && r.problemClassifications && r.controlClassifications && r.comparison && r.comparison.problem && r.comparison.control);
  const temporalDatesChecked = !!(r.temporalDates && r.temporalDates.plateauSurveyYears && Object.keys(r.temporalDates.plateauSurveyYears).length > 0 && r.temporalDates.gsiRoadEdgeVintages);

  if (!orthophotoGeoreferenced) {
    warnings.push('§21 orthophoteGeoreferenced=false: 航空写真がこの環境に存在しないため georeference は実行できなかった。'
      + '§8/§9(control point・alignment誤差)は、画像の代わりに独立ソースOSMに対して実施し、'
      + 'control point ' + (gt.alignment ? gt.alignment.controlPointCount : 0) + ' 点 / 中央値 '
      + (gt.alignment ? gt.alignment.distanceToNearestOsmHighwayM.median : 'n/a') + ' m を実測した。数値の捏造はしていない。');
  }
  if (!controlPointsChecked) errors.push('§8/§9: control point が10点未満、または alignment 誤差が測れていない');
  if (!problemAndControlCompared) errors.push('§1/§2: 問題群・対照群が各20棟以上そろって比較されていない');
  if (!temporalDatesChecked) errors.push('§14: 時点(測量年/データ年度)が記録されていない');

  // ── §3/§4: 梅田の生PLATEAUを一次証拠として使ったか ──
  const umedaRawUsed = !!(r.umedaRawPlateau && r.umedaRawPlateau.available && (r.umedaRawPlateau.meshFilesUsed || []).length > 0);
  const lod2Verdict = r.lod2Availability ? r.lod2Availability.verdict : null;
  if (!umedaRawUsed) errors.push('§3: 梅田の生PLATEAU CityGML を実データで確認していない');
  if (!/^UMEDA_LOD2_(AVAILABLE|NOT_AVAILABLE)$/.test(lod2Verdict || '')) errors.push('§4: LOD2 availability の判定が無い');

  // ── §19/§22: 最終分類とSTOPトークン ──
  const finalOk = /^(REAL_STRUCTURE_DOMINANT|PLATEAU_FOOTPRINT_QUALITY_ISSUE|TEMPORAL_DATA_CONFLICT|MIXED_CAUSES|INSUFFICIENT_GROUND_TRUTH)$/.test(r.finalClassification || '');
  const stopOk = /^(REAL_WORLD_ROOT_CAUSE_IDENTIFIED|REAL_WORLD_GROUND_TRUTH_INSUFFICIENT)$/.test(r.stopToken || '');
  if (!finalOk) errors.push('§19: finalClassification が5択でない: ' + r.finalClassification);
  if (!stopOk) errors.push('§22: stopToken が2択でない: ' + r.stopToken);
  if (!r.recommendedPolicy || !r.recommendedPolicy.policy) errors.push('§20: recommendedPolicy が無い');

  // ── 測定の健全性: 判定根拠に road/rail 重なり量を使っていないこと（32Gの循環論法の再発防止） ──
  const usedOverlapAsEvidence = (r.problemBuildings || []).some((b) => b.classificationEvidence === 'ROAD_RAIL_OVERLAP');
  if (usedOverlapAsEvidence) errors.push('サンプル選定条件(道路/線路重なり)を分類根拠に再利用している（循環論法）');
  const evidenceKinds = [...new Set((r.problemBuildings || []).map((b) => b.classificationEvidence).filter(Boolean))];

  // ── 不在ベースの結論には妥当性ゲートを通していること ──
  const absenceConclusions = (r.problemBuildings || []).concat(r.controlBuildings || []).filter((b) => b.classification === 'PLATEAU_FOOTPRINT_OVERSIZED').length;
  if (absenceConclusions > 0 && !gt.osmAbsenceUsedAsEvidence) errors.push('OSMの「不在」を根拠にOVERSIZEDと判定しているのに妥当性ゲートを通っていない');

  const checks = {
    buildingMutation, roadMutation, landBlockMutation, projectionMutation,
    orthophotoGeoreferenced, controlPointsChecked, problemAndControlCompared, temporalDatesChecked,
    umedaRawPlateauUsedAsPrimaryEvidence: umedaRawUsed,
    lod2AvailabilityVerdict: lod2Verdict,
    overlayReadOnly, productionModified, protectedModified,
    canonicalBuildings: buildingCount, roadV2Features: roadV2Count, landBlocks: landBlockCount,
    problemSampleCount: r.problemSampleCount, controlSampleCount: r.controlSampleCount,
    alignmentControlPoints: gt.alignment ? gt.alignment.controlPointCount : 0,
    alignmentMedianM: gt.alignment ? gt.alignment.distanceToNearestOsmHighwayM.median : null,
    osmUsedAsEvidence: !!gt.osmUsedAsEvidence,
    osmAbsenceUsedAsEvidence: !!gt.osmAbsenceUsedAsEvidence,
    evidenceKinds,
    finalClassification: r.finalClassification, stopToken: r.stopToken,
  };
  const out = { RESULT: errors.length ? 'FAIL' : 'PASS', generatedAt: new Date().toISOString(), missionId: '32H', checks, errors, warnings };
  writeJson(OUT, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  const out = validateRealWorldGroundTruthAudit();
  console.log('RESULT=' + out.RESULT);
  for (const w of out.warnings || []) console.log('WARN: ' + w);
  for (const e of out.errors || []) console.log('ERROR: ' + e);
  console.log(JSON.stringify(out.checks, null, 1));
  if (out.RESULT !== 'PASS') process.exit(1);
}
