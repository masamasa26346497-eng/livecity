#!/usr/bin/env node
// tools/build-road-render-class.js
// [Mission 31G-FIX12] Canonical Road（source truth）と Road Visual Surface（描画面）を分離する。
//
//   PLATEAU tran polygon = 「道路区域」（roadway + 歩道 + 法面 + 植樹帯 + setback）。
//   これを全面 road 色で塗ると、区域の縁に接する建物が「道路に乗って見える」（FIX10/11 で
//   projection バグは否定済み → 主因はこの描画範囲）。
//
//   source geometry は一切変更しない（§0/§18）。各 canonical road feature に **renderClass** を付ける:
//     ROADWAY / INTERSECTION / RAMP / BRIDGE / PEDESTRIAN / ALLEY / MEDIAN / SIDEWALK / ROAD_RESERVE / UNKNOWN
//   runtime は renderClass ごとに style（濃さ・opacity・Y）を変える。
//
//   出力: data/processed/osaka-city/derived/road-render-class.json
//     { version, generatedAt, byClass:{...}, areaByClassM2:{...}, classes:{ <canonicalId>: {c, conf, rs} } }
//       DISPLAY 相当（= ROADWAY・既定濃さ）は index に載せない（tile が小さくなる）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const OUT = P('data', 'processed', 'osaka-city', 'derived', 'road-render-class.json');
const REPORT = P('data', 'reports', 'road-visual-surface-audit.json');

const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
function ringLen(r) { let s = 0; for (let i = 1; i < r.length; i++) s += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]); return s; }
function perimeterOf(ft) {
  let p = 0;
  const polys = ft.geometryType === 'Polygon' ? [ft.coordinates] : ft.coordinates || [];
  for (const poly of polys) for (const ring of poly) if (Array.isArray(ring) && ring.length > 1) p += ringLen(ring);
  return p;
}

// PLATEAU function / OSM highway → 主要道路面か
const REAL_HIGHWAY = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service', 'living_street', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road']);
const PED_HIGHWAY = new Set(['pedestrian', 'footway', 'path', 'steps', 'cycleway', 'bridleway', 'corridor']);
const REAL_DETAIL = new Set(['MAJOR', 'MID', 'LOCAL_RESIDENTIAL', 'LOCAL_SERVICE', 'LOCAL_TRACK']);

// visual style（runtime と一致させること）
const STYLE = {
  ROADWAY: { rs: 'primary' }, INTERSECTION: { rs: 'primary' }, RAMP: { rs: 'primary' }, BRIDGE: { rs: 'bridge' },
  ALLEY: { rs: 'secondary' }, PEDESTRIAN: { rs: 'pedestrian' }, MEDIAN: { rs: 'faint' }, SIDEWALK: { rs: 'faint' },
  ROAD_RESERVE: { rs: 'faint' }, UNKNOWN: { rs: 'faint' },
};

function classify(ft) {
  const a = ft.attributes || {};
  const hasCL = !!ft.centerlineRef;
  const structure = a.plateauStructure || null;
  const isRibbon = (ft.source && ft.source.geometrySource) === 'osm-road-centerline';

  if (a.bridge || structure === 'elevated' || structure === 'bridge' || (a.layer && +a.layer > 0)) return { c: 'BRIDGE', conf: 0.85 };
  if (PED_HIGHWAY.has(a.highway) || a.detail === 'PEDESTRIAN') return { c: 'PEDESTRIAN', conf: 0.8 };
  if (structure === 'intersection') return { c: 'INTERSECTION', conf: 0.8 };
  if (a.highway && a.highway.endsWith('_link')) return { c: 'RAMP', conf: 0.7 };

  const realClass = REAL_HIGHWAY.has(a.highway) || REAL_DETAIL.has(a.detail) || a.lodClass === 'major' || a.lodClass === 'mid';
  if (realClass) return { c: 'ROADWAY', conf: hasCL ? 0.9 : 0.75 };
  if (a.detail === 'LOCAL_ALLEY') return { c: 'ALLEY', conf: 0.7 };
  if (isRibbon) return { c: 'ROADWAY', conf: 0.6 };   // §14 fallback ribbon = 実道路

  // ── 未分類（highway=null & detail=null/LOCAL_UNCLASSIFIED, lodClass=local, OSM centerline なし）──
  //   §5: 全面 road 色を廃止。形状で「細い道路帯」か「幅のある区域（歩道/法面/広場）」かを推定。
  const bb = ft.bbox;
  const W = bb ? bb.maxX - bb.minX : 0, H = bb ? bb.maxZ - bb.minZ : 0;
  const aspect = Math.max(W, H) / Math.max(1, Math.min(W, H));
  const per = perimeterOf(ft);
  const effW = per > 0 ? (2 * (ft.areaM2 || 0)) / per : 0;   // 有効幅 = 2A/周長
  if (hasCL) return { c: 'ROADWAY', conf: 0.65 };
  if (effW <= 8 && (aspect >= 1.6 || (ft.areaM2 || 0) < 350)) return { c: 'ROADWAY', conf: 0.5 };   // 細い道路帯（OSM 欠落）
  if (effW >= 9 && aspect < 2.2) return { c: 'ROAD_RESERVE', conf: 0.6 };                            // 幅のある区域（法面/植樹帯/広場）
  return { c: 'UNKNOWN', conf: 0.4 };                                                                // どちらとも言えない → 中間の薄さ
}

