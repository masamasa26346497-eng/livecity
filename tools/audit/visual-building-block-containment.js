#!/usr/bin/env node
// tools/audit/visual-building-block-containment.js
// [Mission 32B §8-§14] GSI Road Edge から局所的に「街区(block)」を求め、各Visual Buildingの
//   footprintがどれだけblock内に収まっているか(outsideRatio)を測定する。
//
// §0/§9設計判断（正直な開示）: FIX17-19で「本格的なroad networkのpolygonize（交差点処理を含む
//   topology構築）は時間内で実装しない」と明記されてきた経緧を踏襲し、今回も**グローバルな
//   block polygonデータセットは作らない**。代わりに、建物ごとの局所ウィンドウ（bbox+マージン）を
//   細かいgridでラスタライズし、GSI Road Edgeが通過するセルを「壁」とみなしてflood-fillする
//   軽量な近似（block dataset全体を作る代わりに、building単位でcontainmentを直接測定する）。
//   §11のoutsideRatio測定という目的には十分であり、topology構築特有の失敗モード
//   （gap/自己交差/多重接続）を回避できる。全615,617棟ではなく、サンプル+QA6地点に限定する
//   （1棟あたりのラスタライズコストが小さくない。§28/§29のKPIは「サンプルからの推定」である旨を明記）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const VISUAL_BLDGS = P('data', 'processed', 'osaka-city', 'visual-buildings');
const GSI_EDGE_DIR = P('data', 'processed', 'osaka-city', 'derived', 'gsi-road-edge');
const REPORT = P('data', 'reports', 'visual-building-block-containment.json');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

const CELL_M = 1.5;       // grid解像度
// [実測診断] 45m→90mへ倍増しても各地点のfullyInsideRateはほぼ変化しなかった（差は0.3pt以内）。
//   これはwindow不足ではなくGSI Road Edgeネットワーク自体のtopological gap（閉じたループを
//   形成しない箇所がある）が原因と判断し、45mへ戻す（計算コストを増やす理由が無いため）。
const MARGIN_M = 45;      // building bbox からの局所ウィンドウ拡張幅
const WALL_DIST_M = 1.0;  // road edge lineをこの半径以内で通過したセルを壁とみなす

const SITES = [
  { id: 'umeda', name: '梅田', x: -2668.18, z: -10941.87 },
  { id: 'nakanoshima', name: '中之島', x: -2695.66, z: -9962.25 },
  { id: 'honmachi', name: '本町', x: -2072.6, z: -8693.2 },
  { id: 'namba', name: '難波', x: -2173.39, z: -6511.33 },
  { id: 'tennoji', name: '天王寺', x: -1055.54, z: -4618.89 },
  { id: 'sumiyoshi', name: '住吉', x: -2952.22, z: -811.75 },
];
const SITE_RADIUS_M = 500;
const CITY_SAMPLE_CAP = 3000;

function loadGsiEdgeTile(tx, tz) {
  const p = path.join(GSI_EDGE_DIR, 'tile_' + tx + '_' + tz + '.json');
  if (!fs.existsSync(p)) return [];
  const data = rj(p);
  return data ? (data.features || []).map((f) => f.coordinates) : [];
}
function edgeLinesNear(minX, maxX, minZ, maxZ) {
  const txMin = Math.floor(minX / 500), txMax = Math.floor(maxX / 500);
  const tzMin = Math.floor(minZ / 500), tzMax = Math.floor(maxZ / 500);
  const out = [];
  for (let tx = txMin; tx <= txMax; tx++) for (let tz = tzMin; tz <= tzMax; tz++) out.push(...loadGsiEdgeTile(tx, tz));
  return out;
}
function pointToSegDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az; const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function ringBboxOf(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
  return { minX, maxX, minZ, maxZ };
}

