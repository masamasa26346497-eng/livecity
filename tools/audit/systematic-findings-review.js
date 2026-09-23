#!/usr/bin/env node
// tools/audit/systematic-findings-review.js
// [Mission 31F §9/§10/§11] 31E の 3 systematic findings を掘り下げる。
//   #1 possible-osm-water-boundary-error 42: 公的水涯線 source が repo にあるか再確認。無ければ MANUAL_REVIEW 維持。
//   #2 central-arterial-road-area-building-block-overlap 125: sectionType / alignment / source を分析（原因分析まで。補正しない）。
//   #3 park-polygon-possibly-too-broad 82: canonical parks build 後に再評価。
//
//   出力: data/reports/water-boundary-systematic-review.json
//         data/reports/road-building-systematic-review.json
//         data/reports/park-broad-systematic-review.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const MANUAL_REVIEW = P('data', 'reports', 'canonical-manual-review.json');
const TRAN_CONV = P('data', 'reports', 'plateau-tran-conversion.json');
const ROADS_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const PARKS_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'parks');
const BUILD_DIR = P('public', 'map-data', 'osaka-city', 'buildings');

function loadRoadById() {
  const byId = new Map();
  if (!fs.existsSync(ROADS_DIR)) return byId;
  for (const f of fs.readdirSync(ROADS_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    for (const ft of (JSON.parse(fs.readFileSync(path.join(ROADS_DIR, f), 'utf-8')).features || [])) {
      if (!byId.has(ft.canonicalId)) byId.set(ft.canonicalId, ft);
    }
  }
  return byId;
}
function loadParkByName() {
  const byName = new Map();
  if (!fs.existsSync(PARKS_DIR)) return byName;
  for (const f of fs.readdirSync(PARKS_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    for (const ft of (JSON.parse(fs.readFileSync(path.join(PARKS_DIR, f), 'utf-8')).features || [])) {
      if (ft.attributes && ft.attributes.name && !byName.has(ft.attributes.name)) byName.set(ft.attributes.name, ft);
    }
  }
  return byName;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const mr = fs.existsSync(MANUAL_REVIEW) ? JSON.parse(fs.readFileSync(MANUAL_REVIEW, 'utf-8')) : { items: [] };
  const items = mr.items || [];

  // ── #1 water boundary ──
  const waterItems = items.filter((x) => x.causeCandidate === 'possible-osm-water-boundary-error');
  const publicSources = [
    { id: 'gsi-fundamental-water-edge', name: 'GSI 基盤地図情報 水涯線（水域界）', inRepo: fs.existsSync(P('data', 'raw', 'osaka-city', 'gsi-water-edge.json')) },
    { id: 'osaka-pref-river-area', name: '大阪府 河川区域 GIS', inRepo: false },
    { id: 'plateau-luse-water', name: 'PLATEAU 土地利用 luse（河川地及び湖沼）', inRepo: fs.existsSync(P('data', 'raw', 'plateau', 'osaka-city', 'luse')), note: '配布 ZIP に luse は在るが河川 polygon が ~7 件のみで水域界 source として不十分（未取得）。' },
    { id: 'msil-coastline', name: '海上保安庁 海岸線 / MSIL', inRepo: false },
  ];
  const anyPublic = publicSources.some((s) => s.inRepo);
  const waterReview = {
    generatedAt, finding: 'possible-osm-water-boundary-error', count: waterItems.length,
    publicWaterBoundarySources: publicSources,
    anyPublicSourceAvailable: anyPublic,
    decision: anyPublic ? 'COMPARE-AUDIT' : 'MANUAL_REVIEW-MAINTAINED',
    rationale: anyPublic
      ? '公的水涯線が repo にあるため canonical water polygon との差分 audit を実施する。'
      : '公的水涯線 source が repo・PLATEAU 配布のいずれにも十分な形で存在しない。OSM riverbank polygon の陸側過剰包含は疑わしいが、推測補正は禁止（§9）。GSI 基盤地図情報 水涯線 または 大阪府 河川区域 GIS を取得後に一括是正する。MANUAL_REVIEW を維持。',
    items: waterItems.map((x) => ({ conflictId: x.conflictId, ward: x.ward, landmark: x.landmark, water: x.names && x.names.park || (x.names && x.names.water), areaM2: x.areaM2, location: x.location })),
  };
  await writeJson(P('data', 'reports', 'water-boundary-systematic-review.json'), waterReview);

  // ── #2 central arterial road/building ──
  const roadItems = items.filter((x) => x.causeCandidate === 'central-arterial-road-area-building-block-overlap' || x.causeCandidate === 'tran-road-vs-building-block-disagreement');
  const roadById = loadRoadById();
  const tranConv = fs.existsSync(TRAN_CONV) ? JSON.parse(fs.readFileSync(TRAN_CONV, 'utf-8')) : null;
  const bySectionType = {}, byAdminClass = {}, byStructure = {}, byGeomSource = {};
  let withSectionKnown = 0, withSectionUnknown = 0, plateauTranRoad = 0, ribbonRoad = 0;
  const alignVectors = [];
  for (const x of roadItems) {
    const rid = x.featureIds && x.featureIds.A;
    const rf = rid ? roadById.get(rid) : null;
    if (!rf) continue;
    const a = rf.attributes || {};
    const st = a.sectionTypeCode || 'none';
    bySectionType[st] = (bySectionType[st] || 0) + 1;
    byStructure[a.plateauStructure || a.structure || 'none'] = (byStructure[a.plateauStructure || a.structure || 'none'] || 0) + 1;
    byAdminClass[a.plateauAdminClass || a.adminClass || 'none'] = (byAdminClass[a.plateauAdminClass || a.adminClass || 'none'] || 0) + 1;
    byGeomSource[rf.source.geometrySource] = (byGeomSource[rf.source.geometrySource] || 0) + 1;
    if (rf.source.geometrySource === 'plateau-tran-road') plateauTranRoad++; else ribbonRoad++;
    if ((a.plateauStructure && a.plateauStructure !== 'unknown') || (a.sectionTypeCode && a.sectionTypeCode !== '9')) withSectionKnown++;
    else withSectionUnknown++;
    // alignment: road centroid → conflict overlapCentroid（≒ building 群中心）ベクトル
    if (rf.centroid && x.location == null && x.overlapCentroid) {
      // 局所座標が無いので skip
    }
  }
  // alignment: manual-review item の overlapCentroid は捨てられているので、conflict-all から補完
  const allC = fs.existsSync(P('data', 'reports', 'canonical-conflicts-all.json')) ? JSON.parse(fs.readFileSync(P('data', 'reports', 'canonical-conflicts-all.json'), 'utf-8')) : { conflicts: [] };
  const cById = new Map(allC.conflicts.map((c) => [c.conflictId, c]));
  for (const x of roadItems) {
    const c = cById.get(x.conflictId);
    const rf = c && roadById.get(c.roadCanonicalId);
    if (!c || !rf || !rf.centroid || !c.overlapCentroid) continue;
    alignVectors.push([c.overlapCentroid[0] - rf.centroid[0], c.overlapCentroid[1] - rf.centroid[1]]);
  }
  let meanVec = null, alignConsistency = null;
  if (alignVectors.length) {
    const mx = alignVectors.reduce((s, v) => s + v[0], 0) / alignVectors.length;
    const mz = alignVectors.reduce((s, v) => s + v[1], 0) / alignVectors.length;
    const meanMag = Math.hypot(mx, mz);
    const avgMag = alignVectors.reduce((s, v) => s + Math.hypot(v[0], v[1]), 0) / alignVectors.length;
    meanVec = [+mx.toFixed(1), +mz.toFixed(1), +meanMag.toFixed(1)];
    // 一貫した offset なら |meanVec| ≈ avgMag。ランダムなら |meanVec| << avgMag。
    alignConsistency = +(meanMag / (avgMag || 1)).toFixed(3);
  }
  const roadReview = {
    generatedAt, finding: 'central-arterial-road-area-building-block-overlap', count: roadItems.length,
    roadFeaturesResolved: roadItems.filter((x) => x.featureIds && roadById.has(x.featureIds.A)).length,
    bySectionTypeCode: bySectionType, byPlateauStructure: byStructure, byAdminClass, byGeometrySource: byGeomSource,
    sectionKnown: withSectionKnown, sectionUnknown: withSectionUnknown,
    plateauTranRoad, ribbonRoad,
    tranConversionSectionTypeDistribution: tranConv ? (tranConv.stats && tranConv.stats.byStructure) : null,
    alignment: {
      sampleCount: alignVectors.length,
      meanVector: meanVec,
      consistency: alignConsistency,
      interpretation: alignConsistency == null ? 'サンプル無し'
        : alignConsistency > 0.6 ? '一貫した方向の offset ＝ PLATEAU tran と bldg の位置系ずれの可能性が高い'
          : alignConsistency > 0.3 ? '弱い方向性 ＝ 一部 offset + 一部 tran 幅過大の混在'
            : '方向性ほぼ無し ＝ PLATEAU tran 道路区域が実舗装より広く描かれている（都市計画決定幅の可能性）が支配的',
    },
    conclusion: 'sectionType が大半 unknown のため高架判定はできない（§8/§10）。geometry correction の根拠は無い。'
      + '31G の描画では PLATEAU tran 道路区域を「舗装縁」ではなく「道路敷地界」として扱い、建物と重なっても矛盾表示しない設計とする。',
    action: 'CAUSE-ANALYSIS-ONLY（§10: 根拠無し geometry correction 禁止）',
    items: roadItems.map((x) => ({ conflictId: x.conflictId, ward: x.ward, road: x.names && x.names.road, areaM2: x.areaM2, overlapRatioA: x.overlapRatioA, overlapRatioB: x.overlapRatioB })),
  };
  await writeJson(P('data', 'reports', 'road-building-systematic-review.json'), roadReview);

  // ── #3 park broad ──
  const parkItems = items.filter((x) => x.causeCandidate === 'park-polygon-possibly-too-broad');
  const parkByName = loadParkByName();
  let reclassifiedNow = 0, stillFlagged = 0, notFound = 0;
  const parkRows = [];
  for (const x of parkItems) {
    const nm = x.names && x.names.park;
    const pf = nm ? parkByName.get(nm) : null;
    if (!pf) { notFound++; continue; }
    const pc = pf.attributes.parkClass;
    const flags = pf.qaFlags || [];
    if (pc === 'misclassified-block') reclassifiedNow++;
    else if (flags.some((q) => q.startsWith('possibly-too-broad'))) stillFlagged++;
    parkRows.push({ conflictId: x.conflictId, park: nm, ward: x.ward, canonicalParkClass: pc, qaFlags: flags, buildingShareOfPark: x.overlapRatioB });
  }
  const parkReview = {
    generatedAt, finding: 'park-polygon-possibly-too-broad', count: parkItems.length,
    afterCanonicalParksBuild: {
      reclassifiedToMisclassifiedBlock: reclassifiedNow,
      stillFlaggedPossiblyTooBroad: stillFlagged,
      notFoundInCanonicalParks: notFound,
    },
    decision: 'canonical parks で parkClass を付与し、possibly-too-broad は qaFlag のみ（clip しない §7/§11）。'
      + ' 真の building-in-park との分離は、公的公園区域 polygon 取得後（rank1 source）に実施。',
    separationCriterion: 'buildingShareOfPark > 0.8 → park-polygon-not-a-park（misclassified-block）／ 0.35-0.8 → possibly-too-broad（要 evidence）／ < 0.35 → park-facility（EXPLAIN）',
    items: parkRows,
  };
  await writeJson(P('data', 'reports', 'park-broad-systematic-review.json'), parkReview);

  console.log('[systematic-findings-review]');
  console.log('  #1 water-boundary: ' + waterItems.length + ' 件 → ' + waterReview.decision);
  console.log('  #2 road-building: ' + roadItems.length + ' 件 / alignment consistency ' + alignConsistency + ' → ' + roadReview.action);
  console.log('     ' + roadReview.alignment.interpretation);
  console.log('  #3 park-broad: ' + parkItems.length + ' 件 / reclassified-now ' + reclassifiedNow + ' / still-flagged ' + stillFlagged);
  console.log('保存: water-boundary / road-building / park-broad -systematic-review.json');
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[systematic-findings-review] 失敗:', e && e.stack || e); process.exit(1); });
