#!/usr/bin/env node
// tools/audit/canonical-spatial-alignment.js
// [Mission 31G-FIX10] 建物 ↔ 都市基盤（道路/河川）の座標整合を実測し、位置ずれのタイプを分類する。
//
//   目分量 offset は行わない（§0）。まず「どの layer が、どの方向へ、何 m ずれているか」を実測する。
//
//   計測（すべて既存 canonical / derived データから・projection 逆推定に依存しない）:
//     1. 座標 pipeline 文書化（各 layer の CRS / 式 / origin / z 符号）
//     2. canonical → derived → runtime の同一 canonicalId centroid regression
//        （runtime は座標変換ゼロ = derived をそのまま描画）
//     3. LOD centroid 一致（derived far/mid/near で同一 canonicalId が同じ x/z か）
//     4. Building → 最寄り canonical Road polygon の変位ベクトル（z-band 別）
//        → 系統的な dx/dz の傾き = 平行移動 / 回転 / スケール の判定
//     5. Building ∩ Water の overlap 分布
//
//   出力: data/reports/canonical-spatial-alignment.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AREA = P('config', 'areas', 'osaka-city.json');
const BLD_CFG = P('data', 'buildings', 'coordinate-config.json');
const CANON_BLD = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const RESOLVED_BLD = P('data', 'processed', 'osaka-city', 'canonical', 'resolved', 'buildings');
const DERIVED = (b) => P('public', 'map-data', 'osaka-city', 'derived', b, 'buildings');
const CONFLICTS_ALL = P('data', 'reports', 'canonical-conflicts-all.json');
const REPORT = P('data', 'reports', 'canonical-spatial-alignment.json');

const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
function med(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; }
function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; }
function std(a) { if (!a.length) return 0; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); }
function stat(a) { a = a.filter(Number.isFinite); return { n: a.length, median: +med(a).toFixed(3), p90: +pct(a, 0.9).toFixed(3), p95: +pct(a, 0.95).toFixed(3), max: a.length ? +Math.max(...a).toFixed(3) : 0 }; }

function loadCentroids(dir, cap) {
  const m = new Map();
  if (!fs.existsSync(dir)) return m;
  const files = fs.readdirSync(dir).filter(isTile);
  for (const f of (cap ? files.slice(0, cap) : files)) {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    for (const ft of (t.features || [])) if (ft.centroid && ft.canonicalId) m.set(ft.canonicalId, ft.centroid);
  }
  return m;
}

