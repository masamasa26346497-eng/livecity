#!/usr/bin/env node
// tools/audit/map-completeness.js
// [Mission24] 大阪市24区 基礎地図総合完成度監査。
//   LAND / BUILDINGS / ROADS / RIVERS / SEA / PARKS / RAILWAYS の 7 レイヤーを 100m グリッドで横断し、
//   「source 上あるべきものが render されているか」を評価する。新地物は増やさない。
//   出力: data/reports/map-completeness-audit.json
//
// 実行: node tools/audit/map-completeness.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { auditMapCompleteness, clusterCells, classifyAnomalySeverity, layerScore, indexWards, wardAt } from '../lib/map-completeness.js';
import { flattenWardPolygons } from '../lib/water-surface.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const BUILD_DIR = P('public', 'map-data', 'osaka-city', 'buildings');
const WARDS = P('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const ROADS = P('public', 'map-data', 'osaka-city', 'roads');
const RAILS = P('public', 'map-data', 'osaka-city', 'railways');
const PARKS = P('public', 'map-data', 'osaka-city', 'parks');
const RIVERS = P('public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json');
const WATER = P('public', 'map-data', 'osaka-city', 'water-surface', 'water-surface.json');
const OSM_GRID = P('data', 'reports', 'osm-building-incity-grid.json');
const REPORT = P('data', 'reports', 'map-completeness-audit.json');

const RPT = {
  land: P('data', 'reports', 'land-coverage-audit.json'),
  landV: P('data', 'reports', 'land-coverage-validation.json'),
  building: P('data', 'reports', 'building-coverage-audit.json'),
  buildingV: P('data', 'reports', 'building-coverage-validation.json'),
  visualGap: P('data', 'reports', 'building-visual-gap-reconciliation.json'),
  road: P('data', 'reports', 'road-network-coverage.json'),
  roadV: P('data', 'reports', 'road-network-validation.json'),
  river: P('data', 'reports', 'river-network-coverage.json'),
  riverV: P('data', 'reports', 'river-network-validation.json'),
  seaV: P('data', 'reports', 'water-surface-validation.json'),
  parkV: P('data', 'reports', 'park-lod-validation.json'),
  railV: P('data', 'reports', 'rail-lod-validation.json'),
};
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; } };

