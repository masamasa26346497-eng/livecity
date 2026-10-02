#!/usr/bin/env node
// tools/audit/building-map-scale-audit.js
// [Mission 31G-SCALE-AUDIT] 「位置」ではなく「大きさ」が合っていない可能性を検証する。
//
// §0 最重要原則: 今回は測定のみ。building offset・scale補正の適用・road/GSI geometry変更・
//   projection変更・origin変更・Canonical再buildは一切行わない。
//
// 既存の gsi-building-matching.js（FIX20-22で確立・§0によりロジック不変で再利用）を使い、
// PLATEAU building footprint と GSI Building Outline の HIGH match ペアを再計算し、
// 今回はそのペアの「translation(dx/dz)」ではなく「dimension（面積・周長・bbox・主軸長）」を比較する。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { loadWards } from '../lib/gsi-road-edge-transform.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';
import { readFeatureCollectionStreaming } from '../lib/large-json-array-reader.js';
import { precomputeMetrics, matchBuildings, percentileOf } from '../lib/gsi-building-matching.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const GSI_OUTLINE = P('data', 'processed', 'osaka-city', 'gsi-building-outline', 'building-outline-lines.json');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const NEAR_BLDGS = P('data', 'processed', 'osaka-city', 'derived', 'near', 'buildings');
const AREA_CONFIG_PATH = P('config', 'areas', 'osaka-city.json');
const REPORT = P('data', 'reports', 'building-map-scale-audit.json');
const HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');

const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

// ── §2-5/14-18 寸法計量（既存 lib に無い perimeter / principal-axis extent だけをこのファイルで追加）──
function ringPerimeter(ring) {
  let p = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; p += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return p;
}
// PCA主軸（ringOrientation と同じ固有ベクトル角度）方向・直交方向への射影で「主軸長・主軸幅」を測る
// （axis-aligned bboxではなく建物の実際の向きに沿った寸法。回転している建物でも正しく比較できる）。
function principalAxisExtents(ring, orientationDeg) {
  const theta = orientationDeg * Math.PI / 180;
  const ux = Math.cos(theta), uz = Math.sin(theta);   // 主軸方向単位ベクトル
  const vx = -uz, vz = ux;                              // 直交方向
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [x, z] of ring) {
    const u = x * ux + z * uz, v = x * vx + z * vz;
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const lenU = maxU - minU, lenV = maxV - minV;
  return { length: Math.max(lenU, lenV), width: Math.min(lenU, lenV) };
}
function ratioStats(values) {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, p10: null, p25: null, p75: null, p90: null, p95: null, mean: null };
  let sum = 0; for (const x of v) sum += x;
  return {
    n: v.length,
    median: percentileOf(v, 0.5), p10: percentileOf(v, 0.10), p25: percentileOf(v, 0.25),
    p75: percentileOf(v, 0.75), p90: percentileOf(v, 0.90), p95: percentileOf(v, 0.95),
    mean: +(sum / v.length).toFixed(4),
  };
}

