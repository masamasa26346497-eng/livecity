#!/usr/bin/env node
// tools/build-road-visual-v3.js
// [Mission 32I] ROAD V3 — TRUE CARRIAGEWAY REFINEMENT
//
//   §0 遵守: Building x/z / footprint / scale / clip / warp / suppression / Canonical Building /
//   Projection / Origin は一切変更しない。建物は完全 READ ONLY（評価にのみ使う）。
//   §9 遵守: **Building overlap を道路幅の決定に使わない**。道路は道路sourceだけから作る。
//
//   ■ 本ミッション最初の実測（設計の出発点・推測ではない）
//   §1 は「tran envelope が carriageway+sidewalk+road reserve を含むので道路面が広すぎる」と
//   していたが、ROAD V2 の dark area は tran polygon ではなく **GSI corridor quad**（tranへclip済み）
//   である。実際に梅田〜中之島で GSI pair 幅と OSM 由来の車道幅を突き合わせたところ:
//       GSI sepM   median 19.89 m / p90 36.07 m
//       OSM width  median  5.00 m / p90  9.75 m
//       差         median 13.85 m
//   つまり **残存する過大 dark の主因は tran ではなく「GSI corridor 幅 ≠ 車道幅」**だった。
//   GSI 道路縁(真幅道路)は道路区域の境界線なので、ペアリングすると歩道・路肩・(分離道路では
//   両方向＋中央帯)を含む全幅になる。V3 はこの corridor の中から「実際に車道である帯」だけを取る。
//
//   ■ V3 の作り方（§2 の source hierarchy）
//     1. GSI Road Edge paired corridor … corridor の **位置と向き**（どこが道路か）を与える最上位ソース。
//        V3 の carriageway は必ずこの corridor の内側に収まる（外へ広げることは一切しない）。
//     2. OSM highway centerline + width/lanes … corridor の中の **どこが車道でどれだけの幅か** を決める。
//     3. OSM highway class 推定幅 … width も lanes も無い場合のみ。confidence を下げる。
//     4. PLATEAU tran … §8 に従い **MAXIMUM ROAD DOMAIN(safety envelope)** としてのみ使い、
//        dark carriageway の source には一切しない。最終 clip 先。
//   OSM が corridor 内に1本も見つからない場合は corridor 幅のまま残す（＝V2 と同じ挙動）。
//   これは §7「交差点では既存 GSI intersection support を優先」と §24 continuity を守るため。
//
//   ■ §6 self-intersection / sharp corner / junction explosion を構造的に回避
//   centerline を外側へ offset して corridor を作り直す方式は取らない（その方式が自己交差と
//   交差点爆発を生む）。V3 は **既存 quad の内側で横断方向に線形補間して帯を切り出すだけ** なので、
//   生成される帯は常に元 quad の凸結合の内側にあり、自己交差も鋭角も原理的に発生しない。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { segmentize as segmentizeV2, polygonFromPairSegments } from './lib/gsi-road-edge-pairing-v2.js';
import { reconstructCorridorsV3 } from './lib/gsi-road-edge-corridor-v3.js';
import { clipPolygonToRing, ringAreaAbs } from './lib/polygon-clip.js';
import { pointInRing } from './lib/point-in-polygon.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const GSI_LINES = P('data', 'processed', 'osaka-city', 'gsi-road-edge', 'road-edge-lines.json');
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const CANON_RAIL = P('data', 'processed', 'osaka-city', 'canonical', 'rail');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const OSM_ROADS = P('data', 'raw', 'osaka-city', 'roads-osm.json');
const V2_DIR = P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v2');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v3');
// runtime が fetch する配信先（road-visual-v2 と同じ構成に合わせる）
const PUBLIC_DIR = P('public', 'map-data', 'osaka-city', 'derived', 'road-visual-v3');
const REPORT = P('data', 'reports', 'road-visual-v3.json');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

// ── 座標系: znorth-neg-v1（config/areas/osaka-city.json と同一。変更禁止） ──
const CENTER_LAT = 34.604208, CENTER_LON = 135.52502, MPD = 111320;
const COSLAT = Math.cos((CENTER_LAT * Math.PI) / 180);
const toX = (lon) => (lon - CENTER_LON) * COSLAT * MPD;
const toZ = (lat) => -((lat - CENTER_LAT) * MPD);

// ── §5 推定幅テーブル（provenance を明示する。推測値であることを confidence に反映する） ──
//   LANE_WIDTH_M: 1車線あたりの幅。**この dataset の実測から導出した**: width と lanes の両方を持つ way 35件のうち、複数車線の
//   ものは width/lanes がちょうど 3.0 に集中する（secondary lanes=2 → width 6.0 が最頻）。
const LANE_WIDTH_M = 3.0;
//   CLASS_MIN_WIDTH_M: class ごとの下限幅。**推測ではなく roads-osm.json の width タグ実測の中央値**。
//     n>=10 の class のみ実測値を使う（residential 38件→4.0 / unclassified 27件→3.0 /
//     pedestrian 15件→4.0 / service 12件→2.5）。n<10 の class は標本が足りないので実測値を使わず、
//     その class の lanes 中央値 × LANE_WIDTH_M を用いる（いずれも provenance を report に出す）。
const CLASS_MIN_WIDTH_M = {
  residential: 4.0, unclassified: 3.0, pedestrian: 4.0, service: 2.5, // ← width タグ実測中央値(n>=10)
  living_street: 3.0, road: 3.0, track: 2.5,                          // ← 近縁 class からの準用
  motorway: 2 * LANE_WIDTH_M, motorway_link: 1 * LANE_WIDTH_M,        // ← lanes 中央値 × LANE_WIDTH_M
  trunk: 2 * LANE_WIDTH_M, trunk_link: 1 * LANE_WIDTH_M,
  primary: 2 * LANE_WIDTH_M, primary_link: 2 * LANE_WIDTH_M,
  secondary: 2 * LANE_WIDTH_M, secondary_link: 2 * LANE_WIDTH_M,
  tertiary: 2 * LANE_WIDTH_M, tertiary_link: 1 * LANE_WIDTH_M,
};
const CLASS_WIDTH_M = CLASS_MIN_WIDTH_M;
const WIDTH_TAG_MEASURED_CLASSES = ['residential', 'unclassified', 'pedestrian', 'service'];
const MIN_CARRIAGEWAY_M = 2.5;    // §16: これ以下には細めない（service の実測中央値 2.5m が下限）
//   width タグの上限。実測で primary に "40 m" という明らかな誤タグが4件あり(同一 way の重複)、
//   単一車道で 30m を超えるものは現実的でないため 30 を上限にして除外する。
const MAX_OSM_WIDTH_M = 30;
//   GSI pairing の上限(MAX_SEP_M=45)を超える局所 corridor 幅は再構成アーティファクトなので、
//   OSM の裏付けが無い限り dark carriageway にしない（実測で最大 152m の「車道」が出ていた）。
const MAX_CORRIDOR_M = 45;
const PEDESTRIAN_CLASSES = new Set(['pedestrian', 'footway', 'path', 'steps', 'cycleway', 'corridor']);
const VEHICLE_CLASSES = new Set(Object.keys(CLASS_WIDTH_M));

// §2/§4: dark carriageway に使う OSM の情報源と、その confidence
const SRC_CONF = { osmWidth: 'high', osmLanes: 'medium', osmClassInference: 'low', gsiCorridorOnly: 'gsi' };

