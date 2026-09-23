#!/usr/bin/env node
// tools/audit/canonical-conflict-resolution.js
// [Mission 31E §2/§3/§4/§7/§10/§17/§18/§21] canonical conflict の分類と解消判断。
//   canonical-conflicts-all.json（HIGH/MEDIUM 全件 + INFO サンプル）を読み、各 conflict に
//   action（KEEP/EXPLAIN/CORRECT_A/CORRECT_B/RECLASSIFY/SUPPRESS_RENDER_ONLY/MANUAL_REVIEW）と
//   reviewStatus を付ける。overlap を 0 にするのが目的ではなく「正しい分類」を付けるのが目的。
//
//   出力:
//     data/reports/canonical-conflict-resolution.json     全 conflict の分類
//     data/reports/canonical-manual-review.json           自動判断できない分（§17）
//     data/reports/canonical-conflicts-review.geojson      severity 別 visual review（§18）
//     data/reports/canonical-conflict-representative-qa.json  代表地点 QA（§5/§6/§19）
//
// 実行: node tools/audit/canonical-conflict-resolution.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const ALL = P('data', 'reports', 'canonical-conflicts-all.json');
const CONFLICTS = P('data', 'reports', 'canonical-conflicts.json');
const WARDS = P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const AREA = P('config', 'areas', 'osaka-city.json');
const OUT_RES = P('data', 'reports', 'canonical-conflict-resolution.json');
const OUT_MR = P('data', 'reports', 'canonical-manual-review.json');
const OUT_GJ = P('data', 'reports', 'canonical-conflicts-review.geojson');
const OUT_QA = P('data', 'reports', 'canonical-conflict-representative-qa.json');

// §16 sliver tolerance: これ以下は境界丸めとして EXPLAIN（severity に関わらず）
const SLIVER_AREA_M2 = 40;
const SLIVER_FRACTION = 0.02;

// §19 代表地点（znorth-neg-v1 局所座標・半径 m）。
const LANDMARKS = [
  { name: '大川', x: -600, z: -11000, r: 2200 },
  { name: '安治川', x: -6500, z: -7200, r: 2600 },
  { name: '梅田', x: -250, z: -9600, r: 900 },
  { name: '中之島', x: -450, z: -8600, r: 900 },
  { name: '難波', x: -250, z: -6300, r: 900 },
  { name: '天王寺', x: 350, z: -4600, r: 900 },
  { name: '大阪城', x: 1250, z: -8100, r: 1100 },
  { name: '十三', x: -1450, z: -12400, r: 900 },
  { name: '阿倍野', x: 350, z: -4100, r: 900 },
  { name: '住吉', x: -250, z: -300, r: 1200 },
  { name: '夢洲', x: -13500, z: -8000, r: 2500 },
  { name: '南港', x: -9500, z: -3500, r: 2500 },
];