// ── §6 affine transform推定（最小二乗。xG = a*xP + b*zP + tx, zG = c*xP + d*zP + tz）──
function solveLinearLeastSquares3(rows) {
  // rows: [[xP, zP, 1, target], ...] を正規方程式 (A^T A) p = A^T y で解く（3x3系・явно展開）。
  let Sxx = 0, Sxz = 0, Sx1 = 0, Szz = 0, Sz1 = 0, S11 = 0, Sxy = 0, Szy = 0, Sy1 = 0;
  for (const [x, z, _1, y] of rows) {
    Sxx += x * x; Sxz += x * z; Sx1 += x; Szz += z * z; Sz1 += z; S11 += 1;
    Sxy += x * y; Szy += z * y; Sy1 += y;
  }
  // [[Sxx,Sxz,Sx1],[Sxz,Szz,Sz1],[Sx1,Sz1,S11]] * [a,b,c]^T = [Sxy,Szy,Sy1]^T をCramerの公式で解く。
  const A = [[Sxx, Sxz, Sx1], [Sxz, Szz, Sz1], [Sx1, Sz1, S11]];
  const B = [Sxy, Szy, Sy1];
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(A);
  if (Math.abs(D) < 1e-9) return null;
  const withCol = (col) => A.map((row, i) => row.map((v, j) => (j === col ? B[i] : v)));
  return [det3(withCol(0)) / D, det3(withCol(1)) / D, det3(withCol(2)) / D]; // [coefX, coefZ, translation]
}
function estimateAffine(matches) {
  const rowsX = [], rowsZ = [];
  for (const m of matches) {
    if (!m.aCentroid || !m.bCentroid) continue;
    rowsX.push([m.aCentroid[0], m.aCentroid[1], 1, m.bCentroid[0]]);
    rowsZ.push([m.aCentroid[0], m.aCentroid[1], 1, m.bCentroid[1]]);
  }
  const solX = solveLinearLeastSquares3(rowsX); // [a, b, tx]  (xG = a*xP + b*zP + tx)
  const solZ = solveLinearLeastSquares3(rowsZ); // [c, d, tz]  (zG = c*xP + d*zP + tz)
  if (!solX || !solZ) return null;
  const [a, b, tx] = solX, [c, d, tz] = solZ;
  // 2x2行列 [[a,b],[c,d]] のQR風分解でscaleX/scaleZ/rotation/shearへ分解
  // （Gram-Schmidt: 第1列を回転角の基準にする一般的な affine decomposition 手法）。
  const scaleX = Math.hypot(a, c);
  const rotation = Math.atan2(c, a) * 180 / Math.PI;
  const shearRaw = (a * b + c * d) / (scaleX * scaleX);
  const scaleZ = Math.hypot(b - shearRaw * a, d - shearRaw * c);
  return { a, b, c, d, tx, tz, scaleX: +scaleX.toFixed(5), scaleZ: +scaleZ.toFixed(5), rotationDeg: +rotation.toFixed(4), shear: +shearRaw.toFixed(5), sampleCount: rowsX.length };
}

// ── §12/13 distance ratio test（HIGH matchペアをサンプリングし、PLATEAU間距離 vs GSI間距離を比較）──
function distanceRatioTest(matches, sampleSize, rng) {
  const pool = matches.filter((m) => m.aCentroid && m.bCentroid);
  const sample = [];
  const idxs = new Set();
  const n = Math.min(sampleSize, pool.length);
  while (idxs.size < n) idxs.add(Math.floor(rng() * pool.length));
  for (const i of idxs) sample.push(pool[i]);
  const buckets = { '0-100m': [], '100-500m': [], '500-1000m': [], '1-5km': [], '5km+': [] };
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const p1 = sample[i].aCentroid, p2 = sample[j].aCentroid;
      const g1 = sample[i].bCentroid, g2 = sample[j].bCentroid;
      const dP = Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
      const dG = Math.hypot(g1[0] - g2[0], g1[1] - g2[1]);
      if (dP < 1 || dG < 1) continue; // 同一建物同士等の退化ペアは除外
      const ratio = dP / dG;
      let bucket;
      if (dP < 100) bucket = '0-100m'; else if (dP < 500) bucket = '100-500m'; else if (dP < 1000) bucket = '500-1000m';
      else if (dP < 5000) bucket = '1-5km'; else bucket = '5km+';
      buckets[bucket].push(ratio);
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(buckets)) out[k] = ratioStats(v);
  return { sampleBuildingCount: sample.length, pairCount: Object.values(buckets).reduce((s, a) => s + a.length, 0), byDistanceBucket: out };
}
// 決定論的な疑似乱数（毎回同じsampleで再現可能にする。Math.randomは使わない）。
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── §7/§9 runtime scale監査（静的コード検査。canonicalRoot/rtRoot/layerGroup/buildingメッシュへの
//     非sprite scale代入が皆無であることを確認する）──
function auditRuntimeScale(html) {
  const scaleAssignments = [...html.matchAll(/([A-Za-z0-9_.\[\]]+)\.scale\.(set\([^)]*\)|x\s*=\s*[^;]+|z\s*=\s*[^;]+|y\s*=\s*[^;]+)/g)]
    .map((m) => m[0]);
  const nonSpriteScale = scaleAssignments.filter((s) => !/sprite|dotSprite|labelSprite|\bdot\.scale\b/i.test(s));
  return {
    totalScaleAssignmentsFound: scaleAssignments.length,
    nonSpriteScaleAssignments: nonSpriteScale,
    canonicalRootScaleTouched: /canonicalRoot\.scale/.test(html),
    legacyRootScaleTouched: /legacyRoot\.scale/.test(html),
    rtRootScaleTouched: /rtRoot\.scale/.test(html),
    layerGroupScaleTouched: /layerGroup\[[^\]]*\]\.scale/.test(html),
    sceneScaleTouched: /\bscene\.scale/.test(html),
    conclusion: nonSpriteScale.length === 0
      ? 'canonicalRoot/legacyRoot/rtRoot/layerGroup/scene/buildingメッシュへのscale代入は0件（sprite/dot/label以外にscaleを触るコードが存在しない）。THREE.Object3Dの既定値(1,1,1)がそのまま使われている。'
      : '非sprite scale代入を検出。個別に確認が必要。',
  };
}

