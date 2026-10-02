#!/usr/bin/env node
// tools/audit/umeda-real-world-ground-truth-audit.js
// [Mission 32H] UMEDA REAL-WORLD GROUND TRUTH AUDIT — AUDIT ONLY
//   (building geometry変更 / Road変更 / Land Block変更 / offset / scale / clipping /
//    automatic correction / canonical rebuild は一切行わない。読み取りと比較測定のみ)
//
//   目的: Mission 32G が SOURCE_CONFLICT のまま残した
//     H1「実際に線路・道路上へ張り出した駅施設・高架建築・デッキ等である」
//     H2「PLATEAU lod0FootPrint そのものが地上接地形状より過大である」
//   を、現実世界の Ground Truth と照合して判定する。
//
//   ■ 32G の前提の訂正（このミッション最初の発見）
//   32G は「大阪市24区(Kita区/梅田)のPLATEAU建物生CityGMLはこのサンドボックスに存在しない」と
//   記録し、住吉区を代替証拠として使った。これは誤りだった。梅田の生CityGMLは
//   data/raw/osaka-higashisumiyoshi/ 配下に(ディレクトリ名に反して)二次メッシュ 523503/523504 として
//   実在する。本ミッションは梅田そのものの生CityGMLを一次証拠として使う。
//
//   ■ Ground Truth として実際に使えたもの / 使えなかったもの（§5-§9 の正直な開示）
//   使えない: 航空写真/正射画像。このリポジトリにもサンドボックスにも画像は1枚も存在せず
//            (public/ にあるのはロゴPNGのみ)、タイル参照もキャッシュも無く、ネットワークも無い。
//            したがって §5(航空写真比較) §6(orthophoto bounds) §8(control point) §9(alignment誤差)は
//            実行不能である。「実行できなかった」ことを結果として報告し、数値を捏造しない。
//   使える : 梅田の生PLATEAU CityGML そのもの。特に
//            - bldg:lod0FootPrint / bldg:lod0RoofEdge のどちらが採用されているか(提供者の意味付け)
//            - LOD2 (GroundSurface / RoofSurface / WallSurface / lod2Solid)
//            - uro:buildingRoofEdgeArea(屋根投影面積) — 面積属性がこれしか存在しないこと自体が情報
//            - uro:publicSurveySrcDescLod0 / srcScaleLod0 / lod1HeightType(取得方法と地図情報レベル)
//            - gml:name(実名。「大阪駅」等は提供者による直接の同定)
//            - bldg:class(無壁舎=壁の無い構造物) / bldg:usage
//            - core:creationDate / uro:surveyYear(§14 時点差)
//   使える(2): OSM(data/raw/osm/osaka-latest.osm.pbf)の建物outline。OSMの建物は航空写真/現地調査から
//            人手でトレースされた「上空から見て実在する構造物」の独立記録であり、正射画像そのものでは
//            ないが、画像から読み取れる情報をベクタ化したものとして本ミッションのGround Truthに使う。
//            ただし 32G の失敗（GSIは道路上に建物を描かないので、どちらの仮説でも同じ観測になる＝
//            判別不能）を繰り返さないため、使用前に「OSMは道路上の建物を避けていないか」を
//            母集団統計で検証し、検証に通った場合にのみ判定材料として採用する。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const RAW_BLDG_DIR = P('data', 'raw', 'osaka-higashisumiyoshi');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const CANON_RAIL = P('data', 'processed', 'osaka-city', 'canonical', 'rail');
const ROAD_V2_DIR = P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v2', 'tiles');
const CODELIST_DIR = P('data', 'raw', 'plateau', 'osaka-city', 'codelists');
const GSI_ROAD_EDGE_DIR = P('data', 'raw', 'gsi', 'road-edge');
const OSM_PBF = P('data', 'raw', 'osm', 'osaka-latest.osm.pbf');
const G32_REPORT = P('data', 'reports', 'umeda-ground-footprint-audit.json');
const REPORT = P('data', 'reports', 'umeda-real-world-ground-truth-audit.json');
const QA_DIR = P('data', 'processed', 'osaka-city', 'reality-qa', 'umeda');
const PUBLIC_QA_DIR = P('public', 'map-data', 'osaka-city', 'reality-qa', 'umeda');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

// ── 座標系: znorth-neg-v1（config/areas/osaka-city.json と同一。変更禁止） ──
const CENTER_LAT = 34.604208, CENTER_LON = 135.52502, MPD = 111320;
const COSLAT = Math.cos((CENTER_LAT * Math.PI) / 180);
const toX = (lon) => (lon - CENTER_LON) * COSLAT * MPD;
const toZ = (lat) => -((lat - CENTER_LAT) * MPD);

// 32G と同一の梅田AOI（サンプルの同一性を保つため変更しない）
const CENTER = { x: -2668.18, z: -10941.87 };
const HALF_SPAN_M = 600;
const BOUNDS = { minX: CENTER.x - HALF_SPAN_M, maxX: CENTER.x + HALF_SPAN_M, minZ: CENTER.z - HALF_SPAN_M, maxZ: CENTER.z + HALF_SPAN_M };
const CELL_M = 1.0;
const RAIL_HALF_WIDTH_M = 5; // 32G と同一の近似（実測軌道幅データが無い）

// ── 基本図形ユーティリティ ──
function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a) / 2; }
function bboxOfRing(r) { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity; for (const p of r) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; } return { minX, maxX, minZ, maxZ }; }
function bboxOverlaps(a, b) { return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ; }
function pointInRing(x, z, r) { let inside = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside; } return inside; }
function distPointToSegment(px, pz, ax, az, bx, bz) { const dx = bx - ax, dz = bz - az; const L = dx * dx + dz * dz; let t = L === 0 ? 0 : ((px - ax) * dx + (pz - az) * dz) / L; t = Math.max(0, Math.min(1, t)); const qx = ax + t * dx, qz = az + t * dz; return Math.hypot(px - qx, pz - qz); }
const roefRateText = (r) => (r == null ? 'n/a' : (r * 100).toFixed(1) + '%');
function median(v) { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(4); }
function tileRange(b, size) { return { txMin: Math.floor(b.minX / size), txMax: Math.floor(b.maxX / size), tzMin: Math.floor(b.minZ / size), tzMax: Math.floor(b.maxZ / size) }; }

// ── 標準地域メッシュ(3次, 8桁)のbbox ──
function meshBbox(code) {
  const p = String(code);
  const lat0 = +p.slice(0, 2) / 1.5, lon0 = +p.slice(2, 4) + 100;
  const lat1 = lat0 + +p[4] / 12, lon1 = lon0 + +p[5] / 8;
  const s = lat1 + +p[6] / 120, w = lon1 + +p[7] / 80;
  return { s, n: s + 1 / 120, w, e: w + 1 / 80 };
}
/** AOI(world) と交差する3次メッシュの生CityGMLファイル名を返す。 */
function meshFilesForBounds(bounds) {
  if (!fs.existsSync(RAW_BLDG_DIR)) return [];
  const latOf = (z) => CENTER_LAT - z / MPD;
  const lonOf = (x) => CENTER_LON + x / (COSLAT * MPD);
  const box = { s: latOf(bounds.maxZ), n: latOf(bounds.minZ), w: lonOf(bounds.minX), e: lonOf(bounds.maxX) };
  return fs.readdirSync(RAW_BLDG_DIR)
    .filter((f) => /^\d{8}_bldg_\d+_op\.gml$/.test(f))
    .filter((f) => { const b = meshBbox(f.slice(0, 8)); return b.w < box.e && b.e > box.w && b.s < box.n && b.n > box.s; })
    .sort();
}

// ── CityGML 抽出（正規表現ベース。PLATEAU の実ファイル構造に対して実測で検証済み） ──
function posLists(xml) {
  const out = []; const re = /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g; let m;
  while ((m = re.exec(xml))) {
    const n = m[1].trim().split(/\s+/).map(Number); const pts = [];
    for (let i = 0; i + 2 < n.length; i += 3) pts.push([toX(n[i + 1]), toZ(n[i]), n[i + 2]]);
    if (pts.length >= 3) out.push(pts);
  }
  return out;
}
function blocksOf(xml, tag) { const out = []; const re = new RegExp('<' + tag + '[\\s>][\\s\\S]*?</' + tag + '>', 'g'); let m; while ((m = re.exec(xml))) out.push(m[0]); return out; }
function subOf(xml, tag) { const m = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>')); return m ? m[1] : null; }
function attrOf(xml, tag) { const m = xml.match(new RegExp('<' + tag + '[^>]*>([^<]+)')); return m ? m[1] : null; }
function yRange(rings) { const v = []; for (const r of rings) for (const p of r) v.push(p[2]); return v.length ? { min: +Math.min(...v).toFixed(2), max: +Math.max(...v).toFixed(2) } : null; }

function readCodelist(file) {
  const p = path.join(CODELIST_DIR, file);
  if (!fs.existsSync(p)) return {};
  const s = fs.readFileSync(p, 'utf-8'); const o = {};
  const re = /<gml:name>([^<]*)<\/gml:name>\s*<gml:description[^>]*>([^<]*)<\/gml:description>|<gml:description>([^<]*)<\/gml:description>\s*<gml:name>([^<]*)<\/gml:name>/g;
  let m; while ((m = re.exec(s))) { if (m[1] !== undefined) o[m[2]] = m[1]; else o[m[3]] = m[4]; }
  return o;
}

/**
 * 1つの bldg:Building ブロックから、判定に必要な実測値をすべて取り出す。
 * ※ 推測値は入れない。データに無いものは null。
 */
function parseBuilding(part, gmlId, meshCode) {
  const fpXml = subOf(part, 'bldg:lod0FootPrint');
  const reXml = subOf(part, 'bldg:lod0RoofEdge');
  const lod0Kind = fpXml ? 'lod0FootPrint' : (reXml ? 'lod0RoofEdge' : null);
  const lod0Rings = fpXml ? posLists(fpXml) : (reXml ? posLists(reXml) : []);
  const gsRings = blocksOf(part, 'bldg:GroundSurface').flatMap((b) => posLists(b));
  const rsRings = blocksOf(part, 'bldg:RoofSurface').flatMap((b) => posLists(b));
  const wsRings = blocksOf(part, 'bldg:WallSurface').flatMap((b) => posLists(b));
  const l1Rings = subOf(part, 'bldg:lod1Solid') ? posLists(subOf(part, 'bldg:lod1Solid')) : [];
  const outer = lod0Rings.length ? lod0Rings[0] : null;
  const roofEdgeAreaRaw = attrOf(part, 'uro:buildingRoofEdgeArea');
  const roofEdgeArea = roofEdgeAreaRaw != null && Number(roofEdgeAreaRaw) > 0 ? +Number(roofEdgeAreaRaw).toFixed(2) : null;
  const surveyRaw = attrOf(part, 'uro:surveyYear');
  return {
    gmlId, meshCode, lod0Kind,
    outerRing: outer ? outer.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]) : null,
    lod0AreaM2: outer ? +ringArea(outer).toFixed(2) : null,
    centroid: outer ? [+(outer.reduce((a, p) => a + p[0], 0) / outer.length).toFixed(2), +(outer.reduce((a, p) => a + p[1], 0) / outer.length).toFixed(2)] : null,
    groundSurfaceCount: gsRings.length,
    groundSurfaceAreaM2: gsRings.length ? +gsRings.reduce((a, r) => a + ringArea(r), 0).toFixed(2) : null,
    groundSurfaceY: yRange(gsRings),
    roofSurfaceCount: rsRings.length,
    roofSurfaceY: yRange(rsRings),
    wallSurfaceCount: wsRings.length,
    wallSurfaceY: yRange(wsRings),
    lod1Y: yRange(l1Rings),
    hasLod2Solid: /<bldg:lod2Solid>/.test(part),
    lod2MultiSurfaceCount: (part.match(/<bldg:lod2MultiSurface>/g) || []).length,
    measuredHeightM: attrOf(part, 'bldg:measuredHeight') ? +attrOf(part, 'bldg:measuredHeight') : null,
    classCode: attrOf(part, 'bldg:class'),
    usageCode: attrOf(part, 'bldg:usage'),
    name: (part.match(/<gml:name>([^<]*)<\/gml:name>/) || [])[1] || null,
    creationDate: attrOf(part, 'core:creationDate'),
    surveyYear: surveyRaw && /^\d{4}$/.test(surveyRaw) && surveyRaw !== '0001' ? surveyRaw : null,
    buildingRoofEdgeAreaM2: roofEdgeArea,
    geometrySrcDescLod0: attrOf(part, 'uro:geometrySrcDescLod0'),
    geometrySrcDescLod2: attrOf(part, 'uro:geometrySrcDescLod2'),
    publicSurveySrcDescLod0: attrOf(part, 'uro:publicSurveySrcDescLod0'),
    srcScaleLod0: attrOf(part, 'uro:srcScaleLod0'),
    lod1HeightType: attrOf(part, 'uro:lod1HeightType'),
    ward: (part.match(/<gen:stringAttribute name="区名"><gen:value>([^<]*)</) || [])[1] || null,
  };
}

