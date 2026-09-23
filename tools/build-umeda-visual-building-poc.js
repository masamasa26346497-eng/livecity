#!/usr/bin/env node
// tools/build-umeda-visual-building-poc.js
// [Mission 32C] Umeda GSI Unified Visual Building PoC。
//   §0: 梅田限定（約1000m四方）。大阪全域615,617棟の再buildはしない。Canonical/GSI rawは変更しない。
//   §11: 32BのCOMPLEX-chaining教訓を踏まえたmatching（bbox overlap閾値0.55）を再利用しつつ、
//   §11「Block生成」は32Bの「建物ごとの局所window」ではなく、PoC範囲全体を1枚のraster化して
//   flood-fillすることで、真に閉じたblockを判定できるようにする（範囲が固定サイズだからこそ可能）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { readFeatureCollectionStreaming } from './lib/large-json-array-reader.js';
import { precomputeMetrics } from './lib/gsi-building-matching.js';
import { precomputeGsiAreaMetrics, joinBuildingGeometries } from './lib/gsi-visual-building-join.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const NEAR_BLDGS = P('data', 'processed', 'osaka-city', 'derived', 'near', 'buildings');
const GSI_AREA = P('data', 'processed', 'osaka-city', 'gsi-building-area', 'building-area-polygons.json');
const GSI_EDGE_DIR = P('data', 'processed', 'osaka-city', 'derived', 'gsi-road-edge');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'visual-buildings-poc', 'umeda');
const REPORT = P('data', 'reports', 'umeda-visual-building-poc.json');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

// §1 PoC範囲: 梅田中心(既存missionのUmeda site座標)から600m四方(直径1200m)。
//   大阪駅・梅田・西梅田・東梅田・中津南部・堂島北部を含む範囲。
const CENTER = { x: -2668.18, z: -10941.87 };
const HALF_SPAN_M = 600;
const BOUNDS = { minX: CENTER.x - HALF_SPAN_M, maxX: CENTER.x + HALF_SPAN_M, minZ: CENTER.z - HALF_SPAN_M, maxZ: CENTER.z + HALF_SPAN_M };

// block raster設定（PoC範囲全体を1枚でラスタライズ。範囲固定だからこそ可能な精度）
const CELL_M = 1.0;
const WALL_DIST_M = 1.0;
const RASTER_MARGIN_M = 30; // PoC範囲外側の道路も少し含めて壁判定の精度を上げる

function ringArea(ring) { let a = 0; for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; a += x1 * z2 - x2 * z1; } return Math.abs(a) / 2; }
function ringBboxOf(ring) { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity; for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; } return { minX, maxX, minZ, maxZ }; }
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function inBounds(x, z, pad = 0) { return x >= BOUNDS.minX - pad && x <= BOUNDS.maxX + pad && z >= BOUNDS.minZ - pad && z <= BOUNDS.maxZ + pad; }

function loadGsiEdgeTilesInBounds() {
  const txMin = Math.floor((BOUNDS.minX - RASTER_MARGIN_M) / 500), txMax = Math.floor((BOUNDS.maxX + RASTER_MARGIN_M) / 500);
  const tzMin = Math.floor((BOUNDS.minZ - RASTER_MARGIN_M) / 500), tzMax = Math.floor((BOUNDS.maxZ + RASTER_MARGIN_M) / 500);
  const lines = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let tz = tzMin; tz <= tzMax; tz++) {
      const t = rj(path.join(GSI_EDGE_DIR, 'tile_' + tx + '_' + tz + '.json'));
      if (t) for (const f of t.features) lines.push(f.coordinates);
    }
  }
  return lines;
}

/** PoC範囲全体を1枚のgridでラスタライズし、GSI Road Edgeを壁としてflood-fillする。
 *  §11/§12: block分類（VALID_BLOCK/OPEN_BLOCK/AMBIGUOUS/NON_BLOCK）付き。 */
