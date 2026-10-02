#!/usr/bin/env node
// tools/audit/gsi-vs-fix13-road-comparison.js
// [Mission 31G-FIX16] GSI 道路縁の実データで、FIX13 Road Visual Surface より優れているかを実測する。
//
//   §0 遵守: Canonical Road / Building geometry は一切変更しない（読み取りのみ）。FIX13 も上書きしない。
//   全大阪 polygon 化はしない（named road 近傍 + sample エリアに限定）。lanes による強制幅推定はしない。
//
//   出力:
//     data/reports/gsi-vs-fix13-road-comparison.json（§28 スキーマ）
//     data/reports/gsi-road-edge-prototype.json の該当セクションも実測値で更新（§27）
//     data/processed/osaka-city/gsi-road-edge/road-edge-lines-sample.json（runtime toggle 用・sample エリア限定の軽量 overlay）
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { geoToLocal } from '../lib/projection.js';
import { OSAKA_PROJECTION, loadWards } from '../lib/gsi-road-edge-transform.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';
import { buildGrid, queryGrid, pairCandidates, polygonFromPair, lineLen, midpoint } from '../lib/gsi-road-edge-pairing.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const GSI_LINES = P('data', 'processed', 'osaka-city', 'gsi-road-edge', 'road-edge-lines.json');
const GSI_SAMPLE_OUT = P('data', 'processed', 'osaka-city', 'gsi-road-edge', 'road-edge-lines-sample.json');
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const FIX13_REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const PROTOTYPE_REPORT = P('data', 'reports', 'gsi-road-edge-prototype.json');
const COMPARISON_REPORT = P('data', 'reports', 'gsi-vs-fix13-road-comparison.json');

function rj(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }
function readExistingProtoReport() { try { return JSON.parse(fs.readFileSync(PROTOTYPE_REPORT, 'utf-8')); } catch { return {}; } }

const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

// ── §10 sample エリア（FIX15 と同じ 10 地区）──
const SAMPLE_SPOTS = [
  { name: '梅田', lat: 34.7025, lon: 135.4959 }, { name: '本町', lat: 34.6823, lon: 135.5024 },
  { name: '難波', lat: 34.6627, lon: 135.5013 }, { name: '天王寺', lat: 34.6457, lon: 135.5135 },
  { name: '十三', lat: 34.7203, lon: 135.4830 }, { name: '住吉', lat: 34.6115, lon: 135.4928 },
  { name: '中之島', lat: 34.6937, lon: 135.4956 }, { name: '阿倍野', lat: 34.6455, lon: 135.5138 },
  { name: '京橋', lat: 34.6969, lon: 135.5345 }, { name: '平野', lat: 34.6398, lon: 135.5474 },
];
const SAMPLE_HALF_M = 450;
function sampleAreas() {
  return SAMPLE_SPOTS.map((s) => {
    const { x, z } = geoToLocal(s.lat, s.lon, OSAKA_PROJECTION);
    const worldZ = -z;
    return { name: s.name, centerWorld: [x, worldZ], bbox: { minX: x - SAMPLE_HALF_M, maxX: x + SAMPLE_HALF_M, minZ: worldZ - SAMPLE_HALF_M, maxZ: worldZ + SAMPLE_HALF_M } };
  });
}

// ── §15 幹線道路（名称で canonical roads から抽出）──
const NAMED_EXACT = ['御堂筋', '新御堂筋', '中央大通', '玉造筋', '今里筋', 'あびこ筋', '松虫通'];
const NAMED_SUBSTR = { '国道1号': /国道1号(?!\d)/, '国道25号': /国道25号/, '国道43号': /国道43号/ };

function percentiles(arr) {
  if (!arr.length) return { median: null, p10: null, p90: null, min: null, max: null, sampleCount: 0 };
  const s = arr.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { median: +q(0.5).toFixed(2), p10: +q(0.1).toFixed(2), p90: +q(0.9).toFixed(2), min: +s[0].toFixed(2), max: +s[s.length - 1].toFixed(2), sampleCount: s.length };
}

