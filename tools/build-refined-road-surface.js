#!/usr/bin/env node
// tools/build-refined-road-surface.js
// [Mission 31G-FIX13] Road Visual Surface をさらに精密化する。
//
//   FIX12 で Canonical Road（source truth）と Road Visual Surface（描画面）を分離した。
//   FIX13 は「道路区域」から「実際に車道として表示する面（carriageway）」を高精度化する。
//
//   ── 車道幅 source hierarchy（Canonical Road priority とは別）──
//     1. official road edge（基盤地図情報 道路縁 / 道路台帳） … 未取得（rank1 blocker・記録のみ）
//     2. PLATEAU TrafficArea（車道部）            … 市域 858 件（0.4%）・lod1 二重計上回避で canonical 非採用
//     3. OSM width tag                            … 152 件・大半が footway（車道価値ほぼ 0）
//     4. OSM lanes × laneWidth                    … 13,887 件。ただし highway=tertiary が 20〜30m 幹線
//                                                   （玉造筋/松虫通/今里筋…）に付き、lanes は分離帯側 1 方向のみ等で
//                                                   系統的に過少 → **幾何 clamp には使わない（advisory のみ）**（§0「見た目だけで縮めない」）
//     5. PLATEAU polygon + centerline             … 75,946 件（centerlineInsideRatio p50=1.0）
//     6. class default width
//
//   ── 今回安全に適用する精密化 ──
//     - renderClass を §17 taxonomy へ: CARRIAGEWAY / SIDEWALK / INTERSECTION / MEDIAN /
//       ROAD_RESERVE / BRIDGE / RAMP / PEDESTRIAN / FAINT
//     - SIDEWALK / MEDIAN を形状 + 実道路隣接で検出し carriageway から分離（車道色にしない §9/§10）
//     - carriageway 幅 source + confidence を feature ごとに記録（§11）
//     - lanes は laneAdvisoryWidthM / widthAgreement として QA 記録（§4・幾何は変えない）
//
//   ── 適用しなかった精密化（データ制約・§0 遵守）──
//     - OSM width ribbon 化: width タグ 152 件は大半 footway・車道の狭幅化に使える例が僅少 → 見送り（§3）
//     - lanes による車道幅 clamp: highway=tertiary が 20〜30m 幹線（玉造筋/松虫通/今里筋…）に付き、
//       lanes×laneWidth が実幅の 1/3〜1/5 → clamp すると幹線が糸状になる。§0「見た目だけで縮めない」に反する → 不採用
//
//   建物 x/z・PLATEAU footprint・canonical road source geometry は一切変更しない（§0/§15）。
//
//   出力:
//     data/processed/osaka-city/derived/refined-road-surface.json
//       { version, kind, generatedAt, classes, byClass, areaByClassM2, indexedCount,
//         classMap:{ <canonicalId>: "<rs>" } }   // CARRIAGEWAY(primary) 既定は省略。他 rs のみ収録
//     data/reports/refined-road-visual-surface.json  （§21）
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const FIX12_INDEX = P('data', 'processed', 'osaka-city', 'derived', 'road-render-class.json');
const OUT = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const REPORT = P('data', 'reports', 'refined-road-visual-surface.json');

const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
function ringLen(r) { let s = 0; for (let i = 1; i < r.length; i++) s += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]); return s; }
function perimeterOf(ft) {
  let p = 0;
  const polys = ft.geometryType === 'Polygon' ? [ft.coordinates] : ft.coordinates || [];
  for (const poly of polys) for (const ring of poly) if (Array.isArray(ring) && ring.length > 1) p += ringLen(ring);
  return p;
}

const REAL_HIGHWAY = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service', 'living_street', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road']);
const PED_HIGHWAY = new Set(['pedestrian', 'footway', 'path', 'steps', 'cycleway', 'bridleway', 'corridor']);
const REAL_DETAIL = new Set(['MAJOR', 'MID', 'LOCAL_RESIDENTIAL', 'LOCAL_SERVICE', 'LOCAL_TRACK']);
const ARTERIAL = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);
// class 別 lane 幅（一律 3.25 にしない §4）
const LANE_W = {
  motorway: 3.5, motorway_link: 3.5, trunk: 3.5, trunk_link: 3.5, primary: 3.25, primary_link: 3.25,
  secondary: 3.15, secondary_link: 3.15, tertiary: 3.0, tertiary_link: 3.0,
  residential: 2.75, unclassified: 2.75, living_street: 2.75, road: 3.0, service: 2.5,
};
const CLASS_DEFAULT_W = { motorway: 11, trunk: 10, primary: 9, secondary: 7.5, tertiary: 6.5, residential: 4.5, unclassified: 4.5, living_street: 4, service: 3.5, road: 5 };