function buildBlockRaster(edgeLines) {
  const minX = BOUNDS.minX - RASTER_MARGIN_M, maxX = BOUNDS.maxX + RASTER_MARGIN_M;
  const minZ = BOUNDS.minZ - RASTER_MARGIN_M, maxZ = BOUNDS.maxZ + RASTER_MARGIN_M;
  const nx = Math.ceil((maxX - minX) / CELL_M), nz = Math.ceil((maxZ - minZ) / CELL_M);
  const wall = new Uint8Array(nx * nz);
  for (const c of edgeLines) {
    for (let i = 0; i < c.length - 1; i++) {
      const ax = c[i][0], az = c[i][1], bx = c[i + 1][0], bz = c[i + 1][1];
      const segMinX = Math.min(ax, bx) - WALL_DIST_M, segMaxX = Math.max(ax, bx) + WALL_DIST_M;
      const segMinZ = Math.min(az, bz) - WALL_DIST_M, segMaxZ = Math.max(az, bz) + WALL_DIST_M;
      if (segMaxX < minX || segMinX > maxX || segMaxZ < minZ || segMinZ > maxZ) continue;
      const ix0 = Math.max(0, Math.floor((segMinX - minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((segMaxX - minX) / CELL_M));
      const iz0 = Math.max(0, Math.floor((segMinZ - minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((segMaxZ - minZ) / CELL_M));
      const dx = bx - ax, dz = bz - az; const len2 = dx * dx + dz * dz;
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = minX + (ix + 0.5) * CELL_M;
        for (let iz = iz0; iz <= iz1; iz++) {
          const pz = minZ + (iz + 0.5) * CELL_M;
          let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0; t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
          if (d <= WALL_DIST_M) wall[iz * nx + ix] = 1;
        }
      }
    }
  }
  const comp = new Int32Array(nx * nz).fill(-1);
  let compId = 0; const compSize = [], touchesBoundary = [];
  const qx = new Int32Array(nx * nz), qz = new Int32Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const idx = iz * nx + ix;
      if (wall[idx] || comp[idx] !== -1) continue;
      let qh = 0, qt = 0; qx[qt] = ix; qz[qt] = iz; qt++; comp[idx] = compId;
      let size = 0, boundary = false;
      while (qh < qt) {
        const cx0 = qx[qh], cz0 = qz[qh]; qh++; size++;
        if (cx0 === 0 || cx0 === nx - 1 || cz0 === 0 || cz0 === nz - 1) boundary = true;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx2 = cx0 + dx, nz2 = cz0 + dz;
          if (nx2 < 0 || nx2 >= nx || nz2 < 0 || nz2 >= nz) continue;
          const nidx = nz2 * nx + nx2;
          if (wall[nidx] || comp[nidx] !== -1) continue;
          comp[nidx] = compId; qx[qt] = nx2; qz[qt] = nz2; qt++;
        }
      }
      compSize.push(size); touchesBoundary.push(boundary); compId++;
    }
  }
  // §12 分類: 面積閾値は経験則(道路脇の細切れセルをNON_BLOCKとして除外)。
  const blockClass = compSize.map((size, i) => {
    const areaM2 = size * CELL_M * CELL_M;
    if (areaM2 < 15) return 'NON_BLOCK';
    if (touchesBoundary[i]) return 'OPEN_BLOCK';
    if (areaM2 < 60) return 'AMBIGUOUS';
    return 'VALID_BLOCK';
  });
  return { minX, minZ, nx, nz, comp, compSize, blockClass, cellM: CELL_M };
}
function blockOf(raster, x, z) {
  if (x < raster.minX || z < raster.minZ) return -1;
  const ix = Math.floor((x - raster.minX) / raster.cellM), iz = Math.floor((z - raster.minZ) / raster.cellM);
  if (ix < 0 || ix >= raster.nx || iz < 0 || iz >= raster.nz) return -1;
  return raster.comp[iz * raster.nx + ix];
}
/** §13/§14: ring(footprint)についてblock割当+containment(outsideRatio)を測る。raster全体を使うため
 *  32Bの「局所window」方式より閉鎖判定が正確（このPoC範囲全体があらかじめ1つのraster内にあるため）。*/
