#!/usr/bin/env node
// tools/convert-plateau-tran.js
// [Mission 31C2] PLATEAU CityGML 交通モデル（tran:Road）→ 道路区域 polygon（znorth-neg-v1）。
//   build-canonical-roads.js が polygon-first source として読む中間形式を出力する。
//
// ── 実データ（27100 大阪市 2025 CityGML op / udx/tran/*_tran_6697_op.gml 288 file）で確定した schema（§5）
//   core:cityObjectMember > tran:Road[gml:id]
//     ├ tran:function            … Road_function.xml（行政種別。面種別ではない）
//     ├ tran:lod1MultiSurface    … gml:MultiSurface > surfaceMember > Polygon > exterior/interior > LinearRing > posList
//     ├ uro:roadStructureAttribute > uro:RoadStructureAttribute > uro:sectionType … 構造区分（§17）
//     └ tran:trafficArea / tran:auxiliaryTrafficArea（lod3MultiSurface）… 市域で 858 件のみ（0.4%）
//   srsName = EPSG/0/6697、srsDimension="3"、posList の並びは「lat lon alt」。
//
// ── §7 道路面の定義（実 codelist に基づく確定事項）
//   canonical road geometry = tran:Road の lod1MultiSurface（＝道路区域。車道＋歩道を含む道路敷地）。
//   全 199,162 Road に存在し被覆が一様なため、これを唯一の polygon source とする。
//   TrafficArea/AuxiliaryTrafficArea(lod3) は同じ Road の内側を細分した別 LOD であり、
//   lod1 と併せて出力すると同一面を二重計上するため canonical には含めない（§14: 無制限 union をしない）。
//   これらは trafficAreaDetail として件数のみ記録し、将来 LOD3 を使う場合の入口を残す。
//   トンネル区間（sectionType 6）は地表の道路面ではないため surfaceKind='subsurface' として除外する。
//
//   ※ projection origin 変更禁止（§0/§6）。znorth-neg-v1: x=(lon-135.52502)*cos(34.604208°)*111320,
//     z=-((lat-34.604208)*111320)。
//
// 実行:
//   node tools/convert-plateau-tran.js --inspect --input data/raw/plateau/osaka-city/tran/
//   node tools/convert-plateau-tran.js --convert --input data/raw/plateau/osaka-city/tran/
//
// 出力（--convert）:
//   data/processed/osaka-city/canonical/roads-tran/polygons.json  （gitignore）
//   data/reports/plateau-tran-conversion.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AREA = P('config', 'areas', 'osaka-city.json');
const OUT_DEFAULT = P('data', 'processed', 'osaka-city', 'canonical', 'roads-tran', 'polygons.json');
const REPORT = P('data', 'reports', 'plateau-tran-conversion.json');

const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const MARGIN = 3000;
const MIN_AREA_M2 = 1;
const GIANT_AREA_M2 = 600_000;

// ── codelists/Road_function.xml（配布 ZIP 同梱の正本）。行政種別であって面種別ではない。
export const ROAD_FUNCTION_LABEL = Object.freeze({
  '1': '高速自動車国道', '2': '一般国道', '3': '都道府県道', '4': '市町村道',
  '10': '建築基準法第42条1項2号道路', '11': '建築基準法第42条1項3号道路', '12': '建築基準法第42条1項4号道路',
  '13': '建築基準法第42条1項5号道路', '14': '建築基準法第42条2項道路', '15': '建築基準法第43条2項ただし書き適用道',
  '9000': '未調査', '9010': '対象外', '9020': '不明',
});
export const ROAD_FUNCTION_CLASS = Object.freeze({
  '1': 'expressway', '2': 'national', '3': 'prefectural', '4': 'municipal',
  '10': 'buildingStandardAct', '11': 'buildingStandardAct', '12': 'buildingStandardAct',
  '13': 'buildingStandardAct', '14': 'buildingStandardAct', '15': 'buildingStandardAct',
  '9000': 'unsurveyed', '9010': 'outOfScope', '9020': 'unknown',
});

// ── codelists/RoadStructureAttribute_sectionType.xml（§17 高架・橋梁・トンネル判定）
export const SECTION_TYPE_LABEL = Object.freeze({
  '1': '土工区間・通常区間', '2': '高架橋', '3': '橋梁', '4': '交差部',
  '5': 'アンダーパス', '6': 'トンネル', '7': '橋・高架', '9': '不明',
});
export const SECTION_STRUCTURE = Object.freeze({
  '1': 'ground', '2': 'elevated', '3': 'bridge', '4': 'intersection',
  '5': 'underpass', '6': 'tunnel', '7': 'elevated', '9': 'unknown',
});
/** 地表の道路面として扱わない構造区分（§7/§17）。 */
export const SUBSURFACE_STRUCTURES = new Set(['tunnel']);

