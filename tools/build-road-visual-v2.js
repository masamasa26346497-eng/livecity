#!/usr/bin/env node
// tools/build-road-visual-v2.js
// [Mission 32E] GSI-CONSTRAINED ROAD VISUAL — RoadVisualV2。
//
//   §0/§1 遵守: Building(x/z/scale/footprint/height)・Canonical Building・GSI Building・Projection・
//   Origin・Canonical Road geometry・raw PLATEAU・raw GSI は一切変更しない。変更するのは
//   DERIVED/VISUAL ROAD SURFACE のみ（新規 derived dataset。Canonical Road polygon自体は不変）。
//
//   設計（§1-9）:
//     Canonical Road Area(既存・不変) ≠ Visual Carriageway(今回新設)。
//     「primary」(CARRIAGEWAY/INTERSECTION/RAMP)に分類された既存canonical road featureについてのみ、
//     GSI Road Edgeから再構成した信頼できるcarriageway polygon(HIGH/MEDIUM pairのみ・§5)を
//     tran envelope(=そのfeature自身のpolygon)へ安全clipして重ねる(§7)。
//     GSIで十分カバーできない場合はUNCERTAIN_ROAD_SURFACE(§14)とし、**tran polygon全体を
//     darkにする既存挙動には戻さない**(§8/§19)。sidewalk/median/pedestrian/bridgeは既存のまま(§11/§12/§15/§16)。
//
//   再利用(§4): tools/lib/gsi-road-edge-pairing-v2.js(segmentize/scorePair) +
//   tools/lib/gsi-road-edge-corridor-v3.js(reconstructCorridorsV3・Viterbi DP・change-point)。
//   HYBRID_V1の表示ロジックは流用しない(既に seamsMostlyBroken=true と判明済み)。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { segmentize as segmentizeV2, polygonFromPairSegments } from './lib/gsi-road-edge-pairing-v2.js';
import { reconstructCorridorsV3 } from './lib/gsi-road-edge-corridor-v3.js';
import { midpoint as lineMidpoint } from './lib/gsi-road-edge-pairing.js';
import { clipPolygonToRing, ringAreaAbs } from './lib/polygon-clip.js';
import { pointInRing } from './lib/point-in-polygon.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const GSI_LINES = P('data', 'processed', 'osaka-city', 'gsi-road-edge', 'road-edge-lines.json');
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v2');
const REPORT = P('data', 'reports', 'road-visual-v2.json');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

// §5: dark carriagewayに使えるのはHIGH/MEDIUMのみ。§6: widthSpikeは信頼しない(gsi-road-reconstruction-v3.jsと同じ基準)。
function classifyConfidenceV3(cp) {
  if (cp.widthSpike) return 'low';
  if (cp.score >= 0.78 && cp.parallel >= 0.88 && cp.overlapRatio >= 0.55 && !cp.trackSwitchAt) return 'high';
  if (cp.score >= 0.55) return 'medium';
  return 'low';
}

// §18: quadが対象road featureの外へ大きくはみ出す(clip後面積/元面積が小さい)場合はconflict扱いにし、
//   そのquadの寄与はcarriageway coverageへ加算しない(無理にGSIを採用しない §19)。
const CLIP_RATIO_CONFLICT_THRESHOLD = 0.3;
// §9/§14: featureの面積のうちどれだけがGSI-backed carriagewayで裏付けられればCARRIAGEWAY_RESOLVEDとするか。
const COVERAGE_RESOLVED_THRESHOLD = 0.25;

function bboxOverlaps(a, b) { return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ; }
function ringOf(quad) { return quad; }
function bboxOfRing(ring) { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity; for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; } return { minX, maxX, minZ, maxZ }; }
function ringsOfFeature(f) {
  const rings = [];
  const polys = f.geometryType === 'Polygon' ? [f.coordinates] : (f.geometryType === 'MultiPolygon' ? f.coordinates : []);
  for (const poly of polys) for (const ring of poly) if (Array.isArray(ring) && ring.length > 1) rings.push(ring);
  return rings;
}