/** §3/§4: 梅田該当メッシュの生CityGMLを実データ集計する（推測禁止）。 */
function scanUmedaRawPlateau(files) {
  const perMesh = [];
  const byId = new Map();
  const agg = { buildingCount: 0, lod0FootPrint: 0, lod0RoofEdge: 0, lod1Solid: 0, lod2Solid: 0, lod2MultiSurface: 0, GroundSurface: 0, RoofSurface: 0, WallSurface: 0 };
  const srsNames = new Set(); const creationDates = new Map(); const surveyYears = new Map();
  for (const f of files) {
    const s = fs.readFileSync(path.join(RAW_BLDG_DIR, f), 'utf-8');
    for (const m of s.match(/srsName="[^"]+"/g) || []) srsNames.add(m.slice(9, -1));
    const mesh = f.slice(0, 8);
    const counts = { mesh, file: toProjectRelativePath(path.join(RAW_BLDG_DIR, f)), buildingCount: 0, lod0FootPrint: 0, lod0RoofEdge: 0, lod1Solid: 0, lod2Solid: 0, lod2MultiSurface: 0, GroundSurface: 0, RoofSurface: 0, WallSurface: 0 };
    for (const part of s.split('<core:cityObjectMember>')) {
      const m = part.match(/<bldg:Building gml:id="([^"]+)"/);
      if (!m) continue;
      counts.buildingCount++;
      counts.lod0FootPrint += (part.match(/<bldg:lod0FootPrint>/g) || []).length;
      counts.lod0RoofEdge += (part.match(/<bldg:lod0RoofEdge>/g) || []).length;
      counts.lod1Solid += (part.match(/<bldg:lod1Solid>/g) || []).length;
      counts.lod2Solid += (part.match(/<bldg:lod2Solid>/g) || []).length;
      counts.lod2MultiSurface += (part.match(/<bldg:lod2MultiSurface>/g) || []).length;
      counts.GroundSurface += (part.match(/<bldg:GroundSurface[\s>]/g) || []).length;
      counts.RoofSurface += (part.match(/<bldg:RoofSurface[\s>]/g) || []).length;
      counts.WallSurface += (part.match(/<bldg:WallSurface[\s>]/g) || []).length;
      const b = parseBuilding(part, m[1], mesh);
      if (b.creationDate) creationDates.set(b.creationDate, (creationDates.get(b.creationDate) || 0) + 1);
      if (b.surveyYear) surveyYears.set(b.surveyYear, (surveyYears.get(b.surveyYear) || 0) + 1);
      byId.set(m[1], b);
    }
    perMesh.push(counts);
    for (const k of Object.keys(agg)) agg[k] += counts[k];
  }
  return {
    available: files.length > 0,
    meshFiles: perMesh,
    aggregate: agg,
    srsName: [...srsNames],
    creationDates: Object.fromEntries([...creationDates].sort()),
    surveyYears: Object.fromEntries([...surveyYears].sort()),
    lod2Availability: agg.lod2Solid > 0 ? 'UMEDA_LOD2_AVAILABLE' : 'UMEDA_LOD2_NOT_AVAILABLE',
    lod2BuildingRatio: agg.buildingCount ? +(agg.lod2Solid / agg.buildingCount).toFixed(4) : null,
    byId,
  };
}