// ── codelists/TrafficArea_function.xml + AuxiliaryTrafficArea_function.xml（lod3 細分。参考記録用）
export const TRAFFICAREA_FUNCTION_CATEGORY = Object.freeze({
  // TrafficArea
  '1000': 'roadway', '1010': 'roadway', '1020': 'roadway', '1030': 'roadway', '1040': 'roadway',
  '1050': 'track', '1070': 'roadway', '1130': 'roadway',
  '2000': 'sidewalk', '2010': 'sidewalk', '2020': 'sidewalk', '2030': 'bikeway',
  '6000': 'parking', '7000': 'parking',
  '8000': 'track', '8100': 'track', '8110': 'track', '8111': 'track', '8112': 'track', '8120': 'track',
  // AuxiliaryTrafficArea
  '1060': 'roadway', '1080': 'median', '1090': 'median', '1100': 'shoulder',
  '1110': 'roadway', '1120': 'roadway',
  '3000': 'median', '3010': 'median', '3020': 'median',
  '4000': 'median', '5000': 'greenery', '5010': 'greenery', '5020': 'greenery',
});
/** canonical roads の道路面に相当する面種別（§7: 雑に union しない）。 */
export const ROAD_SURFACE_CATEGORIES = new Set(['roadway']);
export const PEDESTRIAN_SURFACE_CATEGORIES = new Set(['sidewalk', 'bikeway']);

/** posList テキスト（"lat lon alt ..." 既定）→ [[lat,lon],...]（alt 破棄）。 */
export function parseTranPosList(text, { axisOrder = 'lat lon', dims = 3 } = {}) {
  const nums = String(text).trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  const out = [];
  for (let i = 0; i + (dims - 1) < nums.length; i += dims) {
    const a = nums[i], b = nums[i + 1];
    out.push(axisOrder === 'lat lon' ? [a, b] : [b, a]);
  }
  return out;
}

/** [lat,lon] → znorth-neg-v1 [x,z]。 */
export function latLonToZNorthNeg(lat, lon, proj) {
  const { centerLat, centerLon, metersPerDegree } = proj;
  const cosf = Math.cos((centerLat * Math.PI) / 180);
  return [
    +(((lon - centerLon) * cosf * metersPerDegree)).toFixed(2),
    +(-((lat - centerLat) * metersPerDegree)).toFixed(2),
  ];
}

/** gml:Polygon 断片群からリング群を抽出（exterior + interior）。 */
export function ringsFromPolygonXml(xml, toXZ, opts = {}) {
  const axisOrder = opts.axisOrder || 'lat lon';
  const defDims = opts.dims || 3;
  const rings = { exterior: [], interior: [] };
  const posOf = (frag) => {
    const m = frag.match(/<gml:posList([^>]*)>([\s\S]*?)<\/gml:posList>/);
    if (!m) return null;
    const dm = m[1].match(/srsDimension="(\d)"/);
    const pts = parseTranPosList(m[2], { axisOrder, dims: dm ? Number(dm[1]) : defDims })
      .map(([lat, lon]) => toXZ(lat, lon));
    return pts.length >= 3 ? pts : null;
  };
  // Polygon 単位で exterior/interior の対応を保つ（Polygon をまたいだ hole 誤結合を防ぐ）
  let any = false;
  for (const pm of xml.matchAll(/<gml:Polygon\b[\s\S]*?<\/gml:Polygon>/g)) {
    any = true;
    const poly = pm[0];
    for (const em of poly.matchAll(/<gml:exterior>[\s\S]*?<\/gml:exterior>/g)) {
      const p = posOf(em[0]); if (p) rings.exterior.push(p);
    }
    for (const im of poly.matchAll(/<gml:interior>[\s\S]*?<\/gml:interior>/g)) {
      const p = posOf(im[0]); if (p) rings.interior.push(p);
    }
  }
  if (!any || !rings.exterior.length) {
    // exterior タグを持たない LinearRing 直書きケース
    for (const lm of xml.matchAll(/<gml:LinearRing>[\s\S]*?<\/gml:LinearRing>/g)) {
      const p = posOf(lm[0]); if (p) rings.exterior.push(p);
    }
  }
  return rings;
}