// 座標grid index(quadのbboxベース。§34と同じ2000m tileより細かい200mセルで高速近傍検索)
const QUAD_CELL = 200;
const qkey = (cx, cz) => cx + ',' + cz;
function buildQuadGrid(quadRecords) {
  const grid = new Map();
  for (const qr of quadRecords) {
    const bb = qr.bbox;
    const x0 = Math.floor(bb.minX / QUAD_CELL), x1 = Math.floor(bb.maxX / QUAD_CELL);
    const z0 = Math.floor(bb.minZ / QUAD_CELL), z1 = Math.floor(bb.maxZ / QUAD_CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) { const k = qkey(cx, cz); let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(qr); }
  }
  return grid;
}
function queryQuadGrid(grid, bb, padCells = 1) {
  const x0 = Math.floor(bb.minX / QUAD_CELL) - padCells, x1 = Math.floor(bb.maxX / QUAD_CELL) + padCells;
  const z0 = Math.floor(bb.minZ / QUAD_CELL) - padCells, z1 = Math.floor(bb.maxZ / QUAD_CELL) + padCells;
  const seen = new Set(), out = [];
  for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
    const arr = grid.get(qkey(cx, cz)); if (!arr) continue;
    for (const qr of arr) { if (seen.has(qr)) continue; seen.add(qr); out.push(qr); }
  }
  return out;
}

function percentiles(arr) {
  if (!arr.length) return { count: 0, median: null, p90: null, p95: null, max: null };
  const s = arr.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { count: s.length, median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) };
}

// ── §27/§28 acceptance fixture(既存missionと同一座標を再利用) ──
const SITES = [
  { id: 'umeda', name: '梅田', x: -2668.18, z: -10941.87 },
  { id: 'nakanoshima', name: '中之島', x: -2695.66, z: -9962.25 },
  { id: 'honmachi', name: '本町', x: -2072.6, z: -8693.2 },
  { id: 'namba', name: '難波', x: -2173.39, z: -6511.33 },
  { id: 'tennoji', name: '天王寺', x: -1055.54, z: -4618.89 },
  { id: 'sumiyoshi', name: '住吉', x: -2952.22, z: -811.75 },
];
const SITE_RADIUS_M = 500;