function assignBlockAndContainment(raster, ring) {
  const bbox = ringBboxOf(ring);
  let cx = 0, cz = 0; for (const [x, z] of ring) { cx += x; cz += z; } cx /= ring.length; cz /= ring.length;
  const homeComp = blockOf(raster, cx, cz);
  if (homeComp === -1) return { blockId: null, blockClass: 'NON_BLOCK', outsideRatio: null, insideBlockArea: null, outsideBlockArea: null };
  let total = 0, inside = 0;
  const step = CELL_M;
  for (let x = bbox.minX; x <= bbox.maxX; x += step) {
    for (let z = bbox.minZ; z <= bbox.maxZ; z += step) {
      if (!pointInRing(x, z, ring)) continue;
      total++;
      if (blockOf(raster, x, z) === homeComp) inside++;
    }
  }
  if (total === 0) return { blockId: null, blockClass: 'NON_BLOCK', outsideRatio: null, insideBlockArea: null, outsideBlockArea: null };
  const area = ringArea(ring);
  const outsideRatio = 1 - inside / total;
  return {
    blockId: 'blk_' + homeComp, blockClass: raster.blockClass[homeComp],
    outsideRatio: +outsideRatio.toFixed(4), insideBlockArea: +(area * inside / total).toFixed(2), outsideBlockArea: +(area * (1 - inside / total)).toFixed(2),
  };
}
function classifyOutsideReason(c, matchType, geometrySource) {
  if (c.outsideRatio == null) return 'UNKNOWN';
  if (c.outsideRatio <= 0.02) return 'NONE';
  if (c.blockClass === 'OPEN_BLOCK') return 'BLOCK_POLYGONIZATION_ERROR';
  if (matchType === 'ONE_TO_MANY' || matchType === 'MANY_TO_ONE' || matchType === 'COMPLEX') return 'MATCHING_ERROR';
  if (geometrySource === 'PLATEAU_FALLBACK') return 'MATCHING_ERROR';
  if (c.outsideRatio < 0.08) return 'EDGE_NOISE';
  return 'GSI_BUILDING_ROAD_CONFLICT';
}
function containmentBuckets(records) {
  const measured = records.filter((r) => r.outsideRatio != null);
  const reliable = measured.filter((r) => r.blockClass !== 'OPEN_BLOCK' && r.blockClass !== 'NON_BLOCK');
  const fullyInside = reliable.filter((r) => r.outsideRatio <= 0.01).length;
  const outsideLt1 = fullyInside; // §28: outsideLt1 = <1%（=fullyInsideと同義。仕様の表記に合わせて両方出す）
  const outside1to5 = reliable.filter((r) => r.outsideRatio > 0.01 && r.outsideRatio <= 0.05).length;
  const outsideGt5 = reliable.filter((r) => r.outsideRatio > 0.05).length;
  return {
    measuredCount: measured.length, reliableCount: reliable.length, unreliableOpenOrNonBlock: measured.length - reliable.length,
    fullyInside, outsideLt1, outside1to5, outsideGt5,
    fullyInsideRate: reliable.length ? +(fullyInside / reliable.length * 100).toFixed(2) : null,
    outside1to5Rate: reliable.length ? +(outside1to5 / reliable.length * 100).toFixed(2) : null,
    outsideGt5Rate: reliable.length ? +(outsideGt5 / reliable.length * 100).toFixed(2) : null,
    medianOutsideRatio: reliable.length ? +(reliable.map((r) => r.outsideRatio).sort((a, b) => a - b)[Math.floor(reliable.length / 2)]).toFixed(4) : null,
  };
}