async function main() {
  const generatedAt = new Date().toISOString();
  if (!fs.existsSync(path.join(CANON_ROADS, 'manifest.json'))) { console.error('[road-render-class] canonical roads が無い'); process.exit(1); }

  const byClass = {}, areaByClassM2 = {};
  const classes = {};
  const seen = new Set();
  let total = 0, totalAreaM2 = 0;
  for (const f of fs.readdirSync(CANON_ROADS).filter(isTile)) {
    const t = JSON.parse(fs.readFileSync(path.join(CANON_ROADS, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (seen.has(ft.canonicalId)) continue;
      seen.add(ft.canonicalId); total++;
      const ar = ft.areaM2 || 0; totalAreaM2 += ar;
      const r = classify(ft);
      byClass[r.c] = (byClass[r.c] || 0) + 1;
      areaByClassM2[r.c] = (areaByClassM2[r.c] || 0) + ar;
      // rs='primary'（= 既定の濃い道路面。ROADWAY/INTERSECTION/RAMP）は index に載せない → runtime 既定。
      //   bridge / secondary / pedestrian / faint だけ index（styling が変わるもの）。
      const rs = STYLE[r.c] ? STYLE[r.c].rs : 'faint';
      if (rs !== 'primary') classes[ft.canonicalId] = { c: r.c, conf: +r.conf.toFixed(2), rs };
    }
  }

  const VISUAL_RS = { primary: 1.0, bridge: 1.0, secondary: 0.7, pedestrian: 0.5, faint: 0.28 };
  // 視覚的な「濃い道路面」の実効面積（rs 係数で重み付け）
  let visualRoadAreaM2 = 0;
  for (const [c, ar] of Object.entries(areaByClassM2)) {
    const rs = STYLE[c] ? STYLE[c].rs : 'faint';
    visualRoadAreaM2 += ar * (VISUAL_RS[rs] || 0.28);
  }

  const out = {
    version: 1, kind: 'road-render-class', generatedAt,
    classes: Object.keys(STYLE),
    byClass, areaByClassM2: Object.fromEntries(Object.entries(areaByClassM2).map(([k, v]) => [k, Math.round(v)])),
    indexedCount: Object.keys(classes).length,
    note: 'source geometry は不変。renderClass のみ付与。ROADWAY(conf>=0.75) は index 省略（runtime 既定）。',
    classMap: classes,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));

  const report = {
    generatedAt,
    canonicalRoadFeatureCount: total,
    canonicalRoadAreaM2: Math.round(totalAreaM2),
    visualRoadAreaM2: Math.round(visualRoadAreaM2),
    reductionRatio: +(1 - visualRoadAreaM2 / totalAreaM2).toFixed(3),
    byClass, areaByClassKm2: Object.fromEntries(Object.entries(areaByClassM2).map(([k, v]) => [k, +(v / 1e6).toFixed(2)])),
    unknownCount: byClass.UNKNOWN || 0,
    reclassifiedFromFullRoad: (byClass.ROAD_RESERVE || 0) + (byClass.UNKNOWN || 0) + (byClass.PEDESTRIAN || 0) + (byClass.MEDIAN || 0) + (byClass.SIDEWALK || 0),
    reservePlusUnknownAreaKm2: +(((areaByClassM2.ROAD_RESERVE || 0) + (areaByClassM2.UNKNOWN || 0)) / 1e6).toFixed(2),
    sourceGeometryMutated: false,
    buildingGeometryMutated: false,
    RESULT: 'AUDIT-DONE',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[road-render-class] features', total, ' canonical area', (totalAreaM2 / 1e6).toFixed(1), 'km2');
  console.log('  byClass:', JSON.stringify(byClass));
  console.log('  areaKm2:', JSON.stringify(report.areaByClassKm2));
  console.log('  visual road area', (visualRoadAreaM2 / 1e6).toFixed(1), 'km2  reduction', (report.reductionRatio * 100).toFixed(0) + '%');
  console.log('  index entries', out.indexedCount, ' →', toProjectRelativePath(OUT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[road-render-class] 失敗:', e && e.stack || e); process.exit(1); });