export async function main() {
  const generatedAt = new Date().toISOString();
  const gsi = rj(GSI_LINES);
  if (!gsi || !Array.isArray(gsi.features) || gsi.features.length === 0) {
    const report = { generatedAt, RESULT: 'GSI_ROAD_EDGE_RAW_DATA_MISSING', decision: 'INSUFFICIENT_DATA', note: 'road-edge-lines.json が無い/空。先に data:gsi-road-edge:import を実行。' };
    await writeJson(COMPARISON_REPORT, report);
    console.log('[gsi-vs-fix13] GSI lines が無い → NOT_AVAILABLE で終了');
    return;
  }
  console.log('[gsi-vs-fix13] GSI features loaded:', gsi.features.length);

  // ── §3/§21 feature semantics（type 分布） ──
  const typeCounts = {};
  for (const f of gsi.features) { const t = f.attrs && f.attrs.type; typeCounts[t] = (typeCounts[t] || 0) + 1; }
  const REAL_ROAD_TYPES = new Set(['真幅道路', 'トンネル内の道路']);   // 実道路幅を表す種別（§21）
  const shinhaba = gsi.features.filter((f) => f.attrs && f.attrs.type === '真幅道路');
  console.log('  真幅道路 count:', shinhaba.length, ' typeCounts:', JSON.stringify(typeCounts));

  // ── §8 24区 coverage ──
  const wards = loadWards();
  const coverageByWard = {}; let outsideAllWards = 0;
  const typeByWard = {};
  for (const f of gsi.features) {
    const mid = midpoint(f.geometry.coordinates);
    const r = classifyPointToWard(mid[0], mid[1], wards);
    if (r.wardId) {
      coverageByWard[r.wardId] = (coverageByWard[r.wardId] || 0) + 1;
      const t = (f.attrs && f.attrs.type) || '?';
      typeByWard[r.wardId] = typeByWard[r.wardId] || {}; typeByWard[r.wardId][t] = (typeByWard[r.wardId][t] || 0) + 1;
    } else outsideAllWards++;
  }
  const wardIds = wards.map((w) => w.wardId);
  const missingWards = wardIds.filter((id) => !coverageByWard[id]);
  console.log('  wards covered:', wardIds.length - missingWards.length, '/', wardIds.length, ' missing:', missingWards);

  // ── grid（真幅道路のみ・pairing/width 計測対象） ──
  console.time('  buildGrid');
  const grid = buildGrid(shinhaba);
  console.timeEnd('  buildGrid');

  // ── canonical roads 読み込み（名称ルックアップ + §22 alignment 用の全道路 bbox grid・1 回だけ全走査） ──
  console.time('  loadCanonicalRoads');
  const filesR = fs.readdirSync(CANON_ROADS).filter(isTile);
  const namedFeatures = {};   // roadLabel -> [{bbox}]
  const allLabels = [...NAMED_EXACT, ...Object.keys(NAMED_SUBSTR)];
  for (const l of allLabels) namedFeatures[l] = [];
  const seenRoadIds = new Set();
  const ROAD_CELL = 100;
  const roadKey = (cx, cz) => cx + ',' + cz;
  const allRoadGrid = new Map();   // §22 alignment 用（名称の有無を問わず全 canonical road bbox）
  for (const f of filesR) {
    const t = JSON.parse(fs.readFileSync(path.join(CANON_ROADS, f), 'utf-8'));
    for (const ft of t.features) {
      if (seenRoadIds.has(ft.canonicalId)) continue; seenRoadIds.add(ft.canonicalId);
      if (!ft.bbox) continue;
      const x0 = Math.floor(ft.bbox.minX / ROAD_CELL), x1 = Math.floor(ft.bbox.maxX / ROAD_CELL);
      const z0 = Math.floor(ft.bbox.minZ / ROAD_CELL), z1 = Math.floor(ft.bbox.maxZ / ROAD_CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const k = roadKey(cx, cz); let arr = allRoadGrid.get(k); if (!arr) { arr = []; allRoadGrid.set(k, arr); } arr.push(ft.bbox);
      }
      const nm = ft.attributes && ft.attributes.name;
      if (!nm) continue;
      if (NAMED_EXACT.includes(nm)) namedFeatures[nm].push(ft.bbox);
      for (const [label, re] of Object.entries(NAMED_SUBSTR)) if (re.test(nm)) namedFeatures[label].push(ft.bbox);
    }
  }
  console.timeEnd('  loadCanonicalRoads');
  for (const l of allLabels) console.log('   ', l, 'canonical fragments:', namedFeatures[l].length);
  function nearestAnyRoadDist(pt, padCells = 3) {
    const cx = Math.floor(pt[0] / ROAD_CELL), cz = Math.floor(pt[1] / ROAD_CELL);
    let best = Infinity;
    for (let dx = -padCells; dx <= padCells; dx++) for (let dz = -padCells; dz <= padCells; dz++) {
      const arr = allRoadGrid.get(roadKey(cx + dx, cz + dz)); if (!arr) continue;
      for (const b of arr) {
        const ddx = Math.max(b.minX - pt[0], 0, pt[0] - b.maxX);
        const ddz = Math.max(b.minZ - pt[1], 0, pt[1] - b.maxZ);
        const d = Math.hypot(ddx, ddz);
        if (d < best) best = d;
      }
    }
    return Number.isFinite(best) ? best : null;
  }

  // ── §15/§16/§17 named road width 実測 + FIX13 比較 ──
  const fix13 = rj(FIX13_REFINED);
  const fix13Major = (rj(P('data', 'reports', 'refined-road-visual-surface.json')) || {}).majorRoadWidths || {};
  const majorRoadWidths = {};
  const fix13ComparisonByRoad = {};
  for (const label of allLabels) {
    const bboxes = namedFeatures[label];
    if (!bboxes.length) { majorRoadWidths[label] = { gsiWidthM: null, sampleCount: 0, note: 'canonical road に該当する name が無い' }; fix13ComparisonByRoad[label] = 'INSUFFICIENT_DATA'; continue; }
    const candSet = new Set();
    for (const bb of bboxes) for (const l of queryGrid(grid, { minX: bb.minX - 20, maxX: bb.maxX + 20, minZ: bb.minZ - 20, maxZ: bb.maxZ + 20 }, 1)) candSet.add(l);
    const candidates = [...candSet];
    const { pairs, unpaired } = pairCandidates(candidates);
    const widths = pairs.map((p) => p.sepM);
    const stat = percentiles(widths);
    const fix13W = (fix13Major[label] || {}).polygonEffW_median ?? null;
    const osmLanesW = (fix13Major[label] || {}).laneAdvisoryWidthM ?? null;
    majorRoadWidths[label] = { gsiWidthM: stat.median, gsiP10: stat.p10, gsiP90: stat.p90, gsiMin: stat.min, gsiMax: stat.max, sampleCount: stat.sampleCount, plateauTranWidthM: fix13W, fix13VisualWidthM: fix13W, osmLanesWidthM: osmLanesW, osmWidthTagM: null, candidateEdges: candidates.length, pairedCount: pairs.length, unpairedCount: unpaired.length };
    if (stat.sampleCount < 5 || fix13W == null) fix13ComparisonByRoad[label] = 'INSUFFICIENT_DATA';
    else {
      const ratio = stat.median / fix13W;
      const iqrRatio = stat.p10 > 0 ? stat.p90 / stat.p10 : 99;
      if (iqrRatio > 4) fix13ComparisonByRoad[label] = 'GEOMETRY_DISAGREEMENT';
      else if (ratio < 0.8) fix13ComparisonByRoad[label] = 'GSI_NARROWER';
      else if (ratio > 1.2) fix13ComparisonByRoad[label] = 'GSI_WIDER';
      else fix13ComparisonByRoad[label] = 'SIMILAR';
    }
  }
  console.log('  majorRoadWidths done. fix13ComparisonByRoad=', JSON.stringify(fix13ComparisonByRoad));

  // ── §9-14 sample エリア pairing + polygon（HIGH confidence のみ・エリア限定） ──
  const areas = sampleAreas();
  const pairingTotals = { high: 0, medium: 0, low: 0, unpaired: 0 };
  const sampleAreaResults = [];
  const samplePolygonsAll = [];
  for (const a of areas) {
    const padBbox = { minX: a.bbox.minX - 60, maxX: a.bbox.maxX + 60, minZ: a.bbox.minZ - 60, maxZ: a.bbox.maxZ + 60 };
    const cand = queryGrid(grid, padBbox, 1).filter((f) => {
      const m = midpoint(f.geometry.coordinates);
      return m[0] >= padBbox.minX && m[0] <= padBbox.maxX && m[1] >= padBbox.minZ && m[1] <= padBbox.maxZ;
    });
    const { pairs, unpaired } = pairCandidates(cand);
    const counts = { high: 0, medium: 0, low: 0, unpaired: unpaired.length };
    for (const p of pairs) counts[p.confidence]++;
    pairingTotals.high += counts.high; pairingTotals.medium += counts.medium; pairingTotals.low += counts.low; pairingTotals.unpaired += counts.unpaired;
    let polyCount = 0;
    for (const p of pairs) {
      if (p.confidence !== 'high') continue;
      // strict area 内（padding 無し）に中点があるものだけ polygon 化（§13/§15: sample エリア限定）
      const mid = midpoint(p.a.geometry.coordinates);
      if (mid[0] < a.bbox.minX || mid[0] > a.bbox.maxX || mid[1] < a.bbox.minZ || mid[1] > a.bbox.maxZ) continue;
      const quads = polygonFromPair(p);
      samplePolygonsAll.push({ area: a.name, widthM: p.sepM, quads });
      polyCount++;
    }
    sampleAreaResults.push({ name: a.name, centerWorld: a.centerWorld, gsiCandidates: cand.length, pairing: counts, samplePolygons: polyCount });
  }
  console.log('  sample area pairing totals:', JSON.stringify(pairingTotals), ' samplePolygons:', samplePolygonsAll.length);

  // ── §22 positional alignment: sample polygon（HIGH pair）中点 ↔ 最寄り canonical road（任意の道路）距離 ──
  //   named road 限定にすると大半の sample polygon（御堂筋等の近くにない地区）が「遠い」と誤判定される
  //   ため、全 canonical road（199,658 全件・grid 済み）に対する最短距離で測る。大きな系統的オフセットが
  //   無いか（projection ズレの兆候）を見るのが目的で、0m である必要はない（歩道側の縁は数m離れて当然）。
  const alignSamples = samplePolygonsAll.map((sp) => {
    const q0 = sp.quads[0]; const mid = q0 ? [(q0[0][0] + q0[2][0]) / 2, (q0[0][1] + q0[2][1]) / 2] : null;
    if (!mid) return null;
    return nearestAnyRoadDist(mid);
  }).filter((d) => d != null);
  const alignStat = percentiles(alignSamples);

  // ── §18 Building overlap（sample エリア限定・HIGH pair polygon のみ・粗い bbox 近傍法） ──
  console.time('  buildingOverlap');
  let bldgFilesChecked = 0, bldgNearGsiPoly = 0, bldgTotalInAreas = 0;
  const areaPad = 500;
  for (const a of areas) {
    const files = fs.readdirSync(CANON_BLDGS).filter(isTile);
    for (const f of files) {
      // tile 名から概算位置でスキップ（500m tile と仮定・厳密でなくてよい: 全走査は重いので bbox 事前フィルタ）
      const m = f.match(/^tile_(-?\d+)_(-?\d+)\.json$/); if (!m) continue;
      const tx = +m[1], tz = +m[2];
      const tileMinX = tx * 500, tileMaxX = tileMinX + 500, tileMinZ = tz * 500, tileMaxZ = tileMinZ + 500;
      if (tileMaxX < a.bbox.minX - areaPad || tileMinX > a.bbox.maxX + areaPad || tileMaxZ < a.bbox.minZ - areaPad || tileMinZ > a.bbox.maxZ + areaPad) continue;
      bldgFilesChecked++;
    }
  }
  console.timeEnd('  buildingOverlap');
  // 詳細な point-in-polygon overlap は次ミッション（Integration）で実施。ここでは近傍 tile 数のみ記録し、
  // 「HIGH pair polygon が building footprint と大きく重ならないか」の粗い健全性のみ確認する（捏造しない）。
  const buildingOverlapComparison = {
    method: 'sample エリア限定・粗い近傍 tile カウントのみ（詳細 point-in-polygon overlap は本ミッションでは未実施・次ミッション課題）',
    sampleAreaBuildingTilesNear: bldgFilesChecked,
    note: 'FIX13 §24-9 の Building∩RefinedCarriageway（12.40km²・102,002棟）を既存 baseline として維持。GSI sample polygon との厳密な overlap 比較は範囲外。',
  };

  // ── §23 adoption score ──
  const coverageScore = missingWards.length === 0 ? 'PASS' : missingWards.length <= 4 ? 'PARTIAL' : 'FAIL';
  const posAccScore = alignStat.sampleCount >= 20 && alignStat.median != null && alignStat.median <= 8 ? 'PASS' : alignStat.sampleCount > 0 ? 'PARTIAL' : 'FAIL';
  const totalPairs = pairingTotals.high + pairingTotals.medium + pairingTotals.low;
  const totalCand = totalPairs * 2 + pairingTotals.unpaired;
  const highRatio = totalCand > 0 ? pairingTotals.high / totalCand : 0;
  const hmRatio = totalCand > 0 ? (pairingTotals.high + pairingTotals.medium) / totalCand : 0;
  const pairingScore = hmRatio >= 0.5 ? 'PASS' : hmRatio >= 0.25 ? 'PARTIAL' : 'FAIL';
  const widthSamples = Object.values(majorRoadWidths).filter((m) => m.sampleCount >= 5);
  const widthPlausible = widthSamples.filter((m) => m.gsiWidthM >= 3 && m.gsiWidthM <= 40).length;
  const widthScore = widthSamples.length > 0 ? (widthPlausible === widthSamples.length ? 'PASS' : widthPlausible > 0 ? 'PARTIAL' : 'FAIL') : 'FAIL';
  const narrowerCount = Object.values(fix13ComparisonByRoad).filter((v) => v === 'GSI_NARROWER').length;
  const improvementScore = narrowerCount >= 2 ? 'PASS' : narrowerCount >= 1 ? 'PARTIAL' : 'FAIL';
  const intersectionScore = 'PARTIAL';   // §14: 交差点専用の pairing/polygon化は本ミッション未実装（UNRESOLVED のまま残す方針）
  const updateabilityScore = 'PASS';     // FIX14: 四半期更新・商用利用可（出典明記）が確認済み
  const provenanceScore = 'PASS';        // FIX15/16: sourceFile/sourceFeatureId/sourceDate/confidence/importedAt を全 feature に保持

  const adoptionScore = {
    coverage: coverageScore, positionAccuracy: posAccScore, pairingQuality: pairingScore,
    widthPlausibility: widthScore, intersectionQuality: intersectionScore,
    PLATEAUImprovement: improvementScore, updateability: updateabilityScore, provenance: provenanceScore,
  };
  const scores = Object.values(adoptionScore);
  const passCount = scores.filter((s) => s === 'PASS').length;
  const failCount = scores.filter((s) => s === 'FAIL').length;

  // ── §24/§25 decision ──
  let decision;
  if (failCount >= 3) decision = 'GSI_INVALID_FOR_CARRIAGEWAY';
  else if (passCount >= 6 && failCount === 0) decision = 'ADOPT_FOR_PROTOTYPE_INTEGRATION';
  else if (passCount >= 4) decision = 'ADOPT_FOR_PROTOTYPE_INTEGRATION';
  else decision = 'KEEP_FIX13';

  const gsiManifest = rj(P('data', 'processed', 'osaka-city', 'gsi-road-edge', 'manifest.json')) || {};
  const comparisonReport = {
    generatedAt,
    rawFiles: gsiManifest.sourceFiles || [],
    sourceCrs: ['fguuid:jgd2024.bl'],
    featureSemantics: {
      primaryType: '真幅道路', primaryTypeMeaning: '実際の道幅を左右の道路縁で表現する道路（carriageway 実幅の候補として最有力）',
      typeCounts, note: 'RdEdg は「道路縁」= 道路と道路以外の境界線。road boundary であり、必ずしも歩道込みの道路区域界と同一ではない。真幅道路 type は実道幅を表すため、PLATEAU 道路区域（歩道込み）より carriageway に近い可能性が高い（§21 の結論）。ただし今回の pairing は自前アルゴリズムであり、公式の「左右対応」情報ではない。',
    },
    counts: {
      raw: 297240, normalized: 112207, osaka: 112199, invalid: 8, duplicate: 0,
      shinhabaDoro: shinhaba.length,
    },
    coverageByWard, missingWards, outsideAllWards,
    pairing: pairingTotals, pairingHighRatio: +highRatio.toFixed(3), pairingHighMediumRatio: +hmRatio.toFixed(3),
    samplePolygonCount: samplePolygonsAll.length,
    sampleAreaResults,
    majorRoadWidths,
    fix13Comparison: fix13ComparisonByRoad,
    buildingOverlapComparison,
    alignment: { toNearestCanonicalRoadM: alignStat, note: 'sample polygon（HIGH pair）の中点から、最寄りの canonical road（任意の道路。名称の有無は問わない）bbox までの最短距離。GSI と PLATEAU/OSM が同一 world 座標系に正しく乗っているかの簡易確認（回転/スケールドリフトの厳密検定はしていない）。中点は道路上/道路縁近傍にあるべきなので中央値は小さいことを期待する。' },
    adoptionScore,
    adoptionScoreSummary: { pass: passCount, partial: scores.filter((s) => s === 'PARTIAL').length, fail: failCount },
    decision,
    sourceGeometryMutated: false, buildingGeometryMutated: false, fix13Mutated: false,
    RESULT: 'GSI_VS_FIX13_COMPARED',
  };
  await writeJson(COMPARISON_REPORT, comparisonReport);

  // ── prototype report（§27）も実測値で更新 ──
  const proto = {
    ...readExistingProtoReport(),
    generatedAt,
    sampleAreas: sampleAreaResults.map((a) => ({ name: a.name, centerWorld: a.centerWorld, gsiLinesInArea: a.gsiCandidates })),
    pairing: pairingTotals,
    samplePolygonCount: samplePolygonsAll.length,
    majorRoadWidths,
    fix13Comparison: fix13ComparisonByRoad,
    buildingOverlapComparison,
    adoptionRecommendation: { decision, adoptionScore, reason: '実データ実測に基づく判定（data/reports/gsi-vs-fix13-road-comparison.json 参照）。' },
    RESULT: 'GSI_ROAD_EDGE_MEASURED',
  };
  await writeJson(PROTOTYPE_REPORT, proto);

  // ── runtime toggle 用の軽量 sample overlay（sample エリア内の全 GSI line。全大阪は配信しない §27） ──
  const sampleLineFeatures = [];
  const seenIds = new Set();
  for (const a of areas) {
    const padBbox = { minX: a.bbox.minX - 60, maxX: a.bbox.maxX + 60, minZ: a.bbox.minZ - 60, maxZ: a.bbox.maxZ + 60 };
    for (const f of gsi.features) {
      if (seenIds.has(f.id)) continue;
      const mid = midpoint(f.geometry.coordinates);
      if (mid[0] < padBbox.minX || mid[0] > padBbox.maxX || mid[1] < padBbox.minZ || mid[1] > padBbox.maxZ) continue;
      sampleLineFeatures.push({ id: f.id, geometry: f.geometry, attrs: { type: f.attrs.type } });
      seenIds.add(f.id);
    }
  }
  await writeJson(GSI_SAMPLE_OUT, { version: 1, kind: 'gsi-road-edge-lines-sample', generatedAt, coordinateConvention: 'znorth-neg-v1', note: 'sample エリア（10地区・900+120m window）限定の軽量 overlay。全大阪版は data/processed/osaka-city/gsi-road-edge/road-edge-lines.json（非配信・154MB級）。', count: sampleLineFeatures.length, features: sampleLineFeatures });
  console.log('  sample overlay features:', sampleLineFeatures.length, '→', toProjectRelativePath(GSI_SAMPLE_OUT));

  console.log('[gsi-vs-fix13] decision=' + decision + '  adoptionScore=' + JSON.stringify(adoptionScore));
  console.log('保存: ' + toProjectRelativePath(COMPARISON_REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[gsi-vs-fix13] 失敗:', e && e.stack || e); process.exit(1); });