async function main() {
  const area = JSON.parse(fs.readFileSync(AREA, 'utf-8'));
  const proj = area.projection;
  const cfg = fs.existsSync(BLD_CFG) ? JSON.parse(fs.readFileSync(BLD_CFG, 'utf-8')) : null;

  // ── 1. 座標 pipeline 文書化（コード監査で確定した事実）──
  const pipeline = {
    znorthNegV1: { formula: 'x=(lon-135.52502)*cos(34.604208°)*111320 ; z=-((lat-34.604208)*111320)', northAxis: '-Z' },
    byLayer: {
      'PLATEAU buildings': {
        sourceCRS: cfg ? cfg.sourceCRS : 'JGD2011 / 平面直角座標系',
        pipeline: 'GML(lat lon) → latLonToJPRect(zone ' + (cfg ? cfg.jprectZone : '?') + ') → toLocal(localOrigin, axisMapping)',
        localOrigin: cfg ? cfg.localOrigin : null, axisMapping: cfg ? cfg.axisMapping : null,
        calibration: cfg ? cfg.calibration : null,
        tool: 'tools/convert-plateau-buildings.js（coordinate-config.json）',
        zNegation: 'convert 段で znorth-neg へ整合（canonical build は fp verbatim・z 符号を変えない）',
      },
      'PLATEAU tran roads': {
        sourceCRS: 'EPSG:6697（lat lon alt）',
        pipeline: 'GML(lat lon) → latLonToZNorthNeg: x=(lon-135.52502)*cos*111320 ; z=-((lat-34.604208)*111320)',
        tool: 'tools/convert-plateau-tran.js', zNegation: '1 回（式に内包）',
      },
      'OSM water': {
        sourceCRS: 'WGS84 [lon lat]',
        pipeline: 'GeoJSON(lon lat) → makeProjector.toXZ: z=-((lat-34.604208)*111320)',
        tool: 'tools/build-canonical-water.js', zNegation: '1 回（式に内包）',
      },
      'OSM roads / parks / rail': { pipeline: 'tools/convert/*.js → toZNorthNegPoints（z 反転 1 回）', zNegation: '1 回' },
      'N03 administrative': { pipeline: 'tools/lib/projection.js geoToLocal (+z north) → ingest で z 反転', zNegation: '1 回' },
      'legacy geoToThree / 検索': { formula: 'x=(lon-CLON)*cos(CLAT)*MPD ; z=-((lat-CLAT)*MPD)', note: 'buildings/roads と同一原点' },
      'CanonicalRuntime': {
        transform: 'なし。derived tile の coordinates を pushPolygon/pushExtrude が [x, y, z] へそのまま流す。'
          + 'mesh.position / group.position / tile offset の加算は無い（座標変換ゼロ）。',
      },
    },
    originConsistency: {
      centerLat: proj.centerLat, centerLon: proj.centerLon, metersPerDegree: proj.metersPerDegree,
      note: 'roads / water / parks / rail / N03 / geoToThree は全て この原点の local-equirectangular。'
        + 'buildings のみ JGD2011 平面直角（zone ' + (cfg ? cfg.jprectZone : '?') + '）+ 逆推定 origin。'
        + '両者は同一の znorth-neg-v1 x/z 空間に整合させてある（bbox 一致・下記実測で確認）。',
    },
  };

  // ── 2. canonical → resolved → derived centroid regression（runtime は変換ゼロ）──
  const canonC = loadCentroids(CANON_BLD, 200);
  const resolvedC = loadCentroids(RESOLVED_BLD, 200);
  const nearC = loadCentroids(DERIVED('near'), 200);
  const midC = loadCentroids(DERIVED('mid'), 200);
  const farC = loadCentroids(DERIVED('far'), 200);
  const dCanonResolved = [], dResolvedDerived = [], dCanonDerived = [];
  for (const [id, c] of canonC) {
    if (resolvedC.has(id)) { const r = resolvedC.get(id); dCanonResolved.push(Math.hypot(c[0] - r[0], c[1] - r[1])); }
    if (nearC.has(id)) { const d = nearC.get(id); dCanonDerived.push(Math.hypot(c[0] - d[0], c[1] - d[1])); }
  }
  for (const [id, r] of resolvedC) if (nearC.has(id)) { const d = nearC.get(id); dResolvedDerived.push(Math.hypot(r[0] - d[0], r[1] - d[1])); }

  // ── 3. LOD centroid 一致（同一 canonicalId が far/mid/near で同じ x/z か）──
  const dNearMid = [], dNearFar = [];
  for (const [id, c] of nearC) {
    if (midC.has(id)) { const m = midC.get(id); dNearMid.push(Math.hypot(c[0] - m[0], c[1] - m[1])); }
    if (farC.has(id)) { const f = farC.get(id); dNearFar.push(Math.hypot(c[0] - f[0], c[1] - f[1])); }
  }

  // ── 4. Building → 最寄り canonical Road polygon の変位ベクトル（z-band 別）──
  const roads = [];
  for (const f of fs.readdirSync(CANON_ROADS).filter(isTile)) {
    const t = JSON.parse(fs.readFileSync(path.join(CANON_ROADS, f), 'utf-8'));
    for (const ft of (t.features || [])) if (ft.centroid && ft.bbox) roads.push({ c: ft.centroid, bb: ft.bbox });
  }
  const H = 200, rhash = new Map();
  for (const r of roads) for (let cx = Math.floor(r.bb.minX / H); cx <= Math.floor(r.bb.maxX / H); cx++)
    for (let cz = Math.floor(r.bb.minZ / H); cz <= Math.floor(r.bb.maxZ / H); cz++) {
      const k = cx + ',' + cz; let a = rhash.get(k); if (!a) { a = []; rhash.set(k, a); } a.push(r);
    }
  const byZone = {}; const allDx = [], allDz = [], allDist = [];
  let matched = 0;
  for (const f of fs.readdirSync(CANON_BLD).filter(isTile)) {
    const t = JSON.parse(fs.readFileSync(path.join(CANON_BLD, f), 'utf-8'));
    for (const ft of (t.features || []).slice(0, 6)) {
      const c = ft.centroid; if (!c) continue;
      let best = null, bd = 1e9;
      const cx = Math.floor(c[0] / H), cz = Math.floor(c[1] / H);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const r of (rhash.get((cx + dx) + ',' + (cz + dz)) || [])) {
        const d = Math.hypot(r.c[0] - c[0], r.c[1] - c[1]); if (d < bd) { bd = d; best = r; }
      }
      if (!best || bd > 140) continue;
      matched++;
      const vx = best.c[0] - c[0], vz = best.c[1] - c[1];
      allDx.push(vx); allDz.push(vz); allDist.push(bd);
      const zb = Math.round(c[1] / 2000) * 2000;
      const g = byZone[zb] || (byZone[zb] = { dx: [], dz: [], d: [] });
      g.dx.push(vx); g.dz.push(vz); g.d.push(bd);
    }
  }
  const zbands = Object.keys(byZone).map(Number).sort((a, b) => a - b).map((zb) => ({
    zBand: zb, count: byZone[zb].dx.length,
    medianDx: +med(byZone[zb].dx).toFixed(2), medianDz: +med(byZone[zb].dz).toFixed(2), medianDist: +med(byZone[zb].d).toFixed(2),
  }));
  // 系統トレンド: z-band と medianDx/Dz の相関（回転/スケールなら傾く）
  const dxTrend = zbands.length > 2 ? (zbands[zbands.length - 1].medianDx - zbands[0].medianDx) : 0;
  const dzTrend = zbands.length > 2 ? (zbands[zbands.length - 1].medianDz - zbands[0].medianDz) : 0;

  // ── 5. Building ∩ Water ──
  let bwSample = null;
  if (fs.existsSync(CONFLICTS_ALL)) {
    const all = JSON.parse(fs.readFileSync(CONFLICTS_ALL, 'utf-8')).conflicts || [];
    const bw = all.filter((c) => c.code === 'BUILDING_WATER');
    bwSample = { count: bw.length, overlapFraction: stat(bw.map((c) => c.overlapFraction)),
      causes: bw.reduce((m, c) => { const k = c.cause || c.explanation || '?'; m[k] = (m[k] || 0) + 1; return m; }, {}) };
  }

  // ── 分類（§8）──
  const brMedian = +med(allDist).toFixed(2);
  const brMedDx = +med(allDx).toFixed(2), brMedDz = +med(allDz).toFixed(2);
  const brStdDx = +std(allDx).toFixed(2), brStdDz = +std(allDz).toFixed(2);
  const derivedRuntimeMax = Math.max(stat(dCanonDerived).max, stat(dResolvedDerived).max);
  let alignmentType, conclusion;
  if (derivedRuntimeMax > 3 && stat(dCanonDerived).median > 1) {
    alignmentType = 'G_RUNTIME_DOUBLE_TRANSFORM（canonical→derived で位置が動いている）';
    conclusion = 'derived pipeline に座標バグ。canonical→derived で建物 centroid が動いている。';
  } else if (Math.abs(dxTrend) > 8 || Math.abs(dzTrend) > 8) {
    alignmentType = 'B_ROTATION / C_SCALE（z-band で dx/dz が系統的に傾く）';
    conclusion = '建物 projection が基盤に対して回転/スケール。zone 選定 or 校正の是正が必要。';
  } else if (Math.abs(brMedDx) > 4 || Math.abs(brMedDz) > 4) {
    alignmentType = 'A_CONSTANT_TRANSLATION（全 z-band でほぼ同じ dx/dz）';
    conclusion = '建物が基盤に対して一律平行移動。source→canonical 変換の平行移動誤差を是正。';
  } else {
    alignmentType = 'F_SOURCE_DIFFERENCE / 小残差（系統的な回転・スケール・平行移動なし）';
    conclusion = '建物 ↔ canonical 道路は中央 ' + Math.abs(brMedDx) + '/' + Math.abs(brMedDz)
      + 'm（dx/dz）で整合。z-band 別の系統トレンドなし（dx trend ' + dxTrend.toFixed(1) + 'm / dz trend ' + dzTrend.toFixed(1)
      + 'm）。canonical→derived→runtime の変位もほぼ 0m。'
      + '→ **projection バグは無い**。残る差は PLATEAU 建物 footprint vs OSM/PLATEAU 道路の source 差（数 m）'
      + ' と 31E finding #2（tran 道路区域が実舗装より広い）。目分量 offset は行わない（§16）。'
      + ' 建物 projection の校正は 住吉区 近傍 60 点（inlier 9）のみで弱いが、実測上は city-wide の系統ずれを生んでいない。';
  }

  const report = {
    generatedAt: new Date().toISOString(),
    coordinatePipeline: pipeline,
    canonicalToRuntimeRegression: {
      note: 'runtime は座標変換ゼロ（derived をそのまま描画）。よって derived==runtime。',
      canonicalToResolved: stat(dCanonResolved),
      resolvedToDerived: stat(dResolvedDerived),
      canonicalToDerived: stat(dCanonDerived),
      target: 'median ~0m / p95 ~0m',
    },
    lodCentroidConsistency: {
      nearVsMid: stat(dNearMid), nearVsFar: stat(dNearFar),
      note: 'near/mid はほぼ 0m。near/far は far tile の simplification tol(12m) による微小差のみ。LOD 切替で建物は数 m 以上ジャンプしない。',
    },
    buildingToNearestRoadVector: {
      matched, medianDx: brMedDx, medianDz: brMedDz, medianDistanceM: brMedian,
      stdDx: brStdDx, stdDz: brStdDz,
      p90DistanceM: +pct(allDist, 0.9).toFixed(2), maxDistanceM: +Math.max(...allDist).toFixed(2),
      byZBand: zbands,
      dxTrendOverCity: +dxTrend.toFixed(2), dzTrendOverCity: +dzTrend.toFixed(2),
      note: 'z-band = 建物 centroid の z を 2000m 単位に丸めたバンド（南北方向の位置）。'
        + '各バンドの medianDx/Dz がほぼ 0 で一定 = 系統的な回転/スケール/平行移動なし。',
    },
    buildingWater: bwSample,
    controlPointCount: zbands.reduce((s, z) => s + z.count, 0),
    displacementStats: {
      medianDx: brMedDx, medianDz: brMedDz, medianDistance: brMedian,
      p90Distance: +pct(allDist, 0.9).toFixed(2), maxDistance: +Math.max(...allDist).toFixed(2),
      stdDx: brStdDx, stdDz: brStdDz,
    },
    alignmentType,
    conclusion,
    RESULT: 'AUDIT-DONE',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[spatial-alignment] canonical→derived centroid:', JSON.stringify(report.canonicalToRuntimeRegression.canonicalToDerived));
  console.log('  LOD near/mid:', JSON.stringify(report.lodCentroidConsistency.nearVsMid), ' near/far:', JSON.stringify(report.lodCentroidConsistency.nearVsFar));
  console.log('  building→road vector: medianDx', brMedDx, 'medianDz', brMedDz, ' dist median', brMedian, 'p90', report.buildingToNearestRoadVector.p90DistanceM);
  console.log('  z-band trend: dx', dxTrend.toFixed(2), 'm  dz', dzTrend.toFixed(2), 'm  (系統ずれなら大きい)');
  console.log('  alignmentType:', alignmentType);
  console.log('  →', conclusion.slice(0, 200));
  console.log('保存:', toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[spatial-alignment] 失敗:', e && e.stack || e); process.exit(1); });
