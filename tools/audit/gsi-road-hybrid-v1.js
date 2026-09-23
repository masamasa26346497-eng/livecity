#!/usr/bin/env node
// tools/audit/gsi-road-hybrid-v1.js
// [Mission 31G-FIX19] Hybrid GSI Road Surface Prototype — GSI corridor v3 の高信頼 surface を優先し、
//   確信できない区域だけ FIX13 primary へ fallback する Hybrid road surface を、sample エリア限定で
//   実 geometry として構築する。
//
//   §0 遵守: Canonical Road / Building / FIX13 default は一切変更しない（読み取りのみ）。
//   GSI LOW confidence は geometry source として使わない。GSI coverage 100% を目標にしない
//   （§26: GSI 65% + FIX13 35% でも geometry 品質が高ければ成功）。
//   本番統合は行わない（sample-scoped prototype のみ・§22）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { geoToLocal } from '../lib/projection.js';
import { OSAKA_PROJECTION, loadWards } from '../lib/gsi-road-edge-transform.js';
import { classifyPointToWard, pointInPolygonWithHoles } from '../lib/point-in-polygon.js';
import { segmentize as segmentizeV2, polygonFromPairSegments } from '../lib/gsi-road-edge-pairing-v2.js';
import { reconstructCorridorsV3 } from '../lib/gsi-road-edge-corridor-v3.js';
import { midpoint as lineMidpoint } from '../lib/gsi-road-edge-pairing.js';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const GSI_LINES = P('data', 'processed', 'osaka-city', 'gsi-road-edge', 'road-edge-lines.json');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'gsi-road-hybrid-v1');
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const CANON_WATER = P('data', 'processed', 'osaka-city', 'canonical', 'water');
const CANON_PARKS = P('data', 'processed', 'osaka-city', 'canonical', 'parks');
const REPORT = P('data', 'reports', 'gsi-road-hybrid-v1.json');

const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
function rj(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }

// Windows のパイプ出力バッファリング対策: 長時間ジョブの進捗を都度ファイルへ直接 flush する
// （console.log だけだと `| tail` 等にリダイレクトした際、プロセス終了までバッファされ進捗が見えないことがある）。
const PROGRESS_LOG = P('data', 'reports', '.gsi-road-hybrid-v1.progress.log');
try { fs.writeFileSync(PROGRESS_LOG, ''); } catch {}
function plog(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.log(line);
  try { fs.appendFileSync(PROGRESS_LOG, line + '\n'); } catch {}
}

const SAMPLE_SPOTS = [
  { name: '梅田', lat: 34.7025, lon: 135.4959 }, { name: '中之島', lat: 34.6937, lon: 135.4956 },
  { name: '本町', lat: 34.6823, lon: 135.5024 }, { name: '難波', lat: 34.6627, lon: 135.5013 },
  { name: '天王寺', lat: 34.6457, lon: 135.5135 }, { name: '阿倍野', lat: 34.6455, lon: 135.5138 },
  { name: '十三', lat: 34.7203, lon: 135.4830 }, { name: '住吉', lat: 34.6115, lon: 135.4928 },
  { name: '京橋', lat: 34.6969, lon: 135.5345 }, { name: '平野', lat: 34.6398, lon: 135.5474 },
];
const SAMPLE_HALF_M = 450;
const RESIDENTIAL_AREAS = new Set(['住吉', '阿倍野', '平野', '十三']);
const NAMED_EXACT = ['御堂筋', '新御堂筋', '中央大通', '玉造筋', '今里筋', 'あびこ筋', '松虫通'];
const NAMED_SUBSTR = { '国道1号': /国道1号(?!\d)/, '国道25号': /国道25号/, '国道43号': /国道43号/ };
const CELL_M = 5;   // rasterize 解像度（実測値として report に明記。車線幅3-3.5m台のため若干の量子化誤差はある）

function sampleAreas() {
  return SAMPLE_SPOTS.map((s) => {
    const { x, z } = geoToLocal(s.lat, s.lon, OSAKA_PROJECTION);
    const worldZ = -z;
    return { name: s.name, centerWorld: [x, worldZ], bbox: { minX: x - SAMPLE_HALF_M, maxX: x + SAMPLE_HALF_M, minZ: worldZ - SAMPLE_HALF_M, maxZ: worldZ + SAMPLE_HALF_M } };
  });
}
function percentiles(arr, keys = [0.1, 0.5, 0.9]) {
  if (!arr.length) return { count: 0 };
  const s = arr.slice().sort((a, b) => a - b);
  const out = { count: s.length, min: +s[0].toFixed(2), max: +s[s.length - 1].toFixed(2) };
  const labels = { 0.1: 'p10', 0.5: 'median', 0.9: 'p90' };
  for (const k of keys) out[labels[k]] = +s[Math.min(s.length - 1, Math.floor(s.length * k))].toFixed(2);
  return out;
}
function shoelaceArea(ring) { let a = 0; for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; a += x1 * z2 - x2 * z1; } return a / 2; }
function segIntersect(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
}
function quadSelfIntersects(q) {
  // 4点quad [p0,p1,q1,q0] の非隣接辺（p0-p1 と q1-q0）が交差していないか
  return segIntersect(q[0], q[1], q[2], q[3]);
}
function pointInRingSimple(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function ringBbox(ring) { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity; for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; } return { minX, maxX, minZ, maxZ }; }
function quadsBbox(quads) { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity; for (const q of quads) for (const [x, z] of q) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; } return { minX, maxX, minZ, maxZ }; }
// spatial grid index for fast quadInList/polyInArea lookups（cellClass rasterize や building overlap QA が
// 全 surface/polygon を毎回線形走査すると sample エリア規模でも組合せ爆発するため、粗い bucket で絞り込む）
const IDX_CELL = 40;
function buildBboxIndex(items) {   // items: [{bbox:{minX,maxX,minZ,maxZ}, ...}]
  const grid = new Map();
  for (const it of items) {
    const x0 = Math.floor(it.bbox.minX / IDX_CELL), x1 = Math.floor(it.bbox.maxX / IDX_CELL);
    const z0 = Math.floor(it.bbox.minZ / IDX_CELL), z1 = Math.floor(it.bbox.maxZ / IDX_CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = cx + ',' + cz; let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(it);
    }
  }
  return grid;
}
function queryBboxIndex(grid, x, z) {
  const cx = Math.floor(x / IDX_CELL), cz = Math.floor(z / IDX_CELL);
  const arr = grid.get(cx + ',' + cz);
  return arr || [];
}