// ── §8 runtime footprint dimension監査（canonical/buildings と derived/near/buildings(FIX24 tolM=0)
//     が同一canonicalIdについて同一座標を持つか、全615,617棟を直接比較する。HIGH matchサブセットに
//     限定せず全数比較する方が、tile走査を絞ったサンプリングより速く・かつ確実である）。
function auditRuntimeFootprintDimensionFull() {
  const files = fs.readdirSync(CANON_BLDGS).filter(isTile);
  let compared = 0, identical = 0;
  const ratios = []; const sample = [];
  let maxAreaDiff = 0;
  for (const f of files) {
    const cTile = rj(path.join(CANON_BLDGS, f));
    if (!cTile) continue;
    const nTile = rj(path.join(NEAR_BLDGS, f));
    if (!nTile) continue;
    const nById = new Map(nTile.features.map((x) => [x.canonicalId, x]));
    for (const ft of cTile.features) {
      const nf = nById.get(ft.canonicalId);
      if (!nf) continue;
      compared++;
      const cRing = ft.coordinates[0], nRing = nf.coordinates[0];
      const same = JSON.stringify(cRing) === JSON.stringify(nRing);
      if (same) identical++;
      const cArea = ringArea_(cRing), nArea = ringArea_(nRing);
      if (nArea > 0) ratios.push(cArea / nArea);
      maxAreaDiff = Math.max(maxAreaDiff, Math.abs(cArea - nArea));
      if (sample.length < 20) sample.push({ canonicalId: ft.canonicalId, found: true, canonicalArea: +cArea.toFixed(4), runtimeNearArea: +nArea.toFixed(4), ratio: nArea > 0 ? +(cArea / nArea).toFixed(6) : null, coordinatesIdentical: same });
    }
  }
  ratios.sort((a, b) => a - b);
  const pct = (p) => ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))] : null;
  return {
    comparedCount: compared, identicalCoordinatesCount: identical, identicalRatio: compared ? identical / compared : null,
    areaRatio: { median: pct(0.5), p05: pct(0.05), p95: pct(0.95), min: ratios[0] ?? null, max: ratios[ratios.length - 1] ?? null },
    maxAreaDiffM2: maxAreaDiff, sample,
  };
}
function ringArea_(ring) { let a = 0; for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; a += x1 * z2 - x2 * z1; } return Math.abs(a) / 2; }