// §17 renderClass → runtime render surface style key（runtime CR_ROAD_RS と一致させる）
const RS = {
  CARRIAGEWAY: 'primary', INTERSECTION: 'primary', RAMP: 'primary', BRIDGE: 'bridge',
  PEDESTRIAN: 'pedestrian', SIDEWALK: 'sidewalk', MEDIAN: 'median',
  ROAD_RESERVE: 'faint', FAINT: 'faint',
};
// 視覚的「濃い車道面」実効係数（§7 visual area 計算）
const VISUAL_RS = { primary: 1.0, bridge: 1.0, pedestrian: 0.5, sidewalk: 0.4, median: 0.25, faint: 0.28 };
// classMap 値の 1 文字コード（payload 圧縮。runtime が RS_CODE 逆引きで復元）
const RS_CODE = { bridge: 'b', pedestrian: 'p', sidewalk: 's', median: 'm', faint: 'f' };

function widthSource(ft) {
  const a = ft.attributes || {};
  const hasCL = !!ft.centerlineRef;
  const wTag = a.width != null ? parseFloat(String(a.width).replace(/[^0-9.]/g, '')) : NaN;
  const lanes = +a.lanes || 0;
  const lw = LANE_W[a.highway] || 3.0;
  const per = perimeterOf(ft);
  const effW = per > 0 ? (2 * (ft.areaM2 || 0)) / per : 0;

  let laneAdvisoryWidthM = null;
  if (lanes > 0) {
    let w = lanes * lw;
    if (a.oneway !== 'yes' && lanes <= 2) w = Math.max(w, 2 * lw); // 双方向下限
    laneAdvisoryWidthM = +w.toFixed(1);
  }

  if (Number.isFinite(wTag) && wTag > 0 && hasCL && wTag < effW * 0.9 && !PED_HIGHWAY.has(a.highway)) {
    return { cwM: +wTag.toFixed(1), cwSrc: 'osm-width', conf: 0.9, effW, laneAdvisoryWidthM };
  }
  if (lanes > 0 && hasCL && !ARTERIAL.has(a.highway)) {
    // 非幹線 + lanes: advisory を記録するが幾何は変えない（§4/§0）。conf は中程度。
    return { cwM: laneAdvisoryWidthM, cwSrc: 'osm-lanes', conf: 0.55, effW, laneAdvisoryWidthM };
  }
  if (lanes > 0 && ARTERIAL.has(a.highway)) {
    return { cwM: Math.max(laneAdvisoryWidthM || 0, CLASS_DEFAULT_W[a.highway] || 8), cwSrc: 'osm-lanes-arterial-advisory', conf: 0.4, effW, laneAdvisoryWidthM };
  }
  if (hasCL) {
    return { cwM: +effW.toFixed(1), cwSrc: 'plateau-polygon+centerline', conf: 0.55, effW, laneAdvisoryWidthM };
  }
  if (a.highway && CLASS_DEFAULT_W[a.highway]) {
    return { cwM: CLASS_DEFAULT_W[a.highway], cwSrc: 'class-default', conf: 0.3, effW, laneAdvisoryWidthM };
  }
  return { cwM: +effW.toFixed(1), cwSrc: 'plateau-polygon', conf: 0.4, effW, laneAdvisoryWidthM };
}

// ── SIDEWALK / MEDIAN 用: 実道路 polygon の 250m 格子 ──
const CELL = 250;
const ckey = (cx, cz) => cx + ',' + cz;
function bboxNearReal(bb, grid, reachM) {
  const x0 = Math.floor((bb.minX - reachM) / CELL), x1 = Math.floor((bb.maxX + reachM) / CELL);
  const z0 = Math.floor((bb.minZ - reachM) / CELL), z1 = Math.floor((bb.maxZ + reachM) / CELL);
  for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
    const arr = grid.get(ckey(cx, cz)); if (!arr) continue;
    for (const r of arr) {
      if (bb.minX - reachM <= r.maxX && bb.maxX + reachM >= r.minX && bb.minZ - reachM <= r.maxZ && bb.maxZ + reachM >= r.minZ) return true;
    }
  }
  return false;
}
function addRealToGrid(grid, bb) {
  const x0 = Math.floor(bb.minX / CELL), x1 = Math.floor(bb.maxX / CELL);
  const z0 = Math.floor(bb.minZ / CELL), z1 = Math.floor(bb.maxZ / CELL);
  for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
    const k = ckey(cx, cz); let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(bb);
  }
}