function ringArea(r) { let a = 0; for (let i = 0; i < r.length; i++) { const q = r[(i + 1) % r.length]; a += r[i][0] * q[1] - q[0] * r[i][1]; } return Math.abs(a) / 2; }
function ringBbox(r) { let a = 1e18, b = -1e18, c = 1e18, d = -1e18; for (const [x, z] of r) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; } return { minX: a, maxX: b, minZ: c, maxZ: d }; }
function segX(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
export function ringSelfIntersects(r) {
  const n = r.length; if (n < 4 || n > 500) return false;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) { if (i === 0 && j === n - 1) continue; if (segX(r[i], r[(i + 1) % n], r[j], r[(j + 1) % n])) return true; }
  return false;
}

/** tran polygon 1 枚の品質検査（§8）。 */
export function validateTranPolygon(rings) {
  if (!rings.exterior.length) return { ok: false, reason: 'no-exterior-ring' };
  let area = 0;
  for (const outer of rings.exterior) {
    for (const p of outer) if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return { ok: false, reason: 'non-finite' };
    const oa = ringArea(outer);
    if (oa < MIN_AREA_M2) return { ok: false, reason: 'zero-area' };
    if (oa > GIANT_AREA_M2) return { ok: false, reason: 'giant-polygon' };
    if (ringSelfIntersects(outer)) return { ok: false, reason: 'self-intersection' };
    area += oa;
  }
  const bb = ringBbox(rings.exterior.flat());
  if (bb.maxX < GROUND_EXTENT.minX - MARGIN || bb.minX > GROUND_EXTENT.maxX + MARGIN
    || bb.maxZ < GROUND_EXTENT.minZ - MARGIN || bb.minZ > GROUND_EXTENT.maxZ + MARGIN) return { ok: false, reason: 'bbox-violation' };
  return { ok: true, areaM2: area, bbox: bb };
}

/** tran:Road ブロック 1 件 → 属性（§7/§17）。 */
export function roadAttributesFromBlock(block) {
  const gmlId = (block.match(/gml:id="([^"]+)"/) || [])[1] || null;
  const fn = (block.match(/<tran:function[^>]*>([^<]+)</) || [])[1];
  const sec = (block.match(/<uro:sectionType[^>]*>([^<]+)</) || [])[1];
  const usage = (block.match(/<tran:usage[^>]*>([^<]+)</) || [])[1];
  const fnCode = fn ? fn.trim() : null;
  const secCode = sec ? sec.trim() : null;
  const structure = secCode ? (SECTION_STRUCTURE[secCode] || 'unknown') : 'unknown';
  return {
    gmlId,
    functionCode: fnCode,
    functionLabel: fnCode ? (ROAD_FUNCTION_LABEL[fnCode] || null) : null,
    adminClass: fnCode ? (ROAD_FUNCTION_CLASS[fnCode] || 'unknown') : 'unknown',
    sectionTypeCode: secCode,
    sectionTypeLabel: secCode ? (SECTION_TYPE_LABEL[secCode] || null) : null,
    structure,
    usageCode: usage ? usage.trim() : null,
    surfaceKind: SUBSURFACE_STRUCTURES.has(structure) ? 'subsurface' : 'roadSurface',
  };
}

function listGml(input) {
  const st = fs.existsSync(input) && fs.statSync(input);
  if (!st) return [];
  if (st.isFile()) return /\.gml$/i.test(input) ? [input] : [];
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d)) { const fp = path.join(d, e); const s = fs.statSync(fp); if (s.isDirectory()) walk(fp); else if (/\.gml$/i.test(e)) out.push(fp); } };
  walk(input);
  return out.sort();
}