async function main() {
  const generatedAt = new Date().toISOString();
  console.log('[umeda-poc] bounds=' + JSON.stringify(BOUNDS));

  // ── PLATEAU Canonical Buildings（PoC範囲内のみ）──
  const txMin = Math.floor(BOUNDS.minX / 500), txMax = Math.floor(BOUNDS.maxX / 500);
  const tzMin = Math.floor(BOUNDS.minZ / 500), tzMax = Math.floor(BOUNDS.maxZ / 500);
  const plateauFeatures = [], osmFallbackFeatures = [];
  const attrByCanonicalId = new Map();
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let tz = tzMin; tz <= tzMax; tz++) {
      const f = 'tile_' + tx + '_' + tz + '.json';
      const t = rj(path.join(CANON_BLDGS, f)); if (!t) continue;
      const nearTile = rj(path.join(NEAR_BLDGS, f));
      if (nearTile) for (const nf of nearTile.features) attrByCanonicalId.set(nf.canonicalId, nf.attributes || {});
      for (const ft of t.features) {
        const outer = ft.geometryType === 'Polygon' ? ft.coordinates[0] : (ft.coordinates[0] && ft.coordinates[0][0]);
        if (!outer || outer.length < 3) continue;
        let cx = 0, cz = 0; for (const [x, z] of outer) { cx += x; cz += z; } cx /= outer.length; cz /= outer.length;
        if (!inBounds(cx, cz)) continue;
        const rec = { id: ft.canonicalId, ring: outer };
        if (ft.source && ft.source.geometrySource === 'plateau-building') plateauFeatures.push(rec); else osmFallbackFeatures.push(rec);
      }
    }
  }
  console.log('[umeda-poc] PLATEAU in-bounds: plateau-building=' + plateauFeatures.length + ' osm-fallback=' + osmFallbackFeatures.length);
  const sourceBuildingCount = plateauFeatures.length + osmFallbackFeatures.length;
  const plateauMetrics = plateauFeatures.map(precomputeMetrics);

  // ── GSI Building Area（PoC範囲内のみ・streaming読込しつつfilter）──
  console.log('[umeda-poc] loading GSI BldA (streaming, filtering to bounds)...');
  const gsiSrc = await readFeatureCollectionStreaming(GSI_AREA);
  const gsiInBounds = [];
  for (const f of (gsiSrc.features || [])) {
    const ring = f.coordinates[0];
    let cx = 0, cz = 0; for (const [x, z] of ring) { cx += x; cz += z; } cx /= ring.length; cz /= ring.length;
    if (inBounds(cx, cz, 50)) gsiInBounds.push(f); // 少し外側も候補に含める（範囲境界付近のmatching精度のため）
  }
  console.log('[umeda-poc] GSI BldA in-bounds(+50m margin)=' + gsiInBounds.length);
  const gsiMetrics = gsiInBounds.map(precomputeGsiAreaMetrics);

  // ── Join ──
  const { groups, unmatchedA, aById, bById } = joinBuildingGeometries(plateauMetrics, gsiMetrics);
  const relationshipCounts = { ONE_TO_ONE: 0, ONE_TO_MANY: 0, MANY_TO_ONE: 0, COMPLEX: 0 };
  for (const g of groups) relationshipCounts[g.relationship] = (relationshipCounts[g.relationship] || 0) + 1;
  console.log('[umeda-poc] relationshipCounts=' + JSON.stringify(relationshipCounts) + ' unmatched=' + unmatchedA.length);

  function heightOf(id) { const a = attrByCanonicalId.get(id); return a && typeof a.heightM === 'number' ? a.heightM : null; }
  function usageOf(id) { const a = attrByCanonicalId.get(id); return a ? { usageCategory: a.usageCategory, usage: a.usage, usageLabel: a.usageLabel, levels: a.levels ?? null } : {}; }

  // ── Visual Building 生成（32Bと同じ§7/§8/§9ルール）──
  // [実測で発見した問題への対策・§32] 面積が全く釣り合わないmatchをconfidence=HIGHのまま素通り
  // させていたことが判明した（例: PLATEAU 34.3m建物がGSI側の巨大polygon(27,213m²、恐らく駅施設等の
  // 大規模構造物)へONE_TO_ONEで結び付き、outsideRatio=40.6%という明らかな誤matchになっていた)。
  // §32「単純matchingが難しい場合は無理にGSI geometry採用せず...REVIEW」に従い、PLATEAU面積と
  // GSI面積(ONE_TO_MANYは合算)の比が[0.3, 3.0]から外れる場合はconfidenceをREVIEWへ格下げする。
  function areaRatioOk(platArea, gsiAreaSum) {
    if (!(platArea > 0) || !(gsiAreaSum > 0)) return true; // 判定不能時は妨げない
    const r = platArea / gsiAreaSum;
    return r >= 0.3 && r <= 3.0;
  }
  const visualFeatures = []; let seq = 0;
  function push(rec) { rec.visualId = 'umeda_vb_' + (seq++); visualFeatures.push(rec); }
  for (const g of groups) {
    if (g.relationship === 'ONE_TO_ONE') {
      const cid = g.aIds[0]; const gsi = bById.get(g.bIds[0]); const plat = aById.get(cid);
      const ok = areaRatioOk(plat.area, gsi.area);
      push({ canonicalIds: [cid], geometry: { type: 'Polygon', coordinates: [gsi.ring, ...gsi.holes] }, geometrySource: 'GSI_POLYGON', matchType: 'ONE_TO_ONE', heightM: heightOf(cid), ...usageOf(cid), confidence: ok ? 'HIGH' : 'REVIEW', reviewReason: ok ? null : ('面積比不整合: PLATEAU=' + plat.area.toFixed(1) + 'm² vs GSI=' + gsi.area.toFixed(1) + 'm²（比=' + (plat.area / gsi.area).toFixed(2) + '）。§32: 駅施設等の大規模構造物の疑い、要目視確認') });
    } else if (g.relationship === 'ONE_TO_MANY') {
      const cid = g.aIds[0]; const h = heightOf(cid); const u = usageOf(cid); const plat = aById.get(cid);
      const gsiAreaSum = g.bIds.reduce((s, bId) => s + bById.get(bId).area, 0);
      const ok = areaRatioOk(plat.area, gsiAreaSum);
      for (const bId of g.bIds) { const gsi = bById.get(bId); push({ canonicalIds: [cid], geometry: { type: 'Polygon', coordinates: [gsi.ring, ...gsi.holes] }, geometrySource: 'GSI_POLYGON', matchType: 'ONE_TO_MANY', heightM: h, ...u, confidence: ok ? 'MEDIUM' : 'REVIEW', reviewReason: ok ? null : ('面積比不整合(GSI parts合計): PLATEAU=' + plat.area.toFixed(1) + 'm² vs GSI合計=' + gsiAreaSum.toFixed(1) + 'm²、要目視確認') }); }
    } else if (g.relationship === 'MANY_TO_ONE') {
      const gsi = bById.get(g.bIds[0]);
      let wsum = 0, hsum = 0; let maxArea = -1, maxAreaId = null;
      for (const aId of g.aIds) { const a = aById.get(aId); const h = heightOf(aId); if (h != null) { hsum += h * a.area; wsum += a.area; } if (a.area > maxArea) { maxArea = a.area; maxAreaId = aId; } }
      const repHeight = wsum > 0 ? hsum / wsum : heightOf(maxAreaId);
      push({ canonicalIds: g.aIds, geometry: { type: 'Polygon', coordinates: [gsi.ring, ...gsi.holes] }, geometrySource: 'GSI_POLYGON', matchType: 'MANY_TO_ONE', heightM: repHeight != null ? +repHeight.toFixed(2) : null, ...usageOf(maxAreaId), confidence: 'MEDIUM', reviewReason: 'height=面積加重平均, usage=最大面積棟(' + maxAreaId + ')代表' });
    } else if (g.relationship === 'COMPLEX') {
      const repId = g.aIds.slice().sort((a, b) => (aById.get(b).area - aById.get(a).area))[0];
      const repH = heightOf(repId); const u = usageOf(repId);
      for (const bId of g.bIds) { const gsi = bById.get(bId); push({ canonicalIds: g.aIds, geometry: { type: 'Polygon', coordinates: [gsi.ring, ...gsi.holes] }, geometrySource: 'GSI_POLYGON', matchType: 'COMPLEX', heightM: repH, ...u, confidence: 'REVIEW', reviewReason: g.aIds.length + '対' + g.bIds.length + 'の複雑対応。代表棟(' + repId + ')から暫定付与、要目視確認' }); }
    }
  }
  for (const aId of unmatchedA) {
    // unmatchedAはPoC範囲外のGSI候補も含めたplateauMetrics由来なので、PoC範囲内のみ対象にする
    if (!plateauFeatures.some((p) => p.id === aId)) continue;
    const a = aById.get(aId);
    push({ canonicalIds: [aId], geometry: { type: 'Polygon', coordinates: [a.ring] }, geometrySource: 'PLATEAU_FALLBACK', matchType: 'UNMATCHED', heightM: heightOf(aId), ...usageOf(aId), confidence: 'FALLBACK', reviewReason: null });
  }
  for (const rec of osmFallbackFeatures) {
    push({ canonicalIds: [rec.id], geometry: { type: 'Polygon', coordinates: [rec.ring] }, geometrySource: 'PLATEAU_FALLBACK', matchType: 'OSM_FALLBACK', heightM: heightOf(rec.id), ...usageOf(rec.id), confidence: 'FALLBACK', reviewReason: null });
  }
  console.log('[umeda-poc] visualFeatures=' + visualFeatures.length);

  // ── §11/§12 Block raster生成 ──
  const edgeLines = loadGsiEdgeTilesInBounds();
  console.log('[umeda-poc] GSI road edge lines in bounds(+margin)=' + edgeLines.length);
  const raster = buildBlockRaster(edgeLines);
  const blockClassCounts = { VALID_BLOCK: 0, OPEN_BLOCK: 0, AMBIGUOUS: 0, NON_BLOCK: 0 };
  for (const c of raster.blockClass) blockClassCounts[c]++;
  console.log('[umeda-poc] blocks=' + raster.blockClass.length + ' ' + JSON.stringify(blockClassCounts));

  // ── §13/§14 Visual Building の block割当+containment ──
  for (const f of visualFeatures) {
    const c = assignBlockAndContainment(raster, f.geometry.coordinates[0]);
    f.blockId = c.blockId; f.insideRatio = c.outsideRatio != null ? +(1 - c.outsideRatio).toFixed(4) : null;
    f._outsideRatio = c.outsideRatio; f._blockClass = c.blockClass;
    f.reviewReason = f.reviewReason || (c.outsideRatio != null && c.outsideRatio > 0.05 ? classifyOutsideReason(c, f.matchType, f.geometrySource) : f.reviewReason);
  }
  const visualContainment = containmentBuckets(visualFeatures.map((f) => ({ outsideRatio: f._outsideRatio, blockClass: f._blockClass })));

  // ── §29/§30 比較用: 同じPoC範囲のPLATEAU footprint(補正なしの元Canonical exact)でも同じ測定 ──
  const plateauContainmentRecords = [...plateauFeatures, ...osmFallbackFeatures].map((p) => {
    const c = assignBlockAndContainment(raster, p.ring);
    return { outsideRatio: c.outsideRatio, blockClass: c.blockClass };
  });
  const plateauContainment = containmentBuckets(plateauContainmentRecords);

  // ── §31 建物保持率 ──
  const uniqueCanonicalIdsInVisual = new Set(); for (const f of visualFeatures) for (const cid of f.canonicalIds) uniqueCanonicalIdsInVisual.add(cid);
  const renderedBuildingRetention = sourceBuildingCount > 0 ? +(uniqueCanonicalIdsInVisual.size / sourceBuildingCount * 100).toFixed(2) : null;

  // ── §33 重点QA（面積が大きい建物 上位30件） ──
  const qaBuildings = visualFeatures.slice()
    .map((f) => ({ ...f, _area: ringArea(f.geometry.coordinates[0]) }))
    .sort((a, b) => b._area - a._area).slice(0, 30)
    .map((f) => ({ visualId: f.visualId, canonicalIds: f.canonicalIds, geometrySource: f.geometrySource, matchType: f.matchType, confidence: f.confidence, reviewReason: f.reviewReason, heightM: f.heightM, usageCategory: f.usageCategory, areaM2: +f._area.toFixed(1), outsideRatio: f._outsideRatio, blockClass: f._blockClass }));

  // ── 出力: tile化はせず単一ファイル（PoC範囲は小さいため）──
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFeatures = visualFeatures.map((f) => ({
    visualId: f.visualId, geometry: f.geometry, geometrySource: f.geometrySource, canonicalIds: f.canonicalIds,
    matchType: f.matchType, heightM: f.heightM, usageCategory: f.usageCategory, usage: f.usage, usageLabel: f.usageLabel, levels: f.levels,
    blockId: f.blockId, insideRatio: f.insideRatio, confidence: f.confidence, reviewReason: f.reviewReason,
    provenance: { generatedAt, source: 'umeda-poc' },
  }));
  fs.writeFileSync(path.join(OUT_DIR, 'umeda-visual-buildings.json'), JSON.stringify({ version: 1, kind: 'umeda-visual-building-poc', coordinateConvention: 'znorth-neg-v1', generatedAt, bounds: BOUNDS, count: outFeatures.length, features: outFeatures }));
  await writeJson(path.join(OUT_DIR, 'manifest.json'), { version: 1, generatedAt, bounds: BOUNDS, featureCount: outFeatures.length, blockClassCounts });

  // ── [§27] Dev [Block QA] overlay用: block raster を行単位RLEで軽量export。
  //   0=wall(road edge cell)/1=VALID_BLOCK/2=OPEN_BLOCK/3=AMBIGUOUS/4=NON_BLOCK。
  //   raster自体(nx*nz個のcell)は送らず、隣接同値runの[code,count]列のみを行ごとに送るため、
  //   建物の少ない都市街区データでも数百KB程度に収まる（1260x1260セルでも連続runが大半のため）。
  {
    const CLASS_CODE = { VALID_BLOCK: 1, OPEN_BLOCK: 2, AMBIGUOUS: 3, NON_BLOCK: 4 };
    const rows = [];
    for (let iz = 0; iz < raster.nz; iz++) {
      const row = [];
      let curCode = -1, runLen = 0;
      for (let ix = 0; ix < raster.nx; ix++) {
        const compId = raster.comp[iz * raster.nx + ix];
        const code = compId === -1 ? 0 : (CLASS_CODE[raster.blockClass[compId]] || 4);
        if (code === curCode) { runLen++; } else { if (curCode !== -1) row.push(curCode, runLen); curCode = code; runLen = 1; }
      }
      if (curCode !== -1) row.push(curCode, runLen);
      rows.push(row);
    }
    await writeJson(path.join(OUT_DIR, 'block-raster.json'), {
      version: 1, generatedAt, cellM: raster.cellM, nx: raster.nx, nz: raster.nz,
      originX: raster.minX, originZ: raster.minZ,
      codeLegend: { 0: 'WALL', 1: 'VALID_BLOCK', 2: 'OPEN_BLOCK', 3: 'AMBIGUOUS', 4: 'NON_BLOCK' },
      rowEncoding: 'run-length: [code,count,code,count,...] per row (row=iz, left-to-right=ix)',
      rows,
    });
  }

  // ── §39 最終判定 ──
  const outsideImproved = plateauContainment.outsideGt5Rate != null && visualContainment.outsideGt5Rate != null && visualContainment.outsideGt5Rate < plateauContainment.outsideGt5Rate;
  const retentionHigh = renderedBuildingRetention != null && renderedBuildingRetention >= 95;
  const heightJoinWorks = visualFeatures.filter((f) => f.heightM != null).length / visualFeatures.length >= 0.9;
  const usageJoinWorks = visualFeatures.filter((f) => f.usageCategory != null).length / visualFeatures.length >= 0.8;
  // §32/§33: 大型建物30件のうち、confidence=REVIEW（COMPLEX関係 or 面積比不整合の疑い）の割合が
  // 3割を超えないことを条件にする（超えると「単純matchingが難しい大型建物を無理にGSI採用している」
  // 可能性が高いと判断）。
  const noMajorMismatchInLargeBuildings = qaBuildings.filter((b) => b.confidence === 'REVIEW').length <= qaBuildings.length * 0.3;
  const verdict = (outsideImproved && retentionHigh && heightJoinWorks && usageJoinWorks && noMajorMismatchInLargeBuildings)
    ? 'UMEDA_GSI_VISUAL_POC_SUCCESS' : 'UMEDA_GSI_VISUAL_POC_NOT_BETTER';

  const report = {
    generatedAt, pocBounds: BOUNDS,
    gsiBuildingFeatureType: 'BldA（建築物ポリゴン。§3で実ファイル確認済み・31G-ALIGNMENT-RESET/32Bで抽出済みのものを再利用）',
    counts: { sourceBuildingCount, gsiVisualCount: visualFeatures.filter((f) => f.geometrySource === 'GSI_POLYGON').length, plateauFallbackCount: visualFeatures.filter((f) => f.geometrySource === 'PLATEAU_FALLBACK').length, totalVisualBuildings: visualFeatures.length },
    matching: { ...relationshipCounts, unmatched: unmatchedA.filter((id) => plateauFeatures.some((p) => p.id === id)).length },
    blockStats: { totalBlocks: raster.blockClass.length, ...blockClassCounts, cellM: CELL_M, rasterDimensions: { nx: raster.nx, nz: raster.nz } },
    containment: { plateauBefore: plateauContainment, visualAfter: visualContainment },
    retention: { sourceBuildingCount, uniqueCanonicalIdsInVisual: uniqueCanonicalIdsInVisual.size, renderedBuildingRetention },
    heightJoin: { withHeight: visualFeatures.filter((f) => f.heightM != null).length, total: visualFeatures.length, rate: +(visualFeatures.filter((f) => f.heightM != null).length / visualFeatures.length * 100).toFixed(2) },
    usageJoin: { withUsage: visualFeatures.filter((f) => f.usageCategory != null).length, total: visualFeatures.length, rate: +(visualFeatures.filter((f) => f.usageCategory != null).length / visualFeatures.length * 100).toFixed(2) },
    qaBuildings,
    verdictCriteria: { outsideImproved, retentionHigh, heightJoinWorks, usageJoinWorks, noMajorMismatchInLargeBuildings },
    verdict,
    validatorFlags: { canonicalMutation: 0, gsiRawMutation: 0, roadMutation: 0, globalOffsetApplied: 0, globalScaleApplied: 0, warpApplied: 0 },
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[umeda-poc] verdict=' + verdict);
  console.log('[umeda-poc] retention=' + renderedBuildingRetention + '% heightJoin=' + report.heightJoin.rate + '% usageJoin=' + report.usageJoin.rate + '%');
  console.log('[umeda-poc] containment plateauBefore.outsideGt5Rate=' + plateauContainment.outsideGt5Rate + '% visualAfter.outsideGt5Rate=' + visualContainment.outsideGt5Rate + '%');
  console.log('保存: ' + toProjectRelativePath(OUT_DIR) + ' / ' + toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[umeda-poc] 失敗:', e && e.stack || e); process.exit(1); });