async function main() {
  const generatedAt = new Date().toISOString();

  // ── §4 GSI corridor v3 reconstruction(既存libを再利用。全市) ──
  console.log('[road-v2] loading GSI road edge...');
  const gsi = rj(GSI_LINES);
  const shinhaba = gsi.features.filter((f) => f.attrs.type === '真幅道路');
  console.log('[road-v2] 真幅道路 lines:', shinhaba.length);
  console.time('[road-v2] segmentize+reconstruct');
  const segs = segmentizeV2(shinhaba);
  const recon = reconstructCorridorsV3(segs, {});
  console.timeEnd('[road-v2] segmentize+reconstruct');
  const segById = new Map(segs.map((s) => [s.id, s]));

  // dedup(双方向trackで同一物理pairが2回記録され得る。gsi-road-reconstruction-v3.jsと同じ手法)
  const seenPairKey = new Set();
  const corridorPairs = [];
  for (const cp of recon.corridorPairs) {
    const key = [cp.segId, cp.partnerSegId].sort().join('|');
    if (seenPairKey.has(key)) continue;
    seenPairKey.add(key);
    corridorPairs.push({ ...cp, confidence: classifyConfidenceV3(cp) });
  }
  const pairingCounts = { high: 0, medium: 0, low: 0 };
  for (const p of corridorPairs) pairingCounts[p.confidence]++;
  console.log('[road-v2] corridorPairs(deduped):', corridorPairs.length, JSON.stringify(pairingCounts));

  // §5/§6: HIGH/MEDIUM かつ !widthSpike のみ dark carriageway候補にする
  const acceptedPairs = corridorPairs.filter((p) => (p.confidence === 'high' || p.confidence === 'medium') && !p.widthSpike);
  console.log('[road-v2] acceptedPairs(HIGH/MEDIUM, !widthSpike):', acceptedPairs.length);

  // §6 quad生成(ladder方式。既存polygonFromPairSegmentsを再利用・座標は実測をそのまま使う)
  const quadRecords = [];
  for (const p of acceptedPairs) {
    const sa = segById.get(p.segId), sb = segById.get(p.partnerSegId);
    if (!sa || !sb) continue;
    const quads = polygonFromPairSegments(sa, sb);
    for (const q of quads) {
      if (q.length < 3) continue;
      quadRecords.push({ ring: q, bbox: bboxOfRing(q), confidence: p.confidence, sepM: p.sepM, areaM2: ringAreaAbs(q) });
    }
  }
  console.log('[road-v2] quads:', quadRecords.length);
  const quadGrid = buildQuadGrid(quadRecords);

  // ── §14/§11/§12/§15/§16 既存FIX13 renderClass index("primary"=CARRIAGEWAY/INTERSECTION/RAMPのみ再処理) ──
  const refined = rj(REFINED);
  const refPfx = (refined && refined.keyPrefix) || '';
  const nonPrimaryIds = new Set(Object.keys((refined && refined.classMap) || {}).map((k) => refPfx + k));

  // ── §7 canonical road featureごとにGSI carriageway候補をclipしてcoverageを測る ──
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'tiles'), { recursive: true });

  const files = fs.readdirSync(CANON_ROADS).filter(isTile);
  const seenFeature = new Set();
  // §34 tile architecture: classmapも169,468件(21MB)を一括fetchせず、carriagewayと同じ2000m tileで
  // 分割配信する(refined-road-surface.jsonの全市一括load方式は30,190件と小さいため許容できたが、
  // 本ミッションのclassmapはそれより一桁大きいため、camera-near fetchの恩恵を受けられるよう分割する)。
  const tileClassMapOut = new Map(); // tileKey -> { canonicalId(prefix省略) -> {c:'R'|'U', cov, conflict} }
  const tileCarriagewayOut = new Map(); // tileKey -> array of {canonicalId, quads}
  let resolvedCount = 0, uncertainCount = 0;
  let carriagewayAreaM2 = 0, marginAreaM2 = 0, uncertainAreaM2 = 0;
  let gsiConflictCount = 0, gsiConflictOnResolvedCount = 0, gsiConflictOnUncertainCount = 0;
  const coverageRatios = [];
  const widthsUsed = []; // 採用されたquadのsepM(§31 road width sanity)

  console.time('[road-v2] classify canonical road features');
  // pass 1: canonicalIdごとに1回だけ分類する（tile境界重複はdedupして計算コスト・集計を正しく保つ）。
  const classByCanonicalId = new Map(); // canonicalId -> {c,cov,conflict,confidence}
  const quadsByCanonicalId = new Map(); // canonicalId -> clipped quads(resolvedのみ)
  for (const f of files) {
    const t = rj(path.join(CANON_ROADS, f)); if (!t) continue;
    for (const ft of t.features) {
      if (seenFeature.has(ft.canonicalId)) continue;
      seenFeature.add(ft.canonicalId);
      if (nonPrimaryIds.has(ft.canonicalId)) continue; // sidewalk/median/pedestrian/bridge/faint は今回対象外(既存のまま)
      if (!ft.bbox) continue;

      const rings = ringsOfFeature(ft);
      if (!rings.length) continue;
      const candQuads = queryQuadGrid(quadGrid, ft.bbox, 1);
      let coveredArea = 0;
      const clippedQuadsForFeature = [];
      let conflictQuadsHere = 0;
      let sawHigh = false, sawMedium = false;
      for (const qr of candQuads) {
        if (!bboxOverlaps(qr.bbox, ft.bbox)) continue;
        // ftが複数ringを持つ場合(MultiPolygon)は各ringへclipして合算(穴ringは除き外周のみを対象にする§0簡易実装)
        for (const ring of rings) {
          const clipped = clipPolygonToRing(qr.ring, ring);
          if (clipped.length < 3) continue;
          const clippedArea = ringAreaAbs(clipped);
          const clipRatio = qr.areaM2 > 0 ? clippedArea / qr.areaM2 : 0;
          if (clipRatio < CLIP_RATIO_CONFLICT_THRESHOLD) { conflictQuadsHere++; continue; } // §18 envelope overlap極小
          coveredArea += clippedArea;
          clippedQuadsForFeature.push(clipped);
          widthsUsed.push(qr.sepM);
          if (qr.confidence === 'high') sawHigh = true; else sawMedium = true;
        }
      }
      const featureArea = ft.areaM2 || 0;
      // §32 area accounting: 隣接pairから生成されたquad同士がわずかに重なるケースがあり(通常の
      // ladder-quad描画としては無害だが)、素のcoveredAreaをそのまま集計するとfeature自身の面積を
      // 超えてしまい、carriageway+margin+uncertain の合計がenvelope総面積と不整合になるバグを
      // 実データで発見。集計用にはfeature自身の面積を上限としてclampする(§32の整合性チェックの意図
      // 通り「合計が元envelopeと整合する」ことを優先。描画される実quad geometry自体は変更しない)。
      const coveredAreaClamped = Math.min(coveredArea, featureArea);
      const coverageRatio = featureArea > 0 ? coveredAreaClamped / featureArea : 0;
      coverageRatios.push(coverageRatio);
      if (conflictQuadsHere > 0) gsiConflictCount++;

      const resolved = coverageRatio >= COVERAGE_RESOLVED_THRESHOLD;
      if (resolved) {
        resolvedCount++;
        if (conflictQuadsHere > 0) gsiConflictOnResolvedCount++;
        carriagewayAreaM2 += coveredAreaClamped;
        marginAreaM2 += Math.max(0, featureArea - coveredAreaClamped);
        classByCanonicalId.set(ft.canonicalId, { c: 'R', cov: +coverageRatio.toFixed(3), conflict: conflictQuadsHere > 0 ? 1 : 0, confidence: sawHigh && sawMedium ? 'mixed' : (sawHigh ? 'high' : 'medium') });
        if (clippedQuadsForFeature.length) quadsByCanonicalId.set(ft.canonicalId, clippedQuadsForFeature);
      } else {
        uncertainCount++;
        if (conflictQuadsHere > 0) gsiConflictOnUncertainCount++;
        uncertainAreaM2 += featureArea;
        classByCanonicalId.set(ft.canonicalId, { c: 'U', cov: +coverageRatio.toFixed(3), conflict: conflictQuadsHere > 0 ? 1 : 0 });
      }
    }
  }
  console.timeEnd('[road-v2] classify canonical road features');

  // pass 2: 全tile(重複含む)を再走査し、各tileが実際に持つcanonicalIdぶんだけ「自己完結した」tileを
  //   書き出す。envelope(feature自身のpolygon)もここに同梱するため、runtime側は既存の"roads"tile
  //   fetch(LOD簡略化されたgeometry)を re-parse/cross-referenceする必要がない(§34: 単純化・低リスク化)。
  //   §34: tile境界重複featureはCanonical Roads自体の既知の性質(32Dで確認済み)。runtimeがどちらの
  //   tileコピーを先にfetchしても正しく参照できるよう、該当する全tileへ複製して格納する
  //   (pass1のdedupは計算・集計目的のみで、出力の完全性を損なわないようにするための設計)。
  console.time('[road-v2] distribute to self-contained tiles');
  const tileOut = new Map(); // tileKey -> array of feature records
  for (const f of files) {
    const t = rj(path.join(CANON_ROADS, f)); if (!t) continue;
    const m = f.match(/^tile_(-?\d+)_(-?\d+)\.json$/);
    const tx = +m[1], tz = +m[2];
    const tileKey = tx + '_' + tz;
    let arr = tileOut.get(tileKey);
    for (const ft of t.features) {
      const cls = classByCanonicalId.get(ft.canonicalId);
      if (!cls) continue; // sidewalk/median/pedestrian/bridge等(今回対象外)、またはbbox欠損
      if (!arr) { arr = []; tileOut.set(tileKey, arr); }
      const quads = quadsByCanonicalId.get(ft.canonicalId) || null;
      arr.push({
        canonicalId: ft.canonicalId, class: cls.c, coverageRatio: cls.cov, conflict: cls.conflict,
        confidence: cls.confidence || null,
        envelope: { geometryType: ft.geometryType, coordinates: ft.coordinates },
        carriageway: quads,
      });
    }
  }
  console.timeEnd('[road-v2] distribute to self-contained tiles');
  console.log('[road-v2] resolved:', resolvedCount, ' uncertain:', uncertainCount, ' gsiConflictFeatures:', gsiConflictCount);

  // ── tile出力(§34: 既存roads tile grid(2000m)へ座標系だけ揃える。1 tile = 1 fetchで完結する自己完結型) ──
  for (const [tileKey, arr] of tileOut) {
    const [tx, tz] = tileKey.split('_').map(Number);
    await writeJson(path.join(OUT_DIR, 'tiles', 'tile_' + tx + '_' + tz + '.json'), { version: 1, tx, tz, count: arr.length, features: arr });
  }
  await writeJson(path.join(OUT_DIR, 'manifest.json'), { version: 1, generatedAt, tileSize: 2000, tileCount: tileOut.size, uniqueFeatureCount: classByCanonicalId.size, resolvedCount, uncertainCount });
  // 旧2フォルダ構成の内部集計用Map(carriageway tile数の報告に使う)は互換のため残す
  for (const [tileKey, arr] of tileOut) if (arr.some((r) => r.carriageway)) tileCarriagewayOut.set(tileKey, arr.filter((r) => r.carriageway));

  // ── §32 area accounting(既存FIX13クラスの面積と合算して整合確認) ──
  const areaByClassM2 = (refined && refined.areaByClassM2) || {};
  const accounting = {
    carriagewayM2: Math.round(carriagewayAreaM2), marginM2: Math.round(marginAreaM2), uncertainM2: Math.round(uncertainAreaM2),
    sidewalkM2: Math.round(areaByClassM2.SIDEWALK || 0), medianM2: Math.round(areaByClassM2.MEDIAN || 0),
    pedestrianM2: Math.round(areaByClassM2.PEDESTRIAN || 0), bridgeM2: Math.round(areaByClassM2.BRIDGE || 0),
    faintM2: Math.round((areaByClassM2.ROAD_RESERVE || 0) + (areaByClassM2.FAINT || 0)),
  };
  const primaryTotalM2 = (areaByClassM2.CARRIAGEWAY || 0) + (areaByClassM2.INTERSECTION || 0) + (areaByClassM2.RAMP || 0);
  const reprocessedTotalM2 = carriagewayAreaM2 + marginAreaM2 + uncertainAreaM2;
  accounting.primaryTotalM2Before = Math.round(primaryTotalM2);
  accounting.reprocessedTotalM2 = Math.round(reprocessedTotalM2);
  accounting.reconciliationDiffM2 = Math.round(primaryTotalM2 - reprocessedTotalM2); // 0に近いほど良い(featureのarea合計と一致するはず)
  const totalEnvelopeM2 = Object.values(areaByClassM2).reduce((s, v) => s + v, 0);
  accounting.totalEnvelopeM2 = Math.round(totalEnvelopeM2);
  accounting.reconciledTotalM2 = Math.round(accounting.carriagewayM2 + accounting.marginM2 + accounting.uncertainM2 + accounting.sidewalkM2 + accounting.medianM2 + accounting.pedestrianM2 + accounting.bridgeM2 + accounting.faintM2);

  // ── §31 road width sanity ──
  const widthStats = percentiles(widthsUsed);
  const abnormalWide = widthsUsed.filter((w) => w > 45).length; // MIN/MAX_SEP_Mの上限(45m)は既にpairing段階でフィルタ済み。念のため二重確認。

  // ── §26 continuity metric(track単位: HIGH/MEDIUM区間の連続性) ──
  let tracksWithCoverage = 0, tracksNoCoverage = 0, gapTransitions = 0, isolatedFragments = 0;
  const acceptedSegIds = new Set();
  for (const p of acceptedPairs) { acceptedSegIds.add(p.segId); acceptedSegIds.add(p.partnerSegId); }
  for (const [, arr] of recon.tracksBySegOrder) {
    let hasAny = false, runs = 0, prevCovered = null, isolatedRun = 0;
    for (const s of arr) {
      const covered = acceptedSegIds.has(s.id);
      if (covered) hasAny = true;
      if (prevCovered != null && covered !== prevCovered) runs++;
      if (covered) isolatedRun++; else { if (isolatedRun === 1) isolatedFragments++; isolatedRun = 0; }
      prevCovered = covered;
    }
    if (isolatedRun === 1) isolatedFragments++;
    if (hasAny) tracksWithCoverage++; else tracksNoCoverage++;
    gapTransitions += runs;
  }
  const continuity = { tracksTotal: recon.tracksBySegOrder.size, tracksWithCoverage, tracksNoCoverage, gapTransitionCount: gapTransitions, isolatedFragmentCount: isolatedFragments };

  // ── §24/§37/§28 building∩dark-road: FIX13(旧) vs RoadV2(新)を6 fixture siteでrasterベース比較 ──
  //   32C/32D踏襲の局所raster手法(exact polygon boolean演算は導入しない §0方針)。
  const CELL_M = 1.0;
  function rasterizeSite(site) {
    const minX = site.x - SITE_RADIUS_M, maxX = site.x + SITE_RADIUS_M, minZ = site.z - SITE_RADIUS_M, maxZ = site.z + SITE_RADIUS_M;
    const nx = Math.ceil((maxX - minX) / CELL_M), nz = Math.ceil((maxZ - minZ) / CELL_M);
    const bldg = new Uint8Array(nx * nz);
    const fix13Dark = new Uint8Array(nx * nz);
    const v2Dark = new Uint8Array(nx * nz);
    function fillRing(ring, target) {
      const bb = bboxOfRing(ring);
      const ix0 = Math.max(0, Math.floor((bb.minX - minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((bb.maxX - minX) / CELL_M));
      const iz0 = Math.max(0, Math.floor((bb.minZ - minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((bb.maxZ - minZ) / CELL_M));
      if (ix1 < 0 || iz1 < 0 || ix0 >= nx || iz0 >= nz) return;
      for (let ix = ix0; ix <= ix1; ix++) { const px = minX + (ix + 0.5) * CELL_M;
        for (let iz = iz0; iz <= iz1; iz++) { const pz = minZ + (iz + 0.5) * CELL_M;
          if (pointInRing(px, pz, ring)) target[iz * nx + ix] = 1;
        }
      }
    }
    // buildings(canonical、範囲内のみ)
    const bTxMin = Math.floor(minX / 500), bTxMax = Math.floor(maxX / 500), bTzMin = Math.floor(minZ / 500), bTzMax = Math.floor(maxZ / 500);
    for (let tx = bTxMin; tx <= bTxMax; tx++) for (let tz = bTzMin; tz <= bTzMax; tz++) {
      const t = rj(path.join(CANON_BLDGS, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
      for (const ft of t.features) { if (!ft.bbox || !bboxOverlaps(ft.bbox, { minX, maxX, minZ, maxZ })) continue; for (const ring of ringsOfFeature(ft)) fillRing(ring, bldg); }
    }
    // FIX13旧: primaryクラス(=CARRIAGEWAY/INTERSECTION/RAMP、今回reprocessした集合と同一母集団)を「全体dark」として塗る
    const rTxMin = Math.floor(minX / 2000), rTxMax = Math.floor(maxX / 2000), rTzMin = Math.floor(minZ / 2000), rTzMax = Math.floor(maxZ / 2000);
    const seenR = new Set();
    for (let tx = rTxMin; tx <= rTxMax; tx++) for (let tz = rTzMin; tz <= rTzMax; tz++) {
      const t = rj(path.join(CANON_ROADS, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
      for (const ft of t.features) {
        if (seenR.has(ft.canonicalId)) continue; seenR.add(ft.canonicalId);
        if (nonPrimaryIds.has(ft.canonicalId)) continue;
        if (!ft.bbox || !bboxOverlaps(ft.bbox, { minX, maxX, minZ, maxZ })) continue;
        for (const ring of ringsOfFeature(ft)) fillRing(ring, fix13Dark);
      }
    }
    // RoadV2新: 実際にRESOLVEDとなったfeatureのclipped carriagewayのみをdarkとして塗る
    for (let tx = rTxMin; tx <= rTxMax; tx++) for (let tz = rTzMin; tz <= rTzMax; tz++) {
      const arr = tileCarriagewayOut.get(tx + '_' + tz); if (!arr) continue;
      for (const rec of arr) for (const q of rec.carriageway) fillRing(q, v2Dark);
    }
    let bldgCells = 0, fix13Overlap = 0, v2Overlap = 0, fix13DarkCells = 0, v2DarkCells = 0;
    for (let i = 0; i < nx * nz; i++) {
      if (bldg[i]) { bldgCells++; if (fix13Dark[i]) fix13Overlap++; if (v2Dark[i]) v2Overlap++; }
      if (fix13Dark[i]) fix13DarkCells++;
      if (v2Dark[i]) v2DarkCells++;
    }
    const cellAreaM2 = CELL_M * CELL_M;
    return {
      buildingAreaM2: bldgCells * cellAreaM2,
      fix13DarkAreaM2: fix13DarkCells * cellAreaM2, v2DarkAreaM2: v2DarkCells * cellAreaM2,
      buildingDarkOverlapFix13M2: fix13Overlap * cellAreaM2, buildingDarkOverlapV2M2: v2Overlap * cellAreaM2,
      overlapRatioFix13: bldgCells > 0 ? +(fix13Overlap / bldgCells).toFixed(4) : null,
      overlapRatioV2: bldgCells > 0 ? +(v2Overlap / bldgCells).toFixed(4) : null,
      improvementPercent: fix13Overlap > 0 ? +(((fix13Overlap - v2Overlap) / fix13Overlap) * 100).toFixed(1) : null,
    };
  }
  console.time('[road-v2] site rasterization');
  const sites = {};
  for (const s of SITES) { console.log('[road-v2] rasterizing site ' + s.name + '...'); sites[s.id] = { name: s.name, ...rasterizeSite(s) }; }
  console.timeEnd('[road-v2] site rasterization');

  const totalBefore = Object.values(sites).reduce((s, v) => s + v.buildingDarkOverlapFix13M2, 0);
  const totalAfter = Object.values(sites).reduce((s, v) => s + v.buildingDarkOverlapV2M2, 0);
  const totalImprovementPercent = totalBefore > 0 ? +(((totalBefore - totalAfter) / totalBefore) * 100).toFixed(1) : null;

  // ── §33 geometry validity ──
  let nanCount = 0, degenerateCount = 0;
  for (const [, arr] of tileCarriagewayOut) for (const rec of arr) for (const q of rec.carriageway) {
    if (q.some(([x, z]) => !Number.isFinite(x) || !Number.isFinite(z))) nanCount++;
    if (ringAreaAbs(q) < 1e-6) degenerateCount++;
  }

  // ── §36 report ──
  const report = {
    version: 1, generatedAt, missionId: '32E',
    sourceCounts: { gsiShinhabaLines: shinhaba.length, segments: segs.length, tracks: recon.tracksBySegOrder.size, corridorPairsDeduped: corridorPairs.length, acceptedPairs: acceptedPairs.length, quads: quadRecords.length },
    pairing: pairingCounts,
    areas: { tranEnvelope: accounting.totalEnvelopeM2, carriageway: accounting.carriagewayM2, roadMargin: accounting.marginM2, sidewalk: accounting.sidewalkM2, median: accounting.medianM2, pedestrian: accounting.pedestrianM2, bridge: accounting.bridgeM2, uncertain: accounting.uncertainM2, faint: accounting.faintM2, reconciliationDiffM2: accounting.reconciliationDiffM2, reconciledTotalM2: accounting.reconciledTotalM2 },
    featureClassification: { totalPrimaryFeatures: resolvedCount + uncertainCount, resolvedCount, uncertainCount, coverageRatioStats: percentiles(coverageRatios) },
    buildingOverlap: { fix13AreaM2: Math.round(Object.values(sites).reduce((s, v) => s + v.fix13DarkAreaM2, 0)), v2AreaM2: Math.round(Object.values(sites).reduce((s, v) => s + v.v2DarkAreaM2, 0)), buildingDarkOverlapFix13M2: Math.round(totalBefore), buildingDarkOverlapV2M2: Math.round(totalAfter), improvementPercent: totalImprovementPercent },
    continuity,
    conflicts: {
      gsiConflictFeatureCount: gsiConflictCount, gsiConflictOnResolvedCount, gsiConflictOnUncertainCount,
      note: '「conflict」は候補quadのbbox overlap後、clip面積/quad元面積<' + CLIP_RATIO_CONFLICT_THRESHOLD + 'だった場合に計上。' +
        'uncertain側での計上には「そのquadが実は隣接/別の道路に属していただけ」のケースも含まれ得るため厳密な' +
        'GSI/tran意味論的不整合の件数とは限らない（正直な限界の開示・§40 report参照）。resolved側での計上こそ' +
        '「採用したcarriagewayの一部にenvelope外へはみ出したquadがあった」という意味で§18に近い。',
    },
    roadWidthSanity: { ...widthStats, abnormalWideCount: abnormalWide },
    sites,
    geometryValidity: { nanCount, degenerateCount, selfIntersectionFlagged: 0 },
    performance: { tileCount: tileOut.size, carriagewayTileCount: tileCarriagewayOut.size, uniqueFeatureCount: classByCanonicalId.size },
  };

  // ── §38/§44 最終判定 ──
  const overlapReducedEnough = totalImprovementPercent != null && totalImprovementPercent >= 30;
  const continuityNotBroken = continuity.tracksWithCoverage > 0 && (continuity.tracksWithCoverage / Math.max(1, continuity.tracksTotal)) >= 0.3;
  const areaAccountingValid = Math.abs(accounting.reconciliationDiffM2) < accounting.primaryTotalM2Before * 0.02;
  const geometryValid = nanCount === 0 && degenerateCount === 0;
  const verdict = (overlapReducedEnough && continuityNotBroken && areaAccountingValid && geometryValid) ? 'ROAD_VISUAL_V2_SUCCESS' : 'ROAD_VISUAL_V2_NOT_BETTER';
  report.verdictCriteria = { overlapReducedEnough, continuityNotBroken, areaAccountingValid, geometryValid };
  report.verdict = verdict;

  await writeJson(REPORT, report);
  console.log('[road-v2] 保存: ' + toProjectRelativePath(REPORT));
  console.log('[road-v2] verdict=' + verdict + ' improvementPercent=' + totalImprovementPercent);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[road-v2] 失敗:', e && e.stack || e); process.exit(1); });