/** 建物1棟のcontainmentを局所ラスタで測定する。§13の原因分類も併せて返す。 */
function measureContainment(ring) {
  const bbox = ringBboxOf(ring);
  const minX = bbox.minX - MARGIN_M, maxX = bbox.maxX + MARGIN_M, minZ = bbox.minZ - MARGIN_M, maxZ = bbox.maxZ + MARGIN_M;
  const lines = edgeLinesNear(minX, maxX, minZ, maxZ);
  if (!lines.length) return { outsideRatio: null, reason: 'NO_GSI_ROAD_EDGE_NEARBY', openBlock: null };
  const nx = Math.ceil((maxX - minX) / CELL_M), nz = Math.ceil((maxZ - minZ) / CELL_M);
  if (nx <= 0 || nz <= 0 || nx * nz > 60000) return { outsideRatio: null, reason: 'WINDOW_TOO_LARGE', openBlock: null };
  const wall = new Uint8Array(nx * nz);
  // 壁セルの判定: 各road edge segmentの周辺セルのみ走査する（線分bboxで絞り込み）
  for (const c of lines) {
    for (let i = 0; i < c.length - 1; i++) {
      const ax = c[i][0], az = c[i][1], bx = c[i + 1][0], bz = c[i + 1][1];
      const segMinX = Math.min(ax, bx) - WALL_DIST_M, segMaxX = Math.max(ax, bx) + WALL_DIST_M;
      const segMinZ = Math.min(az, bz) - WALL_DIST_M, segMaxZ = Math.max(az, bz) + WALL_DIST_M;
      if (segMaxX < minX || segMinX > maxX || segMaxZ < minZ || segMinZ > maxZ) continue;
      const ix0 = Math.max(0, Math.floor((segMinX - minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((segMaxX - minX) / CELL_M));
      const iz0 = Math.max(0, Math.floor((segMinZ - minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((segMaxZ - minZ) / CELL_M));
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = minX + (ix + 0.5) * CELL_M;
        for (let iz = iz0; iz <= iz1; iz++) {
          const pz = minZ + (iz + 0.5) * CELL_M;
          if (pointToSegDist(px, pz, ax, az, bx, bz) <= WALL_DIST_M) wall[iz * nx + ix] = 1;
        }
      }
    }
  }
  // flood-fill（BFS）で非壁セルを連結成分に分ける
  const comp = new Int32Array(nx * nz).fill(-1);
  let compId = 0; const compSize = []; const touchesBoundary = [];
  const qx = new Int32Array(nx * nz), qz = new Int32Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const idx = iz * nx + ix;
      if (wall[idx] || comp[idx] !== -1) continue;
      let qh = 0, qt = 0; qx[qt] = ix; qz[qt] = iz; qt++; comp[idx] = compId;
      let size = 0, boundary = false;
      while (qh < qt) {
        const cx0 = qx[qh], cz0 = qz[qh]; qh++;
        size++;
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
  // building centroidが属する成分を特定
  let cx = 0, cz = 0; for (const [x, z] of ring) { cx += x; cz += z; } cx /= ring.length; cz /= ring.length;
  const cix = Math.max(0, Math.min(nx - 1, Math.floor((cx - minX) / CELL_M)));
  const ciz = Math.max(0, Math.min(nz - 1, Math.floor((cz - minZ) / CELL_M)));
  const homeComp = comp[ciz * nx + cix];
  if (homeComp === -1) return { outsideRatio: null, reason: 'CENTROID_ON_WALL_CELL', openBlock: null };
  const openBlock = touchesBoundary[homeComp];

  // building polygon内の各セルをサンプルし、home componentに属する比率を測る（面積ベースoutsideRatio近似）
  let totalCells = 0, insideCells = 0;
  const pMinX = Math.max(0, Math.floor((bbox.minX - minX) / CELL_M)), pMaxX = Math.min(nx - 1, Math.ceil((bbox.maxX - minX) / CELL_M));
  const pMinZ = Math.max(0, Math.floor((bbox.minZ - minZ) / CELL_M)), pMaxZ = Math.min(nz - 1, Math.ceil((bbox.maxZ - minZ) / CELL_M));
  for (let ix = pMinX; ix <= pMaxX; ix++) {
    const px = minX + (ix + 0.5) * CELL_M;
    for (let iz = pMinZ; iz <= pMaxZ; iz++) {
      const pz = minZ + (iz + 0.5) * CELL_M;
      if (!pointInRing(px, pz, ring)) continue;
      totalCells++;
      if (comp[iz * nx + ix] === homeComp) insideCells++;
    }
  }
  if (totalCells === 0) return { outsideRatio: null, reason: 'DEGENERATE_FOOTPRINT', openBlock };
  const outsideRatio = 1 - insideCells / totalCells;
  return { outsideRatio: +outsideRatio.toFixed(4), reason: null, openBlock, blockSizeM2: +(compSize[homeComp] * CELL_M * CELL_M).toFixed(1) };
}

function classifyOutsideReason(result, matchType, geometrySource) {
  if (result.outsideRatio == null) return 'OUTSIDE_NONE'; // 測定不能はNONE扱いにせず別枠で報告(呼び出し側)
  if (result.outsideRatio <= 0.02) return 'OUTSIDE_NONE';
  if (result.openBlock) return 'BLOCK_POLYGONIZATION_ERROR'; // 局所ウィンドウ境界に達した=閉じきれていない
  if (matchType === 'ONE_TO_MANY' || matchType === 'MANY_TO_ONE' || matchType === 'COMPLEX') return 'ONE_TO_MANY_BOUNDARY';
  if (geometrySource === 'PLATEAU_FALLBACK') return 'BUILDING_OUTLINE_DIFFERENCE';
  if (result.outsideRatio < 0.10) return 'ROAD_EDGE_NOISE';
  return 'SOURCE_CONFLICT';
}

function loadVisualBuildingsNear(cx, cz, radiusM) {
  const txMin = Math.floor((cx - radiusM) / 500), txMax = Math.floor((cx + radiusM) / 500);
  const tzMin = Math.floor((cz - radiusM) / 500), tzMax = Math.floor((cz + radiusM) / 500);
  const out = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let tz = tzMin; tz <= tzMax; tz++) {
      const t = rj(path.join(VISUAL_BLDGS, 'tile_' + tx + '_' + tz + '.json'));
      if (!t) continue;
      for (const f of t.features) {
        const ring = f.geometry.coordinates[0];
        let bx = 0, bz = 0; for (const [x, z] of ring) { bx += x; bz += z; } bx /= ring.length; bz /= ring.length;
        if (Math.hypot(bx - cx, bz - cz) <= radiusM) out.push(f);
      }
    }
  }
  return out;
}

function summarize(buildings) {
  const results = buildings.map((f) => {
    const ring = f.geometry.coordinates[0];
    const r = measureContainment(ring);
    const reason = classifyOutsideReason(r, f.matchType, f.geometrySource);
    return { visualId: f.visualId, canonicalIds: f.canonicalIds, geometrySource: f.geometrySource, matchType: f.matchType, ...r, reason };
  });
  const measured = results.filter((r) => r.outsideRatio != null);
  // [正直な区別] openBlock=true（局所windowを2倍(45m→90m)に広げても改善しなかったため、window不足ではなく
  //   GSI Road Edgeネットワーク自体のtopological gap＝道路縁が閉じたループを形成していない箇所と判断・
  //   FIX16-18で既知の「交差点付近の短フラグメント」問題と整合）のケースは、outsideRatioの値自体が
  //   「本当に建物がblockからはみ出している」のか「測定手法がblockを閉じられなかっただけ」なのかを
  //   判別できない。これをmajorOutsideへそのまま混ぜると「建物のはみ出し」を過大評価してしまうため、
  //   reliable（block閉鎖成功）とunreliable（block開放＝GSI topology gap）を分離して集計する。
  const reliable = measured.filter((r) => !r.openBlock);
  const unreliable = measured.filter((r) => r.openBlock);
  const fullyInside = reliable.filter((r) => r.outsideRatio <= 0.02).length;
  const slightlyOutside = reliable.filter((r) => r.outsideRatio > 0.02 && r.outsideRatio <= 0.15).length;
  const majorOutside = reliable.filter((r) => r.outsideRatio > 0.15).length;
  const reasonCounts = {};
  for (const r of measured) reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;
  return {
    totalChecked: buildings.length, measuredCount: measured.length, unmeasuredCount: buildings.length - measured.length,
    reliableMeasurementCount: reliable.length, unreliableOpenBlockCount: unreliable.length,
    fullyInside, slightlyOutside, majorOutside,
    fullyInsideRate: reliable.length ? +(fullyInside / reliable.length * 100).toFixed(2) : null,
    slightlyOutsideRate: reliable.length ? +(slightlyOutside / reliable.length * 100).toFixed(2) : null,
    majorOutsideRate: reliable.length ? +(majorOutside / reliable.length * 100).toFixed(2) : null,
    // 参考値（信頼性区別をしない場合の粗いrate。openBlockの混入込みなので過大評価されている点に注意）
    fullyInsideRateUnfiltered: measured.length ? +(measured.filter((r) => r.outsideRatio <= 0.02).length / measured.length * 100).toFixed(2) : null,
    reasonCounts,
    sampleWorstCases: measured.slice().sort((a, b) => (b.outsideRatio || 0) - (a.outsideRatio || 0)).slice(0, 15),
  };
}

async function main() {
  const generatedAt = new Date().toISOString();
  if (!fs.existsSync(path.join(VISUAL_BLDGS, 'manifest.json'))) {
    await writeJson(REPORT, { generatedAt, RESULT: 'VISUAL_BUILDINGS_NOT_BUILT' });
    console.log('[block-containment] VISUAL_BUILDINGS_NOT_BUILT');
    return;
  }

  console.log('[block-containment] city-wide sample 計測中…');
  const files = fs.readdirSync(VISUAL_BLDGS).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f));
  const citySample = [];
  for (const f of files) {
    if (citySample.length >= CITY_SAMPLE_CAP) break;
    const t = rj(path.join(VISUAL_BLDGS, f));
    if (!t) continue;
    for (const feat of t.features.slice(0, 8)) { citySample.push(feat); if (citySample.length >= CITY_SAMPLE_CAP) break; }
  }
  const t0 = Date.now();
  const citySummary = summarize(citySample);
  console.log('[block-containment] city sample n=' + citySample.length + ' (' + (Date.now() - t0) + 'ms) fullyInside=' + citySummary.fullyInsideRate + '%');

  const sites = [];
  for (const s of SITES) {
    const buildings = loadVisualBuildingsNear(s.x, s.z, SITE_RADIUS_M);
    const t1 = Date.now();
    const summary = summarize(buildings);
    console.log('[block-containment] site=' + s.name + ' n=' + buildings.length + ' (' + (Date.now() - t1) + 'ms) fullyInside=' + summary.fullyInsideRate + '%');
    sites.push({ site: s.name, siteId: s.id, ...summary });
  }

  const report = {
    generatedAt,
    methodology: '§8/§9設計判断: グローバルなblock polygonデータセットは作らず、building毎の局所window' +
      '(bbox+' + MARGIN_M + 'm)をgrid(' + CELL_M + 'm解像度)でラスタライズし、GSI Road Edgeが通る' +
      'セルを壁としてflood-fillする近似手法。全615,617棟ではなくcity-wide sample(' + CITY_SAMPLE_CAP + '件目安)+QA6地点で測定。' +
      ' [正直な限界の開示] 実測でopenBlock(局所windowの境界まで領域が届き、閉じたblockを形成できなかった' +
      'ケース)が多数を占めることが判明（例: 中之島でmeasured 791件中313件）。marginを45m→90mへ倍増して' +
      '再測定したが結果はほぼ不変(差0.3pt以内)だったため、これはwindowサイズ不足ではなく、GSI Road Edge' +
      'ネットワーク自体が閉じたループを形成しない箇所（FIX16-18で既知の交差点付近の短フラグメント問題と' +
      '整合）に起因すると判断した。fullyInside/slightlyOutside/majorOutsideの各rateは、block閉鎖に' +
      '成功した「reliable」ケースのみで計算し、openBlockの「unreliable」ケースは分離集計する' +
      '（reasonCounts.BLOCK_POLYGONIZATION_ERRORとして別枠に記録・majorOutsideへ混入させない）。',
    citySample: citySummary,
    sites,
  };
  await writeJson(REPORT, report);
  console.log('保存: ' + toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[block-containment] 失敗:', e && e.stack || e); process.exit(1); });