function baseClass(ft) {
  const a = ft.attributes || {};
  const structure = a.plateauStructure || null;
  const hasCL = !!ft.centerlineRef;
  const isRibbon = (ft.source && ft.source.geometrySource) === 'osm-road-centerline';
  if (a.bridge || structure === 'elevated' || structure === 'bridge' || (a.layer && +a.layer > 0)) return { c: 'BRIDGE', conf: 0.85 };
  if (PED_HIGHWAY.has(a.highway) || a.detail === 'PEDESTRIAN') return { c: 'PEDESTRIAN', conf: 0.8 };
  if (structure === 'intersection') return { c: 'INTERSECTION', conf: 0.8 };
  if (a.highway && a.highway.endsWith('_link')) return { c: 'RAMP', conf: 0.7 };
  const realClass = REAL_HIGHWAY.has(a.highway) || REAL_DETAIL.has(a.detail) || a.lodClass === 'major' || a.lodClass === 'mid';
  if (realClass) return { c: 'CARRIAGEWAY', conf: hasCL ? 0.9 : 0.75 };
  if (a.detail === 'LOCAL_ALLEY') return { c: 'CARRIAGEWAY', conf: 0.55 };   // 路地も走行面（歩道扱いにしない）
  if (hasCL) return { c: 'CARRIAGEWAY', conf: 0.65 };
  if (isRibbon) return { c: 'CARRIAGEWAY', conf: 0.6 };
  return null; // 未分類 → 形状判定へ
}