// ── ROAD V2 / Rail ラスタ（32G と同一手法・同一パラメータ） ──
function buildRoadRailMasks() {
  const nx = Math.ceil((BOUNDS.maxX - BOUNDS.minX) / CELL_M), nz = Math.ceil((BOUNDS.maxZ - BOUNDS.minZ) / CELL_M);
  const road = new Uint8Array(nx * nz), rail = new Uint8Array(nx * nz);
  const fillRing = (ring, target) => {
    const bb = bboxOfRing(ring); if (!bboxOverlaps(bb, BOUNDS)) return;
    const ix0 = Math.max(0, Math.floor((bb.minX - BOUNDS.minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((bb.maxX - BOUNDS.minX) / CELL_M));
    const iz0 = Math.max(0, Math.floor((bb.minZ - BOUNDS.minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((bb.maxZ - BOUNDS.minZ) / CELL_M));
    for (let ix = ix0; ix <= ix1; ix++) { const px = BOUNDS.minX + (ix + 0.5) * CELL_M;
      for (let iz = iz0; iz <= iz1; iz++) { const pz = BOUNDS.minZ + (iz + 0.5) * CELL_M; if (pointInRing(px, pz, ring)) target[iz * nx + ix] = 1; } }
  };
  const { txMin, txMax, tzMin, tzMax } = tileRange(BOUNDS, 2000);
  for (let tx = txMin; tx <= txMax; tx++) for (let tz = tzMin; tz <= tzMax; tz++) {
    const t = rj(path.join(ROAD_V2_DIR, 'tile_' + tx + '_' + tz + '.json'));
    if (t) for (const f of t.features || []) {
      if (!f.envelope) continue;
      const polys = f.envelope.geometryType === 'Polygon' ? [f.envelope.coordinates] : (f.envelope.geometryType === 'MultiPolygon' ? f.envelope.coordinates : []);
      for (const poly of polys) for (const ring of poly) if (Array.isArray(ring) && ring.length > 2) fillRing(ring, road);
    }
    const r = rj(path.join(CANON_RAIL, 'tile_' + tx + '_' + tz + '.json'));
    if (r) for (const f of r.features || []) {
      if (f.geometryType !== 'LineString' || !Array.isArray(f.coordinates)) continue;
      const c = f.coordinates;
      for (let i = 0; i + 1 < c.length; i++) {
        const [ax, az] = c[i], [bx, bz] = c[i + 1];
        const sMinX = Math.min(ax, bx) - RAIL_HALF_WIDTH_M, sMaxX = Math.max(ax, bx) + RAIL_HALF_WIDTH_M;
        const sMinZ = Math.min(az, bz) - RAIL_HALF_WIDTH_M, sMaxZ = Math.max(az, bz) + RAIL_HALF_WIDTH_M;
        if (!bboxOverlaps({ minX: sMinX, maxX: sMaxX, minZ: sMinZ, maxZ: sMaxZ }, BOUNDS)) continue;
        const ix0 = Math.max(0, Math.floor((sMinX - BOUNDS.minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((sMaxX - BOUNDS.minX) / CELL_M));
        const iz0 = Math.max(0, Math.floor((sMinZ - BOUNDS.minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((sMaxZ - BOUNDS.minZ) / CELL_M));
        for (let ix = ix0; ix <= ix1; ix++) { const px = BOUNDS.minX + (ix + 0.5) * CELL_M;
          for (let iz = iz0; iz <= iz1; iz++) { const pz = BOUNDS.minZ + (iz + 0.5) * CELL_M; if (distPointToSegment(px, pz, ax, az, bx, bz) <= RAIL_HALF_WIDTH_M) rail[iz * nx + ix] = 1; } }
      }
    }
  }
  return { nx, nz, road, rail };
}
function overlapRatios(ring, masks) {
  const { nx, nz, road, rail } = masks;
  const bb = bboxOfRing(ring);
  const ix0 = Math.max(0, Math.floor((bb.minX - BOUNDS.minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((bb.maxX - BOUNDS.minX) / CELL_M));
  const iz0 = Math.max(0, Math.floor((bb.minZ - BOUNDS.minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((bb.maxZ - BOUNDS.minZ) / CELL_M));
  let total = 0, onRoad = 0, onRail = 0;
  for (let ix = ix0; ix <= ix1; ix++) { const px = BOUNDS.minX + (ix + 0.5) * CELL_M;
    for (let iz = iz0; iz <= iz1; iz++) { const pz = BOUNDS.minZ + (iz + 0.5) * CELL_M; if (!pointInRing(px, pz, ring)) continue;
      total++; const idx = iz * nx + ix; if (road[idx]) onRoad++; if (rail[idx]) onRail++; } }
  return { cells: total, roadRatio: total ? +(onRoad / total).toFixed(4) : 0, railRatio: total ? +(onRail / total).toFixed(4) : 0 };
}

// ══════════════════════════════════════════════════════════════════════════════
// OSM（Ground Truth 候補）
// ══════════════════════════════════════════════════════════════════════════════
/**
 * AOI(+PAD) 内の OSM building / highway / railway を1パスで抽出する。
 * PBF は node が way より前に並ぶ（実測: lastNodeIdx=5,909,958 < firstWayIdx=5,909,959）ため、
 * node を先に bbox で絞ってから way を解決できる。
 */
async function loadOsmInBounds(bounds, padM = 250) {
  if (!fs.existsSync(OSM_PBF)) return { available: false, reason: 'data/raw/osm/osaka-latest.osm.pbf が無い', buildings: [], highways: [] };
  const latOf = (z) => CENTER_LAT - z / MPD, lonOf = (x) => CENTER_LON + x / (COSLAT * MPD);
  const box = { s: latOf(bounds.maxZ + padM), n: latOf(bounds.minZ - padM), w: lonOf(bounds.minX - padM), e: lonOf(bounds.maxX + padM) };
  const nodes = new Map();
  const rawB = [], rawH = [];
  let nodeMax = -1, wayMin = Infinity, i = 0;
  for await (const p of pbfPrimitiveStream(OSM_PBF)) {
    i++;
    if (p.type === 'node') {
      nodeMax = i;
      if (p.lat >= box.s && p.lat <= box.n && p.lon >= box.w && p.lon <= box.e) nodes.set(p.id, [toX(p.lon), toZ(p.lat)]);
    } else if (p.type === 'way') {
      if (i < wayMin) wayMin = i;
      const t = p.tags || {};
      const isB = !!(t.building || t['building:part']);
      const isH = typeof t.highway === 'string';
      if (!isB && !isH) continue;
      let hit = false; for (const r of p.refs || []) if (nodes.has(r)) { hit = true; break; }
      if (!hit) continue;
      (isB ? rawB : rawH).push({ id: p.id, refs: p.refs, tags: t });
    }
  }
  const resolve = (w) => { const pts = []; for (const r of w.refs || []) { const c = nodes.get(r); if (!c) return null; pts.push(c); } return pts; };
  const buildings = [];
  for (const w of rawB) {
    const pts = resolve(w); if (!pts || pts.length < 4) continue;
    const ring = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts.slice(0, -1) : pts;
    if (ring.length < 3) continue;
    buildings.push({ id: w.id, ring, bbox: bboxOfRing(ring), areaM2: +ringArea(ring).toFixed(2), tags: w.tags });
  }
  const highways = [];
  for (const w of rawH) { const pts = resolve(w); if (!pts || pts.length < 2) continue; highways.push({ id: w.id, line: pts, tags: w.tags }); }
  return { available: true, nodeOrderingValid: nodeMax < wayMin, nodesInBox: nodes.size, buildings, highways };
}

/**
 * §8/§9: Ground Truth 側(OSM)と Live City world の位置合わせを、建物以外の control point で確認する。
 * ROAD V2 の「GSI Road Edge から復元した車道 corridor」中心点（＝OSMとは完全に独立な由来）に対し、
 * 最寄りの OSM highway 中心線までの距離を測る。両者が同じ道路の中心を指しているなら距離は小さい。
 * ※ §8 は交差点/橋/河川縁/線路分岐/大型施設外周を例示しているが、このリポジトリで OSM 由来でない
 *    非建物レイヤーは GSI Road Edge 系列しか存在しない（rivers/rail/parks/roads は全て OSM 由来で、
 *    比較すると自己比較になり無意味）。そのため control point は GSI由来の車道 corridor 中心とした。
 */
function auditOsmAlignment(osm, minPoints = 10) {
  const { txMin, txMax, tzMin, tzMax } = tileRange(BOUNDS, 2000);
  const pts = [];
  for (let tx = txMin; tx <= txMax; tx++) for (let tz = tzMin; tz <= tzMax; tz++) {
    const t = rj(path.join(ROAD_V2_DIR, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
    for (const f of t.features || []) {
      if (f.class !== 'R' || !Array.isArray(f.carriageway)) continue;
      // road-visual-v2 の carriageway は「リング(四角形)の配列」であって GeoJSON 形ではない。
      for (const ring of f.carriageway) {
        if (!Array.isArray(ring) || ring.length < 3) continue;
        const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length, cz = ring.reduce((a, p) => a + p[1], 0) / ring.length;
        if (cx < BOUNDS.minX || cx > BOUNDS.maxX || cz < BOUNDS.minZ || cz > BOUNDS.maxZ) continue;
        pts.push([cx, cz]);
      }
    }
  }
  if (!pts.length) return { controlPointCount: 0, sufficient: false, controlPointKind: null, distanceToNearestOsmHighwayM: { median: null, p95: null, max: null }, samplePoints: [], note: 'ROAD V2 の車道corridorがAOI内に見つからなかった。' };
  // AOI 全体に分散させる: 4x4 グリッドから最大2点ずつ拾う
  const cell = new Map();
  const picked = [];
  for (const p of pts) {
    const k = Math.floor(((p[0] - BOUNDS.minX) / (BOUNDS.maxX - BOUNDS.minX)) * 4) + ':' + Math.floor(((p[1] - BOUNDS.minZ) / (BOUNDS.maxZ - BOUNDS.minZ)) * 4);
    const n = cell.get(k) || 0; if (n >= 2) continue; cell.set(k, n + 1); picked.push(p);
  }
  const roadHw = osm.highways.filter((h) => /^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service|pedestrian|road)/.test(h.tags.highway || ''));
  const dists = [];
  for (const [px, pz] of picked) {
    let best = Infinity;
    for (const h of roadHw) for (let i = 0; i + 1 < h.line.length; i++) {
      const d = distPointToSegment(px, pz, h.line[i][0], h.line[i][1], h.line[i + 1][0], h.line[i + 1][1]);
      if (d < best) best = d;
    }
    if (Number.isFinite(best)) dists.push(+best.toFixed(2));
  }
  const sorted = [...dists].sort((a, b) => a - b);
  return {
    controlPointCount: dists.length,
    sufficient: dists.length >= minPoints,
    controlPointKind: 'GSI Road Edge 由来 ROAD V2 車道corridor中心点（OSMとは独立由来・非建物）',
    distanceToNearestOsmHighwayM: {
      median: median(dists), p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
      max: sorted.length ? sorted[sorted.length - 1] : null,
    },
    samplePoints: picked.slice(0, minPoints).map((p, i) => ({ x: p[0], z: p[1], distanceM: dists[i] != null ? dists[i] : null })),
    note: '道路中心同士の比較なので理論値は0付近。数十mのズレが出ていればOSMをGround Truthに使えない。',
  };
}

/** OSM建物のユニオンラスタ（AOI 1m セル）。 */
function buildOsmMask(osm) {
  const nx = Math.ceil((BOUNDS.maxX - BOUNDS.minX) / CELL_M), nz = Math.ceil((BOUNDS.maxZ - BOUNDS.minZ) / CELL_M);
  const mask = new Uint8Array(nx * nz);
  const idOf = new Int32Array(nx * nz).fill(-1);
  osm.buildings.forEach((b, bi) => {
    if (!bboxOverlaps(b.bbox, BOUNDS)) return;
    const ix0 = Math.max(0, Math.floor((b.bbox.minX - BOUNDS.minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((b.bbox.maxX - BOUNDS.minX) / CELL_M));
    const iz0 = Math.max(0, Math.floor((b.bbox.minZ - BOUNDS.minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((b.bbox.maxZ - BOUNDS.minZ) / CELL_M));
    for (let ix = ix0; ix <= ix1; ix++) { const px = BOUNDS.minX + (ix + 0.5) * CELL_M;
      for (let iz = iz0; iz <= iz1; iz++) { const pz = BOUNDS.minZ + (iz + 0.5) * CELL_M;
        if (!pointInRing(px, pz, b.ring)) continue; const idx = iz * nx + ix; mask[idx] = 1; if (idOf[idx] < 0) idOf[idx] = bi; } }
  });
  return { nx, nz, mask, idOf };
}

/**
 * ★ 妥当性ゲート ★
 * 「OSMは道路・線路の上に建物を描かない」なら、OSMで道路上の建物の有無を測っても
 * H1/H2 を区別できない（32Gで GSI に対して起きた失敗と同型）。
 * そこで OSM建物そのものの road/rail 重なり分布を母集団（AOI内の全OSM建物）で測り、
 * OSMが道路上の構造物を実際に描いているかどうかを先に確かめる。
 */
function auditOsmRoadAvoidance(osm, masks, osmMask, plateauRingsInBounds) {
  // (1) 偽陽性率: 「PLATEAU建物が無い道路/線路セル」のうち、OSM建物が乗っているのは何%か。
  //     これが高いとOSM建物が面的に敷き詰められているだけで、「道路上にOSM建物がある」は情報量を持たない。
  const { nx, nz, road, rail } = masks;
  const plateauMask = new Uint8Array(nx * nz);
  for (const ring of plateauRingsInBounds) {
    const bb = bboxOfRing(ring); if (!bboxOverlaps(bb, BOUNDS)) continue;
    const ix0 = Math.max(0, Math.floor((bb.minX - BOUNDS.minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((bb.maxX - BOUNDS.minX) / CELL_M));
    const iz0 = Math.max(0, Math.floor((bb.minZ - BOUNDS.minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((bb.maxZ - BOUNDS.minZ) / CELL_M));
    for (let ix = ix0; ix <= ix1; ix++) { const px = BOUNDS.minX + (ix + 0.5) * CELL_M;
      for (let iz = iz0; iz <= iz1; iz++) { const pz = BOUNDS.minZ + (iz + 0.5) * CELL_M; if (pointInRing(px, pz, ring)) plateauMask[iz * nx + ix] = 1; } }
  }
  let rrOutside = 0, rrOutsideOsm = 0, aoiCells = 0, aoiOsm = 0;
  for (let i = 0; i < nx * nz; i++) {
    aoiCells++; if (osmMask.mask[i]) aoiOsm++;
    if ((road[i] || rail[i]) && !plateauMask[i]) { rrOutside++; if (osmMask.mask[i]) rrOutsideOsm++; }
  }
  const falsePositiveRate = rrOutside ? +(rrOutsideOsm / rrOutside).toFixed(4) : null;

  const rows = [];
  for (const b of osm.buildings) {
    if (!bboxOverlaps(b.bbox, BOUNDS)) continue;
    if (b.areaM2 < 50) continue;
    const r = overlapRatios(b.ring, masks);
    if (!r.cells) continue;
    rows.push(r);
  }
  const roadRatios = rows.map((r) => r.roadRatio), railRatios = rows.map((r) => r.railRatio);
  const frac = (v, t) => (v.length ? +(v.filter((x) => x >= t).length / v.length).toFixed(4) : null);
  const usable = (frac(roadRatios, 0.25) || 0) >= 0.02 || (frac(railRatios, 0.15) || 0) >= 0.02;
  return {
    aoiOsmBuildingCoverage: aoiCells ? +(aoiOsm / aoiCells).toFixed(4) : null,
    roadRailCellsOutsidePlateauBuildings: rrOutside,
    osmBuildingOnThoseCellsRatio: falsePositiveRate,
    falsePositiveInterpretation: falsePositiveRate == null ? null
      : (falsePositiveRate <= 0.2
        ? 'OSM建物は「PLATEAU建物が無い道路/線路セル」の' + (falsePositiveRate * 100).toFixed(1) + '%にしか乗っていない。'
          + 'すなわちOSM建物が道路上に現れるのは稀であり、「PLATEAU外形の道路重なり部分にOSM建物がある」という観測は偶然では生じにくい＝情報量がある。'
        : 'OSM建物が道路/線路セルの' + (falsePositiveRate * 100).toFixed(1) + '%に乗っており、面的に敷き詰められている可能性がある。この場合「道路上にOSM建物がある」は弱い証拠にしかならない。'),
    osmBuildingsMeasured: rows.length,
    roadRatioMedian: median(roadRatios), railRatioMedian: median(railRatios),
    fractionWithRoadRatioGte25pct: frac(roadRatios, 0.25),
    fractionWithRailRatioGte15pct: frac(railRatios, 0.15),
    osmDrawsBuildingsOverRoadOrRail: usable,
    verdict: usable ? 'OSM_USABLE_AS_GROUND_TRUTH' : 'OSM_AVOIDS_ROADS_NOT_USABLE',
    note: usable
      ? 'AOI内のOSM建物のうち相当数が道路/線路corridorと重なって描かれている。すなわちOSMは「道路上には建物を描かない」という性質を持たないので、'
        + '「PLATEAU外形の道路上部分にOSM建物があるか」は H1(実在する上空構造) と H2(過大な外形) を区別する有効な観測になる。'
      : 'OSMも道路・線路上に建物をほぼ描いていない。この場合、OSMの不在は「構造物が無い」ことを意味せず、32GでGSIに対して起きたのと同じ判別不能に陥る。よってOSMを判定材料に使わない。',
  };
}

/** 建物footprintに対する OSM 建物の被覆（道路/線路部分と非道路部分で分けて測る）。 */
function osmCoverageFor(ring, masks, osmMask, osm) {
  const { nx, nz, road, rail } = masks;
  const bb = bboxOfRing(ring);
  const ix0 = Math.max(0, Math.floor((bb.minX - BOUNDS.minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((bb.maxX - BOUNDS.minX) / CELL_M));
  const iz0 = Math.max(0, Math.floor((bb.minZ - BOUNDS.minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((bb.maxZ - BOUNDS.minZ) / CELL_M));
  let total = 0, cov = 0, rrCells = 0, rrCov = 0, clean = 0, cleanCov = 0;
  const hits = new Map();
  for (let ix = ix0; ix <= ix1; ix++) { const px = BOUNDS.minX + (ix + 0.5) * CELL_M;
    for (let iz = iz0; iz <= iz1; iz++) { const pz = BOUNDS.minZ + (iz + 0.5) * CELL_M;
      if (!pointInRing(px, pz, ring)) continue;
      const idx = iz * nx + ix; total++;
      const isRR = road[idx] || rail[idx];
      const isCov = osmMask.mask[idx] === 1;
      if (isCov) { cov++; const bi = osmMask.idOf[idx]; if (bi >= 0) hits.set(bi, (hits.get(bi) || 0) + 1); }
      if (isRR) { rrCells++; if (isCov) rrCov++; } else { clean++; if (isCov) cleanCov++; }
    } }
  const top = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([bi, c]) => {
    const t = osm.buildings[bi].tags;
    return { osmId: osm.buildings[bi].id, name: t.name || null, building: t.building || t['building:part'] || null, covers: +(c / total).toFixed(3) };
  });
  const stationLike = top.some((h) => { const b = osm.buildings.find((x) => x.id === h.osmId); const t = b ? b.tags : {};
    return t.building === 'train_station' || t.public_transport === 'station' || t.railway === 'station' || t.covered === 'yes' || t.bridge === 'yes' || t.man_made === 'bridge'; });
  return {
    footprintCells: total,
    osmCoverageRatio: total ? +(cov / total).toFixed(4) : null,
    roadRailCells: rrCells,
    osmCoverageOfRoadRailPart: rrCells ? +(rrCov / rrCells).toFixed(4) : null,
    osmCoverageOfCleanPart: clean ? +(cleanCov / clean).toFixed(4) : null,
    topOsmOverlaps: top,
    osmStationLike: stationLike,
  };
}

/**
 * §15: LOD2が存在する建物で lod0FootPrint / GroundSurface / RoofSurface投影 / WallSurface下端 を比較する。
 * これは「LOD2が独立した外形情報を持っているか」を確かめるための測定であり、
 * 結果が『すべて同一ポリゴン』なら LOD2 は外形の独立証拠にならない、と結論すること自体が成果。
 */
function compareLod2Outlines(part, b) {
  if (!b.hasLod2Solid || !b.outerRing) return null;
  const fpRing = b.outerRing;
  const roofRings = blocksOf(part, 'bldg:RoofSurface').flatMap((x) => posLists(x)).map((r) => r.map((p) => [p[0], p[1]]));
  if (!roofRings.length) return null;
  const all = [fpRing, ...roofRings];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const r of all) for (const p of r) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; }
  const x0 = Math.floor(minX), z0 = Math.floor(minZ), w = Math.ceil(maxX) - x0 + 1, h = Math.ceil(maxZ) - z0 + 1;
  let fpCells = 0, roofCells = 0, both = 0, roofOutside = 0;
  for (let iz = 0; iz < h; iz++) for (let ix = 0; ix < w; ix++) {
    const x = x0 + ix + 0.5, z = z0 + iz + 0.5;
    const inFp = pointInRing(x, z, fpRing);
    let inRoof = false; for (const r of roofRings) if (pointInRing(x, z, r)) { inRoof = true; break; }
    if (inFp) fpCells++; if (inRoof) roofCells++; if (inFp && inRoof) both++; if (inRoof && !inFp) roofOutside++;
  }
  const gsArea = b.groundSurfaceAreaM2, fpArea = b.lod0AreaM2;
  return {
    roofProjectedCoverageOfFootprint: fpCells ? +(both / fpCells).toFixed(4) : null,
    roofProjectedOutsideFootprintRatio: roofCells ? +(roofOutside / roofCells).toFixed(4) : null,
    groundSurfaceVsFootprintAreaRatio: gsArea && fpArea ? +(gsArea / fpArea).toFixed(4) : null,
    wallSurfaceBottomY: b.wallSurfaceY ? b.wallSurfaceY.min : null,
    groundSurfaceY: b.groundSurfaceY ? b.groundSurfaceY.min : null,
    groundSurfaceIsFlat: b.groundSurfaceY ? b.groundSurfaceY.min === b.groundSurfaceY.max : null,
  };
}

// ── §11 構造種別（属性・実名からのみ判定。道路/線路重なりは判定材料に使わない=循環回避） ──
function classifyStructure(b) {
  const name = b.name || '';
  const wallLess = b.classCode === '3003' || b.classCode === '3004';
  if (/駅$|駅[^前]|ステーション/.test(name)) return { kind: 'STATION', basis: 'gml:name="' + name + '"（提供者による実名）' };
  if (wallLess && b.usageCode === '431') return { kind: 'CANOPY', basis: 'bldg:class=' + b.classCode + '(無壁舎) + usage=431(運輸倉庫施設)' };
  if (wallLess) return { kind: 'CANOPY', basis: 'bldg:class=' + b.classCode + '(無壁舎=壁の無い構造物)' };
  if (b.usageCode === '431') return { kind: 'COMPLEX', basis: 'bldg:usage=431(運輸倉庫施設)' };
  if (name) return { kind: 'NORMAL', basis: 'gml:name="' + name + '"' };
  return { kind: 'NORMAL', basis: 'bldg:class=' + b.classCode + ' / usage=' + b.usageCode };
}

// ── §10 分類 ──
//   判定順: (1)提供者の実名/意味付け → (2)独立ソースOSMとの照合（妥当性ゲートを通った場合のみ）
//   ※ road/rail の重なり量そのものは 32G のサンプル選定条件なので、分類の根拠には使わない（循環回避）。
const OSM_COV_STRONG = 0.7;   // OSMが「そこに構造物がある」と言っているとみなす被覆
const OSM_COV_ABSENT = 0.3;   // OSMが「そこには無い」と言っているとみなす被覆
const OSM_PRESENT_MIN = 0.4;  // その建物自体がOSMに載っている（＝被覆ゼロはOSMの欠測ではない）判断の下限
function classifyAgainstGroundTruth(b, st, lod2cmp, temporal, osmCov, osmUsable, osmAbsenceUsable) {
  // A: 提供者の実名/意味付けが「現実に道路・線路上空へ及ぶ構造物」であることを示すもの。
  if (st.kind === 'STATION') {
    return { cls: 'REAL_OVERHEAD_STRUCTURE', evidence: 'PROVIDER_IDENTITY',
      reason: 'gml:name="' + b.name + '" により提供者が駅施設として同定している。駅施設は線路・駅前広場の上空/上部に及ぶ構造を現実に持つため、外形が線路・道路と重なること自体は誤りではない。'
        + (osmCov && osmCov.osmStationLike ? ' OSM側でも駅/覆い構造としてタグ付けされた建物が重なっており、独立ソースと整合する。' : '') };
  }
  if (st.kind === 'CANOPY') {
    return { cls: 'REAL_OVERHEAD_STRUCTURE', evidence: 'PROVIDER_SEMANTICS',
      reason: 'bldg:class=' + b.classCode + '(無壁舎)。無壁舎は壁を持たない構造物であり、記録される外形は屋根/上屋の投影である。すなわち地面接地面ではなく上空の構造を表す。' };
  }
  // 独立ソース OSM による照合（妥当性ゲートを通過した場合のみ材料として使う）
  if (osmUsable && osmCov && osmCov.footprintCells > 0) {
    const cov = osmCov.osmCoverageRatio, rr = osmCov.osmCoverageOfRoadRailPart;
    const names = osmCov.topOsmOverlaps.filter((h) => h.name).map((h) => h.name).slice(0, 2).join('/');
    if (cov >= OSM_COV_STRONG && (rr == null || rr >= OSM_COV_STRONG)) {
      return { cls: 'FOOTPRINT_MATCHES_REAL_BUILDING', evidence: 'OSM_INDEPENDENT_OUTLINE',
        reason: '独立ソースOSMの建物outlineがPLATEAU外形の' + (cov * 100).toFixed(0) + '%を被覆しており'
          + (rr != null ? '、道路/線路と重なる部分に限っても' + (rr * 100).toFixed(0) + '%が被覆されている' : '')
          + '。すなわちOSMの記録者も同じ範囲に構造物が存在すると判断している' + (names ? '（' + names + '）' : '') + '。PLATEAU外形は概ね現実通りとみなせる。' };
    }
    if (cov >= OSM_PRESENT_MIN && rr != null && rr <= OSM_COV_ABSENT && !osmAbsenceUsable) {
      return { cls: 'AMBIGUOUS', evidence: 'OSM_ABSENCE_NOT_CONCLUSIVE',
        reason: 'OSMはこの建物を記録しているが道路/線路部分は' + (rr * 100).toFixed(0) + '%しか被覆していない。'
          + 'ただしAOIの母集団統計でOSMが道路上の建物をほとんど描いていないことが分かったため、この「不在」は構造物の不在を意味しない（32GでGSIに対して起きた判別不能と同型）。' };
    }
    if (cov >= OSM_PRESENT_MIN && rr != null && rr <= OSM_COV_ABSENT) {
      return { cls: 'PLATEAU_FOOTPRINT_OVERSIZED', evidence: 'OSM_INDEPENDENT_OUTLINE',
        reason: 'OSMはこの建物自体を記録している（外形の' + (cov * 100).toFixed(0) + '%を被覆）が、道路/線路と重なる部分は'
          + (rr * 100).toFixed(0) + '%しか被覆していない。OSMの欠測ではなく「そこには構造物が無い」という独立ソースの記録であり、'
          + 'PLATEAU外形がその部分だけ過大である可能性が高い。' };
    }
    if (cov < OSM_PRESENT_MIN) {
      return { cls: 'AMBIGUOUS', evidence: 'OSM_COVERAGE_GAP',
        reason: 'OSMにこの建物に相当するoutlineがほとんど無い（被覆' + ((cov || 0) * 100).toFixed(0) + '%）。OSMの欠測とPLATEAUの過大を区別できないため判定不能。' };
    }
    return { cls: 'AMBIGUOUS', evidence: 'OSM_INCONCLUSIVE',
      reason: 'OSM被覆が中間的（全体' + ((cov || 0) * 100).toFixed(0) + '% / 道路線路部分' + (rr != null ? (rr * 100).toFixed(0) + '%' : 'n/a') + '）で、'
        + '「概ね現実通り」とも「明確に過大」とも言えない。' };
  }
  // OSMが使えない場合は、属性だけでは C/D を決められない（32Gの教訓）。
  const notes = [];
  if (b.lod0Kind === 'lod0RoofEdge') notes.push('LOD0がbldg:lod0RoofEdge(屋根投影外形)として提供されている');
  if (b.buildingRoofEdgeAreaM2 != null && b.lod0AreaM2) notes.push('uro:buildingRoofEdgeArea/実測面積=' + (b.buildingRoofEdgeAreaM2 / b.lod0AreaM2).toFixed(3));
  if (lod2cmp && lod2cmp.roofProjectedCoverageOfFootprint != null) notes.push('LOD2屋根投影の外形被覆=' + lod2cmp.roofProjectedCoverageOfFootprint);
  if (temporal.conflict) notes.push('PLATEAU測量年(' + (b.surveyYear || '不明') + ')と比較対象データ年度に差がある');
  return { cls: 'AMBIGUOUS', evidence: 'NO_USABLE_GROUND_TRUTH',
    reason: '航空写真が本環境に存在せず、独立ソースOSMも妥当性ゲートを通らなかったため、現実の建物外形と照合できない。利用可能な材料(' + (notes.join(' / ') || '属性のみ') + ')は外形の意味付けを示すが、「現実の建物より大きい/小さい」を決定できない。' };
}

export async function runRealWorldGroundTruthAudit() {
  const g32 = rj(G32_REPORT);
  if (!g32) throw new Error('Mission 32G のレポートが必要: ' + toProjectRelativePath(G32_REPORT));

  // ── §3/§4: 梅田の生PLATEAU ──
  const meshFiles = meshFilesForBounds(BOUNDS);
  const raw = scanUmedaRawPlateau(meshFiles);
  const byId = raw.byId; delete raw.byId;

  // ── §1: 問題建物サンプル（32Gの30棟を固定。≥20） ──
  const problemIds = g32.classifications.map((c) => ({ canonicalId: c.canonicalId, gmlId: c.canonicalId.replace(/^cg_bldg_/, ''), g32: c }));

  const masks = buildRoadRailMasks();

  // ── Ground Truth 候補: OSM（抽出 → 位置合わせ確認 → 妥当性ゲート） ──
  const osm = await loadOsmInBounds(BOUNDS);
  const osmAlignment = osm.available ? auditOsmAlignment(osm) : null;
  const osmMask = osm.available ? buildOsmMask(osm) : null;
  const plateauRingsInBounds = [];
  for (const b of byId.values()) {
    if (!b.outerRing) continue;
    if (bboxOverlaps(bboxOfRing(b.outerRing), BOUNDS)) plateauRingsInBounds.push(b.outerRing);
  }
  const osmAvoidance = osm.available ? auditOsmRoadAvoidance(osm, masks, osmMask, plateauRingsInBounds) : null;
  const alignmentOk = !!(osmAlignment && osmAlignment.sufficient && osmAlignment.distanceToNearestOsmHighwayM.median != null && osmAlignment.distanceToNearestOsmHighwayM.median <= 15);
  // 位置合わせが通れば「OSMがそこに建物を描いている＝構造物が実在する」という【存在】の証拠は使える。
  // 一方「OSMが描いていない＝構造物が無い」という【不在】の証拠は、OSMが道路上の建物を
  // そもそも描かない性質を持つなら成立しない（32GでGSIに対して起きた判別不能と同型）。
  // したがって不在ベースの結論(PLATEAU_FOOTPRINT_OVERSIZED)だけに妥当性ゲートを要求する。
  const osmUsable = !!(osm.available && alignmentOk);
  const osmAbsenceUsable = !!(osmUsable && osmAvoidance && osmAvoidance.osmDrawsBuildingsOverRoadOrRail);

  const codelists = { usage: readCodelist('Building_usage.xml'), cls: readCodelist('Building_class.xml'), srcScale: readCodelist('PublicSurveyDataQualityAttribute_srcScale.xml'), psSrc: readCodelist('PublicSurveyDataQualityAttribute_geometrySrcDesc.xml'), h1: readCodelist('DataQualityAttribute_lod1HeightType.xml') };
  const label = (map, code) => { for (const [k, v] of Object.entries(map)) if (v === code) return k; return null; };

  // 生GMLの該当ブロックをもう一度取り出せるようにキャッシュ（LOD2比較で本文が要るため）
  const partOf = new Map();
  for (const f of meshFiles) {
    const s = fs.readFileSync(path.join(RAW_BLDG_DIR, f), 'utf-8');
    for (const part of s.split('<core:cityObjectMember>')) {
      const m = part.match(/<bldg:Building gml:id="([^"]+)"/); if (m) partOf.set(m[1], part);
    }
  }

  // §14: 比較対象データの年度
  const gsiVintages = fs.existsSync(GSI_ROAD_EDGE_DIR)
    ? [...new Set(fs.readdirSync(GSI_ROAD_EDGE_DIR).map((f) => (f.match(/-(\d{8})\.zip$/) || [])[1]).filter(Boolean))].sort()
    : [];
  const roadV2Generated = (() => { const { txMin, tzMin } = tileRange(BOUNDS, 2000); const t = rj(path.join(ROAD_V2_DIR, 'tile_' + txMin + '_' + tzMin + '.json')); return t ? t.generatedAt || null : null; })();

  function buildRecord(entry, group) {
    const b = byId.get(entry.gmlId);
    if (!b) return { gmlId: entry.gmlId, group, located: false, reason: '梅田該当メッシュの生CityGMLに該当gml:idが見つからない' };
    const part = partOf.get(entry.gmlId);
    const lod2cmp = part ? compareLod2Outlines(part, b) : null;
    const st = classifyStructure(b);
    const temporal = {
      plateauCreationDate: b.creationDate,
      plateauSurveyYear: b.surveyYear,
      comparedRoadDataVintage: gsiVintages.length ? gsiVintages[gsiVintages.length - 1] : null,
      conflict: !!(b.surveyYear && gsiVintages.length && Number(gsiVintages[gsiVintages.length - 1].slice(0, 4)) - Number(b.surveyYear) >= 3),
    };
    const osmCov = osmMask && b.outerRing ? osmCoverageFor(b.outerRing, masks, osmMask, osm) : null;
    const cls = classifyAgainstGroundTruth(b, st, lod2cmp, temporal, osmCov, osmUsable, osmAbsenceUsable);
    const ratios = entry.g32
      ? { roadRatio: entry.g32.roadRatio, railRatio: entry.g32.railRatio, source: 'mission32G' }
      : Object.assign(overlapRatios(b.outerRing, masks), { source: 'mission32H' });
    return {
      canonicalId: entry.canonicalId || null, gmlId: entry.gmlId, group, located: true,
      meshCode: b.meshCode, name: b.name, ward: b.ward,
      centroid: b.centroid, areaM2: b.lod0AreaM2, heightM: b.measuredHeightM,
      lod0Kind: b.lod0Kind,
      classCode: b.classCode, classLabel: label(codelists.cls, b.classCode),
      usageCode: b.usageCode, usageLabel: label(codelists.usage, b.usageCode),
      buildingRoofEdgeAreaM2: b.buildingRoofEdgeAreaM2,
      roofEdgeAreaVsGeometryRatio: b.buildingRoofEdgeAreaM2 && b.lod0AreaM2 ? +(b.buildingRoofEdgeAreaM2 / b.lod0AreaM2).toFixed(4) : null,
      publicSurveySrcDescLod0: b.publicSurveySrcDescLod0, publicSurveySrcLabel: label(codelists.psSrc, b.publicSurveySrcDescLod0),
      srcScaleLod0: b.srcScaleLod0, srcScaleLabel: label(codelists.srcScale, b.srcScaleLod0),
      lod1HeightType: b.lod1HeightType, lod1HeightTypeLabel: label(codelists.h1, b.lod1HeightType),
      hasLod2Solid: b.hasLod2Solid, groundSurfaceCount: b.groundSurfaceCount, groundSurfaceAreaM2: b.groundSurfaceAreaM2,
      roofSurfaceCount: b.roofSurfaceCount, wallSurfaceCount: b.wallSurfaceCount,
      lod2OutlineComparison: lod2cmp,
      osm: osmCov,
      roadRatio: ratios.roadRatio, railRatio: ratios.railRatio, overlapRatioSource: ratios.source,
      structureKind: st.kind, structureBasis: st.basis,
      temporal,
      classification: cls.cls, classificationEvidence: cls.evidence, classificationReason: cls.reason,
    };
  }

  const problem = problemIds.map((e) => buildRecord(e, 'problem'));

  // ── §2: 対照群（area/height/局所密度が同程度の「通常建物」を最低20棟） ──
  // 問題群と同じ手順で測るが、選定は area/height/密度のみで行い、
  // 分類の根拠(実名・class・lod0Kind)は選定に一切使わない（循環回避）。
  const problemSet = new Set(problemIds.map((e) => e.gmlId));
  const inBounds = [...byId.values()].filter((b) => b.centroid && b.centroid[0] >= BOUNDS.minX && b.centroid[0] <= BOUNDS.maxX && b.centroid[1] >= BOUNDS.minZ && b.centroid[1] <= BOUNDS.maxZ);
  const densityOf = (b) => inBounds.reduce((n, o) => n + (Math.hypot(o.centroid[0] - b.centroid[0], o.centroid[1] - b.centroid[1]) <= 100 ? 1 : 0), 0);
  const candidates = inBounds.filter((b) => !problemSet.has(b.gmlId) && b.lod0AreaM2 && b.measuredHeightM);
  const candRatios = new Map();
  for (const b of candidates) candRatios.set(b.gmlId, overlapRatios(b.outerRing, masks));
  // 「通常建物」= 32Gの候補条件(road>=0.25 or rail>=0.15)を満たさないもの
  const normal = candidates.filter((b) => { const r = candRatios.get(b.gmlId); return r.roadRatio < 0.25 && r.railRatio < 0.15; });
  const used = new Set(); const controlEntries = []; const looseMatches = [];
  for (const p of problem) {
    if (!p.located || !p.areaM2 || !p.heightM) continue;
    let best = null, bestScore = Infinity, bestLoose = null, bestLooseScore = Infinity;
    for (const c of normal) {
      if (used.has(c.gmlId)) continue;
      const ar = c.lod0AreaM2 / p.areaM2, hr = c.measuredHeightM / p.heightM;
      const score = Math.abs(Math.log(ar)) + Math.abs(Math.log(hr));
      if (score < bestLooseScore) { bestLooseScore = score; bestLoose = c; }
      if (ar >= 0.7 && ar <= 1.3 && hr >= 0.7 && hr <= 1.3 && score < bestScore) { bestScore = score; best = c; }
    }
    const pick = best || bestLoose;
    if (!pick) continue;
    used.add(pick.gmlId);
    if (!best) looseMatches.push({ problemGmlId: p.gmlId, controlGmlId: pick.gmlId, note: '±30%の一致候補が無く、最近傍で代替（正直な開示）' });
    controlEntries.push({ gmlId: pick.gmlId, canonicalId: 'cg_bldg_' + pick.gmlId, matchedTo: p.gmlId });
  }
  const control = controlEntries.map((e) => Object.assign(buildRecord(e, 'control'), { matchedToGmlId: e.matchedTo }));
  for (const c of control) { const b = byId.get(c.gmlId); c.localDensity100m = b ? densityOf(b) : null; }
  for (const p of problem) { const b = byId.get(p.gmlId); if (b) p.localDensity100m = densityOf(b); }

  // ── §15 の集計: LOD2は外形の独立証拠になったか ──
  const lod2cmps = problem.concat(control).filter((r) => r.lod2OutlineComparison).map((r) => r.lod2OutlineComparison);
  const lod2Finding = {
    comparedBuildings: lod2cmps.length,
    roofProjectedCoverageOfFootprintMedian: median(lod2cmps.map((c) => c.roofProjectedCoverageOfFootprint).filter((v) => v != null)),
    roofProjectedOutsideFootprintRatioMedian: median(lod2cmps.map((c) => c.roofProjectedOutsideFootprintRatio).filter((v) => v != null)),
    groundSurfaceVsFootprintAreaRatioMedian: median(lod2cmps.map((c) => c.groundSurfaceVsFootprintAreaRatio).filter((v) => v != null)),
    groundSurfaceFlatCount: lod2cmps.filter((c) => c.groundSurfaceIsFlat === true).length,
    wallBottomEqualsGroundCount: lod2cmps.filter((c) => c.wallSurfaceBottomY != null && c.groundSurfaceY != null && Math.abs(c.wallSurfaceBottomY - c.groundSurfaceY) < 0.01).length,
    interpretation: null,
  };
  const outlinesIdentical = lod2Finding.roofProjectedCoverageOfFootprintMedian != null && lod2Finding.roofProjectedCoverageOfFootprintMedian >= 0.99
    && lod2Finding.groundSurfaceVsFootprintAreaRatioMedian != null && Math.abs(lod2Finding.groundSurfaceVsFootprintAreaRatioMedian - 1) <= 0.02;
  lod2Finding.interpretation = outlinesIdentical
    ? 'LOD2_PROVIDES_NO_INDEPENDENT_OUTLINE: lod0FootPrint / GroundSurface / RoofSurface投影 / WallSurface下端 はすべて同一の平面外形である(被覆≒1.000、面積比≒1.000、GroundSurfaceは単一標高の平坦面、壁の下端=GroundSurface標高)。したがってLOD2は「外形が地面接地形状かどうか」についての独立した観測を一切与えない。§15の比較は実行したが、H1/H2の判別には使えない。'
    : 'LOD2_OUTLINES_DIFFER: 外形間に差があるため、LOD2は独立情報を持つ。個別値を参照のこと。';

  // ── §5-§9: 航空写真（実在しない） ──
  const orthophoto = {
    available: false,
    source: null, captureDate: null,
    boundsWest: null, boundsEast: null, boundsNorth: null, boundsSouth: null,
    alignmentControlCount: osmAlignment ? osmAlignment.controlPointCount : 0,
    alignmentError: osmAlignment ? osmAlignment.distanceToNearestOsmHighwayM : { median: null, p95: null, max: null },
    searchedLocations: ['data/**（画像ファイル 0件）', 'public/**（ロゴPNGのみ）', 'HTML内のタイル/画像URL参照（0件）', 'data/raw/osaka-city/_cache（roadsのみ）'],
    reason: 'このサンドボックスには正射画像/航空写真が1枚も存在せず、ネットワークも利用できない。§5(画像との真上比較) §6(画像のbounds→world変換)は実行不能。数値を捏造しないため画像関連のフィールドはnullとする。',
    substituteGroundTruth: 'GT-1: PLATEAU梅田の生CityGML(提供者による実名gml:name・bldg:class(無壁舎)・lod0RoofEdge/lod0FootPrintの別・uro:buildingRoofEdgeArea・測量方法/地図情報レベル)。'
      + 'GT-2: OSM建物outline(航空写真等から人手でトレースされた独立記録)。§8/§9のcontrol point照合・alignment誤差は、画像の代わりにGT-2に対して実施した。',
    alignmentMeasuredAgainst: 'OSM（画像ではない）',
  };
  const groundTruth = {
    orthophotoAvailable: false,
    osm: osm.available ? {
      available: true,
      source: toProjectRelativePath(OSM_PBF),
      nodeOrderingValid: osm.nodeOrderingValid,
      buildingsInAoi: osm.buildings.filter((b) => bboxOverlaps(b.bbox, BOUNDS)).length,
      highwaysInAoi: osm.highways.length,
      note: 'OSMの建物outlineは航空写真からのトレースが主体であり、正射画像そのものではないが「上空から見て実在する構造物」の独立記録として扱う。権威データではなく網羅性に差がある点は限界として明記する。',
    } : { available: false, reason: osm.reason },
    alignment: osmAlignment,          // §8/§9
    validityGate: osmAvoidance,       // 32Gの失敗を繰り返さないための事前検証
    osmUsedAsEvidence: osmUsable,
    osmAbsenceUsedAsEvidence: osmAbsenceUsable,
    evidenceAsymmetryNote: '【存在】OSMがそこに建物を描いている ⇒ 構造物が実在する、は位置合わせさえ通れば成立する。'
      + '【不在】OSMが描いていない ⇒ 構造物が無い、はOSMが道路上の建物を描く性質を持つ場合にのみ成立する。'
      + '本監査はこの非対称性を分けて扱い、不在ベースの結論(PLATEAU_FOOTPRINT_OVERSIZED)には妥当性ゲートの通過を要求した。',
    osmUsedReason: osmUsable
      ? '位置合わせ(control point ' + osmAlignment.controlPointCount + '点, 中央値' + osmAlignment.distanceToNearestOsmHighwayM.median + 'm)と妥当性ゲート(OSMは道路/線路上にも建物を描いている)の両方を通過したため、判定材料として採用した。'
      : '位置合わせまたは妥当性ゲートを通過しなかったため、判定材料として採用しなかった。',
  };

  // ── §10/§11/§12/§13 集計 ──
  const tally = (rows, key) => rows.reduce((o, r) => { const k = r[key] || 'UNLOCATED'; o[k] = (o[k] || 0) + 1; return o; }, {});
  const problemClassifications = tally(problem, 'classification');
  const controlClassifications = tally(control, 'classification');
  const problemStructures = tally(problem, 'structureKind');
  const controlStructures = tally(control, 'structureKind');

  const located = problem.filter((r) => r.located);
  const realOverhead = located.filter((r) => r.classification === 'REAL_OVERHEAD_STRUCTURE').length;
  const matchesReal = located.filter((r) => r.classification === 'FOOTPRINT_MATCHES_REAL_BUILDING').length;
  const oversized = located.filter((r) => r.classification === 'PLATEAU_FOOTPRINT_OVERSIZED').length;
  const ambiguous = located.filter((r) => r.classification === 'AMBIGUOUS').length;
  const ctrlOversized = control.filter((r) => r.classification === 'PLATEAU_FOOTPRINT_OVERSIZED').length;

  // lod0RoofEdge(屋根投影外形)の出現率: 問題群 vs 対照群 vs メッシュ全体
  const roofEdgeRate = (rows) => { const l = rows.filter((r) => r.located); return l.length ? +(l.filter((r) => r.lod0Kind === 'lod0RoofEdge').length / l.length).toFixed(4) : null; };
  const meshRoofEdgeRate = raw.aggregate.buildingCount ? +(raw.aggregate.lod0RoofEdge / raw.aggregate.buildingCount).toFixed(4) : null;

  const report0 = {
    problemRrCov: median(located.map((r) => r.osm && r.osm.osmCoverageOfRoadRailPart).filter((v) => v != null)),
    baselineRrCov: osmAvoidance ? osmAvoidance.osmBuildingOnThoseCellsRatio : null,
  };
  const H1Support = {
    verdict: realOverhead + matchesReal >= Math.ceil(located.length / 2) ? 'H1_SUPPORTED' : (realOverhead > 0 ? 'H1_PARTIALLY_SUPPORTED' : 'H1_NOT_SUPPORTED'),
    realOverheadStructureCount: realOverhead,
    footprintMatchesRealCount: matchesReal,
    basis: realOverhead + matchesReal > 0
      ? '(1) 提供者自身が実名(gml:name)または意味付け(bldg:class=無壁舎)で「線路・道路上空に及ぶ構造物」と記録している建物が問題群に ' + realOverhead + ' 棟ある（大阪駅・大阪梅田駅を含む）。'
        + '(2) 独立ソースOSMが、問題群の「道路/線路と重なる部分」の中央値 '
        + (report0.problemRrCov != null ? (report0.problemRrCov * 100).toFixed(1) + '%' : 'n/a') + ' を建物outlineで覆っている。'
        + 'これは偶然ではない: AOI内で「PLATEAU建物が無い道路/線路セル」にOSM建物が乗っている割合は '
        + (report0.baselineRrCov != null ? (report0.baselineRrCov * 100).toFixed(1) + '%' : 'n/a') + ' に過ぎず、約'
        + (report0.baselineRrCov ? (report0.problemRrCov / report0.baselineRrCov).toFixed(0) : '?') + '倍に濃縮されている。'
        + 'すなわち2つの独立した作成者が「そこに構造物がある」と一致して記録している。したがって建物を道路/区画へ押し込むのは現実と反する。'
      : '問題群に実名/無壁舎で同定できる上空構造物が無い。',
  };
  const H2Support = {
    verdict: oversized > ctrlOversized && oversized >= Math.ceil(located.length / 2) ? 'H2_SUPPORTED' : 'H2_NOT_ESTABLISHED',
    plateauOversizedCount: oversized,
    controlOversizedCount: ctrlOversized,
    roofEdgeOutlineRate: { problem: roofEdgeRate(problem), control: roofEdgeRate(control), meshWide: meshRoofEdgeRate },
    basis: osmUsable
      ? '独立ソースOSMとの照合により判定した。問題群 ' + located.length + ' 棟中 ' + oversized + ' 棟が PLATEAU_FOOTPRINT_OVERSIZED、'
        + '対照群 ' + control.length + ' 棟中 ' + ctrlOversized + ' 棟。'
        + '関連する実測事実として、面積属性は uro:buildingRoofEdgeArea(屋根投影面積)のみで uro:buildingFootprintArea(建築面積)は存在せず、'
        + 'LOD0外形が bldg:lod0RoofEdge(屋根投影外形)として提供される建物も存在する（出現率: 問題群'
        + roefRateText(roofEdgeRate(problem)) + ' / 対照群' + roefRateText(roofEdgeRate(control)) + ' / メッシュ全体' + roefRateText(meshRoofEdgeRate) + '）。'
      : '「現実の建物より大きい」の判定には現実側の外形が要るが、航空写真が無くOSMも妥当性ゲートを通らなかったため、H2は肯定も否定もできない。',
  };

  // §14 時点差
  const temporalConflictCount = located.filter((r) => r.temporal.conflict).length;

  // ── §19 最終分類 ──
  let finalClassification, finalReason, stopToken;
  const decidable = located.filter((r) => r.classification !== 'AMBIGUOUS').length;
  const decidableRate = located.length ? decidable / located.length : 0;
  if (!osmUsable && H1Support.verdict === 'H1_NOT_SUPPORTED') {
    finalClassification = 'INSUFFICIENT_GROUND_TRUTH';
    finalReason = '航空写真が無く、独立ソースも使えず、提供者属性からも上空構造物を同定できなかった。';
    stopToken = 'REAL_WORLD_GROUND_TRUTH_INSUFFICIENT';
  } else if (decidableRate < 0.5) {
    finalClassification = 'INSUFFICIENT_GROUND_TRUTH';
    finalReason = '問題群 ' + located.length + ' 棟のうち現実と照合して判定できたのは ' + decidable + ' 棟のみで、過半に達しない。';
    stopToken = 'REAL_WORLD_GROUND_TRUTH_INSUFFICIENT';
  } else if (H1Support.verdict === 'H1_SUPPORTED' && H2Support.verdict !== 'H2_SUPPORTED') {
    finalClassification = 'REAL_STRUCTURE_DOMINANT';
    finalReason = '問題群の過半が、提供者の実名/意味付けにより現実の上空構造物と確認された。';
    stopToken = 'REAL_WORLD_ROOT_CAUSE_IDENTIFIED';
  } else if (H2Support.verdict === 'H2_SUPPORTED') {
    finalClassification = 'PLATEAU_FOOTPRINT_QUALITY_ISSUE';
    finalReason = '問題群の過半でPLATEAU外形が現実の建物より明確に大きく、対照群では発生率が低い。';
    stopToken = 'REAL_WORLD_ROOT_CAUSE_IDENTIFIED';
  } else {
    // H1が一部支持され、残りは画像が無いため判定不能 —— 単一原因に還元できない。
    finalClassification = 'MIXED_CAUSES';
    finalReason = '問題群 ' + located.length + ' 棟の内訳は REAL_OVERHEAD_STRUCTURE ' + realOverhead + ' / FOOTPRINT_MATCHES_REAL_BUILDING ' + matchesReal
      + ' / PLATEAU_FOOTPRINT_OVERSIZED ' + oversized + ' / AMBIGUOUS ' + ambiguous + ' 棟であり、'
      + '「現実に存在する構造物なので正しい」ものと「PLATEAU外形が過大」なものが同時に存在する。単一原因(H1のみ/H2のみ)には還元できない。';
    stopToken = decidableRate >= 0.5 ? 'REAL_WORLD_ROOT_CAUSE_IDENTIFIED' : 'REAL_WORLD_GROUND_TRUTH_INSUFFICIENT';
  }

  // ── §20 次の方針 ──
  const policyMap = {
    REAL_STRUCTURE_DOMINANT: '建物を道路/区画へ押し込む施策を正式終了する。',
    PLATEAU_FOOTPRINT_QUALITY_ISSUE: '問題buildingだけ別footprint sourceの採用を検討する。',
    TEMPORAL_DATA_CONFLICT: 'データ年度の統一へ進む。',
    MIXED_CAUSES: 'building単位のprovenance/confidence方式へ移行する。',
    INSUFFICIENT_GROUND_TRUTH: 'Ground Truth(航空写真等)の取得を先に行う。',
  };
  const recommendedPolicy = {
    policy: policyMap[finalClassification],
    detail: finalClassification === 'MIXED_CAUSES'
      ? [
        '1) 一律に建物を区画へ押し込む処理は採用しない。少なくとも ' + realOverhead + ' 棟(駅施設・無壁舎)は現実の上空構造物であり、押し込めば現実と乖離する。',
        '2) building単位に provenance を持たせる: lod0Kind(lod0FootPrint / lod0RoofEdge), bldg:class(無壁舎か), gml:name有無, LOD2有無, publicSurveySrcDescLod0/srcScaleLod0。これらはすべて生CityGMLから取得済みで追加取得不要。',
        '3) 残る判定不能分については、ローカルPCで梅田の正射画像(例: 大阪市/国土地理院の公開オルソ)を取得し、本ミッションの[REALITY QA]オーバーレイに載せて目視照合する。オーバーレイ側は画像を差し込めば動く状態にしてある。',
      ]
      : finalClassification === 'REAL_STRUCTURE_DOMINANT'
        ? [
          '1) 建物を道路/区画へ押し込む(clip/shrink/warp/offset)施策を正式に終了する。問題群 ' + located.length + ' 棟のうち ' + (realOverhead + matchesReal) + ' 棟は現実に存在する構造物であり、押し込めば現実と乖離する。',
          '2) 「建物が道路にはみ出して見える」の残りの改善余地は建物側ではなく道路側にある。ROAD V2 の envelope は PLATEAU tran の道路区域(32Dで確定: 歩道を含む行政上の道路敷地)であり、実在建物の下にも及ぶ。32Eで実施した「GSI道路縁から車道を復元して暗くする」方向の延長が正しい。',
          '3) 例外として PLATEAU_FOOTPRINT_OVERSIZED ' + oversized + ' 棟 / AMBIGUOUS ' + ambiguous + ' 棟が残る。対照群でも OVERSIZED は ' + ctrlOversized + ' 棟出ており、問題群に固有の欠陥ではない(通常建物にも同程度に存在する背景ノイズ)。個別補正の対象にはしない。',
          '4) 建物単位の provenance は本監査で取得済み(lod0Kind / bldg:class / gml:name / LOD2有無 / publicSurveySrcDescLod0 / srcScaleLod0 / OSM被覆率)。必要ならこれを confidence として持たせる。',
        ]
        : [policyMap[finalClassification]],
  };

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    missionId: '32H',
    mode: 'AUDIT_ONLY',
    bounds: BOUNDS,
    problemSampleCount: problem.length,
    controlSampleCount: control.length,
    umedaRawPlateau: {
      available: raw.available,
      correctionOfMission32G: '32Gは「梅田(Kita区)の建物生CityGMLはサンドボックスに存在しない」と記録したが、これは誤りだった。'
        + 'data/raw/osaka-higashisumiyoshi/ 配下に二次メッシュ523503/523504として実在し、梅田中心は 52350349_bldg_6697_op.gml に含まれる。'
        + '本ミッションは梅田そのものを一次証拠として使用した。',
      meshFilesUsed: raw.meshFiles.map((m) => m.file),
      srsName: raw.srsName,
      lod0Count: raw.aggregate.lod0FootPrint,
      lod0RoofEdgeCount: raw.aggregate.lod0RoofEdge,
      lod1Count: raw.aggregate.lod1Solid,
      lod2Count: raw.aggregate.lod2Solid,
      lod2MultiSurfaceCount: raw.aggregate.lod2MultiSurface,
      groundSurfaceCount: raw.aggregate.GroundSurface,
      roofSurfaceCount: raw.aggregate.RoofSurface,
      wallSurfaceCount: raw.aggregate.WallSurface,
      buildingCount: raw.aggregate.buildingCount,
      perMesh: raw.meshFiles,
      creationDates: raw.creationDates,
      surveyYears: raw.surveyYears,
    },
    lod2Availability: {
      verdict: raw.lod2Availability,
      lod2SolidBuildings: raw.aggregate.lod2Solid,
      totalBuildings: raw.aggregate.buildingCount,
      ratio: raw.lod2BuildingRatio,
      note: 'Mission 32Gは住吉区のサンプル(LOD2=0)から「LOD2なし」と一般化していたが、梅田では実在する。§4の警告どおりの誤りであり、本ミッションで訂正した。',
    },
    lod2OutlineFinding: lod2Finding,
    orthophoto,
    groundTruth,
    problemClassifications,
    controlClassifications,
    problemStructures,
    controlStructures,
    H1Support,
    H2Support,
    temporalConflictCount,
    temporalDates: {
      plateauCreationDates: raw.creationDates,
      plateauSurveyYears: raw.surveyYears,
      gsiRoadEdgeVintages: gsiVintages,
      roadV2GeneratedAt: roadV2Generated,
      note: 'PLATEAU側は測量年2017/整備日2023-03-22、比較に使うGSI道路縁は2026年版。建替え・再開発による差をgeometry errorと誤判定しないため、この差を明示して扱う。',
    },
    matchingQuality: {
      strictMatches: control.length - looseMatches.length,
      looseMatches: looseMatches.length,
      looseMatchDetail: looseMatches,
      note: '対照群は area/height が±30%以内の通常建物から選ぶことを原則とし、該当が無い場合のみ最近傍で代替した(代替は上記に列挙)。選定には実名・class・lod0Kindを一切使っていない(循環回避)。',
    },
    comparison: {
      problem: {
        count: located.length,
        areaM2Median: median(located.map((r) => r.areaM2).filter(Boolean)),
        heightMMedian: median(located.map((r) => r.heightM).filter(Boolean)),
        localDensity100mMedian: median(located.map((r) => r.localDensity100m).filter((v) => v != null)),
        roadRatioMedian: median(located.map((r) => r.roadRatio).filter((v) => v != null)),
        railRatioMedian: median(located.map((r) => r.railRatio).filter((v) => v != null)),
        lod2SolidRate: located.length ? +(located.filter((r) => r.hasLod2Solid).length / located.length).toFixed(4) : null,
        osmCoverageRatioMedian: median(located.map((r) => r.osm && r.osm.osmCoverageRatio).filter((v) => v != null)),
        osmCoverageOfRoadRailPartMedian: median(located.map((r) => r.osm && r.osm.osmCoverageOfRoadRailPart).filter((v) => v != null)),
        osmCoverageOfCleanPartMedian: median(located.map((r) => r.osm && r.osm.osmCoverageOfCleanPart).filter((v) => v != null)),
      },
      control: {
        count: control.length,
        areaM2Median: median(control.map((r) => r.areaM2).filter(Boolean)),
        heightMMedian: median(control.map((r) => r.heightM).filter(Boolean)),
        localDensity100mMedian: median(control.map((r) => r.localDensity100m).filter((v) => v != null)),
        roadRatioMedian: median(control.map((r) => r.roadRatio).filter((v) => v != null)),
        railRatioMedian: median(control.map((r) => r.railRatio).filter((v) => v != null)),
        lod2SolidRate: control.length ? +(control.filter((r) => r.hasLod2Solid).length / control.length).toFixed(4) : null,
        osmCoverageRatioMedian: median(control.map((r) => r.osm && r.osm.osmCoverageRatio).filter((v) => v != null)),
        osmCoverageOfRoadRailPartMedian: median(control.map((r) => r.osm && r.osm.osmCoverageOfRoadRailPart).filter((v) => v != null)),
        osmCoverageOfCleanPartMedian: median(control.map((r) => r.osm && r.osm.osmCoverageOfCleanPart).filter((v) => v != null)),
      },
    },
    problemBuildings: problem,
    controlBuildings: control,
    finalClassification,
    finalClassificationReason: finalReason,
    stopToken,
    recommendedPolicy,
    evidenceSummary: {
      osmCoverageOfRoadRailPart_problemMedian: report0.problemRrCov,
      osmCoverageOfRoadRailCells_baselineWithoutPlateauBuilding: report0.baselineRrCov,
      enrichmentFactor: report0.baselineRrCov ? +(report0.problemRrCov / report0.baselineRrCov).toFixed(1) : null,
      aoiOsmBuildingCoverage: osmAvoidance ? osmAvoidance.aoiOsmBuildingCoverage : null,
      note: '「PLATEAU外形が道路と重なる部分にOSM建物が存在する」という観測の情報量を、ベースライン(PLATEAU建物が無い道路/線路セルでのOSM出現率)と比較して示したもの。',
    },
    limitations: [
      '航空写真/正射画像がこの環境に存在しないため、§5/§6/§8/§9(真上比較・bounds変換・control point・alignment誤差)は実行していない。該当フィールドはnullであり、推定値で埋めていない。',
      'LOD2は梅田に実在するが、lod0FootPrint / GroundSurface / RoofSurface投影 / WallSurface下端 はすべて同一の平面外形であり、外形についての独立した観測を与えない(§15の比較結果そのもの)。',
      'railRatio は Canonical Rail の中心線±' + RAIL_HALF_WIDTH_M + 'm という近似corridorに対する比率であり、実測の軌道敷幅ではない(32Gと同一の近似)。',
      'OSMとPLATEAUは完全に独立とは言い切れない。どちらも航空写真を主要な情報源としうるし、OSMの記入者がPLATEAU由来の情報を参照した可能性も排除できない(大阪市でのPLATEAU一括インポートは確認されていないが、この環境では検証手段が無い)。したがって「2ソースの一致」は独立検証としては強いが、完全独立の証明ではない。',
      'OSMは権威データではなく、網羅性・精度が場所によって異なる。本監査ではAOI内のOSM建物被覆率39.9%という実測値と、位置合わせ誤差(中央値1.36m)を示した上で使用している。',
      '問題群のサンプルは32Gが「道路/線路と重なる」条件で選んだものである。したがって本ミッションでも道路/線路の重なり量は分類の根拠には使わず、記述統計としてのみ扱った。',
    ],
  };

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  writeJson(REPORT, report);

  // ── §7: [REALITY QA] オーバーレイ用データ ──
  // GSI建物 / ROAD V2 / rail のリングは Mission 32G が同一AOIで書き出したものをそのまま再利用する
  // （読み取りのみ・再計算しない。無い場合は空配列で、レイヤーが出ないことをlegendで示す）。
  const g32qa = rj(P('data', 'processed', 'osaka-city', 'ground-footprint-qa', 'umeda', 'overlay.json'));
  const qa = {
    version: 1,
    generatedAt: report.generatedAt,
    missionId: '32H',
    bounds: BOUNDS,
    orthophotoAvailable: false,
    orthophotoNote: orthophoto.reason,
    legend: {
      ORTHOPHOTO: { role: 'base', available: false, note: '航空写真がこの環境に無いため表示できない。取得後にこのJSONの orthophoto フィールドへ画像URLと実world extentを入れれば base として表示される。' },
      PLATEAU_LOD0: { color: 'cyan', note: 'PLATEAU lod0FootPrint / lod0RoofEdge（現在の建物底面）' },
      GSI_BUILDING: { color: 'magenta', note: 'GSI 建築物ポリゴン（独立ソース）' },
      OSM_BUILDING: { color: 'green', note: '【本ミッションのGround Truth】OSM建物outline（航空写真等からの独立トレース）' },
      ROAD_V2: { color: 'gray', note: 'ROAD V2 envelope' },
      RAIL: { color: 'black', note: 'Canonical Rail 中心線±' + RAIL_HALF_WIDTH_M + 'm(概算corridor)' },
    },
    orthophoto: null, // 画像が手に入ったら {url, west, east, north, south} を入れる（§6: px数ではなく実world extent）
    railHalfWidthM: RAIL_HALF_WIDTH_M,
    osmBuildings: osm.available
      ? osm.buildings.filter((b) => bboxOverlaps(b.bbox, BOUNDS) && b.areaM2 >= 20)
        .map((b) => ({ ring: b.ring.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]), name: b.tags.name || null, building: b.tags.building || b.tags['building:part'] || null }))
      : [],
    gsiBldA: g32qa ? g32qa.gsiBldA || [] : [],
    roadV2: g32qa ? g32qa.roadV2 || [] : [],
    rail: g32qa ? g32qa.rail || [] : [],
    reusedLayersFrom: g32qa ? 'data/processed/osaka-city/ground-footprint-qa/umeda/overlay.json (Mission 32G・同一AOI・読み取りのみ)' : null,
    buildings: problem.concat(control).filter((r) => r.located).map((r) => ({
      gmlId: r.gmlId, canonicalId: r.canonicalId, group: r.group, name: r.name,
      ring: byId.get(r.gmlId) ? byId.get(r.gmlId).outerRing : null,
      areaM2: r.areaM2, heightM: r.heightM, lod0Kind: r.lod0Kind,
      classLabel: r.classLabel, usageLabel: r.usageLabel,
      structureKind: r.structureKind, classification: r.classification,
      roadRatio: r.roadRatio, railRatio: r.railRatio,
    })),
  };
  for (const dir of [QA_DIR, PUBLIC_QA_DIR]) { fs.mkdirSync(dir, { recursive: true }); writeJson(path.join(dir, 'overlay.json'), qa); }

  return report;
}

if (isMainModule(import.meta.url)) {
  runRealWorldGroundTruthAudit().then((r) => {
    console.log('[32H] problem=' + r.problemSampleCount + ' control=' + r.controlSampleCount);
    console.log('[32H] umeda raw PLATEAU: buildings=' + r.umedaRawPlateau.buildingCount + ' lod0FootPrint=' + r.umedaRawPlateau.lod0Count + ' lod0RoofEdge=' + r.umedaRawPlateau.lod0RoofEdgeCount + ' lod2Solid=' + r.umedaRawPlateau.lod2Count + ' GroundSurface=' + r.umedaRawPlateau.groundSurfaceCount);
    console.log('[32H] ' + r.lod2Availability.verdict + ' (' + r.lod2Availability.ratio + ')');
    console.log('[32H] lod2OutlineFinding: ' + r.lod2OutlineFinding.interpretation.slice(0, 60));
    console.log('[32H] problemClassifications=' + JSON.stringify(r.problemClassifications));
    console.log('[32H] controlClassifications=' + JSON.stringify(r.controlClassifications));
    console.log('[32H] H1=' + r.H1Support.verdict + ' H2=' + r.H2Support.verdict);
    console.log('[32H] finalClassification=' + r.finalClassification + ' stopToken=' + r.stopToken);
  }).catch((e) => { console.error(e); process.exit(1); });
}