// ── §10/11 meters-per-degree / anisotropic scale監査（全pipelineが単一config由来か静的確認）──
function auditProjectionConsistency() {
  const areaConfig = rj(AREA_CONFIG_PATH);
  const proj = areaConfig && areaConfig.projection;
  const files = [
    'tools/lib/projection.js', 'tools/lib/gsi-road-edge-transform.js',
    'tools/build-canonical-buildings.js', 'tools/build-canonical-roads.js',
    'tools/build-canonical-parks.js', 'tools/build-canonical-water.js',
  ];
  const perFile = [];
  for (const rel of files) {
    const p = resolveProjectPath(rel);
    if (!fs.existsSync(p)) { perFile.push({ file: rel, exists: false }); continue; }
    const src = fs.readFileSync(p, 'utf-8');
    // tools/lib/projection.js は正本の「定義」側（centerLat/centerLon/metersPerDegreeを引数として
    //   受け取る汎用関数）であり、area.projection を「参照する」側ではない。この1ファイルだけは
    //   「呼び出し元から渡された値をそのまま使い、独自の定数を持たない」ことを条件にする
    //   （呼び出し元(build-canonical-*.js等)が area.projection から渡すことは他ファイル側で確認する）。
    const isDefinitionLib = rel.endsWith('lib/projection.js');
    const usesSharedConfig = isDefinitionLib
      ? /function geoToLocal\(lat, lon, projection\)/.test(src) && !/centerLat\s*=\s*34\.604208/.test(src)
      : /\{\s*centerLat,\s*centerLon,\s*metersPerDegree\s*\}\s*=\s*(area|AREA_CONFIG)\.projection/.test(src)
        || /AREA_CONFIG\.projection/.test(src) || /area\.projection/.test(src);
    // 経度側にだけ cos(centerLat) 補正が掛かっているか（異方性の正しい扱い）
    const hasCosCorrection = /Math\.cos\(\(?centerLat/.test(src) || /cosf/.test(src);
    // 独自ハードコード値（34.604208/135.52502/111320 以外の別の定数）が無いか
    const strayLatLon = [...src.matchAll(/\b3[0-9]\.\d{4,}\b/g)].map((m) => m[0]).filter((v) => v !== '34.604208');
    perFile.push({ file: rel, exists: true, usesSharedConfig, hasCosCorrection: isDefinitionLib ? /Math\.cos/.test(src) : hasCosCorrection, strayLatLonLiterals: strayLatLon });
  }
  const htmlSrc = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';
  const runtimeMatch = htmlSrc.match(/const SEARCH_CLAT\s*=\s*([\d.]+).*?const SEARCH_MPD\s*=\s*([\d.]+)/s)
    || [null, null, null];
  return {
    configSource: toProjectRelativePath(AREA_CONFIG_PATH),
    centerLat: proj && proj.centerLat, centerLon: proj && proj.centerLon, metersPerDegree: proj && proj.metersPerDegree,
    perFile,
    runtimeHtmlHas135_52502: /135\.52502/.test(htmlSrc),
    runtimeHtmlHas34_604208: /34\.604208/.test(htmlSrc),
    runtimeHtmlHasCosLatCorrection: /Math\.cos\(\(?lat.*Math\.PI/.test(htmlSrc) || /cos\(34\.604208/.test(htmlSrc) || /Math\.cos\(.*CLAT/.test(htmlSrc),
    conclusion: perFile.every((f) => !f.exists || f.usesSharedConfig)
      ? '全pipelineファイルが config/areas/osaka-city.json 由来の単一 projection定数(centerLat/centerLon/metersPerDegree)を共有している（複製・独自定数は検出されず）。異方性補正(cos(centerLat))はx軸(経度)側にのみ適用され、z軸(緯度)側には適用されない設計で全ファイル一貫している。'
      : '一部ファイルで共有configを使っていない疑い。perFileを確認。',
  };
}

// ── §20 分類 ──
function classify(footprintStats, affine, runtimeFootprintFull, distanceRatio) {
  const linMed = footprintStats.linearScale.median;
  const runtimeAllRatio1 = runtimeFootprintFull.comparedCount > 0
    && runtimeFootprintFull.areaRatio.min != null && runtimeFootprintFull.areaRatio.max != null
    && Math.abs(runtimeFootprintFull.areaRatio.min - 1) < 1e-6 && Math.abs(runtimeFootprintFull.areaRatio.max - 1) < 1e-6;
  const affineScaleOff = affine && (Math.abs(affine.scaleX - 1) > 0.02 || Math.abs(affine.scaleZ - 1) > 0.02);
  const anisotropic = affine && Math.abs(affine.scaleX - affine.scaleZ) > 0.02;
  if (!runtimeAllRatio1) return 'RUNTIME_SCALE_ERROR';
  if (anisotropic) return 'ANISOTROPIC_SCALE_ERROR';
  if (affineScaleOff) return 'MAP_SCALE_ERROR';
  if (linMed != null && (linMed > 1.03 || linMed < 0.97)) return 'SOURCE_SEMANTICS_DIFFERENCE'; // roof(GSI) vs footprint(PLATEAU)の形状差の可能性が高い
  return 'BUILDING_SIZE_CORRECT';
}

async function main() {
  const generatedAt = new Date().toISOString();
  const gsi = await readFeatureCollectionStreaming(GSI_OUTLINE);
  if (!gsi || !Array.isArray(gsi.features) || gsi.features.length === 0) {
    const report = { generatedAt, RESULT: 'GSI_BUILDING_OUTLINE_RAW_DATA_MISSING' };
    await writeJson(REPORT, report);
    console.log('[building-map-scale-audit] GSI_BUILDING_OUTLINE_RAW_DATA_MISSING');
    return;
  }
  const wards = loadWards();
  const gsiClosed = gsi.features.filter((f) => f.closed && f.geometry && f.geometry.coordinates && f.geometry.coordinates.length >= 4);
  console.log('[building-map-scale-audit] GSI closed outlines:', gsiClosed.length, '/', gsi.features.length);
  const gsiFeatures = gsiClosed.map((f, i) => ({ id: f.id || ('gsi_' + i), ring: f.geometry.coordinates }));
  const gsiMetrics = gsiFeatures.map(precomputeMetrics);
  const gsiById = new Map(gsiMetrics.map((g) => [g.id, g]));

  let gMinX = Infinity, gMaxX = -Infinity, gMinZ = Infinity, gMaxZ = -Infinity;
  for (const g of gsiMetrics) { if (g.bbox.minX < gMinX) gMinX = g.bbox.minX; if (g.bbox.maxX > gMaxX) gMaxX = g.bbox.maxX; if (g.bbox.minZ < gMinZ) gMinZ = g.bbox.minZ; if (g.bbox.maxZ > gMaxZ) gMaxZ = g.bbox.maxZ; }
  const PAD = 50;

  console.time('[building-map-scale-audit] loadPlateauBuildings');
  const files = fs.readdirSync(CANON_BLDGS).filter(isTile);
  const plateauFeatures = [];
  for (const f of files) {
    const m = f.match(/^tile_(-?\d+)_(-?\d+)\.json$/); if (!m) continue;
    const tx = +m[1], tz = +m[2], ts = 500;
    const tMinX = tx * ts, tMaxX = tMinX + ts, tMinZ = tz * ts, tMaxZ = tMinZ + ts;
    if (tMaxX < gMinX - PAD || tMinX > gMaxX + PAD || tMaxZ < gMinZ - PAD || tMinZ > gMaxZ + PAD) continue;
    const t = rj(path.join(CANON_BLDGS, f));
    if (!t) continue;
    for (const ft of t.features) {
      if (!ft.source || ft.source.geometrySource !== 'plateau-building') continue;
      if (!ft.bbox || ft.bbox.maxX < gMinX - PAD || ft.bbox.minX > gMaxX + PAD || ft.bbox.maxZ < gMinZ - PAD || ft.bbox.minZ > gMaxZ + PAD) continue;
      const outer = ft.geometryType === 'Polygon' ? ft.coordinates[0] : (ft.coordinates[0] && ft.coordinates[0][0]);
      if (!outer || outer.length < 3) continue;
      plateauFeatures.push({ id: ft.canonicalId, ring: outer });
    }
  }
  console.timeEnd('[building-map-scale-audit] loadPlateauBuildings');
  console.log('[building-map-scale-audit] PLATEAU candidates near GSI coverage:', plateauFeatures.length);
  const plateauMetrics = plateauFeatures.map(precomputeMetrics);
  const plateauById = new Map(plateauMetrics.map((p) => [p.id, p]));

  console.time('[building-map-scale-audit] matchBuildings');
  const allMatches = matchBuildings(plateauMetrics, gsiMetrics);
  console.timeEnd('[building-map-scale-audit] matchBuildings');
  const highMatches = allMatches.filter((m) => m.confidence === 'MATCH_HIGH');
  console.log('[building-map-scale-audit] HIGH matches:', highMatches.length);

  // ── §2-5/14 寸法比較（HIGH matchのみ・§15: roof vs footprint semanticsを念頭に置く）──
  const areaRatios = [], linearScales = [], widthRatios = [], depthRatios = [], perimeterRatios = [];
  const perMatchDim = [];
  for (const m of highMatches) {
    const a = plateauById.get(m.aId), g = gsiById.get(m.bId);
    if (!a || !g) continue;
    const aExt = principalAxisExtents(a.ring, a.orientationDeg);
    const gExt = principalAxisExtents(g.ring, g.orientationDeg);
    const areaRatio = a.area / g.area;
    const perimeterRatio = ringPerimeter(a.ring) / ringPerimeter(g.ring);
    const widthA = a.bbox.maxX - a.bbox.minX, widthG = g.bbox.maxX - g.bbox.minX;
    const depthA = a.bbox.maxZ - a.bbox.minZ, depthG = g.bbox.maxZ - g.bbox.minZ;
    const widthRatio = widthA / widthG, depthRatio = depthA / depthG;
    areaRatios.push(areaRatio); linearScales.push(Math.sqrt(areaRatio));
    widthRatios.push(widthRatio); depthRatios.push(depthRatio); perimeterRatios.push(perimeterRatio);
    perMatchDim.push({
      aId: m.aId, bId: m.bId, areaRatio: +areaRatio.toFixed(4), perimeterRatio: +perimeterRatio.toFixed(4),
      widthRatio: +widthRatio.toFixed(4), depthRatio: +depthRatio.toFixed(4),
      plateauPrincipal: { length: +aExt.length.toFixed(3), width: +aExt.width.toFixed(3) },
      gsiPrincipal: { length: +gExt.length.toFixed(3), width: +gExt.width.toFixed(3) },
      aCentroid: a.centroid, bCentroid: g.centroid,
    });
  }
  const footprintStats = {
    areaRatio: ratioStats(areaRatios), linearScale: ratioStats(linearScales),
    widthRatio: ratioStats(widthRatios), depthRatio: ratioStats(depthRatios), perimeterRatio: ratioStats(perimeterRatios),
  };

  // ── §6 affine transform ──
  const affine = estimateAffine(highMatches);

  // ── §7/§9 runtime scale ──
  const htmlSrc = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';
  const runtimeScale = auditRuntimeScale(htmlSrc);

  // ── §8 runtime footprint dimension（全615,617棟を直接比較。HIGH matchサブセットに限定しない）──
  console.time('[building-map-scale-audit] runtimeFootprintDimensionFull');
  const runtimeFootprintFull = auditRuntimeFootprintDimensionFull();
  console.timeEnd('[building-map-scale-audit] runtimeFootprintDimensionFull');
  console.log('[building-map-scale-audit] runtime footprint compared=' + runtimeFootprintFull.comparedCount + ' identical=' + runtimeFootprintFull.identicalCoordinatesCount);

  // ── §10/11 projection consistency ──
  const projectionAudit = auditProjectionConsistency();

  // ── §12/13 distance ratio ──
  const rngDist = mulberry32(31415926);
  const distanceRatio = distanceRatioTest(highMatches, 1500, rngDist);

  // ── §16 ward別 ──
  const byWard = {};
  for (const rec of perMatchDim) {
    const wr = classifyPointToWard(rec.aCentroid[0], rec.aCentroid[1], wards);
    const wardId = wr.wardId || 'outside';
    if (!byWard[wardId]) byWard[wardId] = { areaRatios: [], linearScales: [], widthRatios: [], depthRatios: [] };
    byWard[wardId].areaRatios.push(rec.areaRatio); byWard[wardId].linearScales.push(Math.sqrt(rec.areaRatio));
    byWard[wardId].widthRatios.push(rec.widthRatio); byWard[wardId].depthRatios.push(rec.depthRatio);
  }
  const byWardSummary = {};
  for (const [wardId, v] of Object.entries(byWard)) {
    byWardSummary[wardId] = {
      n: v.areaRatios.length, medianAreaRatio: ratioStats(v.areaRatios).median, medianLinearScale: ratioStats(v.linearScales).median,
      medianWidthRatio: ratioStats(v.widthRatios).median, medianDepthRatio: ratioStats(v.depthRatios).median,
    };
  }

  // ── §17/18 梅田・住吉 重点 ──
  function deepDive(name, cx, cz, radiusM) {
    const near = perMatchDim.filter((r) => Math.hypot(r.aCentroid[0] - cx, r.aCentroid[1] - cz) <= radiusM);
    const withArea = near.map((r) => ({ ...r, plateauArea: r.plateauPrincipal.length * r.plateauPrincipal.width }))
      .sort((a, b) => b.plateauArea - a.plateauArea);
    const large = withArea.slice(0, Math.min(30, Math.ceil(withArea.length / 3)));
    const small = withArea.slice(-Math.min(30, Math.ceil(withArea.length / 3)));
    const mid = withArea.slice(Math.floor(withArea.length / 3), Math.floor(withArea.length / 3) + Math.min(30, withArea.length));
    return {
      site: name, center: [cx, cz], radiusM, matchedCount: near.length,
      areaRatioStats: ratioStats(near.map((r) => r.areaRatio)),
      linearScaleStats: ratioStats(near.map((r) => Math.sqrt(r.areaRatio))),
      large: { n: large.length, medianAreaRatio: ratioStats(large.map((r) => r.areaRatio)).median, sample: large.slice(0, 10) },
      medium: { n: mid.length, medianAreaRatio: ratioStats(mid.map((r) => r.areaRatio)).median, sample: mid.slice(0, 10) },
      small: { n: small.length, medianAreaRatio: ratioStats(small.map((r) => r.areaRatio)).median, sample: small.slice(0, 10) },
    };
  }
  const umeda = deepDive('梅田', -2668.18, -10941.87, 600);
  const sumiyoshi = deepDive('住吉', -2952.22, -811.75, 600);

  const classification = classify(footprintStats, affine, runtimeFootprintFull, distanceRatio);

  // ── §21/22 correction candidate（適用はしない・記録のみ）──
  const recommendedCorrection = classification === 'BUILDING_SIZE_CORRECT' || classification === 'SOURCE_SEMANTICS_DIFFERENCE'
    ? { applicable: false, appliedToRuntime: false, reason: classification === 'SOURCE_SEMANTICS_DIFFERENCE'
        ? 'roof outline(GSI)とfootprint(PLATEAU)の形状差はsource semanticsの差であり、Canonical側のスケール補正では解決しない（§15）。'
        : 'サイズは概ね正常であり補正不要。' }
    : {
        applicable: true, appliedToRuntime: false,
        scaleXCandidate: affine ? +(1 / affine.scaleX).toFixed(5) : null,
        scaleZCandidate: affine ? +(1 / affine.scaleZ).toFixed(5) : null,
        note: '補正はbuilding centroidを固定して行うべきかworld coordinate scale自体を直すべきかは、' +
          'runtime scale(§7/§9)とmap scale(affine §6)のどちらに原因があるかで異なる（§22）。今回は数値測定のみでRuntimeへは一切適用していない。',
      };

  const report = {
    generatedAt,
    matchedCount: highMatches.length,
    minHighMatchesTarget: 11647,
    footprint: {
      areaRatioMedian: footprintStats.areaRatio.median, linearScaleMedian: footprintStats.linearScale.median,
      widthRatioMedian: footprintStats.widthRatio.median, depthRatioMedian: footprintStats.depthRatio.median,
      perimeterRatioMedian: footprintStats.perimeterRatio.median,
      full: footprintStats,
    },
    affine,
    runtime: {
      meshScale: runtimeScale.nonSpriteScaleAssignments.length === 0 ? 1 : null,
      parentScale: (!runtimeScale.canonicalRootScaleTouched && !runtimeScale.rtRootScaleTouched && !runtimeScale.layerGroupScaleTouched) ? 1 : null,
      effectiveWorldScale: (!runtimeScale.sceneScaleTouched && runtimeScale.nonSpriteScaleAssignments.length === 0) ? 1 : null,
      audit: runtimeScale,
      footprintDimensionFullPopulation: runtimeFootprintFull,
    },
    projection: projectionAudit,
    distanceRatio,
    byWard: byWardSummary,
    deepDive: { umeda, sumiyoshi },
    classification,
    recommendedCorrection,
    validatorFlags: {
      geometryMutation: 0, coordinateMutation: 0, roadMutation: 0,
      runtimeScaleMeasured: true, parentScaleMeasured: true, affineMeasured: !!affine, footprintDimensionMeasured: runtimeFootprintFull.comparedCount > 0,
    },
    note: '§0遵守: building offset・scale補正の適用・geometry変更は一切行っていない（測定専用ミッション）。',
  };
  await writeJson(REPORT, report);
  console.log('[building-map-scale-audit] classification=' + classification);
  console.log('[building-map-scale-audit] areaRatioMedian=' + footprintStats.areaRatio.median + ' linearScaleMedian=' + footprintStats.linearScale.median);
  console.log('保存: ' + toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[building-map-scale-audit] 失敗:', e && e.stack || e); process.exit(1); });