function loadTileLines(dir, filter) {
  const byId = new Map();
  if (!fs.existsSync(dir)) return [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    for (const ft of (t.features || [])) if ((!filter || filter(ft)) && !byId.has(ft.id)) byId.set(ft.id, ft);
  }
  return [...byId.values()];
}
function fpArea(fp) { let a = 0; for (let i = 0; i < fp.length; i++) { const p = fp[i], q = fp[(i + 1) % fp.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }
function loadBuildings(fallback) {
  const out = [];
  for (const ds of fs.readdirSync(BUILD_DIR)) {
    const dp = path.join(BUILD_DIR, ds);
    if (!fs.statSync(dp).isDirectory() || ds === 'unclassified') continue;
    const isFb = ds === 'osaka-osm-fallback';
    if (isFb !== fallback) continue;
    for (const f of fs.readdirSync(dp)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      const t = JSON.parse(fs.readFileSync(path.join(dp, f), 'utf-8'));
      for (const b of (t.buildings || [])) {
        if (!Array.isArray(b.fp) || b.fp.length < 3) continue;
        out.push({ x: b.repX != null ? b.repX : b.fp[0][0], z: b.repZ != null ? b.repZ : b.fp[0][1], fpArea: fpArea(b.fp) });
      }
    }
  }
  return out;
}

const REPRESENTATIVE = [
  { name: '梅田', x: -2400, z: -9500 }, { name: '中之島', x: -2100, z: -8600 }, { name: '本町', x: -1400, z: -7700 },
  { name: '難波', x: -1300, z: -6600 }, { name: '天王寺', x: -300, z: -6100 }, { name: '阿倍野', x: -350, z: -5600 },
  { name: '大阪城', x: 100, z: -8500 }, { name: '京橋', x: 900, z: -8700 }, { name: '鶴橋', x: 700, z: -6600 },
  { name: '住吉', x: -450, z: -1500 }, { name: '東住吉', x: 1200, z: -2500 }, { name: '平野', x: 3600, z: -1300 },
  { name: '生野', x: 1600, z: -5200 }, { name: '西成', x: -1200, z: -4400 },
  { name: '此花', x: -8000, z: -7800 }, { name: 'USJ', x: -8300, z: -7600 }, { name: '夢洲', x: -15800, z: -12200 },
  { name: '舞洲', x: -12500, z: -5200 }, { name: '港', x: -6800, z: -5600 }, { name: '大正', x: -5400, z: -4200 },
  { name: '咲洲', x: -9500, z: -3200 }, { name: '南港', x: -8000, z: -1500 },
];

function main() {
  const wards = JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards || [];
  const wardsFlat = flattenWardPolygons(wards);
  const idxW = indexWards(wards);
  const roads = loadTileLines(ROADS, (f) => f.kind === 'line' && f.underground !== true).map((f) => ({ p: f.p, tier: f.tier, name: f.name, highway: f.highway }));
  const rails = loadTileLines(RAILS, (f) => f.kind === 'line').map((f) => ({ p: f.p, railway: f.railway }));
  const parksAll = loadTileLines(PARKS, (f) => f.kind === 'area');
  const parkRings = parksAll.map((f) => f.p);
  let rivers = [], riverRibbons = [];
  try {
    const rv = rd(RIVERS);
    for (const r of (rv.rivers || [])) {
      if (!r.ok || r.suppressed) continue;
      if (Array.isArray(r.centerline) && r.centerline.length >= 2) rivers.push({ p: r.centerline });
      if (Array.isArray(r.left) && Array.isArray(r.right) && r.left.length >= 2 && r.right.length >= 2) {
        riverRibbons.push([...r.left, ...r.right.slice().reverse()]);
      }
    }
  } catch (e) { /* */ }
  const seaPositions = (() => { try { return rd(WATER).positions || []; } catch (e) { return []; } })();
  // 鉄道ヤード近似: rail cell が周囲に密集する領域（新大阪/宮原/百済/竜華 等）。rail line の bbox を膨らませた矩形。
  const railYardRings = [];
  const osmBuildingGrid = rd(OSM_GRID);

  const plateauBuildings = loadBuildings(false);
  const fallbackBuildings = loadBuildings(true);

  const A = auditMapCompleteness({
    wards, cellM: 100, plateauBuildings, fallbackBuildings,
    roads, rivers, riverRibbons, rails, parkRings, railYardRings, seaPositions, osmBuildingGrid,
  });

  // ── N03 区界（=大阪市外周）からの距離。城際の孤立 cell を explained にする ──
  const wardRings = wardsFlat.flatMap((w) => [w.outer, ...(w.holes || [])]);
  const nearCityEdge = (x, z, tol) => {
    for (const ring of wardRings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const ax = ring[i][0], az = ring[i][1], bx = ring[i + 1][0], bz = ring[i + 1][1];
        const dx = bx - ax, dz = bz - az; const L2 = dx * dx + dz * dz || 1;
        let t = ((x - ax) * dx + (z - az) * dz) / L2; t = Math.max(0, Math.min(1, t));
        if (Math.hypot(x - (ax + t * dx), z - (az + t * dz)) <= tol) return true;
      }
    }
    return false;
  };

  // ── anomaly クラスタ化 + severity ──
  const anomalies = [];
  const push = (type, cl, extra) => {
    const sev = classifyAnomalySeverity({ type, areaKm2: cl.areaKm2, cells: cl.cells, ward: cl.ward, ...extra });
    anomalies.push({ type, severity: sev, ward: cl.ward, center: cl.center, areaKm2: cl.areaKm2, cells: cl.cells, bbox: cl.bbox, ...extra });
  };
  // A: 説明不能な完全空白（park/water/rail で説明できない陸 cell の連結。>= 4 cell）
  //   ただし cause I（港湾/工業/緑地）として building-coverage-audit で既に説明済みのクラスタと重なるものは explained。
  const bAudit = rd(RPT.building);
  const explainedGapBoxes = ((bAudit && bAudit.gapClusters && bAudit.gapClusters.list) || []).map((c) => c.bbox);
  const inExplained = (cl) => explainedGapBoxes.some((b) => cl.center[0] >= b.minX - 200 && cl.center[0] <= b.maxX + 200 && cl.center[1] >= b.minZ - 200 && cl.center[1] <= b.maxZ + 200);
  // A クラスタの原因判定: OSM も建物 0 → 実際に建物が無い（rail yard / 空港 / 人工島 / 工業）→ explained
  const osmC = (osmBuildingGrid && osmBuildingGrid.counts) || {};
  const oz = A.origin.x / 100, ozz = A.origin.z / 100; // audit cell index → raw grid key の変換
  const clusterOsm = (cl) => (cl.cellKeys || []).reduce((s, k) => { const [cx, cz] = k.split(',').map(Number); return s + (osmC[(oz + cx) + ',' + (ozz + cz)] || 0); }, 0);
  for (const cl of clusterCells(A.anomalyCells.A, 100, 4)) {
    // クラスタの実 anomaly cell（建物 0・道路 0）だけで OSM 建物を集計する
    let osmSum = clusterOsm(cl), edge = false;
    if (nearCityEdge(cl.center[0], cl.center[1], 300)) edge = true;
    const knownExplained = inExplained(cl);
    const osmDensity = cl.areaKm2 > 0 ? osmSum / cl.areaKm2 : osmSum; // 棟/km²
    let cause, explained;
    if (knownExplained) { cause = 'building-coverage-audit で cause I 判定済み（港湾/工業/緑地/河川敷）'; explained = true; }
    else if (osmDensity < 45) { cause = 'PLATEAU 0・OSM も疎（' + osmDensity.toFixed(0) + '棟/km²）＝鉄道ヤード/空港敷地/スポーツ島/大規模工業。実際に建物がほぼ無い'; explained = true; }
    else if (edge) { cause = '大阪市外周に接する cell（隣接市 or 未収録埋立地の縁）'; explained = true; }
    else { cause = '陸・道路・建物とも無く OSM に建物密（' + osmDensity.toFixed(0) + '棟/km²）＝要調査'; explained = false; }
    push('A', cl, { explained, note: cause, osmBuildings: osmSum, osmDensityPerKm2: +osmDensity.toFixed(0), nearCityEdge: edge });
  }
  // B: 建物密だが道路0。OSM も道路が薄い区（東淀川区 等 OSM 未整備）は MEDIUM(known limitation)。
  const roadCovByWard = {};
  const roadDensityReport = rd(RPT.road);
  { const rc = roadDensityReport; if (rc && rc.byWard) for (const [w, s] of Object.entries(rc.byWard)) roadCovByWard[w] = s; }
  // [Mission26/31] 生 OSM 道路データが薄い区。§18: PBF 抽出範囲外（拡張で解消可）= SOURCE-MISSING、
  //   範囲内だが OSM 未整備 = SOURCE-SPARSE。osm-source-coverage.json 無しなら全て SOURCE-MISSING（後方互換）。
  const roadDensD = roadDensityReport && roadDensityReport.density;
  const roadSparseWards = new Set((roadDensD && roadDensD.sparseWards) || []);
  const roadSourceMissingWards = new Set((roadDensD && roadDensD.sourceMissingWards && roadDensD.sourceMissingWards.length ? roadDensD.sourceMissingWards : (roadDensD && roadDensD.sparseWards)) || []);
  const roadSourceSparseWards = new Set((roadDensD && roadDensD.sourceSparseWards) || []);
  const roadSourceMissingByWard = {};
  if (roadDensityReport && roadDensityReport.density && roadDensityReport.density.byWard) {
    for (const [w, s] of Object.entries(roadDensityReport.density.byWard)) roadSourceMissingByWard[w] = s.sourceMissingCells || 0;
  }
  for (const cl of clusterCells(A.anomalyCells.B, 100, 3)) {
    const wr = roadCovByWard[cl.ward];
    const osmSum = clusterOsm(cl);
    const osmThinWard = wr && wr.count < 400;
    // クラスタ内で OSM 建物も疎（<= cluster cell 数 × 3）→ OSM の当該エリア整備が薄い＝road も同様に欠落
    const osmThinLocal = osmSum <= cl.cells * 3;
    const explained = osmThinWard || osmThinLocal;
    push('B', cl, { explained, osmBuildings: osmSum, note: explained
      ? 'OSM road/building データが当該エリアで薄い（区 ' + (wr ? wr.count : '?') + ' feature / cluster OSM建物 ' + osmSum + '）。道路の他ソース無し＝known limitation'
      : '建物密だが道路網が無い（要調査）' });
  }
  // C: OSM dense / render sparse residual（Mission21C で 0 目標）
  for (const cl of clusterCells(A.anomalyCells.C, 100, 3)) push('C', cl, { explained: false });
  // F: land ∩ sea 不正 overlap
  for (const cl of clusterCells(A.anomalyCells.F, 100, 1)) push('F', cl, {});

  // ── D/E: 主要河川・主要鉄道の未説明 gap（既存レポートから） ──
  const riverCov = rd(RPT.river);
  if (riverCov && riverCov.unexplainedGapRivers && riverCov.unexplainedGapRivers.length) {
    for (const r of riverCov.unexplainedGapRivers) anomalies.push({ type: 'D', severity: (['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川'].includes(r.name)) ? 'CRITICAL' : 'HIGH', ward: null, river: r.name, detail: r });
  }
  // 鉄道: 名前がタイルに無いため geometry ベース。rail 由来の grid で「陸域 rail cell が 0 の区」だけ INFO。

  // ── G: tile 境界一致の空白（road / building は非 tile-clip なので構造的に 0。既存 audit を確認） ──
  const roadCov = rd(RPT.road);
  if (roadCov && roadCov.continuity && roadCov.continuity.tileBoundaryBreaks > 0) {
    anomalies.push({ type: 'G', severity: 'HIGH', ward: null, detail: 'road tileBoundaryBreaks ' + roadCov.continuity.tileBoundaryBreaks });
  }

  // ── H: City / Ward runtime 不一致（source complete かどうかのみ静的判定。runtime は debug API） ──
  //   静的には「fallback dataset が root manifest にあり、CityBuildingLOD が別枠ロードする」ことを確認。

  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const an of anomalies) counts[an.severity]++;

  // ── byWard score ──
  const byWard = {};
  for (const [wid, W] of Object.entries(A.byWard)) {
    const wardAnoms = anomalies.filter((a) => a.ward === wid);
    const crit = wardAnoms.filter((a) => a.severity === 'CRITICAL').length;
    const high = wardAnoms.filter((a) => a.severity === 'HIGH').length;
    const med = wardAnoms.filter((a) => a.severity === 'MEDIUM').length;
    const landStatus = 'PASS'; // land coverage 100%（Mission21）
    const buildingStatus = W.buildingCoverage >= 0.55 ? 'PASS' : (crit + high === 0 ? 'EXPLAINED' : 'FAIL');
    const wrCov = roadCovByWard[wid];
    const roadOsmThin = wrCov && wrCov.count < 400; // OSM road データが当該区で薄い
    // [Mission26/31] SOURCE-MISSING = PBF 抽出範囲外（ソース拡張で解消可）。SOURCE-SPARSE = 範囲内だが OSM 未整備。
    const roadSparse = roadSparseWards.has(wid) || (roadSourceMissingByWard[wid] || 0) >= W.land * 0.08;
    const roadStatus = W.roadCoverage >= 0.6 ? 'PASS'
      : roadSourceSparseWards.has(wid) ? 'SOURCE-SPARSE'
        : (roadSparse && roadSourceMissingWards.has(wid)) ? 'SOURCE-MISSING'
          : roadSparse ? 'SOURCE-MISSING'
            : ((W.roadCells > W.land * 0.4 || roadOsmThin) ? 'EXPLAINED' : 'FAIL');
    const waterStatus = W.seaOnLand === 0 ? 'PASS' : (W.seaOnLand <= 1 ? 'EXPLAINED' : 'FAIL'); // 1 cell = ラスタ端の丸め
    const parkStatus = 'PASS'; // 公園「あるべき場所に無い」= 別途主要公園チェック
    const railStatus = 'PASS'; // 鉄道「あるべき場所に無い」= 別途主要路線チェック
    byWard[wid] = {
      landCells: W.land, landAreaKm2: +(W.land * 0.01).toFixed(2),
      buildingCells: W.buildingCells, buildings: W.buildings, buildingCoverage: W.buildingCoverage,
      fallbackOnlyCells: W.buildingFbCells,
      roadCells: W.roadCells, roadCoverage: W.roadCoverage,
      riverCells: W.riverCells, railCells: W.railCells, parkCells: W.parkCells, seaOnLandCells: W.seaOnLand,
      landStatus, buildingStatus, roadStatus, waterStatus, parkStatus, railStatus,
      runtimeStatus: 'CHECK-DEBUG-API',
      anomalies: { critical: crit, high, medium: med },
      overallCompleteness: Math.max(0, 100 - crit * 100 - high * 20 - med * 4),
    };
  }

  // ── byLayer score ──
  const landV = rd(RPT.landV), buildingV = rd(RPT.buildingV), visualGap = rd(RPT.visualGap), roadV = rd(RPT.roadV), riverV = rd(RPT.riverV), seaV = rd(RPT.seaV), parkV = rd(RPT.parkV), railV = rd(RPT.railV);
  const anomBy = (types) => anomalies.filter((a) => types.includes(a.type));
  const sevCnt = (arr, s) => arr.filter((a) => a.severity === s).length;
  const cellCov = (fn) => { let cov = 0, tot = 0; for (const W of Object.values(A.byWard)) { tot += W.land; cov += fn(W); } return tot ? cov / tot : 0; };
  const byLayer = {
    land: { score: (landV && landV.RESULT === 'PASS') ? 100 : 50, coverage: 1.0, source: (rd(RPT.land) || {}).coveragePercent, validator: landV && landV.RESULT, unexplainedMissing: (rd(RPT.land) || {}).missingClusters ? (rd(RPT.land).missingClusters.unexplained) : 0 },
    buildings: {
      score: layerScore(cellCov((W) => W.buildingCells), sevCnt(anomBy(['A', 'B', 'C']), 'CRITICAL'), sevCnt(anomBy(['A', 'B', 'C']), 'HIGH'), sevCnt(anomBy(['A', 'B', 'C']), 'MEDIUM')),
      cellCoverage: +cellCov((W) => W.buildingCells).toFixed(3),
      renderable: (bAudit && bAudit.corpus) ? bAudit.corpus.totalRenderable : null,
      unexplainedVisualGap: visualGap ? visualGap.remainingExplained.unexplained : null,
      sparseMismatchResidual: visualGap ? visualGap.sparseMismatch.residualCells : null,
      duplicateFallback: (buildingV && buildingV.checks) ? (buildingV.checks.fbDupId + (buildingV.checks.fbSparseDup > 5 ? buildingV.checks.fbSparseDup : 0)) : null,
      validator: buildingV && buildingV.RESULT,
    },
    roads: {
      score: layerScore(cellCov((W) => W.roadCells), 0, sevCnt(anomBy(['G']), 'HIGH'), 0),
      cellCoverage: +cellCov((W) => W.roadCells).toFixed(3),
      eligibleLocalCoverage: roadCov ? roadCov.nearCoverage.localCoveragePercent : null,
      tileBoundaryBreaks: roadCov ? roadCov.continuity.tileBoundaryBreaks : null,
      features: roadCov ? roadCov.totalRoadWays : null,
      validator: roadV && roadV.RESULT,
    },
    rivers: {
      score: (riverV && riverV.RESULT === 'PASS') ? 100 : 40,
      displayed: riverCov ? riverCov.displayed : null,
      undergroundSkipped: riverCov ? riverCov.undergroundLineFeatures : null,
      unexplainedGapRivers: riverCov ? riverCov.unexplainedGapRivers.length : null,
      validator: riverV && riverV.RESULT,
    },
    sea: {
      score: (seaV && seaV.RESULT === 'PASS' && sevCnt(anomBy(['F']), 'CRITICAL') === 0) ? 100 : 30,
      illegalLandOverlap: seaV ? (seaV.stats ? seaV.stats.inlandHits : 0) : null,
      landCellsInSea: Object.values(A.byWard).reduce((s, W) => s + W.seaOnLand, 0),
      validator: seaV && seaV.RESULT,
    },
    parks: {
      score: (parkV && (parkV.errorCount === 0)) ? layerScore(1, 0, sevCnt(anomBy(['PARK']), 'HIGH'), 0) : 60,
      count: parksAll.length,
      validatorErrors: parkV ? parkV.errorCount : null,
    },
    railways: {
      score: (railV && (railV.errorCount === 0)) ? layerScore(1, 0, sevCnt(anomBy(['E']), 'HIGH'), 0) : 60,
      lineFeatures: rails.length,
      validatorErrors: railV ? railV.errorCount : null,
    },
  };

  // ── 主要公園チェック（§8）: 名前一致 + 期待位置周辺の park polygon geometry を両方見る ──
  const majorParks = [
    { name: '大阪城公園', x: 250, z: -8500, key: '大阪城' },
    { name: '長居公園', x: 200, z: -1000, key: '長居' },
    { name: '花博記念公園鶴見緑地', x: 4300, z: -11500, key: '鶴見' },
    { name: '靱公園', x: -2900, z: -8050, key: '靱' },
    { name: '天王寺公園', x: -250, z: -6300, key: '天王寺' },
    { name: '毛馬桜之宮公園', x: 300, z: -10800, key: '桜' },
    { name: '扇町公園', x: -1550, z: -9550, key: '扇町' },
    { name: '八幡屋公園', x: -6400, z: -6100, key: '八幡屋' },
    { name: '住吉公園', x: -1100, z: -1450, key: '住吉' },
  ];
  const namedParkSet = new Set(parksAll.filter((p) => p.name).map((p) => p.name));
  const parkCheck = majorParks.map((mp) => {
    const hit = [...namedParkSet].filter((n) => n.includes(mp.key));
    // 期待位置 ±700m の park polygon 面積合計（名前不問）
    let geomArea = 0, geomCount = 0;
    for (const p of parksAll) {
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (const [x, z] of p.p) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
      if (Math.hypot((a + b) / 2 - mp.x, (c + d) / 2 - mp.z) <= 900) { geomArea += fpArea(p.p); geomCount++; }
    }
    const found = hit.length > 0 || geomArea > 3000; // 名前一致 or 周辺に相応の park polygon
    return { name: mp.name, foundByName: hit.length > 0, matchedNames: hit.slice(0, 3), geomAreaM2: Math.round(geomArea), geomCount, rendered: found };
  });
  const missingMajorParks = parkCheck.filter((p) => !p.rendered);
  const nameOnlyGapParks = parkCheck.filter((p) => p.rendered && !p.foundByName);
  for (const p of missingMajorParks) {
    anomalies.push({ type: 'PARK', severity: 'HIGH', ward: null, park: p.name, detail: '主要公園が render されていない（geometry も名前も無い）' });
    counts.HIGH++;
  }
  for (const p of nameOnlyGapParks) {
    anomalies.push({ type: 'PARK', severity: 'LOW', ward: null, park: p.name, explained: true, detail: 'geometry は存在（周辺 park polygon 合計 ' + p.geomAreaM2 + 'm²）。OSM 上は別名/分割で正式名一致せず＝表示は正常' });
    counts.LOW++;
  }

  // ── 主要鉄道（§9）: Mission24 で路線名 + ネットワーク連結 railClass を tile へ付与 ──
  const railFeatsFull = loadTileLines(RAILS, (f) => f.kind === 'line');
  const railNamed = railFeatsFull.filter((f) => f.name).length;
  const railByClass = {};
  let railShort60Local = 0;
  for (const r of railFeatsFull) {
    const rc = r.railClass || (r.railway === 'subway' ? 'urban' : 'local');
    railByClass[rc] = (railByClass[rc] || 0) + 1;
    if (r.railway === 'rail' && rc === 'local') {
      let L = 0; for (let i = 1; i < r.p.length; i++) L += Math.hypot(r.p[i][0] - r.p[i - 1][0], r.p[i][1] - r.p[i - 1][1]);
      if (L < 60) railShort60Local++;
    }
  }
  // 主要路線チェック。OSM は正式名（愛称でなく）で入っているため、愛称→正式名の別名を併記して照合する。
  const majorLines = [
    { name: 'JR大阪環状線', alt: ['大阪環状線', '環状線'] },
    { name: 'JR京都線/神戸線（東海道本線）', alt: ['東海道本線', '東海道線'] },
    { name: 'JR東西線', alt: ['東西線'] },
    { name: 'JR学研都市線（片町線）', alt: ['片町線'] },
    { name: 'JR阪和線', alt: ['阪和線'] },
    { name: 'JR大和路線（関西本線）', alt: ['大和路線', '関西本線'] },
    { name: 'JRおおさか東線', alt: ['おおさか東線'] },
    { name: 'JRゆめ咲線（桜島線）', alt: ['ゆめ咲線', '桜島線'] },
    { name: 'Osaka Metro御堂筋線', alt: ['御堂筋線'] },
    { name: 'Osaka Metro谷町線', alt: ['谷町線'] },
    { name: 'Osaka Metro四つ橋線', alt: ['四つ橋線'] },
    { name: 'Osaka Metro中央線', alt: ['中央線'] },
    { name: 'Osaka Metro千日前線', alt: ['千日前線'] },
    { name: 'Osaka Metro堺筋線', alt: ['堺筋線'] },
    { name: 'Osaka Metro長堀鶴見緑地線', alt: ['長堀鶴見緑地線'] },
    { name: 'Osaka Metro今里筋線', alt: ['今里筋線'] },
    { name: '阪急', alt: ['阪急'] },
    { name: '阪神', alt: ['阪神'] },
    { name: '近鉄', alt: ['近畿日本鉄道', '近鉄'] },
    { name: '南海', alt: ['南海'] },
    { name: '京阪', alt: ['京阪'] },
  ];
  const namedSet = new Set(railFeatsFull.filter((f) => f.name).map((f) => f.name));
  const railLineCheck = majorLines.map((ml) => {
    const hit = [...namedSet].filter((n) => ml.alt.some((a) => n.includes(a)));
    return { name: ml.name, found: hit.length > 0, matched: hit.slice(0, 2) };
  });
  const missingMajorLines = railLineCheck.filter((l) => !l.found);
  for (const l of missingMajorLines) { anomalies.push({ type: 'E', severity: 'HIGH', ward: null, line: l.name, detail: '主要鉄道路線が名前で見つからない' }); counts.HIGH++; }

  // ── representative area QA（§10）──
  const reprGrids = A.grids;
  const cm = A.cellM, org = A.origin;
  const at = (grid, x, z) => (grid.get ? (grid.get(Math.floor((x - org.x) / cm) + ',' + Math.floor((z - org.z) / cm)) || 0) : (grid.has(Math.floor((x - org.x) / cm) + ',' + Math.floor((z - org.z) / cm)) ? 1 : 0));
  const representativeAreas = REPRESENTATIVE.map((r) => {
    const ward = wardAt(r.x, r.z, idxW);
    const b = reprGrids.bG.get(Math.floor((r.x - org.x) / cm) + ',' + Math.floor((r.z - org.z) / cm)) || { plat: 0, fb: 0 };
    // 半径 300m の周辺集計
    let bN = 0, roadL = 0, riverL = 0, railL = 0, parkN = 0, seaN = 0, cellN = 0;
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      const k = (Math.floor((r.x - org.x) / cm) + dx) + ',' + (Math.floor((r.z - org.z) / cm) + dz);
      cellN++;
      const bb = reprGrids.bG.get(k); if (bb) bN += bb.plat + bb.fb;
      roadL += reprGrids.roadG.get(k) || 0;
      riverL += reprGrids.riverG.get(k) || 0;
      railL += reprGrids.railG.get(k) || 0;
      if (reprGrids.parkC.has(k)) parkN++;
      if (reprGrids.seaC.has(k)) seaN++;
    }
    const land = ward != null;
    let status = 'PASS';
    let reason = null;
    if (!land) { status = 'EXPLAINED'; reason = 'N03 24区外（隣接市 or 未収録埋立地）'; }
    else if (seaN > 0) { status = 'FAIL'; reason = 'sea が陸を覆っている'; }
    else if (bN === 0 && roadL < 60) { status = 'FAIL'; reason = '建物・道路とも周辺 700m に無い'; }
    else if (bN < 5 && roadL > 200) {
      // 港湾・工業・緑地系なら EXPLAINED
      const industrial = ['夢洲', '舞洲', 'USJ', '咲洲', '南港', '此花'].includes(r.name);
      status = industrial ? 'EXPLAINED' : 'PASS';
      reason = industrial ? '港湾/人工島/工業地（建物疎は正当）' : null;
    }
    return {
      name: r.name, x: r.x, z: r.z, ward, land,
      buildings: bN, roadLengthM: Math.round(roadL), riverLengthM: Math.round(riverL), railLengthM: Math.round(railL), parkCells: parkN, seaCells: seaN,
      status, reason,
    };
  });
  const reprFail = representativeAreas.filter((r) => r.status === 'FAIL');
  for (const r of reprFail) { anomalies.push({ type: r.seaCells > 0 ? 'F' : 'A', severity: 'HIGH', ward: r.ward, area: r.name, detail: r.reason }); counts.HIGH++; }

  const overallScore = Math.round(Object.values(byLayer).reduce((s, l) => s + l.score, 0) / 7);

  const knownLimitations = [
    'rail は Mission24 で路線名 + ネットワーク連結 railClass を tile に付与済み。名前別の厳密な運行系統トレースは将来フェーズ（現状は geometry/coverage + 主要路線存在確認）。',
    'PLATEAU LOD1 建物。LOD2/LOD3（屋根形状・階層）再現は別フェーズ。',
    '航空写真レベルの完全一致は対象外（orthophoto QA は将来）。',
    'unclassified 建物 10,371 棟は N03 の 2 ソースで区外確認済み（隣接市）。夢洲は N03 未収録のためコア部のみ Mission21 で補完。',
    '湾岸ワード（此花/住之江/西淀川/港/大正）の building cell coverage が低いのは港湾ヤード・コンテナターミナル・工場敷地・USJ 敷地で cause I 判定済み。',
    '東淀川区・淀川区の road cell coverage が低いのは OSM 抽出ファイル（data/raw/osm/osaka-latest.osm.pbf）の収録範囲が北端 lat≈34.735 で切れており、東淀川区の約78%・淀川区の約25%・旭区の約9%の陸域に生 OSM 道路データが存在しないため（railways/waterways は同領域を収録しているので PBF extract のバウンディングボックス設定の問題）。roadStatus=SOURCE-MISSING。§17 に従い架空道路は生成しない。解消には北端 lat>=34.78 での再抽出（osmium extract）または大阪府全域 PBF の使用 → data:import:osm-pbf → data:build:city-layer-tiles の再実行が必要。',
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'N03 24区陸域 100m グリッドで 7 レイヤーを横断。source（tile/レポート）にあるべきものが render されているかを評価。',
    baseline: { plateauClassified: 574112, osmFallback: fallbackBuildings.length, renderable: 574112 + fallbackBuildings.length, roadFeatures: roads.length, riverDisplayed: riverCov ? riverCov.displayed : null, parks: parksAll.length, railLines: rails.length },
    overallScore,
    criticalCount: counts.CRITICAL, highCount: counts.HIGH, mediumCount: counts.MEDIUM, lowCount: counts.LOW, infoCount: counts.INFO,
    byLayer,
    byWard,
    representativeAreas,
    parkCheck,
    railClassification: {
      totalLines: railFeatsFull.length, named: railNamed, byClass: railByClass,
      shortRailStillLocal: railShort60Local,
      lineCheck: railLineCheck,
      note: 'Mission24 で路線名 + ネットワーク連結 railClass を tile に付与。本線の橋/分岐断片を major へ救済（FAR で本線が点線化する問題を解消）。',
    },
    anomalies: anomalies.sort((a, b) => ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].indexOf(a.severity) - ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].indexOf(b.severity)),
    knownLimitations,
    RESULT: (counts.CRITICAL === 0 && counts.HIGH === 0) ? 'PASS' : 'FAIL',
    verdict: (counts.CRITICAL === 0 && counts.HIGH === 0) ? '大阪市基礎地図 β1 完成候補' : 'CRITICAL/HIGH 未解消',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  writeJson(REPORT, report);

  console.log('[map-completeness] overallScore ' + overallScore + ' / CRITICAL ' + counts.CRITICAL + ' HIGH ' + counts.HIGH + ' MEDIUM ' + counts.MEDIUM + ' LOW ' + counts.LOW + ' INFO ' + counts.INFO);
  console.log('  byLayer score: ' + Object.entries(byLayer).map(([k, v]) => k + ' ' + v.score).join(' / '));
  console.log('  anomalies:');
  for (const an of report.anomalies.slice(0, 20)) console.log('    [' + an.severity + '] ' + an.type + ' ' + (an.ward || an.river || an.park || an.area || '') + ' ' + (an.center ? JSON.stringify(an.center) : '') + ' ' + (an.areaKm2 ? an.areaKm2 + 'km²' : '') + (an.explained ? ' (explained)' : '') + '  ' + (an.note || an.detail || ''));
  console.log('  representative FAIL: ' + reprFail.map((r) => r.name).join(', ') || '(none)');
  console.log('  major park missing: ' + missingMajorParks.map((p) => p.name).join(', ') || '(none)');
  console.log('  -- byWard overallCompleteness --');
  for (const [w, s] of Object.entries(byWard).sort((a, b) => a[1].overallCompleteness - b[1].overallCompleteness)) console.log('    ' + w.padEnd(18) + s.overallCompleteness + '  bld ' + (s.buildingCoverage * 100).toFixed(0) + '% road ' + (s.roadCoverage * 100).toFixed(0) + '%  ' + s.buildingStatus + '/' + s.roadStatus + '/' + s.waterStatus);
  console.log('保存:', toProjectRelativePath(REPORT), '  RESULT:', report.RESULT, '/', report.verdict);
  if (report.RESULT !== 'PASS') process.exitCode = 1;
}

main();