function inspect(gmls) {
  const s = {
    files: gmls.length, srsNames: {}, tranElements: {}, lodElements: {},
    roadFunctionCodes: {}, sectionTypeCodes: {}, trafficAreaFunctionCodes: {},
    samplePosList: null, roads: 0,
  };
  for (const f of gmls) {
    const x = fs.readFileSync(f, 'utf-8');
    for (const m of x.matchAll(/srsName="([^"]+)"/g)) s.srsNames[m[1]] = (s.srsNames[m[1]] || 0) + 1;
    for (const m of x.matchAll(/<(tran:[A-Za-z]+)[\s>]/g)) s.tranElements[m[1]] = (s.tranElements[m[1]] || 0) + 1;
    for (const m of x.matchAll(/<(tran:lod\d[A-Za-z]+)[\s>]/g)) s.lodElements[m[1]] = (s.lodElements[m[1]] || 0) + 1;
    for (const m of x.matchAll(/<uro:sectionType[^>]*>([^<]+)</g)) { const c = m[1].trim(); s.sectionTypeCodes[c] = (s.sectionTypeCodes[c] || 0) + 1; }
    for (const rm of x.matchAll(/<tran:Road\b[\s\S]*?<\/tran:Road>/g)) {
      s.roads++;
      const fn = (rm[0].match(/<tran:function[^>]*>([^<]+)</) || [])[1];
      if (fn) s.roadFunctionCodes[fn.trim()] = (s.roadFunctionCodes[fn.trim()] || 0) + 1;
      for (const am of rm[0].matchAll(/<tran:(?:Auxiliary)?TrafficArea\b[\s\S]*?<\/tran:(?:Auxiliary)?TrafficArea>/g)) {
        const af = (am[0].match(/<tran:function[^>]*>([^<]+)</) || [])[1];
        if (af) s.trafficAreaFunctionCodes[af.trim()] = (s.trafficAreaFunctionCodes[af.trim()] || 0) + 1;
      }
    }
    if (!s.samplePosList) { const pm = x.match(/<gml:posList[^>]*>([\s\S]{0,160})/); if (pm) s.samplePosList = pm[1].trim().slice(0, 120); }
  }
  return s;
}

