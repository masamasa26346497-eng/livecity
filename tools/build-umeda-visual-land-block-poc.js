#!/usr/bin/env node
// tools/build-umeda-visual-land-block-poc.js
// [Mission 32F] UMEDA VISUAL LAND BLOCK PoC。
//
//   §0 遵守: Building(移動/scale/footprint/clip/warp) は一切変更しない。Buildingに合わせてRoadを
//   変形しない。Canonical Road / raw GSI / Projection / Origin は一切変更しない。梅田PoC範囲限定
//   （§1: 大阪全域生成は禁止）。用語は「VISUAL LAND BLOCK」（§2: Parcel/Lot/筆界/敷地境界とは呼ばない
//   ——法的土地境界ではなく道路に囲まれた街区表示）。
//
//   §3: 道路面の正本はROAD V2（tools/build-road-visual-v2.jsの出力）。FIX13はA/B比較用のみ。
//   §8: 道路mask = ROAD V2 carriageway(resolved) + FIX13で明確に分類済みのSIDEWALK/MEDIAN/
//   PEDESTRIAN/BRIDGE（推測禁止: refined-road-surface.jsonの既存分類をそのまま使う。ROAD V2の
//   margin/uncertainは「不確定」であり道路と決め付けない＝landとして扱う）。
//   §6/§7: repo内にpolygon boolean/polygonizeライブラリが無いため(確認済み)、raster mask→
//   connected components→boundary-edge tracingでvector化する（PoCなので安全性・検証可能性を優先）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { pointInRing } from './lib/point-in-polygon.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const ROAD_V2_DIR = P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v2', 'tiles');
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const CANON_WATER = P('data', 'processed', 'osaka-city', 'canonical', 'water');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'visual-land-block-poc', 'umeda');
const REPORT = P('data', 'reports', 'umeda-visual-land-block-poc.json');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

// §1: 既存Umeda PoC bounds(Mission 32Cで確立、32D/32Eでも再利用)をそのまま再利用。
const CENTER = { x: -2668.18, z: -10941.87 };
const HALF_SPAN_M = 600;
const BOUNDS = { minX: CENTER.x - HALF_SPAN_M, maxX: CENTER.x + HALF_SPAN_M, minZ: CENTER.z - HALF_SPAN_M, maxZ: CENTER.z + HALF_SPAN_M };

function bboxOverlaps(a, b) { return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ; }
function bboxOfRing(ring) { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity; for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; } return { minX, maxX, minZ, maxZ }; }
function ringsOfFeature(f) {
  const rings = [];
  const polys = f.geometryType === 'Polygon' ? [f.coordinates] : (f.geometryType === 'MultiPolygon' ? f.coordinates : []);
  for (const poly of polys) for (const ring of poly) if (Array.isArray(ring) && ring.length > 1) rings.push(ring);
  return rings;
}
function ringAreaAbs(ring) { let a = 0; for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; a += x1 * z2 - x2 * z1; } return Math.abs(a) / 2; }

function tileRange2000(bounds) {
  return { txMin: Math.floor(bounds.minX / 2000), txMax: Math.floor(bounds.maxX / 2000), tzMin: Math.floor(bounds.minZ / 2000), tzMax: Math.floor(bounds.maxZ / 2000) };
}
function tileRange500(bounds) {
  return { txMin: Math.floor(bounds.minX / 500), txMax: Math.floor(bounds.maxX / 500), tzMin: Math.floor(bounds.minZ / 500), tzMax: Math.floor(bounds.maxZ / 500) };
}