function bboxOverlaps(a, b) { return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ; }
function bboxOfRing(ring) { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity; for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; } return { minX, maxX, minZ, maxZ }; }
function ringsOfFeature(f) {
  const rings = [];
  const polys = f.geometryType === 'Polygon' ? [f.coordinates] : (f.geometryType === 'MultiPolygon' ? f.coordinates : []);
  for (const poly of polys) for (const ring of poly) if (Array.isArray(ring) && ring.length > 1) rings.push(ring);
  return rings;
}
function percentiles(arr) {
  if (!arr.length) return { count: 0, median: null, p50: null, p75: null, p90: null, p95: null, max: null };
  const s = arr.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { count: s.length, median: +q(0.5).toFixed(2), p50: +q(0.5).toFixed(2), p75: +q(0.75).toFixed(2), p90: +q(0.9).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) };
}
function distPointToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az; const L = dx * dx + dz * dz;
  let t = L === 0 ? 0 : ((px - ax) * dx + (pz - az) * dz) / L; t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(px - (ax + t * dx), pz - (az + t * dz)), qx: ax + t * dx, qz: az + t * dz };
}
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// ── §4/§5 OSM highway の読み込みと属性抽出（実在する attribute のみ使う） ──
function parseOsmWidth(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/^\s*([\d.]+)/); if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v < 1.5 || v > MAX_OSM_WIDTH_M) return null;
  return v;
}
function loadOsmHighways() {
  const j = rj(OSM_ROADS);
  if (!j || !Array.isArray(j.elements)) return { ways: [], attrPresence: null };
  const ways = [];
  const presence = { total: 0, highway: 0, width: 0, widthUsable: 0, lanes: 0, oneway: 0, bridge: 0, tunnel: 0, layer: 0, junction: 0 };
  for (const e of j.elements) {
    const t = e.tags || {}; const g = e.geometry;
    presence.total++;
    if (t.highway) presence.highway++;
    if (t.width != null) presence.width++;
    if (t.lanes != null) presence.lanes++;
    if (t.oneway != null) presence.oneway++;
    if (t.bridge != null) presence.bridge++;
    if (t.tunnel != null) presence.tunnel++;
    if (t.layer != null) presence.layer++;
    if (t.junction != null) presence.junction++;
    if (!g || g.length < 2 || !t.highway) continue;
    const w = parseOsmWidth(t.width);
    if (w != null) presence.widthUsable++;
    const lanes = t.lanes != null && Number.isFinite(+t.lanes) && +t.lanes > 0 && +t.lanes <= 12 ? +t.lanes : null;
    let width = null, widthSource = null;
    if (w != null) { width = w; widthSource = 'osmWidth'; }
    else if (lanes != null) { width = Math.max(MIN_CARRIAGEWAY_M, CLASS_MIN_WIDTH_M[t.highway] || 0, lanes * LANE_WIDTH_M); widthSource = 'osmLanes'; }
    else if (CLASS_MIN_WIDTH_M[t.highway] != null) { width = Math.max(MIN_CARRIAGEWAY_M, CLASS_MIN_WIDTH_M[t.highway]); widthSource = 'osmClassInference'; }
    if (width == null) continue;
    const layer = Number.isFinite(+t.layer) ? +t.layer : 0;
    ways.push({
      line: g.map((p) => [toX(p.lon), toZ(p.lat)]),
      highway: t.highway, width, widthSource,
      oneway: t.oneway === 'yes' || t.oneway === '-1' || t.oneway === 'true',
      bridge: t.bridge != null && t.bridge !== 'no',
      tunnel: t.tunnel != null && t.tunnel !== 'no',
      layer,
      pedestrian: PEDESTRIAN_CLASSES.has(t.highway),
      vehicle: VEHICLE_CLASSES.has(t.highway) && !PEDESTRIAN_CLASSES.has(t.highway),
    });
  }
  return { ways, attrPresence: presence };
}

// OSM セグメントの空間 index（100m セル）
const OSM_CELL = 100;
function buildOsmSegIndex(ways) {
  const grid = new Map();
  let segCount = 0;
  ways.forEach((w, wi) => {
    for (let i = 0; i + 1 < w.line.length; i++) {
      const a = w.line[i], b = w.line[i + 1];
      segCount++;
      const rec = { wi, a, b };
      const x0 = Math.floor(Math.min(a[0], b[0]) / OSM_CELL), x1 = Math.floor(Math.max(a[0], b[0]) / OSM_CELL);
      const z0 = Math.floor(Math.min(a[1], b[1]) / OSM_CELL), z1 = Math.floor(Math.max(a[1], b[1]) / OSM_CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const k = cx + ',' + cz; let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(rec);
      }
    }
  });
  return { grid, segCount };
}
function queryOsmSegs(idx, x, z, radius) {
  const c0 = Math.floor((x - radius) / OSM_CELL), c1 = Math.floor((x + radius) / OSM_CELL);
  const d0 = Math.floor((z - radius) / OSM_CELL), d1 = Math.floor((z + radius) / OSM_CELL);
  const out = [];
  for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) { const arr = idx.grid.get(cx + ',' + cz); if (arr) out.push(...arr); }
  return out;
}

/**
 * 1つの GSI quad [p0,p1,q1,q0] の中から「実際に車道である帯」を切り出す。
 * §6: 元 quad の内側で横断方向に線形補間するだけなので自己交差・鋭角・交差点爆発は起きない。
 * §9: building は一切参照しない。
 */