function convertFile(f, toXZ, axisOrder, acc) {
  const xml = fs.readFileSync(f, 'utf-8');
  const base = path.basename(f);
  for (const rm of xml.matchAll(/<tran:Road\b[\s\S]*?<\/tran:Road>/g)) {
    const block = rm[0];
    acc.stats.tranRoads++;
    const attr = roadAttributesFromBlock(block);
    // lod3 TrafficArea は件数のみ記録（§7: lod1 と二重計上しない）
    for (const am of block.matchAll(/<tran:(Auxiliary)?TrafficArea\b[\s\S]*?<\/tran:(?:Auxiliary)?TrafficArea>/g)) {
      if (am[1]) acc.stats.auxTrafficAreas++; else acc.stats.trafficAreas++;
      const af = (am[0].match(/<tran:function[^>]*>([^<]+)</) || [])[1];
      if (af) { const c = TRAFFICAREA_FUNCTION_CATEGORY[af.trim()] || 'other'; acc.stats.trafficAreaDetail[c] = (acc.stats.trafficAreaDetail[c] || 0) + 1; }
    }
    // canonical geometry は lod1MultiSurface のみ
    const lm = block.match(/<tran:lod1MultiSurface>[\s\S]*?<\/tran:lod1MultiSurface>/);
    if (!lm) { acc.rej('no-lod1'); continue; }
    const rings = ringsFromPolygonXml(lm[0], toXZ, { axisOrder, dims: 3 });
    if (!rings.exterior.length) { acc.rej('no-exterior-ring'); continue; }
    const v = validateTranPolygon(rings);
    if (!v.ok) { acc.rej(v.reason); continue; }
    acc.stats.polygonsExtracted++;
    acc.stats.byAdminClass[attr.adminClass] = (acc.stats.byAdminClass[attr.adminClass] || 0) + 1;
    acc.stats.byStructure[attr.structure] = (acc.stats.byStructure[attr.structure] || 0) + 1;
    acc.stats.bySurfaceKind[attr.surfaceKind] = (acc.stats.bySurfaceKind[attr.surfaceKind] || 0) + 1;
    if (attr.surfaceKind === 'roadSurface') acc.stats.roadSurfaceAreaM2 += v.areaM2;
    acc.out.push({
      // §13 stable id: PLATEAU gml:id をそのまま使う（再生成しても不変）
      tranId: attr.gmlId || (base + ':' + acc.stats.tranRoads),
      roadId: attr.gmlId,
      surfaceKind: attr.surfaceKind,
      adminClass: attr.adminClass,
      functionCode: attr.functionCode, functionLabel: attr.functionLabel,
      sectionTypeCode: attr.sectionTypeCode, structure: attr.structure,
      geometryType: rings.exterior.length === 1 ? 'Polygon' : 'MultiPolygon',
      coordinates: rings.exterior.length === 1
        ? [rings.exterior[0], ...rings.interior]
        : rings.exterior.map((e) => [e]),
      areaM2: +v.areaM2.toFixed(2), bbox: v.bbox,
      sourceFile: base,
    });
  }
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) { if (process.argv[i].startsWith('--')) { const k = process.argv[i].slice(2); const v = (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[++i] : true; args[k] = v; } }
  const input = args.input ? resolveProjectPath(args.input) : P('data', 'raw', 'plateau', 'osaka-city', 'tran');
  const proj = JSON.parse(fs.readFileSync(AREA, 'utf-8')).projection;
  const gmls = listGml(input);

  if (!gmls.length) {
    const status = {
      generatedAt: new Date().toISOString(), input: toProjectRelativePath(input),
      RESULT: 'NO-DATA',
      message: 'PLATEAU tran GML が見つからない。配布 ZIP から展開: node tools/extract-plateau-tran.js --zip <配布 ZIP>',
    };
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    await writeJson(REPORT, status);
    console.log('[convert-plateau-tran] tran GML なし: ' + toProjectRelativePath(input));
    console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: NO-DATA');
    return;
  }

  if (args.inspect || !args.convert) {
    const summary = inspect(gmls);
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    await writeJson(REPORT, { generatedAt: new Date().toISOString(), mode: 'inspect', input: toProjectRelativePath(input), summary, RESULT: 'INSPECT-DONE' });
    console.log('[convert-plateau-tran] inspect: ' + gmls.length + ' GML / tran:Road ' + summary.roads);
    console.log('  srsNames: ' + JSON.stringify(Object.keys(summary.srsNames)));
    console.log('  LOD: ' + JSON.stringify(summary.lodElements));
    console.log('  Road_function: ' + JSON.stringify(summary.roadFunctionCodes));
    console.log('  sectionType: ' + JSON.stringify(summary.sectionTypeCodes));
    console.log('保存: ' + toProjectRelativePath(REPORT));
    return;
  }

  const axisOrder = 'lat lon'; // EPSG:6697（実データで確認済み）
  const toXZ = (lat, lon) => latLonToZNorthNeg(lat, lon, proj);
  const acc = {
    out: [],
    stats: {
      files: gmls.length, tranRoads: 0, trafficAreas: 0, auxTrafficAreas: 0, trafficAreaDetail: {},
      polygonsExtracted: 0, rejected: {}, byAdminClass: {}, byStructure: {}, bySurfaceKind: {},
      roadSurfaceAreaM2: 0,
    },
    rej(r) { this.stats.rejected[r] = (this.stats.rejected[r] || 0) + 1; },
  };
  let done = 0;
  for (const f of gmls) {
    convertFile(f, toXZ, axisOrder, acc);
    if (++done % 50 === 0) console.log('  ... ' + done + '/' + gmls.length + ' file, polygon ' + acc.stats.polygonsExtracted);
  }

  const outPath = args.out ? resolveProjectPath(args.out) : OUT_DEFAULT;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    version: 2, kind: 'plateau-tran-road-polygons', coordinateConvention: 'znorth-neg-v1',
    generatedAt: new Date().toISOString(), axisOrder, sourceCrs: 'EPSG:6697',
    geometrySemantics: 'tran:Road/lod1MultiSurface = 道路区域（車道＋歩道を含む道路敷地）',
    sourceGmlCount: gmls.length, polygonCount: acc.out.length, polygons: acc.out,
  }));
  const roadSurface = acc.stats.bySurfaceKind.roadSurface || 0;
  const report = {
    generatedAt: new Date().toISOString(), mode: 'convert',
    input: toProjectRelativePath(input), output: toProjectRelativePath(outPath),
    stats: acc.stats,
    roadSurfacePolygons: roadSurface,
    subsurfacePolygons: acc.stats.bySurfaceKind.subsurface || 0,
    roadSurfaceAreaM2: +acc.stats.roadSurfaceAreaM2.toFixed(0),
    invalidRate: +(Object.values(acc.stats.rejected).reduce((a, b) => a + b, 0) / Math.max(1, acc.stats.tranRoads)).toFixed(5),
    geometrySemantics: 'lod1MultiSurface のみ採用。TrafficArea(lod3) は二重計上回避のため非採用（件数のみ記録）',
    RESULT: acc.out.length > 0 ? 'CONVERTED' : 'EMPTY',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[convert-plateau-tran] converted: ' + acc.out.length + ' polygon（roadSurface ' + roadSurface + ' / subsurface ' + report.subsurfacePolygons + '）');
  console.log('  byAdminClass: ' + JSON.stringify(acc.stats.byAdminClass));
  console.log('  byStructure: ' + JSON.stringify(acc.stats.byStructure));
  console.log('  rejected: ' + JSON.stringify(acc.stats.rejected) + '  invalidRate: ' + report.invalidRate);
  console.log('保存: ' + toProjectRelativePath(outPath) + ' / ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[convert-plateau-tran] 失敗:', e && e.stack || e); process.exit(1); });