function pip(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > pt[1]) !== (zj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function loadWards() {
  if (!fs.existsSync(WARDS)) return [];
  return JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards.map((w) => ({ name: w.wardName, bbox: w.bbox, polys: w.polygons }));
}
function wardAt(pt, wards) {
  if (!pt) return null;
  for (const w of wards) {
    const b = w.bbox;
    if (pt[0] < b.minX || pt[0] > b.maxX || pt[1] < b.minZ || pt[1] > b.maxZ) continue;
    for (const p of w.polys) {
      if (!pip(pt, p.outer)) continue;
      let hole = false;
      for (const h of (p.holes || [])) if (pip(pt, h)) { hole = true; break; }
      if (!hole) return w.name;
    }
  }
  return null;
}
function landmarkAt(pt) {
  if (!pt) return null;
  let best = null, bd = Infinity;
  for (const lm of LANDMARKS) {
    const d = Math.hypot(pt[0] - lm.x, pt[1] - lm.z);
    if (d <= lm.r && d < bd) { best = lm.name; bd = d; }
  }
  return best;
}
function projFromArea() {
  const proj = JSON.parse(fs.readFileSync(AREA, 'utf-8')).projection;
  const cosf = Math.cos((proj.centerLat * Math.PI) / 180);
  return (x, z) => [
    +(proj.centerLon + x / (cosf * proj.metersPerDegree)).toFixed(6),
    +(proj.centerLat - z / proj.metersPerDegree).toFixed(6),
  ];
}

// ── §3 分類ロジック ─────────────────────────────────────────────────────────────
function classify(c) {
  const r = { action: null, resolvedCause: c.cause, reviewStatus: null, reasoning: null, evidence: null };

  // §16 sliver tolerance（severity 問わず）
  if ((c.overlapAreaM2 || 0) < SLIVER_AREA_M2 || (c.overlapFraction || 0) < SLIVER_FRACTION) {
    return { ...r, action: 'EXPLAIN', resolvedCause: 'boundary-rounding-sliver', reviewStatus: 'AUTO_EXPLAINED',
      reasoning: `overlap ${c.overlapAreaM2}m² / frac ${c.overlapFraction} が sliver tolerance 内（§16）。境界丸め。` };
  }

  // audit が既に意味付けした conflict はそのまま EXPLAIN
  if (c.explanation) {
    return { ...r, action: 'EXPLAIN', resolvedCause: c.explanation, reviewStatus: 'AUTO_EXPLAINED',
      reasoning: `conflict audit で ${c.explanation} と意味付け済み。` };
  }

  const isHigh = c.severity === 'HIGH' || c.severity === 'CRITICAL';

  if (c.code === 'BUILDING_WATER') {
    // MEDIUM: OSM 水域 polygon の陸側エッジが PLATEAU footprint より粗いことによる系統的な縁重なり。
    //   個別 review 不要（severity MEDIUM ＝ 明確な defect ではない）。
    if (!isHigh) {
      return { ...r, action: 'EXPLAIN', resolvedCause: 'osm-water-boundary-imprecision', reviewStatus: 'AUTO_EXPLAINED',
        reasoning: `MEDIUM。OSM 由来水域 polygon（conf ${c.waterConfidence}）の陸側エッジが PLATEAU footprint（conf 0.95）より粗く、岸の建物前面を取り込む系統的な縁重なり。frac ${c.overlapFraction}。建物側を採用し水側は非採用（建物は削らない §0）。` };
    }
    if (c.overlapFraction < 0.15) {
      return { ...r, action: 'EXPLAIN', resolvedCause: 'osm-water-boundary-imprecision', reviewStatus: 'AUTO_EXPLAINED',
        reasoning: `HIGH だが frac ${c.overlapFraction} は縁のかすり。OSM 水域 polygon の陸側エッジが粗く岸の建物前面を取り込んでいるだけで、建物の水上実侵入ではない。より確度の高い建物側を採用。` };
    }
    return { ...r, action: 'MANUAL_REVIEW', resolvedCause: 'possible-osm-water-boundary-error', reviewStatus: 'NEEDS_EVIDENCE',
      reasoning: `frac ${c.overlapFraction} は縁のかすりでは説明しにくい規模。OSM 水域 polygon の陸側過剰包含か、特定建物 footprint 誤りかを自動判別できない。水域は 31E で clip しない（§0: 建物を water から一括削除しない / source のない geometry を推測生成しない）。`,
      evidence: '航空写真 / GSI 基盤地図情報 水涯線 と PLATEAU building footprint の照合。' };
  }

  if (c.code === 'BUILDING_ROAD') {
    // 31C2: PLATEAU tran 道路区域 = 法的区域界（車道＋歩道＋前面）。同一出典（PLATEAU bldg）が
    //   その区域界まで footprint を持つのは境界解釈差であって地図上の矛盾ではない。
    if (c.roadStructure === 'elevated' || c.roadStructure === 'bridge' || c.roadBridge || (c.roadLayer && c.roadLayer > 0)) {
      return { ...r, action: 'EXPLAIN', resolvedCause: 'building-over-elevated-road', reviewStatus: 'AUTO_EXPLAINED',
        reasoning: `道路は高架/橋梁（structure=${c.roadStructure} bridge=${c.roadBridge} layer=${c.roadLayer}）。高架下に建物＝正常。` };
    }
    if (c.roadStructure === 'tunnel' || c.roadStructure === 'underpass' || c.roadTunnel || (c.roadLayer && c.roadLayer < 0)) {
      return { ...r, action: 'EXPLAIN', resolvedCause: 'building-over-covered-road', reviewStatus: 'AUTO_EXPLAINED',
        reasoning: `道路はトンネル/アンダーパス（structure=${c.roadStructure}）。地下道路の上に建物＝正常。` };
    }
    // MEDIUM: 系統的な PLATEAU bldg ∩ PLATEAU tran-road 境界重なり。個別 review 不要。
    if (!isHigh) {
      return { ...r, action: 'EXPLAIN', resolvedCause: 'plateau-building-tran-road-boundary-overlap', reviewStatus: 'AUTO_EXPLAINED',
        reasoning: `MEDIUM。PLATEAU tran 道路区域は法的区域界（歩道・前面を含む。31C2 で確認）。同一出典の PLATEAU building footprint がその区域界まで達する系統的な重なり（frac ${c.overlapFraction} / bldgs ${c.overlapBuildingCount}）。map の矛盾ではない。` };
    }
    if ((c.roadAreaM2 || 0) < 800) {
      return { ...r, action: 'EXPLAIN', resolvedCause: 'tran-road-small-fragment-overlap', reviewStatus: 'AUTO_EXPLAINED',
        reasoning: `HIGH だが対象は小さな tran polygon（${c.roadAreaM2}m²・隅切り/分離帯/交差部の断片）で、建物の下に大半が入る。geometry の矛盾ではなく描画時に建物へ隠れる断片。31G の描画側で扱う（SUPPRESS_RENDER_ONLY 相当）。` };
    }
    if ((c.overlapFraction || 0) < 0.40) {
      return { ...r, action: 'EXPLAIN', resolvedCause: 'plateau-road-area-frontage-overlap', reviewStatus: 'AUTO_EXPLAINED',
        reasoning: `road polygon の ${Math.round((c.overlapFraction || 0) * 100)}% のみ建物と重なる（縁の frontage）。PLATEAU tran 道路区域の法的区域界に PLATEAU footprint が達しているだけ。` };
    }
    if ((c.deepestBuildingCoverage || 0) < 0.5) {
      return { ...r, action: 'EXPLAIN', resolvedCause: 'plateau-wide-road-area-frontage-overlap', reviewStatus: 'AUTO_EXPLAINED',
        reasoning: `frac は ${Math.round((c.overlapFraction || 0) * 100)}% と大きいが、最も深い建物でも footprint の ${Math.round((c.deepestBuildingCoverage || 0) * 100)}% しか区域内に無い（deepest < 50%）。御堂筋・谷町筋等の幅広歩道を持つ幹線で、沿道建物前面が広い歩道区域に接しているだけ。建物が車道へ実侵入しているのではない。` };
    }
    return { ...r, action: 'MANUAL_REVIEW', resolvedCause: 'central-arterial-road-area-building-block-overlap', reviewStatus: 'NEEDS_EVIDENCE',
      reasoning: `${c.overlapBuildingCount} 棟が road area（${c.roadAreaM2}m²）の ${Math.round((c.overlapFraction || 0) * 100)}% を覆い、最深建物は区域内 ${Math.round((c.deepestBuildingCoverage || 0) * 100)}%。frontage では説明できない。中央区・北区の幹線に集中しており、PLATEAU tran 道路区域が都市計画決定幅で描かれている／PLATEAU tran と bldg の位置系に系統ずれがある可能性。sectionType が 42.7% 不明のため自動で高架化しない（§8）。`,
      evidence: '航空写真 + 当該 tran:Road の uro:sectionType / uro:lodType / uro:width 精査 + 同一街区の PLATEAU bldg/tran 位置整合確認（グループで 1 つの根本原因の可能性）。' };
  }

  if (c.code === 'PARK_BUILDING') {
    const share = c.buildingShareOfPark || 0;
    if (!isHigh) {
      return { ...r, action: 'EXPLAIN', resolvedCause: 'park-facility-or-minor-overreach', reviewStatus: 'AUTO_EXPLAINED',
        reasoning: `MEDIUM。公園内施設（share ${Math.round(share * 100)}%）または OSM park polygon の軽微な過剰包含。個別 review 不要。` };
    }
    if (share > 0.8) {
      return { ...r, action: 'RECLASSIFY', resolvedCause: 'park-polygon-not-a-park', reviewStatus: 'CORRECTION_QUEUED',
        reasoning: `建物総面積が公園面積の ${Math.round(share * 100)}%。この leisure=park polygon は実質「街区」であって公園ではない（OSM の過大 polygon or landuse 誤タグ）。park canonical 分類の信頼度を下げ、31F の canonical parks build で境界を再導出する。`,
        evidence: 'OSM way/relation メンバー確認 + 航空写真。' };
    }
    if (share >= 0.35) {
      return { ...r, action: 'MANUAL_REVIEW', resolvedCause: 'park-polygon-possibly-too-broad', reviewStatus: 'NEEDS_EVIDENCE',
        reasoning: `建物総面積が公園の ${Math.round(share * 100)}%。OSM park polygon が隣接街区を巻き込んでいる可能性。`,
        evidence: 'OSM park polygon 範囲を航空写真で確認。公園実範囲との差分を測る。' };
    }
    return { ...r, action: 'EXPLAIN', resolvedCause: 'park-facility', reviewStatus: 'AUTO_EXPLAINED',
      reasoning: `建物面積は公園の ${Math.round(share * 100)}% のみ。公園内施設（管理棟・トイレ・売店・スポーツ施設）。` };
  }

  if (c.code === 'BUILDING_RAIL') {
    // §9: HIGH 0 が前提。HIGH が出たら要確認。
    return { ...r, action: 'MANUAL_REVIEW', resolvedCause: 'building-rail-high-unexpected', reviewStatus: 'NEEDS_EVIDENCE',
      reasoning: 'Building∩Rail は HIGH 0 が baseline。HIGH が出現＝回帰の可能性。', evidence: '当該建物と rail corridor の位置確認。' };
  }

  if (c.code === 'ROAD_WATER') {
    return { ...r, action: 'EXPLAIN', resolvedCause: c.cause || 'bridge', reviewStatus: 'AUTO_EXPLAINED',
      reasoning: `Road∩Water は単純 overlap を ERROR にしない（§11）。${c.cause}。` };
  }

  return { ...r, action: 'MANUAL_REVIEW', resolvedCause: 'unclassified', reviewStatus: 'NEEDS_EVIDENCE', reasoning: '分類ルール未整備。' };
}

async function main() {
  if (!fs.existsSync(ALL)) { console.error('canonical-conflicts-all.json が無い。先に node tools/audit/canonical-conflicts.js'); process.exit(1); }
  const all = JSON.parse(fs.readFileSync(ALL, 'utf-8'));
  const full = JSON.parse(fs.readFileSync(CONFLICTS, 'utf-8'));
  const wards = loadWards();
  const toLonLat = projFromArea();
  const generatedAt = new Date().toISOString();

  const resolved = [];
  for (const c of all.conflicts) {
    const cls = classify(c);
    const pt = c.overlapCentroid || null;
    resolved.push({
      conflictId: c.conflictId,
      pairType: c.code,
      featureA: c.waterCanonicalId || c.roadCanonicalId || c.parkId || c.railName || null,
      featureB: c.code === 'BUILDING_RAIL' ? (c.buildingId || null)
        : (c.overlapBuildings || []).slice(0, 6).map((b) => b.id).filter(Boolean),
      overlapAreaM2: c.overlapAreaM2 || null,
      overlapRatioA: c.overlapFraction != null ? c.overlapFraction : null,
      overlapRatioB: c.deepestBuildingCoverage != null ? c.deepestBuildingCoverage
        : (c.buildingShareOfPark != null ? c.buildingShareOfPark : null),
      buildingShareOfPark: c.buildingShareOfPark != null ? c.buildingShareOfPark : null,
      severity: c.severity,
      cause: c.cause,
      explanation: c.explanation || null,
      resolvedCause: cls.resolvedCause,
      confidenceA: c.waterConfidence != null ? c.waterConfidence : (c.roadConfidence != null ? c.roadConfidence : null),
      confidenceB: 0.95, // PLATEAU building。fallback は個別に overlapBuildings.src で判る
      sourceA: c.waterGeometrySource || c.roadGeometrySource || c.parkTag || c.railway || null,
      sourceB: c.source,
      action: cls.action,
      reviewStatus: cls.reviewStatus,
      reasoning: cls.reasoning,
      evidence: cls.evidence,
      ward: pt ? wardAt(pt, wards) : null,
      landmark: pt ? landmarkAt(pt) : null,
      location: pt ? toLonLat(pt[0], pt[1]) : null,
      overlapCentroid: pt,
      names: { water: c.waterName, road: c.roadName, park: c.parkName, rail: c.railName },
    });
  }

  // ── 集計（§21）──
  const byAction = {}, byPairAction = {}, byPairReview = {};
  for (const x of resolved) {
    byAction[x.action] = (byAction[x.action] || 0) + 1;
    const pk = x.pairType;
    byPairAction[pk] = byPairAction[pk] || {};
    byPairAction[pk][x.action] = (byPairAction[pk][x.action] || 0) + 1;
    byPairReview[pk] = byPairReview[pk] || {};
    byPairReview[pk][x.reviewStatus] = (byPairReview[pk][x.reviewStatus] || 0) + 1;
  }
  // HIGH のみ（§21 の before/after HIGH）
  const highResolved = resolved.filter((x) => x.severity === 'HIGH' || x.severity === 'CRITICAL');
  const highByPairAction = {};
  for (const x of highResolved) {
    highByPairAction[x.pairType] = highByPairAction[x.pairType] || {};
    highByPairAction[x.pairType][x.action] = (highByPairAction[x.pairType][x.action] || 0) + 1;
  }
  const unresolvedHigh = highResolved.filter((x) => x.action === 'MANUAL_REVIEW');

  // ── §17 manual review list ──
  const manualReview = resolved.filter((x) => x.action === 'MANUAL_REVIEW').map((x) => ({
    conflictId: x.conflictId, pairType: x.pairType, severity: x.severity,
    location: x.location, landmark: x.landmark, ward: x.ward,
    featureIds: { A: x.featureA, B: x.featureB },
    areaM2: x.overlapAreaM2, overlapRatioA: x.overlapRatioA, overlapRatioB: x.overlapRatioB,
    names: x.names,
    causeCandidate: x.resolvedCause,
    reasoning: x.reasoning,
    recommendedEvidence: x.evidence,
  })).sort((a, b) => (b.areaM2 || 0) - (a.areaM2 || 0));

  // ── §18 review GeoJSON（HIGH は全件、MEDIUM は 400 件サンプル）──
  const gjFeats = [];
  let mediumEmitted = 0;
  for (const x of resolved) {
    if (!x.location) continue;
    if (x.severity === 'MEDIUM') { if (++mediumEmitted > 400) continue; }
    gjFeats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: x.location },
      properties: {
        conflictId: x.conflictId, severity: x.severity, pairType: x.pairType,
        cause: x.resolvedCause, action: x.action, reviewStatus: x.reviewStatus,
        featureA: x.featureA, featureB: Array.isArray(x.featureB) ? x.featureB.join(',') : x.featureB,
        overlapArea: x.overlapAreaM2, confidenceA: x.confidenceA, confidenceB: x.confidenceB,
        ward: x.ward, landmark: x.landmark,
      },
    });
  }
  await writeJson(OUT_GJ, {
    type: 'FeatureCollection', name: 'canonical-conflicts-review (31E)',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    note: 'HIGH 全件 + MEDIUM 400 件サンプル + INFO サンプル。severity / action / cause で色分け確認。',
    features: gjFeats,
  });

  // ── §5/§6/§19 代表地点 QA ──
  const repQa = LANDMARKS.map((lm) => {
    const near = resolved.filter((x) => x.overlapCentroid && Math.hypot(x.overlapCentroid[0] - lm.x, x.overlapCentroid[1] - lm.z) <= lm.r);
    const byPair = {}, byAct = {};
    for (const x of near) { byPair[x.pairType] = (byPair[x.pairType] || 0) + 1; byAct[x.action] = (byAct[x.action] || 0) + 1; }
    return {
      location: lm.name, center: [lm.x, lm.z], radiusM: lm.r,
      conflictsNear: near.length, byPair, byAction: byAct,
      highNear: near.filter((x) => x.severity === 'HIGH').length,
      manualReviewNear: near.filter((x) => x.action === 'MANUAL_REVIEW').length,
      notable: near.filter((x) => x.severity === 'HIGH').sort((a, b) => (b.overlapAreaM2 || 0) - (a.overlapAreaM2 || 0)).slice(0, 5)
        .map((x) => ({ conflictId: x.conflictId, pair: x.pairType, cause: x.resolvedCause, action: x.action, area: x.overlapAreaM2, name: x.names.water || x.names.road || x.names.park })),
    };
  });

  const resolution = {
    generatedAt,
    baseline: { file: 'data/reports/baselines/canonical-conflicts-31E-before.json' },
    inputCounts: { byCode: all.byCode, bySeverity: all.bySeverity },
    totalResolved: resolved.length,
    byAction, byPairAction, byPairReview,
    high: {
      total: highResolved.length,
      byPairAction: highByPairAction,
      explained: highResolved.filter((x) => x.action === 'EXPLAIN').length,
      reclassify: highResolved.filter((x) => x.action === 'RECLASSIFY').length,
      manualReview: unresolvedHigh.length,
      unexplainedAfter: 0, // MANUAL_REVIEW として明示 → unexplained は 0（§20）
    },
    representativeQa: repQa,
    note: 'action の意味: EXPLAIN=正常/既知の境界解釈差, RECLASSIFY=分類修正待ち, MANUAL_REVIEW=source 不足で自動判断不能（§17 リスト参照）, CORRECT_*=geometry 補正（現状 water の 1 件のみ・corrections/ 参照）。',
    RESULT: 'RESOLUTION-DONE',
  };
  fs.mkdirSync(path.dirname(OUT_RES), { recursive: true });
  // resolved 全件は別ファイルが大きくなるので HIGH+RECLASSIFY+MANUAL_REVIEW を格納、EXPLAIN は集計のみ
  await writeJson(OUT_RES, {
    ...resolution,
    conflicts: resolved.filter((x) => x.severity !== 'MEDIUM' || x.action !== 'EXPLAIN').slice(0, 2000),
    explainedMediumCount: resolved.filter((x) => x.severity === 'MEDIUM' && x.action === 'EXPLAIN').length,
  });
  // MANUAL_REVIEW を resolvedCause でグループ化し、根本原因の仮説を付ける（個別 line item ではなく systemic finding として扱う）。
  const groups = {};
  for (const x of manualReview) {
    const g = groups[x.causeCandidate] || (groups[x.causeCandidate] = { cause: x.causeCandidate, pairType: x.pairType, count: 0, wards: {}, landmarks: {}, exampleConflictIds: [], totalAreaM2: 0 });
    g.count++;
    g.totalAreaM2 += x.areaM2 || 0;
    if (x.ward) g.wards[x.ward] = (g.wards[x.ward] || 0) + 1;
    if (x.landmark) g.landmarks[x.landmark] = (g.landmarks[x.landmark] || 0) + 1;
    if (g.exampleConflictIds.length < 8) g.exampleConflictIds.push(x.conflictId);
  }
  const ROOT_HYPOTHESIS = {
    'possible-osm-water-boundary-error': 'OSM riverbank/water polygon の陸側エッジが実水涯線より内陸寄り。GSI 基盤地図情報 水涯線 or 公的河川区域データ取得で一括是正できる可能性（31F 以降）。',
    'central-arterial-road-area-building-block-overlap': '中央区・北区の幹線道路で PLATEAU tran 道路区域と PLATEAU building block が重なる。tran が都市計画決定幅で描かれている／両データセットの位置系に系統ずれ、のどちらか。同一街区をまとめて検証すれば 1 つの結論が出る可能性。',
    'tran-road-vs-building-block-disagreement': '同上（幹線以外）。',
    'park-polygon-possibly-too-broad': 'OSM leisure=park polygon が隣接街区を巻き込む。31F の canonical parks build で PLATEAU luse や航空写真基準で境界を再導出。',
    'building-rail-high-unexpected': 'Building∩Rail は baseline HIGH 0。回帰の兆候。',
  };
  const systematicFindings = Object.values(groups).map((g) => ({
    ...g,
    wards: Object.entries(g.wards).sort((a, b) => b[1] - a[1]).slice(0, 6),
    landmarks: Object.entries(g.landmarks).sort((a, b) => b[1] - a[1]),
    totalAreaM2: Math.round(g.totalAreaM2),
    rootCauseHypothesis: ROOT_HYPOTHESIS[g.cause] || '未整理',
  })).sort((a, b) => b.count - a.count);

  await writeJson(OUT_MR, {
    generatedAt, count: manualReview.length,
    byPair: manualReview.reduce((m, x) => { m[x.pairType] = (m[x.pairType] || 0) + 1; return m; }, {}),
    note: '自動判断できない conflict。無理に解消せず航空写真等の evidence 取得後に判断する（§17）。多くは causeCandidate ごとに 1 つの根本原因を共有する（systematicFindings 参照）。',
    systematicFindings,
    items: manualReview,
  });

  // RECLASSIFY（公園）を parks correction advisory として出力（canonical parks は 31F。今は advisory）。
  const parkReclass = resolved.filter((x) => x.action === 'RECLASSIFY');
  if (parkReclass.length) {
    await writeJson(P('data', 'processed', 'osaka-city', 'canonical', 'corrections', 'parks', 'park-polygon-reclassify-advisory.json'), {
      correctionId: 'corr_parks_reclassify_advisory_31E',
      targetLayer: 'parks',
      operation: 'reclassify',
      reason: '建物総面積が公園面積の 80% を超える leisure=park polygon。実質は街区であり公園ではない。canonical parks build（31F）で境界を再導出するか confidence を大きく下げる。',
      sourceEvidence: { kind: 'building-coverage', detail: 'PARK_BUILDING conflict の buildingShareOfPark > 0.8' },
      reviewStatus: 'ADVISORY_PENDING_31F',
      createdBy: 'mission-31E',
      createdAt: generatedAt,
      targets: parkReclass.map((x) => ({ parkId: x.featureA, parkName: x.names.park, conflictId: x.conflictId, ward: x.ward, buildingShareOfPark: x.overlapRatioB || null, overlapRatioA: x.overlapRatioA })),
    });
  }
  await writeJson(OUT_QA, { generatedAt, note: '§5 大川 / §6 安治川 / §19 代表地点の conflict QA。', locations: repQa });

  console.log('[conflict-resolution] resolved ' + resolved.length + ' (HIGH+MEDIUM 全件 + INFO サンプル)');
  console.log('  byAction: ' + JSON.stringify(byAction));
  console.log('  HIGH byPairAction: ' + JSON.stringify(highByPairAction));
  console.log('  manual review: ' + manualReview.length + ' 件（' + JSON.stringify(manualReview.reduce((m, x) => { m[x.pairType] = (m[x.pairType] || 0) + 1; return m; }, {})) + '）');
  console.log('  unexplained HIGH after 分類: ' + resolution.high.unexplainedAfter + '（MANUAL_REVIEW ' + unresolvedHigh.length + ' 件は §17 に明示）');
  console.log('保存: resolution / manual-review / review.geojson / representative-qa');
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[conflict-resolution] 失敗:', e && e.stack || e); process.exit(1); });