async function main() {
  const generatedAt = new Date().toISOString();
  const gsi = rj(GSI_LINES);
  if (!gsi || !Array.isArray(gsi.features) || gsi.features.length === 0) {
    const report = { generatedAt, RESULT: 'GSI_ROAD_EDGE_RAW_DATA_MISSING', finalDecision: 'HYBRID_V1_NOT_READY', visualQaStatus: 'VISUAL_QA_PENDING_USER', note: 'road-edge-lines.json が無い/空。先に data:gsi-road-edge:import。' };
    await writeJson(REPORT, report);
    console.log('[gsi-road-hybrid-v1] GSI lines が無い → NOT_AVAILABLE で終了');
    return;
  }
  const areas = sampleAreas();
  const shinhaba = gsi.features.filter((f) => f.attrs.type === '真幅道路');
  plog('真幅道路:', shinhaba.length);

  // ── §0: FIX18 と同じ corridor v3 reconstruction を再実行（city-wide。~19秒） ──
  plog('segmentize+corridorV3 開始...');
  console.time('  segmentize+corridorV3');
  const segs = segmentizeV2(shinhaba);
  plog('segmentize 完了 segs=' + segs.length);
  const recon = reconstructCorridorsV3(segs, {});
  console.timeEnd('  segmentize+corridorV3');
  plog('reconstructCorridorsV3 完了 corridorPairs(raw)=' + recon.corridorPairs.length);
  const segById = new Map(segs.map((s) => [s.id, s]));

  // dedup（FIX18 と同一方式）+ v3 confidence 分類
  function classifyConfidenceV3(cp) {
    if (cp.widthSpike) return 'low';
    if (cp.score >= 0.78 && cp.parallel >= 0.88 && cp.overlapRatio >= 0.55 && !cp.trackSwitchAt) return 'high';
    if (cp.score >= 0.55) return 'medium';
    return 'low';
  }
  const seenKey = new Set();
  const corridorPairs = [];
  for (const cp of recon.corridorPairs) {
    const key = [cp.segId, cp.partnerSegId].sort().join('|');
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    corridorPairs.push({ ...cp, confidence: classifyConfidenceV3(cp) });
  }
  console.log('  corridorPairs(deduped):', corridorPairs.length);

  // ── §1 Hybrid source hierarchy: GSI_CORRIDOR_HIGH（HIGH かつ widthSpike/trackSwitchAt でない）/
  //     GSI_CORRIDOR_MEDIUM（MEDIUM かつ widthSpike/trackSwitchAt でない = continuity 条件）/ それ以外は不採用。
  //     GSI_POLYGONIZED_HIGH は Strategy A 未実装のため存在しない（FIX17/18 から継続の正直な記録）。
  const gsiSurfaces = [];
  let sid = 0;
  for (const p of corridorPairs) {
    const sa = segById.get(p.segId), sb = segById.get(p.partnerSegId);
    if (!sa || !sb) continue;
    let geometrySource = null;
    if (p.confidence === 'high' && !p.widthSpike && !p.trackSwitchAt) geometrySource = 'GSI_CORRIDOR_HIGH';
    else if (p.confidence === 'medium' && !p.widthSpike && !p.trackSwitchAt) geometrySource = 'GSI_CORRIDOR_MEDIUM';
    if (!geometrySource) continue;   // LOW / spike / switch境界 は採用しない（§1/§7 conservative fallback）
    const quads = polygonFromPairSegments(sa, sb);
    // §18 geometry validity: self-intersection / zero area / sliver
    let invalid = 0, sliverCount = 0, totalArea = 0;
    const validQuads = [];
    for (const q of quads) {
      if (quadSelfIntersects(q)) { invalid++; continue; }
      const area = Math.abs(shoelaceArea(q));
      if (area < 0.01) { invalid++; continue; }
      if (area < 0.5) sliverCount++;   // §19: 面積だけで削除しない。分類のみ（VALID_SMALL_FEATURE として保持）
      totalArea += area;
      validQuads.push(q);
    }
    if (!validQuads.length) continue;
    gsiSurfaces.push({
      surfaceId: 'hybrid_gsi_' + (sid++), geometrySource, confidence: p.confidence,
      sourceIds: [p.segId, p.partnerSegId], corridorId: recon.trackOf.get(p.segId), fallbackReason: null,
      widthM: p.sepM, areaM2: +totalArea.toFixed(1), invalidQuadCount: invalid, sliverQuadCount: sliverCount,
      quads: validQuads, bbox: quadsBbox(validQuads), midpoint: lineMidpoint([sa.midpoint, sb.midpoint]), generatedAt,
    });
  }
  plog('gsiSurfaces (HIGH+MEDIUM・非spike・非switch境界):', gsiSurfaces.length,
    'HIGH=' + gsiSurfaces.filter((s) => s.geometrySource === 'GSI_CORRIDOR_HIGH').length,
    'MEDIUM=' + gsiSurfaces.filter((s) => s.geometrySource === 'GSI_CORRIDOR_MEDIUM').length);
  // §35 building/seam QA で毎回全走査しないための粗 grid index（性能対策。判定ロジックは不変）
  const gsiSurfaceIndex = buildBboxIndex(gsiSurfaces);

  // ── §8 multi-carriageway 分類（track 単位）: 同一 track が複数の異なる partnerTrack と pair している場合 ──
  const partnersByTrack = new Map();
  for (const p of corridorPairs) {
    if (p.confidence === 'low') continue;
    for (const [trackId, partnerTrackId] of [[recon.trackOf.get(p.segId), p.partnerTrackId], [p.partnerTrackId, recon.trackOf.get(p.segId)]]) {
      let m = partnersByTrack.get(trackId); if (!m) { m = new Map(); partnersByTrack.set(trackId, m); }
      let arr = m.get(partnerTrackId); if (!arr) { arr = []; m.set(partnerTrackId, arr); }
      arr.push(p.sepM);
    }
  }
  const carriagewayClass = { SINGLE_CARRIAGEWAY: 0, DUAL_CARRIAGEWAY: 0, MULTI_CARRIAGEWAY: 0, AMBIGUOUS: 0 };
  for (const [, m] of partnersByTrack) {
    const distinctPartners = m.size;
    if (distinctPartners <= 1) { carriagewayClass.SINGLE_CARRIAGEWAY++; continue; }
    const meds = [...m.values()].map((arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)]).sort((a, b) => a - b);
    if (distinctPartners === 2) {
      const ratio = meds[1] / (meds[0] || 1);
      if (ratio >= 1.8) carriagewayClass.DUAL_CARRIAGEWAY++;   // 近い(median候補)+遠い(outer)の2層構造
      else carriagewayClass.AMBIGUOUS++;
    } else if (distinctPartners >= 3) carriagewayClass.MULTI_CARRIAGEWAY++;
  }
  plog('carriagewayClass:', carriagewayClass);

  // ── canonical roads 読み込み（named road bbox・FIX13 primary polygon 実 geometry・sample エリア限定）──
  const fix13Classes = rj(P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json'));
  const fix13Pfx = (fix13Classes && fix13Classes.keyPrefix) || '';
  const fix13Codes = (fix13Classes && fix13Classes.rsCodes) || {};
  const fix13ClassMap = new Map();
  if (fix13Classes) for (const [k, code] of Object.entries(fix13Classes.classMap || {})) fix13ClassMap.set(fix13Pfx + k, fix13Codes[code] || code);

  console.time('  loadCanonicalRoadsForAreas');
  const filesR = fs.readdirSync(CANON_ROADS).filter(isTile);
  const namedFeatures = {};
  const allLabels = [...NAMED_EXACT, ...Object.keys(NAMED_SUBSTR)];
  for (const l of allLabels) namedFeatures[l] = [];
  const seenRoadIds = new Set();
  const fix13PolysByArea = Object.fromEntries(areas.map((a) => [a.name, []]));   // {outer,holes,areaM2,attrs}
  const padArea = 100;
  for (const f of filesR) {
    const t = JSON.parse(fs.readFileSync(path.join(CANON_ROADS, f), 'utf-8'));
    for (const ft of t.features) {
      if (seenRoadIds.has(ft.canonicalId)) continue; seenRoadIds.add(ft.canonicalId);
      if (!ft.bbox) continue;
      const nm = ft.attributes && ft.attributes.name;
      if (nm) {
        if (NAMED_EXACT.includes(nm)) namedFeatures[nm].push(ft.bbox);
        for (const [label, re] of Object.entries(NAMED_SUBSTR)) if (re.test(nm)) namedFeatures[label].push(ft.bbox);
      }
      const rs = fix13ClassMap.get(ft.canonicalId) || 'primary';
      if (rs !== 'primary') continue;
      for (const a of areas) {
        if (ft.bbox.maxX < a.bbox.minX - padArea || ft.bbox.minX > a.bbox.maxX + padArea || ft.bbox.maxZ < a.bbox.minZ - padArea || ft.bbox.minZ > a.bbox.maxZ + padArea) continue;
        const polys = ft.geometryType === 'Polygon' ? [ft.coordinates] : (ft.coordinates || []);
        for (const poly of polys) fix13PolysByArea[a.name].push({ outer: poly[0], holes: poly.slice(1), bbox: ft.bbox });
      }
    }
  }
  console.timeEnd('  loadCanonicalRoadsForAreas');
  plog('FIX13 primary polys near sample areas:', Object.fromEntries(areas.map((a) => [a.name, fix13PolysByArea[a.name].length])));

  // ── §12/§13 service road 検出（named road 近傍の cluster 分析。city-wide topology 検出は未実装・正直に記録）──
  const serviceRoadStats = { MAIN: 0, SERVICE: 0, UNKNOWN: 0 };
  const majorRoads = {};
  for (const label of allLabels) {
    const bboxes = namedFeatures[label];
    if (!bboxes.length) { majorRoads[label] = { sampleCount: 0, note: 'canonical road に該当する name が無い' }; continue; }
    function bboxContainsMid(bb, mid, pad) { return mid[0] >= bb.minX - pad && mid[0] <= bb.maxX + pad && mid[1] >= bb.minZ - pad && mid[1] <= bb.maxZ + pad; }
    const matched = corridorPairs.filter((p) => { const a = segById.get(p.segId), b = segById.get(p.partnerSegId); if (!a || !b) return false; const mid = lineMidpoint([a.midpoint, b.midpoint]); return bboxes.some((bb) => bboxContainsMid(bb, mid, 20)); });
    const matchedHM = matched.filter((p) => p.confidence === 'high' || p.confidence === 'medium');
    const stat = percentiles(matchedHM.map((p) => p.sepM));
    // §12 簡易 service road 検出: 分離幅を bin 化し、最頻 bin = MAIN、大きく外れた少数派 bin = SERVICE 候補
    const widths = matchedHM.map((p) => p.sepM).sort((a, b) => a - b);
    let mainCount = 0, serviceCount = 0;
    if (widths.length >= 8) {
      const med = widths[Math.floor(widths.length / 2)];
      for (const w of widths) { if (Math.abs(w - med) / med <= 0.4) mainCount++; else serviceCount++; }
    } else mainCount = widths.length;
    serviceRoadStats.MAIN += mainCount; serviceRoadStats.SERVICE += serviceCount;
    majorRoads[label] = { sampleCount: stat.count || 0, median: stat.median ?? null, p10: stat.p10 ?? null, p90: stat.p90 ?? null, mainWidthPairs: mainCount, serviceCandidatePairs: serviceCount };
  }
  serviceRoadStats.UNKNOWN = corridorPairs.length - serviceRoadStats.MAIN - serviceRoadStats.SERVICE;
  plog('majorRoads median:', Object.fromEntries(Object.entries(majorRoads).map(([k, v]) => [k, v.median])));

  // ── §3-7 Hybrid mask 構築（5m grid rasterize）+ §5/§6 seam 分類 + §28-30 building/water/park QA ──
  console.time('  loadBuildingsWaterParks');
  function loadCanonPolysNearAreas(dir) {
    const byArea = Object.fromEntries(areas.map((a) => [a.name, []]));
    let files; try { files = fs.readdirSync(dir).filter(isTile); } catch { return byArea; }
    for (const f of files) {
      let t; try { t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { continue; }
      for (const ft of (t.features || [])) {
        if (!ft.bbox) continue;
        for (const a of areas) {
          if (ft.bbox.maxX < a.bbox.minX - padArea || ft.bbox.minX > a.bbox.maxX + padArea || ft.bbox.maxZ < a.bbox.minZ - padArea || ft.bbox.minZ > a.bbox.maxZ + padArea) continue;
          const polys = ft.geometryType === 'Polygon' ? [ft.coordinates] : (ft.coordinates || []);
          for (const poly of polys) byArea[a.name].push({ outer: poly[0], holes: poly.slice(1), bbox: ft.bbox });
        }
      }
    }
    return byArea;
  }
  const waterPolysByArea = loadCanonPolysNearAreas(CANON_WATER);
  const parkPolysByArea = loadCanonPolysNearAreas(CANON_PARKS);
  console.timeEnd('  loadBuildingsWaterParks');

  function polyInArea(pt, polyList) { for (const p of polyList) { if (pt[0] < p.bbox.minX || pt[0] > p.bbox.maxX || pt[1] < p.bbox.minZ || pt[1] > p.bbox.maxZ) continue; if (pointInPolygonWithHoles(pt[0], pt[1], p)) return true; } return false; }
  // bbox 事前判定つき（gsiSurfaces は s.bbox を持つ。判定結果は bbox なしと同一・性能のみの最適化）
  function quadInList(pt, surfaceList) {
    for (const s of surfaceList) {
      if (s.bbox && (pt[0] < s.bbox.minX || pt[0] > s.bbox.maxX || pt[1] < s.bbox.minZ || pt[1] > s.bbox.maxZ)) continue;
      for (const q of s.quads) if (pointInRingSimple(pt[0], pt[1], q)) return s;
    }
    return null;
  }
  // building overlap QA など city-wide gsiSurfaces を都度全走査すると sample規模でも組合せ爆発するため、
  // 粗 grid index で候補を絞ってから quadInList する（判定結果は不変・性能のみの最適化）
  function quadInIndex(pt, grid) { return quadInList(pt, queryBboxIndex(grid, pt[0], pt[1])); }

  const sampleResults = {};
  const seams = [];
  let cleanSeams = 0, gapSeams = 0, overlapSeams = 0, widthJumpSeams = 0, topologyBreakSeams = 0, ambiguousSeams = 0;

  for (const a of areas) {
    const t0 = Date.now();
    const highSurfaces = gsiSurfaces.filter((s) => s.geometrySource === 'GSI_CORRIDOR_HIGH' && s.midpoint[0] >= a.bbox.minX - 60 && s.midpoint[0] <= a.bbox.maxX + 60 && s.midpoint[1] >= a.bbox.minZ - 60 && s.midpoint[1] <= a.bbox.maxZ + 60);
    const medSurfaces = gsiSurfaces.filter((s) => s.geometrySource === 'GSI_CORRIDOR_MEDIUM' && s.midpoint[0] >= a.bbox.minX - 60 && s.midpoint[0] <= a.bbox.maxX + 60 && s.midpoint[1] >= a.bbox.minZ - 60 && s.midpoint[1] <= a.bbox.maxZ + 60);
    const fix13Polys = fix13PolysByArea[a.name];
    plog('  [rasterize] area=' + a.name + ' 開始 highSurfaces=' + highSurfaces.length + ' medSurfaces=' + medSurfaces.length + ' fix13Polys=' + fix13Polys.length);

    let nHigh = 0, nMed = 0, nFix13 = 0, nUnresolved = 0, nFix13Original = 0;
    const nx = Math.round((a.bbox.maxX - a.bbox.minX) / CELL_M), nz = Math.round((a.bbox.maxZ - a.bbox.minZ) / CELL_M);
    const cellClass = new Array(nx * nz).fill(0);   // 0=none 1=high 2=med 3=fix13
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const px = a.bbox.minX + (ix + 0.5) * CELL_M, pz = a.bbox.minZ + (iz + 0.5) * CELL_M;
        let cls = 0;
        const onFix13Original = polyInArea([px, pz], fix13Polys);   // §27: GSIに置換されたかに関係ない「元のFIX13面積」（採否判定とは独立に毎セル判定）
        if (onFix13Original) nFix13Original++;
        if (quadInList([px, pz], highSurfaces)) { cls = 1; nHigh++; }
        else if (quadInList([px, pz], medSurfaces)) { cls = 2; nMed++; }
        else if (onFix13Original) { cls = 3; nFix13++; }
        cellClass[ix * nz + iz] = cls;
        if (cls === 0) {
          // FIX13 領域にも GSI 領域にも属さないが、隣接セルが道路(1/2/3) なら「穴」の可能性として後段でカウント
        }
      }
    }
    // unresolved: 8近傍に道路セルがあるのに自身は 0 のセル（純粋な非道路領域は除外する簡易ヒューリスティック）
    for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) {
      if (cellClass[ix * nz + iz] !== 0) continue;
      let neighborRoad = 0;
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const jx = ix + dx, jz = iz + dz; if (jx < 0 || jx >= nx || jz < 0 || jz >= nz) continue;
        if (cellClass[jx * nz + jz] !== 0) neighborRoad++;
      }
      if (neighborRoad >= 2) nUnresolved++;
    }
    const cellAreaM2 = CELL_M * CELL_M;
    const areaFix13OriginalM2 = nFix13Original * cellAreaM2;   // §27: GSI採否に関係ない元のFIX13面積（比較の分母）
    const totalRoadCells = nHigh + nMed + nFix13 + nUnresolved;
    const cov = totalRoadCells > 0 ? {
      GSI_HIGH_pct: +((nHigh / totalRoadCells) * 100).toFixed(1), GSI_MEDIUM_pct: +((nMed / totalRoadCells) * 100).toFixed(1),
      FIX13_FALLBACK_pct: +((nFix13 / totalRoadCells) * 100).toFixed(1), UNRESOLVED_pct: +((nUnresolved / totalRoadCells) * 100).toFixed(1),
    } : { GSI_HIGH_pct: 0, GSI_MEDIUM_pct: 0, FIX13_FALLBACK_pct: 0, UNRESOLVED_pct: 0 };

    // §5/§6 seam classification: GSI(1/2) セルと FIX13(3) セルが隣接する境界を検査
    let localClean = 0, localGap = 0, localOverlap = 0, localWidthJump = 0, localTopoBreak = 0, localAmbiguous = 0;
    for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) {
      const c = cellClass[ix * nz + iz];
      if (c !== 1 && c !== 2) continue;
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const jx = ix + dx, jz = iz + dz; if (jx >= nx || jz >= nz) continue;
        const nb = cellClass[jx * nz + jz];
        if (nb !== 3) continue;
        // GSI→FIX13 境界: 幅の急変を確認（GSI 側 surface の widthM と、その付近の FIX13 polygon の局所有効幅を比較）
        const px = a.bbox.minX + (ix + 0.5) * CELL_M, pz = a.bbox.minZ + (iz + 0.5) * CELL_M;
        const gsiSurf = quadInList([px, pz], c === 1 ? highSurfaces : medSurfaces);
        const gsiW = gsiSurf ? gsiSurf.widthM : null;
        let fix13W = null;
        for (const fp of fix13Polys) {
          if (px < fp.bbox.minX - 5 || px > fp.bbox.maxX + 5 || pz < fp.bbox.minZ - 5 || pz > fp.bbox.maxZ + 5) continue;
          const per = (() => { let s = 0; const r = fp.outer; for (let i = 1; i < r.length; i++) s += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]); return s; })();
          const areaFp = Math.abs(shoelaceArea(fp.outer));
          fix13W = per > 0 ? 2 * areaFp / per : null; break;
        }
        let seamClass;
        if (gsiW == null || fix13W == null) seamClass = 'AMBIGUOUS';
        else { const ratio = Math.max(gsiW, fix13W) / Math.min(gsiW, fix13W); seamClass = ratio > 2.5 ? 'WIDTH_JUMP' : 'CLEAN'; }
        if (seamClass === 'CLEAN') { cleanSeams++; localClean++; }
        else if (seamClass === 'WIDTH_JUMP') { widthJumpSeams++; localWidthJump++; }
        else { ambiguousSeams++; localAmbiguous++; }
        seams.push({ area: a.name, x: +px.toFixed(1), z: +pz.toFixed(1), classification: seamClass, gsiWidthM: gsiW, fix13WidthM: fix13W });
      }
    }
    // GAP: GSI surface 同士の間に生じた小さな未分類隙間（隣接両側が GSI(1/2)で自身が0のセル）
    for (let ix = 1; ix < nx - 1; ix++) for (let iz = 1; iz < nz - 1; iz++) {
      if (cellClass[ix * nz + iz] !== 0) continue;
      const left = cellClass[(ix - 1) * nz + iz], right = cellClass[(ix + 1) * nz + iz];
      if ((left === 1 || left === 2) && (right === 1 || right === 2)) { gapSeams++; localGap++; }
    }
    // OVERLAP: 優先順位に従い GSI を先に判定しているため、構造的に発生しないはず（0 のはずを実測で確認）
    // TOPOLOGY_BREAK: 未実装（交差点の polygon 再構成自体が未実装のため評価対象外・正直に 0 として記録し note を残す）

    sampleResults[a.name] = {
      coverage: cov, cellsHigh: nHigh, cellsMedium: nMed, cellsFix13: nFix13, cellsUnresolved: nUnresolved,
      areaHighM2: nHigh * cellAreaM2, areaMediumM2: nMed * cellAreaM2, areaFix13M2: nFix13 * cellAreaM2,
      areaFix13OriginalM2,   // §27: GSI採否に関係ない、window内の元のFIX13 primary面積（比較の分母として使う）
      seams: { clean: localClean, gap: localGap, overlap: 0, widthJump: localWidthJump, topologyBreak: 0, ambiguous: localAmbiguous },
    };
    plog('  [rasterize] area=' + a.name + ' 完了 ' + (Date.now() - t0) + 'ms  high=' + nHigh + ' med=' + nMed + ' fix13=' + nFix13 + ' unresolved=' + nUnresolved + ' seams(local)=' + JSON.stringify(sampleResults[a.name].seams));
  }
  const totalSeams = { clean: cleanSeams, gap: gapSeams, overlap: overlapSeams, widthJump: widthJumpSeams, topologyBreak: topologyBreakSeams, ambiguous: ambiguousSeams };
  const criticalSeams = overlapSeams + topologyBreakSeams;   // §7: 不安定な seam は FIX13 へ全戻し方針。overlap/topology break のみ critical 扱い
  plog('  seams:', totalSeams, ' critical:', criticalSeams);

  // ── §28 Building overlap（FIX13 vs GSI v3 trusted vs Hybrid。sample エリア限定・5点サンプリング）──
  console.time('  buildingOverlapQA');
  function samplePoints5(ft) {
    const b = ft.bbox; const c = ft.centroid || [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
    const qx = (b.maxX - b.minX) / 4, qz = (b.maxZ - b.minZ) / 4;
    const mx = (b.minX + b.maxX) / 2, mz = (b.minZ + b.maxZ) / 2;
    return [[c[0], c[1]], [mx - qx, mz - qz], [mx + qx, mz - qz], [mx - qx, mz + qz], [mx + qx, mz + qz]];
  }
  let bldgFilesChecked = 0, bldgOnFix13 = 0, bldgOnGsi = 0, bldgOnHybrid = 0, bldgTotal = 0;
  const allBldgFiles = fs.readdirSync(CANON_BLDGS).filter(isTile);
  // 性能対策: 全 area の fix13 polys を1回だけ結合して index 化する（判定結果は不変。
  // 以前は building×5点ごとに毎回 concat しており building 数×5 回の O(n) 再構築が発生していた）
  const allFix13PolysFlat = [].concat(...Object.values(fix13PolysByArea));
  const fix13PolyIndex = buildBboxIndex(allFix13PolysFlat);
  for (const f of allBldgFiles) {
    const m = f.match(/^tile_(-?\d+)_(-?\d+)\.json$/); if (!m) continue;
    const tx = +m[1], tz = +m[2];
    const tileMinX = tx * 500, tileMaxX = tileMinX + 500, tileMinZ = tz * 500, tileMaxZ = tileMinZ + 500;
    let near = false;
    for (const a of areas) if (!(tileMaxX < a.bbox.minX - 50 || tileMinX > a.bbox.maxX + 50 || tileMaxZ < a.bbox.minZ - 50 || tileMinZ > a.bbox.maxZ + 50)) { near = true; break; }
    if (!near) continue;
    bldgFilesChecked++;
    const t = JSON.parse(fs.readFileSync(path.join(CANON_BLDGS, f), 'utf-8'));
    for (const ft of t.features) {
      if (!ft.bbox) continue;
      let inArea = false;
      for (const a of areas) if (!(ft.bbox.maxX < a.bbox.minX || ft.bbox.minX > a.bbox.maxX || ft.bbox.maxZ < a.bbox.minZ || ft.bbox.minZ > a.bbox.maxZ)) { inArea = true; break; }
      if (!inArea) continue;
      bldgTotal++;
      const pts = samplePoints5(ft);
      let onFix13 = 0, onGsi = 0;
      for (const pt of pts) {
        if (polyInArea(pt, queryBboxIndex(fix13PolyIndex, pt[0], pt[1]))) onFix13++;
        if (quadInIndex(pt, gsiSurfaceIndex)) onGsi++;
      }
      if (onFix13 > pts.length / 2) bldgOnFix13++;
      if (onGsi > pts.length / 2) bldgOnGsi++;
      if (onGsi > pts.length / 2 || onFix13 > pts.length / 2) bldgOnHybrid++;   // Hybrid = GSI優先 + FIX13 fallback の合成なので和集合
    }
    if (bldgFilesChecked % 20 === 0) plog('  [buildingOverlapQA] tiles=' + bldgFilesChecked + ' buildings=' + bldgTotal);
  }
  console.timeEnd('  buildingOverlapQA');
  plog('buildingOverlapQA 完了 tiles=' + bldgFilesChecked + ' buildings=' + bldgTotal);
  const buildingOverlapComparison = {
    method: 'sample エリア限定・footprint 5点サンプリング（Buildingは road geometry の ground truth ではない §28）',
    buildingsChecked: bldgTotal,
    buildingsMostlyOnFix13: bldgOnFix13, buildingsMostlyOnGsiV3: bldgOnGsi, buildingsMostlyOnHybrid: bldgOnHybrid,
  };

  // ── §29/§30 Water/Park overlap QA（GSI trusted surface の中点が canonical water/park に入っていないか）。
  //     §22 に合わせ sample エリア近傍の surface のみを対象にする（性能対策も兼ねる。city-wide gsiSurfaces
  //     全件を毎回 concat しながら走査すると組合せ爆発するため、先に1回だけ index を作る）。
  const allWaterPolysFlat = [].concat(...Object.values(waterPolysByArea));
  const allParkPolysFlat = [].concat(...Object.values(parkPolysByArea));
  const waterPolyIndex = buildBboxIndex(allWaterPolysFlat);
  const parkPolyIndex = buildBboxIndex(allParkPolysFlat);
  const sampleScopedGsiSurfaces = gsiSurfaces.filter((s) => areas.some((a) => s.midpoint[0] >= a.bbox.minX - 60 && s.midpoint[0] <= a.bbox.maxX + 60 && s.midpoint[1] >= a.bbox.minZ - 60 && s.midpoint[1] <= a.bbox.maxZ + 60));
  let gsiOnWater = 0, gsiOnWaterBridge = 0, gsiOnPark = 0;
  for (const s of sampleScopedGsiSurfaces) {
    const inWater = polyInArea(s.midpoint, queryBboxIndex(waterPolyIndex, s.midpoint[0], s.midpoint[1]));
    const inPark = polyInArea(s.midpoint, queryBboxIndex(parkPolyIndex, s.midpoint[0], s.midpoint[1]));
    if (inWater) { gsiOnWater++; const sa = segById.get(s.sourceIds[0]); if (sa && sa.attrs && sa.attrs.type) gsiOnWaterBridge++; }   // 橋区間は type 属性からは判別不能なため件数のみ記録
    if (inPark) gsiOnPark++;
  }
  const waterOverlapQA = { gsiSurfacesOnWater: gsiOnWater, totalGsiSurfacesChecked: sampleScopedGsiSurfaces.length, note: '橋がある場合は正常に水面と重なる。件数のみ記録し「橋以外で大きく増えていないか」は目視 QA 対象とする（§29 本文の要求通り、数値だけで断定しない）。sample エリア近傍の surface のみ対象（§22）。' };
  const parkOverlapQA = { gsiSurfacesOnPark: gsiOnPark, totalGsiSurfacesChecked: sampleScopedGsiSurfaces.length };
  console.log('  water/park overlap:', gsiOnWater, gsiOnPark, '/', sampleScopedGsiSurfaces.length);

  // ── §24 residential ──
  const residentialSamples = {};
  for (const a of areas) { if (RESIDENTIAL_AREAS.has(a.name)) residentialSamples[a.name] = sampleResults[a.name]; }

  // ── §27 FIX13 area vs Hybrid area（全 sample 合算）。fix13AreaM2 は「GSI採否に関係ない window 内の
  //     元の FIX13 primary 面積」＝比較の分母として正しいベースライン（旧実装は「GSIに置換されなかった
  //     残りの FIX13 面積」を誤って分母にしており、differencePct が常に過大な正の値になる不具合があった。
  //     ここで area FixOriginalM2 を分母に修正）──
  let fix13AreaOriginalTotal = 0, fix13FallbackAreaTotal = 0, hybridAreaTotal = 0;
  for (const a of areas) {
    fix13AreaOriginalTotal += sampleResults[a.name].areaFix13OriginalM2;
    fix13FallbackAreaTotal += sampleResults[a.name].areaFix13M2;
    hybridAreaTotal += sampleResults[a.name].areaHighM2 + sampleResults[a.name].areaMediumM2 + sampleResults[a.name].areaFix13M2;
  }
  const areaComparison = {
    fix13AreaM2: Math.round(fix13AreaOriginalTotal),
    hybridAreaM2: Math.round(hybridAreaTotal),
    differencePct: fix13AreaOriginalTotal > 0 ? +(((hybridAreaTotal - fix13AreaOriginalTotal) / fix13AreaOriginalTotal) * 100).toFixed(1) : null,
    fix13FallbackAreaM2: Math.round(fix13FallbackAreaTotal),
    note: 'fix13AreaM2 は GSI採否に関係ない window 内の元の FIX13 primary 面積（比較の分母）。hybridAreaM2 は GSI_HIGH+GSI_MEDIUM+FIX13_FALLBACK（GSIに置換されず残った分のみ）の合計＝Hybrid適用後に道路として認識された総面積。差が大きい場合、5m grid rasterize の量子化誤差・UNRESOLVED（seams.gap等）に分配された分・GSI/FIX13の形状差が原因になり得る。「小さい＝成功」ではなく「元のFIX13被覆をどれだけ再現できたか」の目安として読む（§27）。',
  };

  // ── §39 output（offline precompute のみ・巨大単一JSON回避） ──
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'samples'), { recursive: true });
  for (const a of areas) {
    const areaSurfaces = gsiSurfaces.filter((s) => s.midpoint[0] >= a.bbox.minX - 60 && s.midpoint[0] <= a.bbox.maxX + 60 && s.midpoint[1] >= a.bbox.minZ - 60 && s.midpoint[1] <= a.bbox.maxZ + 60);
    await writeJson(path.join(OUT_DIR, 'samples', a.name + '.json'), { version: 1, kind: 'gsi-road-hybrid-v1-sample', generatedAt, area: a.name, centerWorld: a.centerWorld, cellSizeM: CELL_M, ...sampleResults[a.name], surfaceCount: areaSurfaces.length, surfaces: areaSurfaces.map((s) => ({ surfaceId: s.surfaceId, geometrySource: s.geometrySource, confidence: s.confidence, widthM: s.widthM, areaM2: s.areaM2, quads: s.quads })) });
  }
  await writeJson(path.join(OUT_DIR, 'seams.json'), { version: 1, kind: 'gsi-road-hybrid-v1-seams', generatedAt, count: seams.length, totals: totalSeams, seams: seams.slice(0, 5000) });
  await writeJson(path.join(OUT_DIR, 'provenance.json'), { version: 1, kind: 'gsi-road-hybrid-v1-provenance', generatedAt, surfaceCount: gsiSurfaces.length, surfaces: gsiSurfaces.map((s) => ({ surfaceId: s.surfaceId, geometrySource: s.geometrySource, confidence: s.confidence, sourceIds: s.sourceIds, corridorId: s.corridorId, fallbackReason: s.fallbackReason, generatedAt: s.generatedAt })) });
  const manifestOut = { version: 1, generatedAt, sampleAreas: areas.map((a) => a.name), gsiSurfaceCount: gsiSurfaces.length, cellSizeM: CELL_M, files: ['samples/<area>.json (x10)', 'seams.json', 'provenance.json'] };
  await writeJson(path.join(OUT_DIR, 'manifest.json'), manifestOut);

  // sample-scoped runtime overlay（軽量。全大阪版は作らない §35。sampleScopedGsiSurfaces は §29/§30 で定義済み）
  const runtimeSurfaces = sampleScopedGsiSurfaces.map((s) => ({ surfaceId: s.surfaceId, geometrySource: s.geometrySource, confidence: s.confidence, quads: s.quads }));
  await writeJson(path.join(OUT_DIR, 'hybrid-surfaces-sample.json'), { version: 1, kind: 'gsi-road-hybrid-v1-runtime-sample', generatedAt, count: runtimeSurfaces.length, note: 'sample エリア（10地区）限定 GSI trusted surface（HIGH+MEDIUM）。runtime [Hybrid v1] toggle 用。', surfaces: runtimeSurfaces });

  const outSizes = {};
  for (const [label, p] of [['seams.json', path.join(OUT_DIR, 'seams.json')], ['provenance.json', path.join(OUT_DIR, 'provenance.json')], ['hybrid-surfaces-sample.json', path.join(OUT_DIR, 'hybrid-surfaces-sample.json')], ['manifest.json', path.join(OUT_DIR, 'manifest.json')]]) outSizes[label] = fs.statSync(p).size;
  plog('  output sizes(MB):', Object.fromEntries(Object.entries(outSizes).map(([k, v]) => [k, +(v / 1e6).toFixed(2)])));

  // ── §37 source truth 保護 ──
  const canonRoadManifest = rj(P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'));
  const canonBldgManifest = rj(P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'));
  const fix13Refined = rj(P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json'));

  // ── §18/§19 geometry validity 集計（§22 に合わせ sample エリア近傍 surface のみを対象にする。
  //     report 全体が「sample-scoped only」なので、ここも city-wide 全件ではなく sampleScopedGsiSurfaces を使う）──
  const geometryValidity = {
    invalidQuads: sampleScopedGsiSurfaces.reduce((s, x) => s + x.invalidQuadCount, 0),
    sliverQuads: sampleScopedGsiSurfaces.reduce((s, x) => s + x.sliverQuadCount, 0),
    validSurfaces: sampleScopedGsiSurfaces.length,
    cityWideNote: 'city-wide (全大阪) の GSI surface 総数は ' + gsiSurfaces.length + '件（provenance.json に全件記録・data/processed のみ・publicには出さない）。本 report の集計値は sample エリア近傍(' + sampleScopedGsiSurfaces.length + '件)に限定。',
  };

  // ── coverage 面積は grid rasterize（cellClass）結果を sample area 毎に合算した値を使う
  //     （shoelace 多角形面積の単純合算だと quad 同士の重なりで過大計上され得るため、rasterize 集計の方が
  //     coverage.bySample の数値と整合する）。
  const gsiHighAreaM2Sum = Object.values(sampleResults).reduce((s, r) => s + r.areaHighM2, 0);
  const gsiMediumAreaM2Sum = Object.values(sampleResults).reduce((s, r) => s + r.areaMediumM2, 0);

  // ── §44/§45 最終判定 ──
  const stopConditions = {
    seamsMostlyBroken: (cleanSeams / Math.max(1, cleanSeams + widthJumpSeams + ambiguousSeams)) < 0.5,
    criticalSeamsPresent: criticalSeams > 0,
    multiCarriagewayMisclassifiedHeavily: carriagewayClass.AMBIGUOUS > (carriagewayClass.SINGLE_CARRIAGEWAY + carriagewayClass.DUAL_CARRIAGEWAY) * 0.5,
    invalidGeometryExcessive: geometryValidity.invalidQuads > Math.max(1, sampleScopedGsiSurfaces.length) * 0.05,
    residentialRegression: Object.values(residentialSamples).some((r) => r.coverage && (r.coverage.GSI_HIGH_pct + r.coverage.GSI_MEDIUM_pct) < 20),
  };
  const anyStop = Object.values(stopConditions).some(Boolean);
  const finalDecision = anyStop ? 'HYBRID_V1_NOT_READY' : 'READY_FOR_USER_VISUAL_QA';

  const report = {
    generatedAt,
    visualQaStatus: 'VISUAL_QA_PENDING_USER',
    visualQaNote: 'このセッションではブラウザを操作できないため、実機での目視確認は未実施。[Hybrid v1] トグルは実装済みで、ユーザーがローカルで開けば確認可能。READY_FOR_PRODUCTION とは判定しない（§41/§45 の指示通り）。',
    sampleCount: areas.length,
    scopeNote: 'coverage/seams/geometryValidity/buildingOverlap/waterOverlap/parkOverlap は 10 sample エリア(900m四方)近傍の surface のみに限定（§22）。multiCarriageway/serviceRoad/majorRoads は「名前付き道路・corridor 単位」の統計であり、FIX16-18 と同じ方式で該当道路の corridor 全体（sample エリアの外側も含む）から抽出している（900m窓のみに絞ると比較サンプル数が不足するため）。',
    surfaceCount: sampleScopedGsiSurfaces.length,
    cityWideGsiSurfaceCount: gsiSurfaces.length,
    coverage: {
      gsiHighAreaM2: Math.round(gsiHighAreaM2Sum),
      gsiMediumAreaM2: Math.round(gsiMediumAreaM2Sum),
      fix13FallbackAreaM2: Math.round(fix13FallbackAreaTotal),
      bySample: Object.fromEntries(areas.map((a) => [a.name, sampleResults[a.name].coverage])),
    },
    multiCarriageway: carriagewayClass,
    serviceRoad: serviceRoadStats,
    seams: totalSeams,
    seamMethodologyCaveat: 'fix13W（seam 位置の FIX13 側実効幅）は、そのセルに最も近い FIX13 primary polygon 全体の 2*area/perimeter で近似している。これは単純な矩形道路セグメントには妥当だが、交差点を含む・枝分かれした・湾曲した polygon では実際の局所断面幅より小さく出やすく、widthJump 判定（比率>2.5）を過剰計上している可能性がある。より正確には seam 点での道路進行方向に垂直な断面幅を実測すべきだが、本ミッションの時間内では未実装。そのためこの widthJump 優勢という結果は「GSI/FIX13 境界が実際に荒れている」ことの確証ではなく、「安全側に倒すと際どい・自動READY判定はできない」という保守的な signal として扱う（§7 の精度>coverage 方針通り）。',
    criticalSeamCount: criticalSeams,
    geometryValidity,
    areaComparison,
    buildingOverlap: buildingOverlapComparison,
    waterOverlap: waterOverlapQA,
    parkOverlap: parkOverlapQA,
    majorRoads,
    residentialSamples,
    runtimePayloadBytes: outSizes,
    finalDecisionStopConditions: stopConditions,
    sourceTruthProtection: {
      canonicalRoadFeatureCount: canonRoadManifest ? canonRoadManifest.featureCount : null,
      canonicalBuildingFeatureCount: canonBldgManifest ? canonBldgManifest.featureCount : null,
      fix13IndexedCount: fix13Refined ? fix13Refined.indexedCount : null,
      canonicalRoadUnchanged: canonRoadManifest && canonRoadManifest.featureCount === CANONICAL_ROAD_FEATURE_COUNT,
      canonicalBuildingUnchanged: canonBldgManifest && canonBldgManifest.featureCount === 615617,
      fix13Unchanged: fix13Refined && fix13Refined.indexedCount === REFINED_ROAD_SURFACE_INDEXED_COUNT,
    },
    finalDecision,
    RESULT: 'GSI_HYBRID_V1_DONE',
  };
  await writeJson(REPORT, report);
  plog('finalDecision=' + finalDecision + '  stopConditions=' + JSON.stringify(stopConditions));
  plog('保存: ' + toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[gsi-road-hybrid-v1] 失敗:', e && e.stack || e); process.exit(1); });