async function main() {
  const generatedAt = new Date().toISOString();
  if (!fs.existsSync(path.join(CANON_ROADS, 'manifest.json'))) { console.error('[refined-road] canonical roads が無い'); process.exit(1); }

  // pass 1: 全 feature 読み込み（dedup）+ 実道路 grid
  const feats = [];
  const seen = new Set();
  const realGrid = new Map();
  for (const f of fs.readdirSync(CANON_ROADS).filter(isTile)) {
    const t = JSON.parse(fs.readFileSync(path.join(CANON_ROADS, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (seen.has(ft.canonicalId)) continue;
      seen.add(ft.canonicalId);
      feats.push(ft);
      const a = ft.attributes || {};
      const isReal = !!ft.centerlineRef || REAL_HIGHWAY.has(a.highway) || REAL_DETAIL.has(a.detail) || a.lodClass === 'major' || a.lodClass === 'mid';
      if (isReal && ft.bbox) addRealToGrid(realGrid, ft.bbox);
    }
  }

  // pass 2: 分類
  const byClass = {}, areaByClassM2 = {};
  const bySource = {};
  const classMap = {};
  let total = 0, totalAreaM2 = 0;
  let sidewalkFromCarriageway = 0;
  const majorRoadWidths = {};
  let widthAgreeN = 0, widthDisagreeN = 0;

  for (const ft of feats) {
    total++;
    const a = ft.attributes || {};
    const ar = ft.areaM2 || 0; totalAreaM2 += ar;
    const bb = ft.bbox || { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    const W = bb.maxX - bb.minX, H = bb.maxZ - bb.minZ;
    const aspect = Math.max(W, H) / Math.max(1, Math.min(W, H));
    const ws = widthSource(ft);
    bySource[ws.cwSrc] = (bySource[ws.cwSrc] || 0) + 1;

    // lanes advisory vs polygon 幅の一致度（§4 QA 記録・幾何は変えない）
    if (ws.laneAdvisoryWidthM && ws.effW > 0) {
      const rr = ws.laneAdvisoryWidthM / ws.effW;
      if (rr >= 0.7 && rr <= 1.4) widthAgreeN++; else widthDisagreeN++;
    }

    let cls = baseClass(ft);
    if (!cls) {
      // 未分類（highway=null & detail=null & centerline なし = PLATEAU 道路区域の断片）:
      //   形状 + 実道路隣接で SIDEWALK / MEDIAN / ROAD_RESERVE / CARRIAGEWAY(細街路) / FAINT。
      //   SIDEWALK/MEDIAN は「隣に実道路 polygon がある細い帯」に限定（誤って車道を歩道化しない §8/§15）。
      const effW = ws.effW;
      const isPlateauFrag = (ft.source && ft.source.geometrySource) === 'plateau-tran-road';
      const nearReal = isPlateauFrag && bboxNearReal(bb, realGrid, 3.0);
      if (nearReal && effW <= 2.8 && aspect >= 4.5 && ar >= 4 && ar <= 260) cls = { c: 'MEDIAN', conf: 0.55 };
      else if (nearReal && effW <= 4.0 && aspect >= 2.8 && ar >= 6 && ar <= 400) cls = { c: 'SIDEWALK', conf: 0.6 };
      else if (effW <= 8 && (aspect >= 1.6 || ar < 350)) cls = { c: 'CARRIAGEWAY', conf: 0.5 };  // OSM 欠落の細街路
      else if (effW >= 9 && aspect < 2.2) cls = { c: 'ROAD_RESERVE', conf: 0.6 };
      else cls = { c: 'FAINT', conf: 0.4 };
    }

    if (cls.c === 'SIDEWALK') sidewalkFromCarriageway += ar;  // FIX12 で CARRIAGEWAY(細道路) だった分が移る

    byClass[cls.c] = (byClass[cls.c] || 0) + 1;
    areaByClassM2[cls.c] = (areaByClassM2[cls.c] || 0) + ar;

    const rs = RS[cls.c] || 'faint';
    // primary 既定（CARRIAGEWAY/INTERSECTION/RAMP）は index 省略（runtime 既定）。
    //   payload 圧縮: key から共通 prefix 'cg_road_' を落とし、値は rs 1 文字コード（runtime が復元）。
    if (rs !== 'primary') classMap[ft.canonicalId.replace(/^cg_road_/, '')] = RS_CODE[rs];

    if (a.name && (REAL_DETAIL.has(a.detail) || ARTERIAL.has(a.highway) || a.detail === 'MID')) {
      const m = majorRoadWidths[a.name] || { polygonEffW: [], laneAdvisory: ws.laneAdvisoryWidthM, highway: a.highway, detail: a.detail };
      if (ws.effW > 0) m.polygonEffW.push(+ws.effW.toFixed(1));
      majorRoadWidths[a.name] = m;
    }
  }

  // ── visual / carriageway 面積 ──
  let visualRoadAreaM2 = 0;
  for (const [c, arr] of Object.entries(areaByClassM2)) {
    const rs = RS[c] || 'faint';
    visualRoadAreaM2 += arr * (VISUAL_RS[rs] || 0.28);
  }
  const carriagewayAreaM2 = (areaByClassM2.CARRIAGEWAY || 0) + (areaByClassM2.INTERSECTION || 0) + (areaByClassM2.RAMP || 0);

  // major road width 集計（代表幹線）
  const NAMED = ['御堂筋', '新御堂筋', '中央大通', '長居公園通', '玉造筋', '松虫通', 'あびこ筋', '今里筋', '都島通', '天満橋筋', '堺筋', '土佐堀通', '中之島通'];
  const majorOut = {};
  for (const n of NAMED) {
    const m = majorRoadWidths[n]; if (!m || !m.polygonEffW.length) continue;
    const s = m.polygonEffW.slice().sort((x, y) => x - y);
    majorOut[n] = { highway: m.highway, detail: m.detail, polygonEffW_median: s[s.length >> 1], polygonEffW_p90: s[Math.floor(s.length * 0.9)] || s[s.length - 1], laneAdvisoryWidthM: m.laneAdvisory, samples: s.length };
  }

  const out = {
    version: 1, kind: 'refined-road-surface', generatedAt,
    classes: Object.keys(RS),
    byClass,
    areaByClassM2: Object.fromEntries(Object.entries(areaByClassM2).map(([k, v]) => [k, Math.round(v)])),
    indexedCount: Object.keys(classMap).length,
    widthSourceCounts: bySource,
    keyPrefix: 'cg_road_',
    rsCodes: { b: 'bridge', p: 'pedestrian', s: 'sidewalk', m: 'median', f: 'faint' },
    note: 'source geometry 不変。renderClass のみ付与（§17 taxonomy）。lanes は advisory のみ（幾何 clamp なし §0/§4）。CARRIAGEWAY(primary) 既定は index 省略。classMap key は keyPrefix を除いた canonicalId、値は rsCodes の 1 文字。',
    classMap,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));

  const audit12 = (() => { try { return JSON.parse(fs.readFileSync(P('data', 'reports', 'road-visual-surface-audit.json'), 'utf-8')); } catch { return null; } })();

  const report = {
    generatedAt,
    canonicalAreaM2: Math.round(totalAreaM2),
    canonicalAreaKm2: +(totalAreaM2 / 1e6).toFixed(2),
    oldVisualAreaM2: audit12 ? audit12.visualRoadAreaM2 : null,
    oldVisualAreaKm2: audit12 ? +(audit12.visualRoadAreaM2 / 1e6).toFixed(2) : null,
    newVisualAreaM2: Math.round(visualRoadAreaM2),
    newVisualAreaKm2: +(visualRoadAreaM2 / 1e6).toFixed(2),
    newCarriagewayAreaM2: Math.round(carriagewayAreaM2),
    newCarriagewayAreaKm2: +(carriagewayAreaM2 / 1e6).toFixed(2),
    byClass,
    areaByClassKm2: Object.fromEntries(Object.entries(areaByClassM2).map(([k, v]) => [k, +(v / 1e6).toFixed(3)])),
    bySource: {
      official: 0,
      trafficArea: 0,
      osmWidth: (bySource['osm-width'] || 0),
      lanes: (bySource['osm-lanes'] || 0) + (bySource['osm-lanes-arterial-advisory'] || 0),
      lanesUsedForGeometry: 0,
      centerlinePolygon: (bySource['plateau-polygon+centerline'] || 0),
      classDefault: (bySource['class-default'] || 0),
      plateauPolygon: (bySource['plateau-polygon'] || 0),
    },
    lanesWidthAgreement: { agree: widthAgreeN, disagree: widthDisagreeN, note: 'lanes×laneWidth vs polygon effW が 0.7〜1.4 なら agree。disagree の多くは highway=tertiary の幹線（玉造筋等）で lanes 過少 → 幾何 clamp 不採用の根拠。' },
    sidewalkReclassifiedAreaKm2: +((areaByClassM2.SIDEWALK || 0) / 1e6).toFixed(3),
    medianReclassifiedAreaKm2: +((areaByClassM2.MEDIAN || 0) / 1e6).toFixed(3),
    majorRoadWidths: majorOut,
    officialRoadEdgeAcquired: false,
    officialRoadEdgeNote: '基盤地図情報「道路縁」/ 大阪市道路台帳 は未取得。これが carriageway 精密化の rank1 source。ネットワーク接続（ローカル PC）で取得後に本 build を再実行すれば source hierarchy 1 位で車道面を再構成できる。',
    plateauTrafficAreaCount: 858,
    plateauTrafficAreaNote: 'PLATEAU tran に TrafficArea/AuxiliaryTrafficArea は市域 858 件（0.4%）のみ。lod1 道路区域と二重計上になるため canonical 非採用（tools/convert-plateau-tran.js §7）。',
    osmWidthNote: 'OSM width タグは 152 件・大半が footway。車道の狭幅化に使える例は僅少。',
    sourceGeometryMutated: false,
    buildingGeometryMutated: false,
    negativeBufferHack: false,
    RESULT: 'AUDIT-DONE',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[refined-road] features', total, ' canonical area', (totalAreaM2 / 1e6).toFixed(1), 'km2');
  console.log('  byClass:', JSON.stringify(byClass));
  console.log('  areaKm2:', JSON.stringify(report.areaByClassKm2));
  console.log('  widthSource:', JSON.stringify(bySource));
  console.log('  lanes agree/disagree:', widthAgreeN, '/', widthDisagreeN);
  console.log('  sidewalk reclass:', report.sidewalkReclassifiedAreaKm2, 'km2  median:', report.medianReclassifiedAreaKm2, 'km2');
  console.log('  old visual', report.oldVisualAreaKm2, '→ new visual', report.newVisualAreaKm2, 'km2 / carriageway', report.newCarriagewayAreaKm2, 'km2');
  console.log('  index entries', out.indexedCount, ' →', toProjectRelativePath(OUT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[refined-road] 失敗:', e && e.stack || e); process.exit(1); });