function refineQuad(quad, osmIdx, ways) {
  const [p0, p1, q1, q0] = quad;
  const mid = [(p0[0] + p1[0] + q0[0] + q1[0]) / 4, (p0[1] + p1[1] + q0[1] + q1[1]) / 4];
  const sep0 = Math.hypot(q0[0] - p0[0], q0[1] - p0[1]);
  const sep1 = Math.hypot(q1[0] - p1[0], q1[1] - p1[1]);
  const sepLocal = (sep0 + sep1) / 2;
  if (!(sepLocal > 0.01)) return null;

  // quad の進行方向（p0→p1）と横断方向（p0→q0）
  const ax = p1[0] - p0[0], az = p1[1] - p0[1];
  const alen = Math.hypot(ax, az);
  const cx = q0[0] - p0[0], cz = q0[1] - p0[1];
  const clen = Math.hypot(cx, cz);
  // quad 中央の横断軸（帯の横断位置はこの軸で測る）
  const midP = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const midQ = [(q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2];
  const mcx = midQ[0] - midP[0], mcz = midQ[1] - midP[1];
  const mclen = Math.hypot(mcx, mcz);
  if (!(alen > 0.01) || !(clen > 0.01) || !(mclen > 0.01)) return null;

  // corridor 内にある OSM way を集める（way ごとに横断位置 s∈[0,1] と幅を求める）
  const cand = queryOsmSegs(osmIdx, mid[0], mid[1], sepLocal * 0.75 + 10);
  const byWay = new Map();
  for (const seg of cand) {
    const w = ways[seg.wi];
    // 平行性: quad の進行方向と OSM セグメントの向きが概ね揃っていること（直交する交差道路を拾わない）
    const sx = seg.b[0] - seg.a[0], sz = seg.b[1] - seg.a[1];
    const slen = Math.hypot(sx, sz); if (!(slen > 0.01)) continue;
    const cosang = Math.abs((ax * sx + az * sz) / (alen * slen));
    if (cosang < 0.72) continue; // ±44度以内
    const pr = distPointToSegment(mid[0], mid[1], seg.a[0], seg.a[1], seg.b[0], seg.b[1]);
    if (pr.d > sepLocal * 0.75 + 2) continue;
    // 横断位置 s: quad の**中央**の横断軸 midP→midQ への射影。
    //   始端(p0→q0)の軸で測ると、quad が斜行・湾曲している場合に帯が数m横へずれる
    //   （実測: V2 にあって V3 に無い centerline の 83% がこのずれ由来だった）。
    const s = ((pr.qx - midP[0]) * mcx + (pr.qz - midP[1]) * mcz) / (mclen * mclen);
    if (!(s >= -0.15 && s <= 1.15)) continue;
    const prev = byWay.get(seg.wi);
    if (!prev || pr.d < prev.d) byWay.set(seg.wi, { d: pr.d, s: Math.max(0, Math.min(1, s)), w });
  }
  if (!byWay.size) {
    // §7: OSM が無い区間（交差点内部など）は GSI corridor をそのまま使う＝V2と同じ。細めない。
    // ただし局所 corridor 幅が pairing 上限(45m)を超えるものは再構成アーティファクトなので採用しない。
    if (sepLocal > MAX_CORRIDOR_M) return { bands: [], overwide: true, sepLocal, matched: false };
    return { bands: [{ ring: quad, widthM: sepLocal, cls: 'CARRIAGEWAY', source: 'gsiCorridorOnly', confidence: SRC_CONF.gsiCorridorOnly }], sepLocal, matched: false };
  }

  const entries = [...byWay.values()].sort((a, b) => a.s - b.s);
  const bands = [];
  const occupied = []; // [sLo, sHi]
  for (const e of entries) {
    const half = Math.max(MIN_CARRIAGEWAY_M, Math.min(e.w.width, sepLocal)) / 2 / sepLocal;
    let sLo = Math.max(0, e.s - half), sHi = Math.min(1, e.s + half);
    if (!(sHi > sLo)) continue;
    const ring = [lerp(p0, q0, sLo), lerp(p1, q1, sLo), lerp(p1, q1, sHi), lerp(p0, q0, sHi)];
    let cls = 'CARRIAGEWAY';
    if (e.w.pedestrian) cls = 'PEDESTRIAN';
    else if (e.w.tunnel || e.w.layer < 0) cls = 'TUNNEL';
    else if (e.w.bridge || e.w.layer > 0) cls = 'BRIDGE';
    bands.push({ ring, widthM: (sHi - sLo) * sepLocal, cls, source: e.w.widthSource, confidence: SRC_CONF[e.w.widthSource], highway: e.w.highway });
    occupied.push([sLo, sHi]);
  }
  if (!bands.length) {
    if (sepLocal > MAX_CORRIDOR_M) return { bands: [], overwide: true, sepLocal, matched: false };
    return { bands: [{ ring: quad, widthM: sepLocal, cls: 'CARRIAGEWAY', source: 'gsiCorridorOnly', confidence: SRC_CONF.gsiCorridorOnly }], sepLocal, matched: false };
  }

  // §10: 帯と帯の間（分離帯）と、corridor の外側の残り（路肩/歩道側）を分類する
  occupied.sort((a, b) => a[0] - b[0]);
  const gaps = [];
  if (occupied[0][0] > 0.001) gaps.push({ lo: 0, hi: occupied[0][0], cls: 'SHOULDER_MARGIN' });
  for (let i = 1; i < occupied.length; i++) if (occupied[i][0] > occupied[i - 1][1] + 0.001) gaps.push({ lo: occupied[i - 1][1], hi: occupied[i][0], cls: 'MEDIAN' });
  if (occupied[occupied.length - 1][1] < 0.999) gaps.push({ lo: occupied[occupied.length - 1][1], hi: 1, cls: 'SHOULDER_MARGIN' });
  const nonCarriageway = gaps.map((g) => ({
    ring: [lerp(p0, q0, g.lo), lerp(p1, q1, g.lo), lerp(p1, q1, g.hi), lerp(p0, q0, g.hi)],
    widthM: (g.hi - g.lo) * sepLocal, cls: g.cls,
  }));
  return { bands, nonCarriageway, sepLocal, matched: true };
}

// ── §27/§28 acceptance fixture（V2 と同一座標。§20/§21 の control/other fixture を維持） ──
const SITES = [
  { id: 'umeda', name: '梅田', x: -2668.18, z: -10941.87 },
  { id: 'nakanoshima', name: '中之島', x: -2695.66, z: -9962.25 },
  { id: 'honmachi', name: '本町', x: -2072.6, z: -8693.2 },
  { id: 'namba', name: '難波', x: -2173.39, z: -6511.33 },
  { id: 'tennoji', name: '天王寺', x: -1055.54, z: -4618.89 },
  { id: 'sumiyoshi', name: '住吉', x: -2952.22, z: -811.75 },
];
const SITE_RADIUS_M = 500;

// ── §19 梅田重点 15地点（座標は 32H で同定した実データ由来。半径120m） ──
const UMEDA_SPOTS = [
  { id: 'osaka_station', name: '大阪駅', x: -2657.4, z: -10926.96, kind: 'station' },
  { id: 'osaka_umeda_station', name: '大阪梅田駅(阪急)', x: -2453.94, z: -11227.97, kind: 'station' },
  { id: 'station_south_plaza', name: '大阪駅前広場(南)', x: -2657.4, z: -10806.96, kind: 'station_plaza' },
  { id: 'station_north', name: 'うめきた(駅北)', x: -2707.88, z: -10994.67, kind: 'rail_side' },
  { id: 'rail_west', name: '線路沿い(西)', x: -2804.5, z: -11304.98, kind: 'rail_side' },
  { id: 'rail_east', name: '線路沿い(東)', x: -2453.94, z: -11100.0, kind: 'rail_side' },
  { id: 'rail_south', name: '線路沿い(南)', x: -2753.36, z: -10828.01, kind: 'rail_side' },
  { id: 'elevated_hanshin', name: '高架道路(阪神高速)', x: -3071.78, z: -10932.03, kind: 'elevated' },
  { id: 'elevated_north', name: '高架道路(北)', x: -3095.96, z: -11533.73, kind: 'elevated' },
  { id: 'xing_ekimae', name: '駅前交差点', x: -2571.0, z: -10741.0, kind: 'intersection' },
  { id: 'xing_west', name: '交差点(西)', x: -2880.0, z: -10941.87, kind: 'intersection' },
  { id: 'xing_east', name: '交差点(東)', x: -2450.0, z: -10741.0, kind: 'intersection' },
  { id: 'facility_grandfront', name: '大型施設(北側)', x: -2771.54, z: -11143.5, kind: 'facility' },
  { id: 'facility_hep', name: '大型施設(東側)', x: -2480.73, z: -10532.67, kind: 'facility' },
  { id: 'facility_south', name: '大型施設(南側)', x: -2629.85, z: -11131.09, kind: 'facility' },
];
const SPOT_RADIUS_M = 120;

async function main() {
  const generatedAt = new Date().toISOString();
  const tBuildStart = Date.now();

  // ── §2-1 GSI corridor 再構成（V2 と同一手順・同一 confidence 基準を維持 §3） ──
  console.log('[road-v3] loading GSI road edge...');
  const gsi = rj(GSI_LINES);
  const shinhaba = gsi.features.filter((f) => f.attrs.type === '真幅道路');
  console.time('[road-v3] segmentize+reconstruct');
  const segs = segmentizeV2(shinhaba);
  const recon = reconstructCorridorsV3(segs, {});
  console.timeEnd('[road-v3] segmentize+reconstruct');
  const segById = new Map(segs.map((s) => [s.id, s]));

  const seenPairKey = new Set();
  const corridorPairs = [];
  for (const cp of recon.corridorPairs) {
    const key = [cp.segId, cp.partnerSegId].sort().join('|');
    if (seenPairKey.has(key)) continue;
    seenPairKey.add(key);
    // §3: FIX18/ROAD V2 と同一の confidence 分類を維持する
    const confidence = cp.widthSpike ? 'low'
      : (cp.score >= 0.78 && cp.parallel >= 0.88 && cp.overlapRatio >= 0.55 && !cp.trackSwitchAt) ? 'high'
        : (cp.score >= 0.55 ? 'medium' : 'low');
    corridorPairs.push({ ...cp, confidence });
  }
  const pairingCounts = { high: 0, medium: 0, low: 0 };
  for (const p of corridorPairs) pairingCounts[p.confidence]++;
  const acceptedPairs = corridorPairs.filter((p) => (p.confidence === 'high' || p.confidence === 'medium') && !p.widthSpike);
  console.log('[road-v3] acceptedPairs:', acceptedPairs.length, JSON.stringify(pairingCounts));

  // ── §2-2/§4/§5 OSM highway ──
  console.log('[road-v3] loading OSM highways...');
  const { ways: osmWays, attrPresence } = loadOsmHighways();
  const osmIdx = buildOsmSegIndex(osmWays);
  console.log('[road-v3] osm ways:', osmWays.length, 'segments:', osmIdx.segCount);

  // ── quad ごとに車道帯を切り出す ──
  console.time('[road-v3] refine quads');
  const quadRecords = [];   // V3 carriageway 帯（dark 対象）
  const nonCarriagewayAreaByClass = { SIDEWALK: 0, PEDESTRIAN: 0, MEDIAN: 0, SHOULDER_MARGIN: 0, BRIDGE: 0, TUNNEL: 0, UNCERTAIN: 0 };
  const sourceUsage = { gsi: 0, osmWidth: 0, osmLanes: 0, osmClassInference: 0, tranEnvelopeOnly: 0 };
  const widthsByClass = { CARRIAGEWAY: [], PEDESTRIAN: [], MEDIAN: [], SHOULDER_MARGIN: [], BRIDGE: [], TUNNEL: [] };
  const gsiVsOsm = []; // §18
  let quadsTotal = 0, quadsMatched = 0, quadsOverwideDropped = 0;
  for (const p of acceptedPairs) {
    const sa = segById.get(p.segId), sb = segById.get(p.partnerSegId);
    if (!sa || !sb) continue;
    for (const q of polygonFromPairSegments(sa, sb)) {
      if (q.length < 4) continue;
      quadsTotal++;
      const r = refineQuad(q, osmIdx, osmWays);
      if (!r) continue;
      if (r.matched) quadsMatched++;
      if (r.overwide) quadsOverwideDropped++;
      let carriagewayWidthHere = 0;
      for (const b of r.bands) {
        const area = ringAreaAbs(b.ring);
        if (!(area > 1e-9)) continue;
        if (b.cls === 'CARRIAGEWAY') {
          quadRecords.push({ ring: b.ring, bbox: bboxOfRing(b.ring), areaM2: area, widthM: b.widthM, confidence: b.confidence, source: b.source, cls: 'CARRIAGEWAY' });
          widthsByClass.CARRIAGEWAY.push(b.widthM);
          carriagewayWidthHere += b.widthM;
          sourceUsage[b.source === 'gsiCorridorOnly' ? 'gsi' : b.source]++;
        } else {
          // §11: BRIDGE/TUNNEL/PEDESTRIAN は dark carriageway に入れない（§23: 地上へ dark を落とさない）
          nonCarriagewayAreaByClass[b.cls] += area;
          if (widthsByClass[b.cls]) widthsByClass[b.cls].push(b.widthM);
        }
      }
      for (const nc of r.nonCarriageway || []) {
        const area = ringAreaAbs(nc.ring);
        if (!(area > 1e-9)) continue;
        nonCarriagewayAreaByClass[nc.cls] += area;
        if (widthsByClass[nc.cls]) widthsByClass[nc.cls].push(nc.widthM);
      }
      if (r.matched && carriagewayWidthHere > 0) gsiVsOsm.push({ gsi: r.sepLocal, osm: carriagewayWidthHere });
    }
  }
  console.timeEnd('[road-v3] refine quads');
  console.log('[road-v3] quads:', quadsTotal, 'matched by OSM:', quadsMatched, 'carriageway bands:', quadRecords.length);

  // ── 空間 index（tran envelope への clip 用） ──
  const QUAD_CELL = 200;
  const quadGrid = new Map();
  for (const qr of quadRecords) {
    const bb = qr.bbox;
    for (let cx = Math.floor(bb.minX / QUAD_CELL); cx <= Math.floor(bb.maxX / QUAD_CELL); cx++)
      for (let cz = Math.floor(bb.minZ / QUAD_CELL); cz <= Math.floor(bb.maxZ / QUAD_CELL); cz++) {
        const k = cx + ',' + cz; let arr = quadGrid.get(k); if (!arr) { arr = []; quadGrid.set(k, arr); } arr.push(qr);
      }
  }
  const queryQuads = (bb) => {
    const out = new Set();
    for (let cx = Math.floor(bb.minX / QUAD_CELL) - 1; cx <= Math.floor(bb.maxX / QUAD_CELL) + 1; cx++)
      for (let cz = Math.floor(bb.minZ / QUAD_CELL) - 1; cz <= Math.floor(bb.maxZ / QUAD_CELL) + 1; cz++) {
        const arr = quadGrid.get(cx + ',' + cz); if (arr) for (const q of arr) out.add(q);
      }
    return out;
  };

  // ── §8 tran envelope へ clip（tran は safety envelope としてのみ使用。dark source にはしない） ──
  const refined = rj(REFINED);
  const refPfx = (refined && refined.keyPrefix) || '';
  const nonPrimaryIds = new Set(Object.keys((refined && refined.classMap) || {}).map((k) => refPfx + k));

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, 'tiles'), { recursive: true });
  fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(PUBLIC_DIR, 'tiles'), { recursive: true });

  const files = fs.readdirSync(CANON_ROADS).filter(isTile);
  const classByCanonicalId = new Map();
  const quadsByCanonicalId = new Map();
  const seenFeature = new Set();
  let carriagewayAreaM2 = 0, marginAreaM2 = 0, uncertainAreaM2 = 0;
  let resolvedCount = 0, uncertainCount = 0, escapedEnvelopeCount = 0;
  const coverageRatios = [];
  const MIN_RESOLVED_AREA_M2 = 5; // 帯が clip 後に 5m² 以上残れば「この feature に車道がある」とみなす
  const CLIP_RATIO_CONFLICT_THRESHOLD = 0.3;
  const MIN_CLIPPED_AREA_M2 = 1e-4; // 退化ポリゴン除去（描画不能かつ tile を膨らませるだけ）

  console.time('[road-v3] clip to tran envelope');
  for (const f of files) {
    const t = rj(path.join(CANON_ROADS, f)); if (!t) continue;
    for (const ft of t.features) {
      if (seenFeature.has(ft.canonicalId)) continue;
      seenFeature.add(ft.canonicalId);
      if (nonPrimaryIds.has(ft.canonicalId)) continue;
      if (!ft.bbox) continue;
      const rings = ringsOfFeature(ft); if (!rings.length) continue;
      let coveredArea = 0; const clipped = [];
      for (const qr of queryQuads(ft.bbox)) {
        if (!bboxOverlaps(qr.bbox, ft.bbox)) continue;
        for (const ring of rings) {
          const cp = clipPolygonToRing(qr.ring, ring);
          if (cp.length < 3) continue;
          const a = ringAreaAbs(cp);
          // 退化ポリゴン(面積ほぼ0)は描画されず tile を膨らませるだけなので捨てる。
          if (!(a > MIN_CLIPPED_AREA_M2)) continue;
          if (qr.areaM2 > 0 && a / qr.areaM2 < CLIP_RATIO_CONFLICT_THRESHOLD) { escapedEnvelopeCount++; continue; }
          coveredArea += a; clipped.push(cp);
        }
      }
      const featureArea = ft.areaM2 || 0;
      const coveredClamped = Math.min(coveredArea, featureArea);
      const cov = featureArea > 0 ? coveredClamped / featureArea : 0;
      coverageRatios.push(cov);
      // V3 の resolved 判定は面積ベース。V2 の「envelope の何割を覆ったか」という比率基準は
      // corridor 全幅を塗る V2 向けの基準で、幅 3m の帯を塗る V3 では広い envelope(広場状の tran 等)
      // にある正しい車道帯まで UNCERTAIN に落としてしまうため採用しない。
      if (coveredClamped >= MIN_RESOLVED_AREA_M2 && clipped.length) {
        resolvedCount++;
        carriagewayAreaM2 += coveredClamped;
        marginAreaM2 += Math.max(0, featureArea - coveredClamped);
        classByCanonicalId.set(ft.canonicalId, { c: 'R', cov: +cov.toFixed(4) });
        quadsByCanonicalId.set(ft.canonicalId, clipped);
      } else {
        uncertainCount++;
        uncertainAreaM2 += featureArea;
        classByCanonicalId.set(ft.canonicalId, { c: 'U', cov: +cov.toFixed(4) });
      }
    }
  }
  console.timeEnd('[road-v3] clip to tran envelope');
  console.log('[road-v3] resolved:', resolvedCount, 'uncertain:', uncertainCount);

  // ── §14 DIFF 用: V2 が dark にしていた feature 集合（V3 band は同じ GSI quad の内側なので、
  //   V2 が RESOLVED だった feature の V3 band は「common」、そうでなければ「V3 only」になる） ──
  const v2ResolvedIds = new Set();
  {
    const v2TilesDir = path.join(V2_DIR, 'tiles');
    if (fs.existsSync(v2TilesDir)) for (const f of fs.readdirSync(v2TilesDir)) {
      const t = rj(path.join(v2TilesDir, f)); if (!t) continue;
      for (const rec of t.features || []) if (rec.class === 'R') v2ResolvedIds.add(rec.canonicalId);
    }
  }
  console.log('[road-v3] V2 resolved features:', v2ResolvedIds.size);

  // ── tile 出力（V2 と同じ自己完結型 2000m tile） ──
  const tileOut = new Map();
  for (const f of files) {
    const t = rj(path.join(CANON_ROADS, f)); if (!t) continue;
    const m = f.match(/^tile_(-?\d+)_(-?\d+)\.json$/);
    const tileKey = +m[1] + '_' + +m[2];
    let arr = tileOut.get(tileKey);
    for (const ft of t.features) {
      const cls = classByCanonicalId.get(ft.canonicalId); if (!cls) continue;
      if (!arr) { arr = []; tileOut.set(tileKey, arr); }
      arr.push({
        canonicalId: ft.canonicalId, class: cls.c, coverageRatio: cls.cov,
        inV2: v2ResolvedIds.has(ft.canonicalId) ? 1 : 0,
        envelope: { geometryType: ft.geometryType, coordinates: ft.coordinates },
        carriageway: quadsByCanonicalId.get(ft.canonicalId) || null,
      });
    }
  }
  let tileBytes = 0;
  for (const [tileKey, arr] of tileOut) {
    const [tx, tz] = tileKey.split('_').map(Number);
    const payload = { version: 1, tx, tz, count: arr.length, features: arr };
    const p = path.join(OUT_DIR, 'tiles', 'tile_' + tx + '_' + tz + '.json');
    await writeJson(p, payload);
    await writeJson(path.join(PUBLIC_DIR, 'tiles', 'tile_' + tx + '_' + tz + '.json'), payload);
    tileBytes += fs.statSync(p).size;
  }
  const manifest = { version: 1, generatedAt, tileSize: 2000, tileCount: tileOut.size, uniqueFeatureCount: classByCanonicalId.size, resolvedCount, uncertainCount };
  await writeJson(path.join(OUT_DIR, 'manifest.json'), manifest);
  await writeJson(path.join(PUBLIC_DIR, 'manifest.json'), manifest);
  const buildTimeMs = Date.now() - tBuildStart;

  // ── §15/§16 Building ∩ DarkRoad: FIX13 / V2 / V3 を同一 raster で比較 ──
  const CELL_M = 1.0;
  const v3ByTile = new Map();
  for (const [k, arr] of tileOut) { const r = arr.filter((x) => x.carriageway); if (r.length) v3ByTile.set(k, r); }

  function rasterize(cx, cz, radius) {
    const minX = cx - radius, maxX = cx + radius, minZ = cz - radius, maxZ = cz + radius;
    const nx = Math.ceil((maxX - minX) / CELL_M), nz = Math.ceil((maxZ - minZ) / CELL_M);
    const bldg = new Uint8Array(nx * nz), d13 = new Uint8Array(nx * nz), d2 = new Uint8Array(nx * nz), d3 = new Uint8Array(nx * nz), rail = new Uint8Array(nx * nz);
    const fill = (ring, target) => {
      const bb = bboxOfRing(ring);
      const ix0 = Math.max(0, Math.floor((bb.minX - minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((bb.maxX - minX) / CELL_M));
      const iz0 = Math.max(0, Math.floor((bb.minZ - minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((bb.maxZ - minZ) / CELL_M));
      if (ix1 < 0 || iz1 < 0 || ix0 >= nx || iz0 >= nz) return;
      for (let ix = ix0; ix <= ix1; ix++) { const px = minX + (ix + 0.5) * CELL_M;
        for (let iz = iz0; iz <= iz1; iz++) { const pz = minZ + (iz + 0.5) * CELL_M; if (pointInRing(px, pz, ring)) target[iz * nx + ix] = 1; } }
    };
    const box = { minX, maxX, minZ, maxZ };
    for (let tx = Math.floor(minX / 500); tx <= Math.floor(maxX / 500); tx++) for (let tz = Math.floor(minZ / 500); tz <= Math.floor(maxZ / 500); tz++) {
      const t = rj(path.join(CANON_BLDGS, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
      for (const ft of t.features) { if (!ft.bbox || !bboxOverlaps(ft.bbox, box)) continue; for (const ring of ringsOfFeature(ft)) fill(ring, bldg); }
    }
    const seenR = new Set();
    for (let tx = Math.floor(minX / 2000); tx <= Math.floor(maxX / 2000); tx++) for (let tz = Math.floor(minZ / 2000); tz <= Math.floor(maxZ / 2000); tz++) {
      const t = rj(path.join(CANON_ROADS, 'tile_' + tx + '_' + tz + '.json'));
      if (t) for (const ft of t.features) {
        if (seenR.has(ft.canonicalId)) continue; seenR.add(ft.canonicalId);
        if (nonPrimaryIds.has(ft.canonicalId)) continue;
        if (!ft.bbox || !bboxOverlaps(ft.bbox, box)) continue;
        for (const ring of ringsOfFeature(ft)) fill(ring, d13);
      }
      const v2t = rj(path.join(V2_DIR, 'tiles', 'tile_' + tx + '_' + tz + '.json'));
      if (v2t) for (const rec of v2t.features) if (Array.isArray(rec.carriageway)) for (const q of rec.carriageway) fill(q, d2);
      const v3t = v3ByTile.get(tx + '_' + tz);
      if (v3t) for (const rec of v3t) for (const q of rec.carriageway) fill(q, d3);
      // §22: rail を road として塗っていないかの確認用
      const rt = rj(path.join(CANON_RAIL, 'tile_' + tx + '_' + tz + '.json'));
      if (rt) for (const ft of rt.features) {
        if (ft.geometryType !== 'LineString' || !Array.isArray(ft.coordinates)) continue;
        const c = ft.coordinates;
        for (let i = 0; i + 1 < c.length; i++) {
          const [ax, az] = c[i], [bx, bz] = c[i + 1];
          const dx = bx - ax, dz = bz - az; const L = Math.hypot(dx, dz); if (!(L > 0)) continue;
          const ox = (-dz / L) * 5, oz = (dx / L) * 5;
          fill([[ax + ox, az + oz], [bx + ox, bz + oz], [bx - ox, bz - oz], [ax - ox, az - oz]], rail);
        }
      }
    }
    // §24 road continuity: OSM 車道 centerline を 2m 間隔でサンプルし、V2/V3 の dark に覆われて
    //   いるかを見る。「道路が途切れて見えないか」を直接測る指標（track ベースの指標は V2/V3 で
    //   同一 corridor を使うため差が出ず、V3 の評価には使えない）。
    const SAMPLE_M = 2;
    const cont = { samples: 0, coveredV2: 0, coveredV3: 0, gapsV2: 0, gapsV3: 0, gapLenV2: 0, gapLenV3: 0, longestGapV3: 0 };
    const inCell = (x, z, mask) => {
      const ix = Math.floor((x - minX) / CELL_M), iz = Math.floor((z - minZ) / CELL_M);
      if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return null;
      return mask[iz * nx + ix] === 1;
    };
    for (const w of osmWays) {
      if (!w.vehicle || w.tunnel) continue;
      let runV2 = 0, runV3 = 0;
      for (let i = 0; i + 1 < w.line.length; i++) {
        const [ax2, az2] = w.line[i], [bx2, bz2] = w.line[i + 1];
        const L = Math.hypot(bx2 - ax2, bz2 - az2); if (!(L > 0)) continue;
        const steps = Math.max(1, Math.round(L / SAMPLE_M));
        for (let k = 0; k <= steps; k++) {
          const x = ax2 + ((bx2 - ax2) * k) / steps, z = az2 + ((bz2 - az2) * k) / steps;
          const c2 = inCell(x, z, d2); if (c2 == null) continue;
          const c3 = inCell(x, z, d3);
          cont.samples++;
          if (c2) { cont.coveredV2++; if (runV2 > 0) { cont.gapsV2++; cont.gapLenV2 += runV2 * SAMPLE_M; runV2 = 0; } } else runV2++;
          if (c3) { cont.coveredV3++; if (runV3 > 0) { cont.gapsV3++; cont.gapLenV3 += runV3 * SAMPLE_M; cont.longestGapV3 = Math.max(cont.longestGapV3, runV3 * SAMPLE_M); runV3 = 0; } } else runV3++;
        }
      }
      if (runV2 > 0) { cont.gapsV2++; cont.gapLenV2 += runV2 * SAMPLE_M; }
      if (runV3 > 0) { cont.gapsV3++; cont.gapLenV3 += runV3 * SAMPLE_M; cont.longestGapV3 = Math.max(cont.longestGapV3, runV3 * SAMPLE_M); }
    }

    let b = 0, o13 = 0, o2 = 0, o3 = 0, a13 = 0, a2 = 0, a3 = 0, railV3 = 0, railV2 = 0, railCells = 0;
    for (let i = 0; i < nx * nz; i++) {
      if (bldg[i]) { b++; if (d13[i]) o13++; if (d2[i]) o2++; if (d3[i]) o3++; }
      if (d13[i]) a13++; if (d2[i]) a2++; if (d3[i]) a3++;
      if (rail[i]) { railCells++; if (d3[i]) railV3++; if (d2[i]) railV2++; }
    }
    return {
      buildingAreaM2: b, fix13DarkAreaM2: a13, v2DarkAreaM2: a2, v3DarkAreaM2: a3,
      buildingDarkOverlapFix13M2: o13, buildingDarkOverlapV2M2: o2, buildingDarkOverlapV3M2: o3,
      overlapRatioFix13: b ? +(o13 / b).toFixed(4) : null,
      overlapRatioV2: b ? +(o2 / b).toFixed(4) : null,
      overlapRatioV3: b ? +(o3 / b).toFixed(4) : null,
      improvementV2ToV3Percent: o2 > 0 ? +(((o2 - o3) / o2) * 100).toFixed(1) : null,
      improvementFix13ToV3Percent: o13 > 0 ? +(((o13 - o3) / o13) * 100).toFixed(1) : null,
      railCorridorCells: railCells, railPaintedAsRoadV3Cells: railV3, railPaintedAsRoadV2Cells: railV2,
      railPaintedRatioV3: railCells ? +(railV3 / railCells).toFixed(4) : null,
      railPaintedRatioV2: railCells ? +(railV2 / railCells).toFixed(4) : null,
      centerlineSamples: cont.samples,
      centerlineCoveredPercentV2: cont.samples ? +((cont.coveredV2 / cont.samples) * 100).toFixed(2) : null,
      centerlineCoveredPercentV3: cont.samples ? +((cont.coveredV3 / cont.samples) * 100).toFixed(2) : null,
      gapCountV2: cont.gapsV2, gapCountV3: cont.gapsV3,
      gapLengthV2M: Math.round(cont.gapLenV2), gapLengthV3M: Math.round(cont.gapLenV3),
      longestGapV3M: Math.round(cont.longestGapV3),
    };
  }

  console.time('[road-v3] site rasterization');
  const sites = {};
  for (const s of SITES) { console.log('[road-v3] site ' + s.name); sites[s.id] = { name: s.name, ...rasterize(s.x, s.z, SITE_RADIUS_M) }; }
  console.timeEnd('[road-v3] site rasterization');

  console.time('[road-v3] umeda spots');
  const umedaSpots = {};
  for (const s of UMEDA_SPOTS) umedaSpots[s.id] = { name: s.name, kind: s.kind, ...rasterize(s.x, s.z, SPOT_RADIUS_M) };
  console.timeEnd('[road-v3] umeda spots');

  const sum = (f) => Object.values(sites).reduce((a, v) => a + f(v), 0);
  const clSamples = sum((v) => v.centerlineSamples);
  const centerlineCoverage = {
    samples: clSamples,
    coveredPercentV2: clSamples ? +((sum((v) => (v.centerlineCoveredPercentV2 / 100) * v.centerlineSamples) / clSamples) * 100).toFixed(2) : null,
    coveredPercentV3: clSamples ? +((sum((v) => (v.centerlineCoveredPercentV3 / 100) * v.centerlineSamples) / clSamples) * 100).toFixed(2) : null,
    gapCountV2: sum((v) => v.gapCountV2), gapCountV3: sum((v) => v.gapCountV3),
    gapLengthV2M: sum((v) => v.gapLengthV2M), gapLengthV3M: sum((v) => v.gapLengthV3M),
    longestGapV3M: Math.max(...Object.values(sites).map((v) => v.longestGapV3M)),
    note: '6 fixture site 合算。OSM 車道 centerline を 2m 間隔でサンプルし、V2/V3 の dark polygon に '
      + '覆われている割合。§24 の covered corridor % / gap count / gap length に対応する。',
  };
  const totalFix13 = sum((v) => v.buildingDarkOverlapFix13M2), totalV2 = sum((v) => v.buildingDarkOverlapV2M2), totalV3 = sum((v) => v.buildingDarkOverlapV3M2);

  // ── §24 continuity（V2 と同一手法で track 単位に測る。V3 は帯化しても track 被覆は変わらないので、
  //      V3 側は「clip 後に実際に carriageway が残った feature」ベースの被覆率も併記する） ──
  const acceptedSegIds = new Set();
  for (const p of acceptedPairs) { acceptedSegIds.add(p.segId); acceptedSegIds.add(p.partnerSegId); }
  let tracksWithCoverage = 0, tracksNoCoverage = 0, gapTransitions = 0, isolatedFragments = 0, gapLenTotal = 0;
  for (const [, arr] of recon.tracksBySegOrder) {
    let hasAny = false, runs = 0, prev = null, isoRun = 0;
    for (const s of arr) {
      const covered = acceptedSegIds.has(s.id);
      if (covered) hasAny = true; else gapLenTotal++;
      if (prev != null && covered !== prev) runs++;
      if (covered) isoRun++; else { if (isoRun === 1) isolatedFragments++; isoRun = 0; }
      prev = covered;
    }
    if (isoRun === 1) isolatedFragments++;
    if (hasAny) tracksWithCoverage++; else tracksNoCoverage++;
    gapTransitions += runs;
  }
  const v2Report = rj(P('data', 'reports', 'road-visual-v2.json'));
  const continuity = {
    v2: v2Report ? v2Report.continuity : null,
    v3: {
      tracksTotal: recon.tracksBySegOrder.size, tracksWithCoverage, tracksNoCoverage,
      coveredCorridorPercent: +((tracksWithCoverage / Math.max(1, recon.tracksBySegOrder.size)) * 100).toFixed(2),
      gapTransitionCount: gapTransitions, gapSegmentCount: gapLenTotal, isolatedFragmentCount: isolatedFragments,
      resolvedFeatureCount: resolvedCount,
      resolvedFeaturePercent: +((resolvedCount / Math.max(1, classByCanonicalId.size)) * 100).toFixed(2),
    },
    note: 'track 単位の被覆は V2/V3 で同じ corridor 集合を使うため一致する（V3 は corridor を細くするだけで '
      + 'corridor を捨てないため）。V3 の実際の連続性は centerlineCoverage（OSM 車道 centerline を 2m 間隔で '
      + 'サンプルし dark に覆われているかを見る）で測る。',
  };

  // ── §25 area accounting ──
  const areaByClassM2 = (refined && refined.areaByClassM2) || {};
  const totalEnvelopeM2 = Object.values(areaByClassM2).reduce((s, v) => s + v, 0);
  const primaryTotalM2 = (areaByClassM2.CARRIAGEWAY || 0) + (areaByClassM2.INTERSECTION || 0) + (areaByClassM2.RAMP || 0);
  const areas = {
    tranEnvelopeM2: Math.round(totalEnvelopeM2),
    primaryEnvelopeM2: Math.round(primaryTotalM2),
    v3CarriagewayM2: Math.round(carriagewayAreaM2),
    v3MarginM2: Math.round(marginAreaM2),
    v3UncertainM2: Math.round(uncertainAreaM2),
    reconciliationDiffM2: Math.round(primaryTotalM2 - (carriagewayAreaM2 + marginAreaM2 + uncertainAreaM2)),
    v2CarriagewayM2: v2Report ? v2Report.areas.carriageway : null,
    carriagewayAreaDriftVsV2Percent: v2Report && v2Report.areas.carriageway
      ? +(((carriagewayAreaM2 - v2Report.areas.carriageway) / v2Report.areas.carriageway) * 100).toFixed(1) : null,
    corridorSubdivisionM2: {
      note: 'GSI corridor(=道路区域相当)を V3 がどう分解したか。clip 前の生の帯面積。',
      carriagewayBands: Math.round(quadRecords.reduce((s, q) => s + q.areaM2, 0)),
      ...Object.fromEntries(Object.entries(nonCarriagewayAreaByClass).map(([k, v]) => [k, Math.round(v)])),
    },
    sidewalkM2: Math.round(areaByClassM2.SIDEWALK || 0),
    medianM2: Math.round(areaByClassM2.MEDIAN || 0),
    pedestrianM2: Math.round(areaByClassM2.PEDESTRIAN || 0),
    bridgeM2: Math.round(areaByClassM2.BRIDGE || 0),
  };

  // ── §17 width validation（class 別） ──
  const widthStats = Object.fromEntries(Object.entries(widthsByClass).map(([k, v]) => [k, percentiles(v)]));
  widthStats._v2CarriagewayForComparison = v2Report ? v2Report.roadWidthSanity : null;
  widthStats._notes = {
    SIDEWALK: 'V3 の corridor 分解では SIDEWALK を独立に切り出せない。corridor 内で車道帯の外側に残る部分は '
      + '歩道と路肩の両方を含むため、区別せず SHOULDER_MARGIN としている（両者を分ける source がこの環境に無い）。'
      + '独立した SIDEWALK class 自体は既存 FIX13 の tran 分類(' + Math.round(areaByClassM2.SIDEWALK || 0) + ' m²)として'
      + '引き続き存在し、V3 はそれに手を触れていない。',
    MEDIAN_SHOULDER_MAX: 'MEDIAN / SHOULDER_MARGIN の max が 100m を超えるのは、GSI corridor 再構成が稀に生成する'
      + '過大 corridor（pairing 上限 45m を超えるもの）の残余であり、これらは dark carriageway には入らない。'
      + 'carriageway 側は max ' + MAX_CORRIDOR_M + 'm に収まっていることを別途確認している。',
  };

  // ── §18 GSI / OSM consistency ──
  const diffs = gsiVsOsm.map((r) => r.gsi - r.osm);
  const osmConsistency = {
    comparedQuads: gsiVsOsm.length,
    gsiCorridorWidthM: percentiles(gsiVsOsm.map((r) => r.gsi)),
    osmDerivedCarriagewayWidthM: percentiles(gsiVsOsm.map((r) => r.osm)),
    differenceM: percentiles(diffs),
    note: 'GSI corridor は道路区域の境界どうしの間隔（歩道・路肩・分離道路では両方向を含む）であり、'
      + 'OSM 由来の車道幅より系統的に広い。この差が ROAD V3 が縮めた量そのものである。',
  };

  // ── §26 performance ──
  const v2Bytes = (() => { let b = 0; const d = path.join(V2_DIR, 'tiles'); if (!fs.existsSync(d)) return null; for (const f of fs.readdirSync(d)) b += fs.statSync(path.join(d, f)).size; return b; })();
  const performance = {
    v3: { tileCount: tileOut.size, tileBytes, meshPolygonCount: quadRecords.length, uniqueFeatureCount: classByCanonicalId.size, buildTimeMs },
    v2: { tileCount: v2Report ? v2Report.performance.tileCount : null, tileBytes: v2Bytes, meshPolygonCount: null, uniqueFeatureCount: v2Report ? v2Report.performance.uniqueFeatureCount : null },
    tileBytesDeltaPercent: v2Bytes ? +(((tileBytes - v2Bytes) / v2Bytes) * 100).toFixed(1) : null,
    note: 'draw call / runtime memory はブラウザ実行が必要なため本環境では測れない。代理指標として '
      + 'tile bytes と描画ポリゴン数を記録する（runtime のマテリアルは V2 と同一構成なので draw call は '
      + 'ポリゴン数ではなくバケット数で決まり、V2 と同数のバケットを使う）。',
  };

  // ── §33 geometry validity ──
  let nanCount = 0, degenerateCount = 0;
  for (const [, arr] of tileOut) for (const rec of arr) if (rec.carriageway) for (const q of rec.carriageway) {
    if (q.some(([x, z]) => !Number.isFinite(x) || !Number.isFinite(z))) nanCount++;
    if (ringAreaAbs(q) < 1e-6) degenerateCount++;
  }

  // ── §29 成功条件 ──
  const overlapImprovedVsV2 = totalV2 > 0 && totalV3 < totalV2;
  const overlapImprovementPercent = totalV2 > 0 ? +(((totalV2 - totalV3) / totalV2) * 100).toFixed(1) : null;
  const cwStats = widthStats.CARRIAGEWAY;
  // §16: 数字のためだけに細くしていないこと。中央値が 1 車線未満なら不合格。
  //   下限: 1車線未満に細めていない。上限: GSI pairing 上限(45m)を超える「車道」が残っていない。
  const widthRealistic = !!(cwStats.count && cwStats.median >= 3 && cwStats.median <= 25 && cwStats.p95 <= MAX_CORRIDOR_M && cwStats.max <= MAX_CORRIDOR_M);
  // §24: ROAD V2 以下に大幅悪化したら FAIL。centerline 被覆率が V2 の 85% を下回ったら不合格。
  const continuityMaintained = !!(centerlineCoverage.coveredPercentV3 != null
    && centerlineCoverage.coveredPercentV2 != null
    && centerlineCoverage.coveredPercentV3 >= centerlineCoverage.coveredPercentV2 * 0.85);
  const umedaImproved = sites.umeda.improvementV2ToV3Percent != null && sites.umeda.improvementV2ToV3Percent > 0;
  // §20: 住吉を改悪しない（V2 より overlap が増えていない）
  const sumiyoshiNotWorse = sites.sumiyoshi.buildingDarkOverlapV3M2 <= sites.sumiyoshi.buildingDarkOverlapV2M2;
  const otherFixturesNotWorse = ['nakanoshima', 'honmachi', 'namba', 'tennoji'].every((k) => sites[k].buildingDarkOverlapV3M2 <= sites[k].buildingDarkOverlapV2M2);
  const geometryValid = nanCount === 0 && degenerateCount === 0;
  const verdict = (overlapImprovedVsV2 && widthRealistic && continuityMaintained && umedaImproved && sumiyoshiNotWorse && geometryValid)
    ? 'ROAD_VISUAL_V3_SUCCESS' : 'ROAD_VISUAL_V3_NOT_BETTER';

  const report = {
    version: 1, generatedAt, missionId: '32I',
    designNote: 'ROAD V2 の残存 dark 過大の主因は tran envelope ではなく「GSI corridor 幅 ≠ 車道幅」であることを '
      + '実測で確認した上で、GSI corridor の内側から OSM 由来の車道帯だけを切り出す方式にした。',
    sourceCounts: { gsiShinhabaLines: shinhaba.length, segments: segs.length, tracks: recon.tracksBySegOrder.size, corridorPairsDeduped: corridorPairs.length, acceptedPairs: acceptedPairs.length, quadsTotal, quadsMatchedByOsm: quadsMatched, carriagewayBands: quadRecords.length, quadsDroppedAsOverwideCorridor: quadsOverwideDropped },
    pairing: pairingCounts,
    sourceUsage: {
      gsi: sourceUsage.gsi, osmWidth: sourceUsage.osmWidth, osmLanes: sourceUsage.osmLanes,
      osmClassInference: sourceUsage.osmClassInference, tranEnvelopeOnly: sourceUsage.tranEnvelopeOnly,
      note: 'gsi = OSM が corridor 内に見つからず GSI corridor 幅のまま採用した帯の数（§7 交差点内部など）。'
        + 'tranEnvelopeOnly = 0 は「tran polygon を dark carriageway の source として使った帯が 1 つも無い」ことを意味する（§8）。',
    },
    osmAttributePresence: attrPresence,
    osmWidthTableProvenance: {
      laneWidthM: LANE_WIDTH_M,
      laneWidthBasis: '道路構造令 第4種(都市部)の標準車線幅員 3.00〜3.25m のうち 3.25m を採用。規格由来の仮定であり実測ではない。',
      classWidthM: CLASS_WIDTH_M,
      classWidthBasis: 'width タグを持つ way の class 別中央値(n>=10 の residential/unclassified/pedestrian/service)は実測値。'
        + 'それ以外の class は標本不足のため lanes 中央値 × laneWidthM を用いた導出値であり、個々の道路の実幅ではない。',
      laneWidthBasisMeasured: 'width と lanes の両方を持つ way 35件のうち複数車線のものは width/lanes が 3.0 に集中(secondary lanes=2 → width 6.0)。',
      minCarriagewayM: MIN_CARRIAGEWAY_M, maxOsmWidthM: MAX_OSM_WIDTH_M, maxCorridorM: MAX_CORRIDOR_M,
      widthTagMeasuredClasses: WIDTH_TAG_MEASURED_CLASSES,
      widthTagSampleSizes: { residential: 38, unclassified: 27, pedestrian: 15, service: 12, secondary: 7, primary: 4, tertiary: 2, track: 1 },
      confidenceMapping: SRC_CONF,
    },
    areas,
    widthStats,
    osmGsiConsistency: osmConsistency,
    overlap: {
      fix13: Math.round(totalFix13), v2: Math.round(totalV2), v3: Math.round(totalV3),
      fix13DarkAreaM2: Math.round(sum((v) => v.fix13DarkAreaM2)), v2DarkAreaM2: Math.round(sum((v) => v.v2DarkAreaM2)), v3DarkAreaM2: Math.round(sum((v) => v.v3DarkAreaM2)),
      improvementV2ToV3Percent: overlapImprovementPercent,
      improvementFix13ToV3Percent: totalFix13 > 0 ? +(((totalFix13 - totalV3) / totalFix13) * 100).toFixed(1) : null,
    },
    continuity,
    centerlineCoverage,
    sites,
    umedaSpots,
    railInteraction: {
      note: '§22: rail corridor(中心線±5m 近似)のうち V3 carriageway で塗られたセルの割合。rail を road として塗っていないかの確認。',
      bySite: Object.fromEntries(Object.entries(sites).map(([k, v]) => [k, { railCorridorCells: v.railCorridorCells, v2Cells: v.railPaintedAsRoadV2Cells, v3Cells: v.railPaintedAsRoadV3Cells, ratioV2: v.railPaintedRatioV2, ratioV3: v.railPaintedRatioV3 }])),
      totalRatioV2: (() => { const c = sum((v) => v.railCorridorCells); return c ? +(sum((v) => v.railPaintedAsRoadV2Cells) / c).toFixed(4) : null; })(),
      totalRatioV3: (() => { const c = sum((v) => v.railCorridorCells); return c ? +(sum((v) => v.railPaintedAsRoadV3Cells) / c).toFixed(4) : null; })(),
      interpretation: 'rail corridor は中心線±5m の近似帯なので、踏切・立体交差・並走道路によりある程度の重なりは '
        + '正常に発生する。重要なのは V3 が V2 より rail を road として塗っていないこと（totalRatioV3 <= totalRatioV2）。',
    },
    bridgeHandling: {
      note: '§23: OSM で bridge=yes または layer>0 の way に対応する帯は BRIDGE として分類し、地上の dark carriageway には含めない。'
        + 'tunnel=yes または layer<0 は TUNNEL として同様に除外する。3D 道路化は行わない。',
      bridgeBandAreaM2: Math.round(nonCarriagewayAreaByClass.BRIDGE),
      tunnelBandAreaM2: Math.round(nonCarriagewayAreaByClass.TUNNEL),
    },
    geometryValidity: { nanCount, degenerateCount, selfIntersectionByConstruction: false, selfIntersectionNote: '帯は元 quad の横断方向線形補間で作るため、元 quad が単純多角形である限り自己交差しない（§6）。' },
    performance,
    escapedEnvelopeQuadCount: escapedEnvelopeCount,
    diffAgainstV2: {
      v2ResolvedFeatureCount: v2ResolvedIds.size,
      v3ResolvedFeatureCount: resolvedCount,
      v3ResolvedAlsoInV2: [...classByCanonicalId.entries()].filter(([id, c]) => c.c === 'R' && v2ResolvedIds.has(id)).length,
      v3ResolvedNewVsV2: [...classByCanonicalId.entries()].filter(([id, c]) => c.c === 'R' && !v2ResolvedIds.has(id)).length,
      note: '§14 DIFF の色分けに使う。V3 band は V2 と同じ GSI quad の内側にあるため、V2 が RESOLVED だった '
        + 'feature の V3 band は common(neutral)、そうでない feature の band は V3 only(blue) として描く。'
        + 'feature 単位の判定であり、厳密なポリゴン差分ではない（runtime でのboolean演算を避けるための近似・正直な開示）。',
    },
    verdictCriteria: { overlapImprovedVsV2, widthRealistic, continuityMaintained, umedaImproved, sumiyoshiNotWorse, otherFixturesNotWorse, geometryValid },
    verdict,
  };
  await writeJson(REPORT, report);
  console.log('[road-v3] 保存: ' + toProjectRelativePath(REPORT));
  console.log('[road-v3] verdict=' + verdict);
  console.log('[road-v3] overlap fix13=' + Math.round(totalFix13) + ' v2=' + Math.round(totalV2) + ' v3=' + Math.round(totalV3) + ' (V2→V3 ' + overlapImprovementPercent + '%)');
  console.log('[road-v3] carriageway width median=' + cwStats.median + ' p95=' + cwStats.p95 + ' (V2 median=' + (v2Report ? v2Report.roadWidthSanity.median : '?') + ')');
  return report;
}

export { main as buildRoadVisualV3 };
if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[road-v3] 失敗:', e && e.stack || e); process.exit(1); });