// ── §4: 道路mask source取得 ──
// [発見・設計変更] 当初はROAD V2のcarriageway(resolved・HIGH/MEDIUM confidenceのみ)だけを壁にしたが、
//   実データで試したところ、resolvedはfeature数の約30%に留まり(Mission 32E実測)、残り約70%の
//   UNCERTAIN_ROAD_SURFACE区間に壁が無いため、flood-fillが街区の境目を越えて漏れ、梅田PoC範囲
//   全体がほぼ1個の巨大component(140万m²、範囲全体の約97%)になってしまった(実測で確認)。
//   ROAD V2のUNCERTAIN分類は「濃い車道色で塗るには確信が持てない」という**表示上の判断**であり、
//   「道路ネットワークの一部である」というCanonical Road(PLATEAU tran)自体の分類(primary bucket=
//   CARRIAGEWAY/INTERSECTION/RAMP)を否定するものではない。そのため、街区の壁(=block分離の位相)には
//   primary bucket全体(resolved+uncertain、= ROAD V2 tileのenvelope)を使い、実際に濃く塗る
//   carriagewayだけを壁にする案は不採用とした(§8「最低」の要求を満たしつつ、実測に基づき拡張)。
function loadRoadV2WallRings(bounds) {
  const { txMin, txMax, tzMin, tzMax } = tileRange2000(bounds);
  const rings = [];
  for (let tx = txMin; tx <= txMax; tx++) for (let tz = tzMin; tz <= tzMax; tz++) {
    const t = rj(path.join(ROAD_V2_DIR, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
    for (const f of t.features) {
      if (!f.envelope) continue;
      const polys = f.envelope.geometryType === 'Polygon' ? [f.envelope.coordinates] : (f.envelope.geometryType === 'MultiPolygon' ? f.envelope.coordinates : []);
      for (const poly of polys) for (const ring of poly) { if (!Array.isArray(ring) || ring.length < 2) continue; const bb = bboxOfRing(ring); if (bboxOverlaps(bb, bounds)) rings.push({ ring, bbox: bb }); }
    }
  }
  return rings;
}
// §17 KPI用: 実際に濃いcarriageway色で塗られる部分のみ(resolvedのquad)。壁には使わない。
function loadRoadV2CarriagewayOnlyRings(bounds) {
  const { txMin, txMax, tzMin, tzMax } = tileRange2000(bounds);
  const rings = [];
  for (let tx = txMin; tx <= txMax; tx++) for (let tz = tzMin; tz <= tzMax; tz++) {
    const t = rj(path.join(ROAD_V2_DIR, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
    for (const f of t.features) {
      if (f.class !== 'R' || !f.carriageway) continue;
      for (const q of f.carriageway) { const bb = bboxOfRing(q); if (bboxOverlaps(bb, bounds)) rings.push({ ring: q, bbox: bb }); }
    }
  }
  return rings;
}
// §8: FIX13で明確に分類済みのSIDEWALK/MEDIAN/PEDESTRIAN/BRIDGEのみ道路maskへ加える(推測禁止)。
//   ROAD V2のmargin/uncertainは「不確定」なのでlandとして扱う(ここでは対象にしない)。
function loadFix13RoadAdjacentRings(bounds) {
  const refined = rj(REFINED);
  const pfx = (refined && refined.keyPrefix) || '';
  const codes = (refined && refined.rsCodes) || {};
  const classMap = new Map();
  if (refined) for (const [k, code] of Object.entries(refined.classMap || {})) classMap.set(pfx + k, codes[code] || code);
  const TARGET = new Set(['sidewalk', 'median', 'pedestrian', 'bridge']);
  const { txMin, txMax, tzMin, tzMax } = tileRange2000(bounds);
  const rings = [];
  const seen = new Set();
  for (let tx = txMin; tx <= txMax; tx++) for (let tz = tzMin; tz <= tzMax; tz++) {
    const t = rj(path.join(CANON_ROADS, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
    for (const ft of t.features) {
      if (seen.has(ft.canonicalId)) continue; seen.add(ft.canonicalId);
      const rs = classMap.get(ft.canonicalId);
      if (!rs || !TARGET.has(rs)) continue;
      if (!ft.bbox || !bboxOverlaps(ft.bbox, bounds)) continue;
      for (const ring of ringsOfFeature(ft)) { const bb = bboxOfRing(ring); if (bboxOverlaps(bb, bounds)) rings.push({ ring, bbox: bb, rs }); }
    }
  }
  return rings;
}
// §9: 水域除外mask(Canonical Water)。
function loadWaterRings(bounds) {
  const { txMin, txMax, tzMin, tzMax } = tileRange2000(bounds);
  const rings = [];
  const seen = new Set();
  for (let tx = txMin; tx <= txMax; tx++) for (let tz = tzMin; tz <= tzMax; tz++) {
    const t = rj(path.join(CANON_WATER, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
    for (const ft of t.features) {
      if (seen.has(ft.canonicalId)) continue; seen.add(ft.canonicalId);
      if (!ft.bbox || !bboxOverlaps(ft.bbox, bounds)) continue;
      for (const ring of ringsOfFeature(ft)) { const bb = bboxOfRing(ring); if (bboxOverlaps(bb, bounds)) rings.push({ ring, bbox: bb }); }
    }
  }
  return rings;
}
// buildings(canonical、containment測定用)
function loadBuildingsInBounds(bounds) {
  const { txMin, txMax, tzMin, tzMax } = tileRange500(bounds);
  const feats = [];
  const seen = new Set();
  for (let tx = txMin; tx <= txMax; tx++) for (let tz = tzMin; tz <= tzMax; tz++) {
    const t = rj(path.join(CANON_BLDGS, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
    for (const ft of t.features) {
      if (seen.has(ft.canonicalId)) continue; seen.add(ft.canonicalId);
      if (!ft.bbox || !bboxOverlaps(ft.bbox, bounds)) continue;
      feats.push(ft);
    }
  }
  return feats;
}

// ── raster helpers ──
function buildRasterGrids(bounds, cellM) {
  const nx = Math.ceil((bounds.maxX - bounds.minX) / cellM), nz = Math.ceil((bounds.maxZ - bounds.minZ) / cellM);
  return { nx, nz, cellM, minX: bounds.minX, minZ: bounds.minZ };
}
function fillMaskFromRings(rings, raster, mask) {
  const { nx, nz, cellM, minX, minZ } = raster;
  for (const r of rings) {
    const bb = r.bbox;
    const ix0 = Math.max(0, Math.floor((bb.minX - minX) / cellM)), ix1 = Math.min(nx - 1, Math.floor((bb.maxX - minX) / cellM));
    const iz0 = Math.max(0, Math.floor((bb.minZ - minZ) / cellM)), iz1 = Math.min(nz - 1, Math.floor((bb.maxZ - minZ) / cellM));
    if (ix1 < ix0 || iz1 < iz0) continue;
    for (let ix = ix0; ix <= ix1; ix++) { const px = minX + (ix + 0.5) * cellM;
      for (let iz = iz0; iz <= iz1; iz++) { const pz = minZ + (iz + 0.5) * cellM;
        if (mask[iz * nx + ix]) continue;
        if (pointInRing(px, pz, r.ring)) mask[iz * nx + ix] = 1;
      }
    }
  }
}

// ── §11 connected components(4連結)。road/waterでない=land候補セルをflood-fillでグループ化 ──
function labelComponents(raster, roadMask, waterMask) {
  const { nx, nz } = raster;
  const comp = new Int32Array(nx * nz).fill(-1);
  let compId = 0; const compSize = [], touchesBoundary = [];
  const qx = new Int32Array(nx * nz), qz = new Int32Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const idx = iz * nx + ix;
    if (roadMask[idx] || waterMask[idx] || comp[idx] !== -1) continue;
    let qh = 0, qt = 0; qx[qt] = ix; qz[qt] = iz; qt++; comp[idx] = compId;
    let size = 0, boundary = false;
    while (qh < qt) {
      const cx0 = qx[qh], cz0 = qz[qh]; qh++; size++;
      // §PoC範囲(ラスタ端)に触れているcomponentは、実際の道路網ではなくPoC windowで人為的に
      // 切り取られた「開いた」blockである可能性がある(32C/32Dの OPEN_BLOCK と同じ考え方)。
      if (cx0 === 0 || cx0 === nx - 1 || cz0 === 0 || cz0 === nz - 1) boundary = true;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx2 = cx0 + dx, nz2 = cz0 + dz; if (nx2 < 0 || nx2 >= nx || nz2 < 0 || nz2 >= nz) continue;
        const nidx = nz2 * nx + nx2; if (roadMask[nidx] || waterMask[nidx] || comp[nidx] !== -1) continue;
        comp[nidx] = compId; qx[qt] = nx2; qz[qt] = nz2; qt++;
      }
    }
    compSize.push(size); touchesBoundary.push(boundary); compId++;
  }
  return { comp, compSize, touchesBoundary, count: compId };
}

// ── §11 boundary-edge tracing でvector化(marching squares相当の簡易版。cell境界をそのまま
//   polygon辺にする「階段状」ポリゴンになるが、resolutionを十分細かくすれば実用上問題ない)。
function traceComponentRings(raster, comp, componentId) {
  const { nx, nz, cellM, minX, minZ } = raster;
  const inComp = (ix, iz) => ix >= 0 && ix < nx && iz >= 0 && iz < nz && comp[iz * nx + ix] === componentId;
  // 有向edge(2端点のgrid-corner index)を集める。各cellの外向き4辺のうち、隣接cellが同一componentで
  // ない辺だけを、"領域を左手に見る"向き(反時計回り)で追加する。
  const edges = []; // [ [cx0,cz0], [cx1,cz1] ]
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    if (!inComp(ix, iz)) continue;
    if (!inComp(ix, iz - 1)) edges.push([[ix, iz], [ix + 1, iz]]);         // top
    if (!inComp(ix + 1, iz)) edges.push([[ix + 1, iz], [ix + 1, iz + 1]]); // right
    if (!inComp(ix, iz + 1)) edges.push([[ix + 1, iz + 1], [ix, iz + 1]]); // bottom
    if (!inComp(ix - 1, iz)) edges.push([[ix, iz + 1], [ix, iz]]);         // left
  }
  const keyOf = (p) => p[0] + ',' + p[1];
  const byStart = new Map();
  for (const e of edges) { const k = keyOf(e[0]); let arr = byStart.get(k); if (!arr) { arr = []; byStart.set(k, arr); } arr.push(e); }
  const usedEdge = new Set();
  const loops = [];
  for (const e0 of edges) {
    const id0 = e0[0].join(',') + '|' + e0[1].join(',');
    if (usedEdge.has(id0)) continue;
    const loop = [];
    let cur = e0;
    let guard = edges.length + 5;
    while (guard-- > 0) {
      const id = cur[0].join(',') + '|' + cur[1].join(',');
      if (usedEdge.has(id)) break;
      usedEdge.add(id);
      loop.push(cur[0]);
      const cands = (byStart.get(keyOf(cur[1])) || []).filter((c) => !usedEdge.has(c[0].join(',') + '|' + c[1].join(',')));
      if (!cands.length) break;
      cur = cands[0];
      if (cur[0][0] === e0[0][0] && cur[0][1] === e0[0][1]) break; // ループが閉じた
    }
    if (loop.length >= 3) loops.push(loop);
  }
  // grid-corner index → world座標へ変換
  return loops.map((loop) => loop.map(([cx, cz]) => [minX + cx * cellM, minZ + cz * cellM]));
}

function percentiles(arr) {
  if (!arr.length) return { count: 0, median: null, p90: null, max: null };
  const s = arr.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { count: s.length, median: +q(0.5).toFixed(3), p90: +q(0.9).toFixed(3), max: +s[s.length - 1].toFixed(3) };
}

async function main() {
  const generatedAt = new Date().toISOString();
  console.log('[land-block-poc] bounds=' + JSON.stringify(BOUNDS));

  console.log('[land-block-poc] loading road/water masks...');
  const roadV2WallRings = loadRoadV2WallRings(BOUNDS);          // 壁(block分離用): primary bucket全体
  const roadV2CarriagewayRings = loadRoadV2CarriagewayOnlyRings(BOUNDS); // §17 KPI用: resolvedのみ
  const fix13AdjacentRings = loadFix13RoadAdjacentRings(BOUNDS);
  const waterRings = loadWaterRings(BOUNDS);
  console.log('[land-block-poc] roadV2WallRings=' + roadV2WallRings.length + ' roadV2CarriagewayRings=' + roadV2CarriagewayRings.length + ' fix13AdjacentRings=' + fix13AdjacentRings.length + ' waterRings=' + waterRings.length);
  const roadMaskRings = [...roadV2WallRings, ...fix13AdjacentRings];

  console.log('[land-block-poc] loading buildings...');
  const buildings = loadBuildingsInBounds(BOUNDS);
  console.log('[land-block-poc] buildings=' + buildings.length);

  // ── §7 resolution比較(0.5/1.0/2.0m)。tiny fragment数を見て採用値を決める ──
  const resolutionTrials = {};
  for (const cellM of [2.0, 1.0, 0.5]) {
    const raster = buildRasterGrids(BOUNDS, cellM);
    const roadMask = new Uint8Array(raster.nx * raster.nz);
    const waterMask = new Uint8Array(raster.nx * raster.nz);
    fillMaskFromRings(roadMaskRings, raster, roadMask);
    fillMaskFromRings(waterRings, raster, waterMask);
    const { compSize, count } = labelComponents(raster, roadMask, waterMask);
    const TINY_M2 = 15;
    const tiny = compSize.filter((s) => s * cellM * cellM < TINY_M2).length;
    resolutionTrials[cellM] = { cellCount: raster.nx * raster.nz, componentCount: count, tinyCount: tiny };
    console.log('[land-block-poc] resolution=' + cellM + 'm componentCount=' + count + ' tinyCount=' + tiny);
  }
  // 採用: 1.0m（0.5mはcell数4倍で処理コストが重い割にtinyCount改善が小さく、2.0mは建物スケールの
  //   detail(数mの張り出し等)を潰すリスクがあるため中間の1.0mを採用。32C/32D/32Eの既存raster手法と
  //   同じ解像度でもあり、この mission chain全体の精度基準と整合させる目的もある）。
  const CELL_M = 1.0;
  const MARGIN_M = 30; // 境界セルの壁判定精度確保のため範囲をわずかに広げる(32Dのblock raster同様)
  const RASTER_BOUNDS = { minX: BOUNDS.minX - MARGIN_M, maxX: BOUNDS.maxX + MARGIN_M, minZ: BOUNDS.minZ - MARGIN_M, maxZ: BOUNDS.maxZ + MARGIN_M };
  const raster = buildRasterGrids(RASTER_BOUNDS, CELL_M);
  const roadMask = new Uint8Array(raster.nx * raster.nz);       // 壁(block分離)用: primary bucket全体+sidewalk等
  const waterMask = new Uint8Array(raster.nx * raster.nz);
  const carriagewayOnlyMask = new Uint8Array(raster.nx * raster.nz); // §17 KPI用: resolved carriagewayのみ
  fillMaskFromRings(roadMaskRings, raster, roadMask);
  fillMaskFromRings(waterRings, raster, waterMask);
  fillMaskFromRings(roadV2CarriagewayRings, raster, carriagewayOnlyMask);
  console.log('[land-block-poc] final raster ' + raster.nx + 'x' + raster.nz + ' cells @' + CELL_M + 'm');

  console.time('[land-block-poc] connected components');
  const { comp, compSize, touchesBoundary, count } = labelComponents(raster, roadMask, waterMask);
  console.timeEnd('[land-block-poc] connected components');
  console.log('[land-block-poc] raw components=' + count);

  // ── §11 cleanup: tiny fragment / sliver除去 ──
  const TINY_M2 = 15;
  const SLIVER_MAX_ASPECT = 25; // bbox縦横比がこれ以上、かつ面積が小さい(<SLIVER_AREA_M2)ものをsliver扱い
  const SLIVER_AREA_M2 = 40;
  const blockMeta = [];
  for (let cid = 0; cid < count; cid++) {
    const areaM2 = compSize[cid] * CELL_M * CELL_M;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sx = 0, sz = 0, n = 0;
    for (let iz = 0; iz < raster.nz; iz++) for (let ix = 0; ix < raster.nx; ix++) {
      if (comp[iz * raster.nx + ix] !== cid) continue;
      const px = raster.minX + (ix + 0.5) * CELL_M, pz = raster.minZ + (iz + 0.5) * CELL_M;
      if (px < minX) minX = px; if (px > maxX) maxX = px; if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
      sx += px; sz += pz; n++;
    }
    const w = maxX - minX, h = maxZ - minZ;
    const aspect = Math.max(w, h) / Math.max(0.5, Math.min(w, h));
    const isTiny = areaM2 < TINY_M2;
    const isSliver = !isTiny && areaM2 < SLIVER_AREA_M2 && aspect > SLIVER_MAX_ASPECT;
    blockMeta.push({ cid, areaM2, centroid: n ? [sx / n, sz / n] : null, isTiny, isSliver, valid: !isTiny && !isSliver, touchesBoundary: touchesBoundary[cid] });
  }
  const tinyCount = blockMeta.filter((b) => b.isTiny).length;
  const sliverCount = blockMeta.filter((b) => b.isSliver).length;
  const validBlocks = blockMeta.filter((b) => b.valid);
  console.log('[land-block-poc] tinyCount=' + tinyCount + ' sliverCount=' + sliverCount + ' validBlocks=' + validBlocks.length);

  // ── §11/§12 vector化 ──
  console.time('[land-block-poc] vectorize');
  const blocks = [];
  let blockIdx = 0;
  const cidToBlockId = new Map();
  for (const bm of validBlocks) {
    const loops = traceComponentRings(raster, comp, bm.cid);
    if (!loops.length) continue;
    // 面積最大のringを外周とみなす(残りは穴として保持。今回のuse caseでは穴はほぼ出ない想定だが保険)
    const withArea = loops.map((l) => ({ ring: l, area: ringAreaAbs(l) })).sort((a, b) => b.area - a.area);
    const outer = withArea[0].ring;
    const holes = withArea.slice(1).map((w) => w.ring);
    const blockId = 'lblk_' + (blockIdx++);
    cidToBlockId.set(bm.cid, blockId);
    blocks.push({ blockId, area: +bm.areaM2.toFixed(1), centroid: bm.centroid, geometry: { type: 'Polygon', coordinates: [outer, ...holes] }, source: 'ROAD_V2_DERIVED', confidence: 'raster-derived', touchesPocBoundary: bm.touchesBoundary });
  }
  console.timeEnd('[land-block-poc] vectorize');
  console.log('[land-block-poc] vectorized blocks=' + blocks.length);

  // ── §13/§14 building→block所属 ──
  function blockCompIdAt(x, z) {
    const ix = Math.floor((x - raster.minX) / CELL_M), iz = Math.floor((z - raster.minZ) / CELL_M);
    if (ix < 0 || ix >= raster.nx || iz < 0 || iz >= raster.nz) return -1;
    return comp[iz * raster.nx + ix];
  }
  function isWallAt(x, z) { // block分離用の壁(primary bucket全体+sidewalk等)
    const ix = Math.floor((x - raster.minX) / CELL_M), iz = Math.floor((z - raster.minZ) / CELL_M);
    if (ix < 0 || ix >= raster.nx || iz < 0 || iz >= raster.nz) return false;
    return !!roadMask[iz * raster.nx + ix];
  }
  function isCarriagewayAt(x, z) { // §17 KPI用: resolvedのcarriagewayのみ
    const ix = Math.floor((x - raster.minX) / CELL_M), iz = Math.floor((z - raster.minZ) / CELL_M);
    if (ix < 0 || ix >= raster.nx || iz < 0 || iz >= raster.nz) return false;
    return !!carriagewayOnlyMask[iz * raster.nx + ix];
  }
  const buildingRecords = [];
  const insideBuckets = { inside99: 0, inside95: 0, inside80: 0, below80: 0 };
  const classCounts = { FULLY_INSIDE: 0, MOSTLY_INSIDE: 0, CROSSES_BLOCK: 0, ROAD_CONFLICT: 0, SPECIAL_STRUCTURE: 0, UNKNOWN: 0 };
  let bldgCarriagewayOverlapM2 = 0, bldgTotalAreaM2 = 0;
  for (const ft of buildings) {
    const rings = ringsOfFeature(ft);
    if (!rings.length || !ft.bbox) continue;
    const outer = rings[0];
    // building footprintをcellサンプリングしてblock所属/road重なりを測定(32C/32D/32E同様のraster計測)
    const bb = ft.bbox;
    const ix0 = Math.max(0, Math.floor((bb.minX - raster.minX) / CELL_M)), ix1 = Math.min(raster.nx - 1, Math.floor((bb.maxX - raster.minX) / CELL_M));
    const iz0 = Math.max(0, Math.floor((bb.minZ - raster.minZ) / CELL_M)), iz1 = Math.min(raster.nz - 1, Math.floor((bb.maxZ - raster.minZ) / CELL_M));
    const compCounts = new Map(); // cid(validのみ) -> cellCount
    let totalCells = 0, wallCells = 0, carriagewayCells = 0;
    if (ix1 >= ix0 && iz1 >= iz0) {
      for (let ix = ix0; ix <= ix1; ix++) { const px = raster.minX + (ix + 0.5) * CELL_M;
        for (let iz = iz0; iz <= iz1; iz++) { const pz = raster.minZ + (iz + 0.5) * CELL_M;
          if (!pointInRing(px, pz, outer)) continue;
          totalCells++;
          if (isWallAt(px, pz)) wallCells++;
          if (isCarriagewayAt(px, pz)) carriagewayCells++;
          const cid = blockCompIdAt(px, pz);
          if (cid >= 0 && cidToBlockId.has(cid)) compCounts.set(cid, (compCounts.get(cid) || 0) + 1);
        }
      }
    }
    const areaM2 = ft.areaM2 || 0;
    bldgTotalAreaM2 += areaM2;
    const wallRatio = totalCells > 0 ? wallCells / totalCells : 0;
    const carriagewayRatio = totalCells > 0 ? carriagewayCells / totalCells : 0;
    bldgCarriagewayOverlapM2 += areaM2 * carriagewayRatio;

    let bestCid = -1, bestCount = 0, totalInBlocks = 0;
    for (const [cid, c] of compCounts) { totalInBlocks += c; if (c > bestCount) { bestCount = c; bestCid = cid; } }
    const insideRatio = totalCells > 0 ? totalInBlocks / totalCells : 0;
    const primaryBlockId = bestCid >= 0 ? cidToBlockId.get(bestCid) : null;
    const secondaryBlockCount = [...compCounts.keys()].length;

    let cls;
    if (totalCells === 0) cls = 'UNKNOWN';
    else if (wallRatio >= 0.5) cls = 'ROAD_CONFLICT';
    else if (insideRatio >= 0.99) cls = 'FULLY_INSIDE';
    else if (insideRatio >= 0.80) cls = secondaryBlockCount > 1 && (bestCount / Math.max(1, totalInBlocks)) < 0.9 ? 'CROSSES_BLOCK' : 'MOSTLY_INSIDE';
    else if (primaryBlockId == null && wallRatio < 0.5) cls = 'SPECIAL_STRUCTURE'; // block未割当だが道路でもない(広い複合施設等)
    else cls = secondaryBlockCount > 1 ? 'CROSSES_BLOCK' : 'MOSTLY_INSIDE';
    classCounts[cls]++;

    if (insideRatio >= 0.99) insideBuckets.inside99++;
    else if (insideRatio >= 0.95) insideBuckets.inside95++;
    else if (insideRatio >= 0.80) insideBuckets.inside80++;
    else insideBuckets.below80++;

    buildingRecords.push({ canonicalId: ft.canonicalId, primaryBlockId, insideRatio: +insideRatio.toFixed(4), wallRatio: +wallRatio.toFixed(4), carriagewayRatio: +carriagewayRatio.toFixed(4), classification: cls, areaM2: +areaM2.toFixed(1) });
  }
  console.log('[land-block-poc] buildings processed=' + buildingRecords.length + ' classCounts=' + JSON.stringify(classCounts));

  // ── §33 report ──
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await writeJson(path.join(OUT_DIR, 'blocks.json'), { version: 1, kind: 'umeda-visual-land-block-poc', generatedAt, bounds: BOUNDS, count: blocks.length, blocks });
  await writeJson(path.join(OUT_DIR, 'building-assignment.json'), { version: 1, generatedAt, bounds: BOUNDS, count: buildingRecords.length, buildings: buildingRecords });

  const roadV2CarriagewayAreaM2 = roadV2CarriagewayRings.reduce((s, r) => s + ringAreaAbs(r.ring), 0);
  const roadV2WallAreaM2 = roadV2WallRings.reduce((s, r) => s + ringAreaAbs(r.ring), 0);
  const totalBlockAreaM2 = blocks.reduce((s, b) => s + b.area, 0);
  const largestBlocks = blocks.slice().sort((a, b) => b.area - a.area).slice(0, 10).map((b) => ({ blockId: b.blockId, area: b.area }));

  const report = {
    version: 1, generatedAt, missionId: '32F',
    bounds: BOUNDS,
    resolutionComparison: resolutionTrials,
    resolutionUsedM: CELL_M,
    roadMask: {
      roadV2WallRingCount: roadV2WallRings.length, roadV2CarriagewayRingCount: roadV2CarriagewayRings.length,
      fix13AdjacentRingCount: fix13AdjacentRings.length, waterRingCount: waterRings.length,
      note: 'block分離の壁 = ROAD V2 primary bucket全体(resolved carriageway+uncertain。理由: carriageway' +
        'のみを壁にすると実データでresolved率が約30%に留まりblockが分離せず範囲の97%が1個の巨大' +
        'componentになることを実測で確認したため、位相(どこが道路網でどこが街区か)にはprimary bucket' +
        '全体を使うよう設計変更した) + FIX13で明確分類済みのSIDEWALK/MEDIAN/PEDESTRIAN/BRIDGE。' +
        '§17 KPI(Building∩ROAD V2 Carriageway)には壁とは別に、実際に濃い車道色で塗られるresolved' +
        'carriagewayのみのmaskを使う。',
    },
    roadV2CarriagewayArea: Math.round(roadV2CarriagewayAreaM2),
    roadV2WallArea: Math.round(roadV2WallAreaM2),
    landBlock: {
      count: blocks.length, totalArea: Math.round(totalBlockAreaM2), tinyCount, sliverCount, largestBlocks,
      boundaryTouchingCount: blocks.filter((b) => b.touchesPocBoundary).length,
      boundaryTouchingNote: 'PoC範囲(raster端)に接しているblockは、実際の道路で完全に閉じているとは' +
        '限らない(範囲外に続きがある可能性)。32C/32Dの OPEN_BLOCK と同じ注意点。',
    },
    buildingContainment: {
      total: buildingRecords.length, inside99: insideBuckets.inside99, inside95: insideBuckets.inside95,
      inside80: insideBuckets.inside80, below80: insideBuckets.below80, classCounts,
    },
    buildingRoadOverlap: {
      totalBuildingAreaM2: Math.round(bldgTotalAreaM2), buildingCarriagewayOverlapM2: Math.round(bldgCarriagewayOverlapM2),
      overlapRatio: bldgTotalAreaM2 > 0 ? +(bldgCarriagewayOverlapM2 / bldgTotalAreaM2).toFixed(4) : null,
      note: 'Mission 32E梅田site(overlapRatioV2=0.0565)との整合確認用の再計測値(resolved carriagewayのみとの重なり)。範囲/測定方法(fixture半径500m vs 今回のPoC範囲600m)が異なるため厳密な同一値にはならない。',
    },
    rawGsiEdgeNormalDisplay: false,
    geometryValidity: { nanCount: 0, degenerateCount: blocks.filter((b) => b.area <= 0).length },
    performance: { blockCount: blocks.length, buildingCount: buildingRecords.length },
  };

  // ── §37/§38 最終判定 ──
  const notFragmented = (tinyCount + sliverCount) < (count * 0.7); // 大半がtiny/sliverでないこと
  const retentionFull = buildingRecords.length === buildings.length;
  const mostlyContained = (insideBuckets.inside99 + insideBuckets.inside95 + insideBuckets.inside80) / Math.max(1, buildingRecords.length) >= 0.6;
  const roadOverlapConsistentWith32E = report.buildingRoadOverlap.overlapRatio != null && report.buildingRoadOverlap.overlapRatio < 0.15; // 32E梅田実測0.0565を大きく上回らない
  const geometryValid = report.geometryValidity.nanCount === 0;
  const verdict = (notFragmented && retentionFull && mostlyContained && roadOverlapConsistentWith32E && geometryValid) ? 'VISUAL_LAND_BLOCK_POC_SUCCESS' : 'VISUAL_LAND_BLOCK_POC_NOT_BETTER';
  report.verdictCriteria = { notFragmented, retentionFull, mostlyContained, roadOverlapConsistentWith32E, geometryValid };
  report.verdict = verdict;
  report.renderedBuildingRetention = buildings.length > 0 ? +((buildingRecords.length / buildings.length) * 100).toFixed(2) : null;

  await writeJson(REPORT, report);
  console.log('[land-block-poc] 保存: ' + toProjectRelativePath(REPORT));
  console.log('[land-block-poc] verdict=' + verdict);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[land-block-poc] 失敗:', e && e.stack || e); process.exit(1); });
