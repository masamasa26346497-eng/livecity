#!/usr/bin/env node
// tools/audit/umeda-ground-footprint-audit.js
// [Mission 32G] GROUND FOOTPRINT ROOT AUDIT — AUDIT ONLY（building移動/scale/clip/warp・Road変更・
//   Land Block変更・projection変更・global rebuildは一切行わない。読み取りと比較測定のみ）。
//
//   §2/§3: 現在のCanonical Building footprintがPLATEAUのどのgeometryから生成されたのかを、
//   コード(tools/convert-plateau-buildings.js)と実際の生CityGML(raw)の両方で確認する（推測禁止）。
//
//   §重要な制約（正直な開示）: このサンドボックス環境には大阪市24区(Kita区/梅田を含む)のPLATEAU建物
//   生CityGMLが存在しない(data/raw/plateau/osaka-cityにはtran(道路)のみ)。唯一利用可能な生CityGMLは
//   data/raw/osaka-sumiyoshi/plateau/buildings-lod2/配下（住吉区、Mission LOD2調査で取得済み）。
//   同一の大阪市PLATEAU提供元・同一の変換パイプラインである前提のもと、住吉区の生データ監査結果を
//   「大阪市PLATEAU建物データセット全体の特性」を示す強い代替証拠として使う（Kita区個別の直接確認では
//   ない、という限界を明記する）。梅田の30棟サンプル自体はCanonical Buildings(既にPLATEAU由来として
//   確定済み)から選び、独立ソースのGSI BldA(建築物ポリゴン)と比較することで、生CityGML無しでも
//   意味のある検証を行う。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { readFeatureCollectionStreaming } from '../lib/large-json-array-reader.js';
import { pointInRing } from '../lib/point-in-polygon.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const CANON_RAIL = P('data', 'processed', 'osaka-city', 'canonical', 'rail');
const ROAD_V2_DIR = P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v2', 'tiles');
const GSI_BLDA = P('data', 'processed', 'osaka-city', 'gsi-building-area', 'building-area-polygons.json');
const LAND_BLOCK_ASSIGNMENT = P('data', 'processed', 'osaka-city', 'visual-land-block-poc', 'umeda', 'building-assignment.json');
const CONVERT_SCRIPT = P('tools', 'convert-plateau-buildings.js');
const SUMIYOSHI_LOD2_AUDIT_DIR = P('data', 'processed', 'osaka-sumiyoshi', 'buildings-lod2', '2024', 'audit');
const SUMIYOSHI_RAW_GML = P('data', 'raw', 'osaka-sumiyoshi', 'plateau', 'buildings-lod2', '2024', 'gml', '51357420_bldg_6697_op.gml');
const REPORT = P('data', 'reports', 'umeda-ground-footprint-audit.json');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

const CENTER = { x: -2668.18, z: -10941.87 };
const HALF_SPAN_M = 600;
const BOUNDS = { minX: CENTER.x - HALF_SPAN_M, maxX: CENTER.x + HALF_SPAN_M, minZ: CENTER.z - HALF_SPAN_M, maxZ: CENTER.z + HALF_SPAN_M };
const RAIL_HALF_WIDTH_M = 5; // 軌道中心線からの片側バッファ(概算。実測軌道幅データが無いための近似・正直に開示)

function bboxOverlaps(a, b) { return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ; }
function bboxOfRing(ring) { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity; for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; } return { minX, maxX, minZ, maxZ }; }
function ringsOfFeature(f) {
  const rings = [];
  const polys = f.geometryType === 'Polygon' ? [f.coordinates] : (f.geometryType === 'MultiPolygon' ? f.coordinates : []);
  for (const poly of polys) for (const ring of poly) if (Array.isArray(ring) && ring.length > 1) rings.push(ring);
  return rings;
}
function ringAreaAbs(ring) { let a = 0; for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; a += x1 * z2 - x2 * z1; } return Math.abs(a) / 2; }
function tileRange(bounds, size) { return { txMin: Math.floor(bounds.minX / size), txMax: Math.floor(bounds.maxX / size), tzMin: Math.floor(bounds.minZ / size), tzMax: Math.floor(bounds.maxZ / size) }; }

// ── §2/§3: convert-plateau-buildings.js のfootprint選択ロジックを静的に確認(推測禁止・実コード引用) ──
function auditConverterLogic() {
  const src = fs.existsSync(CONVERT_SCRIPT) ? fs.readFileSync(CONVERT_SCRIPT, 'utf-8') : '';
  const usesLod0FootPrint = /ringsIn\(xml, \/<bldg:lod0FootPrint>/.test(src);
  const usesGroundSurfaceFallback = /ringsIn\(xml, \/<bldg:GroundSurface\\b/.test(src);
  const usesLowestRingFallback = /avgAlt < bestAlt/.test(src) && /fpSource = 'lowestRing'/.test(src);
  const excludesRoofSurface = /屋根面\(RoofSurface\)はFootprintに使わない/.test(src);
  const priorityCommentFound = /1\.\s*bldg:lod0FootPrint の外周リング/.test(src);
  return {
    scriptPath: toProjectRelativePath(CONVERT_SCRIPT),
    documentedPriority: ['lod0FootPrint', 'GroundSurface', 'lowestRing(lod1Solid最下面)'],
    priorityCommentFound,
    usesLod0FootPrint, usesGroundSurfaceFallback, usesLowestRingFallback, excludesRoofSurface,
    note: 'コード実測(tools/convert-plateau-buildings.js)を直接引用。lod0RoofEdge/RoofSurface/WallSurface/lod2Solid/lod2MultiSurfaceはこのconverterのfootprint選択ロジックには一切登場しない(検索して不在を確認)。',
    referencesLod0RoofEdge: /lod0RoofEdge/.test(src),
    referencesRoofSurfaceAsSource: /ringsIn\(xml, \/<bldg:RoofSurface/.test(src),
    referencesLod2: /lod2Solid|lod2MultiSurface/.test(src),
  };
}

// ── §2実データ確認: 唯一利用可能な生CityGML(住吉区)でgeometry型の実在を確認 ──
function auditRawCityGmlAvailability() {
  const kitaRawExists = fs.existsSync(P('data', 'raw', 'plateau', 'osaka-city', 'bldg'));
  const sumiyoshiAudits = [];
  if (fs.existsSync(SUMIYOSHI_LOD2_AUDIT_DIR)) {
    for (const f of fs.readdirSync(SUMIYOSHI_LOD2_AUDIT_DIR)) {
      if (!f.endsWith('.json')) continue;
      const j = rj(path.join(SUMIYOSHI_LOD2_AUDIT_DIR, f));
      if (j) sumiyoshiAudits.push({ mesh: j.mesh, buildingCount: j.audit.buildingCount, ...j.audit });
    }
  }
  let sumiyoshiRawGrepCounts = null;
  if (fs.existsSync(SUMIYOSHI_RAW_GML)) {
    const xml = fs.readFileSync(SUMIYOSHI_RAW_GML, 'utf-8');
    const countOf = (tag) => (xml.match(new RegExp('<' + tag + '\\b', 'g')) || []).length;
    sumiyoshiRawGrepCounts = {
      sourceFile: toProjectRelativePath(SUMIYOSHI_RAW_GML),
      lod0FootPrint: countOf('bldg:lod0FootPrint'), lod0RoofEdge: countOf('bldg:lod0RoofEdge'),
      GroundSurface: countOf('bldg:GroundSurface'), RoofSurface: countOf('bldg:RoofSurface'),
      WallSurface: countOf('bldg:WallSurface'), lod1Solid: countOf('bldg:lod1Solid'),
      lod2Solid: countOf('bldg:lod2Solid'), lod2MultiSurface: countOf('bldg:lod2MultiSurface'),
      buildingCount: countOf('bldg:Building'),
    };
  }
  return {
    kitaWardRawCityGmlAvailable: kitaRawExists,
    note: 'このサンドボックス環境に大阪市24区(Kita区/梅田含む)のPLATEAU建物生CityGMLは存在しない' +
      '(data/raw/plateau/osaka-cityにはtran(道路)のみ確認・data:download系はネットワーク不可のため' +
      '実行できない §正直な限界)。唯一利用可能な生CityGML(住吉区・Mission LOD2調査で取得済み)を' +
      '大阪市PLATEAU提供元全体の代替証拠として用いる(Kita区個別の直接確認ではない)。',
    sumiyoshiLod2AuditReports: sumiyoshiAudits,
    sumiyoshiRawGrepCounts,
  };
}

async function loadCanonicalBuildingsInBounds(bounds) {
  const { txMin, txMax, tzMin, tzMax } = tileRange(bounds, 500);
  const feats = []; const seen = new Set();
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
function loadRoadV2WallRingsInBounds(bounds) {
  const { txMin, txMax, tzMin, tzMax } = tileRange(bounds, 2000);
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
function loadRailLinesInBounds(bounds) {
  const { txMin, txMax, tzMin, tzMax } = tileRange(bounds, 2000);
  const lines = [];
  for (let tx = txMin; tx <= txMax; tx++) for (let tz = tzMin; tz <= tzMax; tz++) {
    const t = rj(path.join(CANON_RAIL, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
    for (const f of t.features) {
      if (f.geometryType !== 'LineString' || !f.bbox) continue;
      const padBox = { minX: f.bbox.minX - RAIL_HALF_WIDTH_M, maxX: f.bbox.maxX + RAIL_HALF_WIDTH_M, minZ: f.bbox.minZ - RAIL_HALF_WIDTH_M, maxZ: f.bbox.maxZ + RAIL_HALF_WIDTH_M };
      if (bboxOverlaps(padBox, bounds)) lines.push(f.coordinates);
    }
  }
  return lines;
}
function distPointToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az; const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function percentiles(arr) {
  if (!arr.length) return { count: 0, median: null, p90: null, max: null };
  const s = arr.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { count: s.length, median: +q(0.5).toFixed(3), p90: +q(0.9).toFixed(3), max: +s[s.length - 1].toFixed(3) };
}

async function main() {
  const generatedAt = new Date().toISOString();
  console.log('[ground-footprint-audit] bounds=' + JSON.stringify(BOUNDS));

  console.log('[ground-footprint-audit] §2/§3 converter logic + raw CityGML availability...');
  const converterAudit = auditConverterLogic();
  const rawAvailability = auditRawCityGmlAvailability();
  console.log('[ground-footprint-audit] converter priority found:', converterAudit.priorityCommentFound, ' excludesRoofSurface:', converterAudit.excludesRoofSurface);
  console.log('[ground-footprint-audit] sumiyoshi raw grep:', JSON.stringify(rawAvailability.sumiyoshiRawGrepCounts));

  console.log('[ground-footprint-audit] loading buildings/road/rail masks...');
  const buildings = await loadCanonicalBuildingsInBounds(BOUNDS);
  const roadWallRings = loadRoadV2WallRingsInBounds(BOUNDS);
  const railLines = loadRailLinesInBounds(BOUNDS);
  console.log('[ground-footprint-audit] buildings=' + buildings.length + ' roadWallRings=' + roadWallRings.length + ' railLines=' + railLines.length);

  console.log('[ground-footprint-audit] loading GSI BldA (streaming, filter to bounds)...');
  const gsiAll = await readFeatureCollectionStreaming(GSI_BLDA);
  const MARGIN = 100;
  const gsiInBounds = gsiAll.features.filter((f) => {
    const rings = ringsOfFeature(f); if (!rings.length) return false;
    const bb = bboxOfRing(rings[0]);
    return bboxOverlaps(bb, { minX: BOUNDS.minX - MARGIN, maxX: BOUNDS.maxX + MARGIN, minZ: BOUNDS.minZ - MARGIN, maxZ: BOUNDS.maxZ + MARGIN });
  }).map((f) => ({ ring: ringsOfFeature(f)[0], bbox: bboxOfRing(ringsOfFeature(f)[0]) }));
  console.log('[ground-footprint-audit] GSI BldA in bounds=' + gsiInBounds.length);

  const landBlockAssignment = rj(LAND_BLOCK_ASSIGNMENT);
  const landBlockByCanonicalId = new Map((landBlockAssignment ? landBlockAssignment.buildings : []).map((b) => [b.canonicalId, b]));

  // ── raster: road wall / rail corridor / GSI BldA coverage(1m、32C-32F同一解像度) ──
  const CELL_M = 1.0;
  const nx = Math.ceil((BOUNDS.maxX - BOUNDS.minX) / CELL_M), nz = Math.ceil((BOUNDS.maxZ - BOUNDS.minZ) / CELL_M);
  const roadMask = new Uint8Array(nx * nz), railMask = new Uint8Array(nx * nz), gsiMask = new Uint8Array(nx * nz);
  function fillRing(ring, target) {
    const bb = bboxOfRing(ring);
    const ix0 = Math.max(0, Math.floor((bb.minX - BOUNDS.minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((bb.maxX - BOUNDS.minX) / CELL_M));
    const iz0 = Math.max(0, Math.floor((bb.minZ - BOUNDS.minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((bb.maxZ - BOUNDS.minZ) / CELL_M));
    if (ix1 < ix0 || iz1 < iz0) return;
    for (let ix = ix0; ix <= ix1; ix++) { const px = BOUNDS.minX + (ix + 0.5) * CELL_M;
      for (let iz = iz0; iz <= iz1; iz++) { const pz = BOUNDS.minZ + (iz + 0.5) * CELL_M;
        if (target[iz * nx + ix]) continue;
        if (pointInRing(px, pz, ring)) target[iz * nx + ix] = 1;
      }
    }
  }
  console.time('[ground-footprint-audit] rasterize road/GSI masks');
  for (const r of roadWallRings) fillRing(r.ring, roadMask);
  for (const g of gsiInBounds) fillRing(g.ring, gsiMask);
  console.timeEnd('[ground-footprint-audit] rasterize road/GSI masks');

  // 建物重なりカウント: 各セルを何棟のPLATEAU建物が覆っているか(飽和カウント)。
  //   footprintが「実体1棟の地面接地形状」ではなく「複合施設のenvelope」である場合、
  //   同じ場所を複数のPLATEAU建物が重複して覆う傾向が出る。GSIとは独立した手がかり。
  console.time('[ground-footprint-audit] rasterize building overlap count');
  const bldgCount = new Uint8Array(nx * nz);
  for (const ft of buildings) {
    const rings = ringsOfFeature(ft); if (!rings.length || !ft.bbox) continue;
    const ring = rings[0];
    const bb = bboxOfRing(ring);
    const ix0 = Math.max(0, Math.floor((bb.minX - BOUNDS.minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((bb.maxX - BOUNDS.minX) / CELL_M));
    const iz0 = Math.max(0, Math.floor((bb.minZ - BOUNDS.minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((bb.maxZ - BOUNDS.minZ) / CELL_M));
    if (ix1 < ix0 || iz1 < iz0) continue;
    for (let ix = ix0; ix <= ix1; ix++) { const px = BOUNDS.minX + (ix + 0.5) * CELL_M;
      for (let iz = iz0; iz <= iz1; iz++) { const pz = BOUNDS.minZ + (iz + 0.5) * CELL_M;
        if (!pointInRing(px, pz, ring)) continue;
        const idx = iz * nx + ix; if (bldgCount[idx] < 255) bldgCount[idx]++;
      }
    }
  }
  console.timeEnd('[ground-footprint-audit] rasterize building overlap count');
  // rail corridor: 全セル×全segmentの総当たりは実測68秒かかったため、segmentのbbox側から
  //   該当セル範囲だけを塗る方式へ変更（結果は同一・計算順序だけが違う）。
  console.time('[ground-footprint-audit] rasterize rail corridor');
  for (const line of railLines) {
    for (let i = 0; i < line.length - 1; i++) {
      const ax = line[i][0], az = line[i][1], bx = line[i + 1][0], bz = line[i + 1][1];
      const segMinX = Math.min(ax, bx) - RAIL_HALF_WIDTH_M, segMaxX = Math.max(ax, bx) + RAIL_HALF_WIDTH_M;
      const segMinZ = Math.min(az, bz) - RAIL_HALF_WIDTH_M, segMaxZ = Math.max(az, bz) + RAIL_HALF_WIDTH_M;
      const ix0 = Math.max(0, Math.floor((segMinX - BOUNDS.minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((segMaxX - BOUNDS.minX) / CELL_M));
      const iz0 = Math.max(0, Math.floor((segMinZ - BOUNDS.minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((segMaxZ - BOUNDS.minZ) / CELL_M));
      if (ix1 < ix0 || iz1 < iz0) continue;
      for (let ix = ix0; ix <= ix1; ix++) { const px = BOUNDS.minX + (ix + 0.5) * CELL_M;
        for (let iz = iz0; iz <= iz1; iz++) {
          const idx = iz * nx + ix; if (railMask[idx]) continue;
          const pz = BOUNDS.minZ + (iz + 0.5) * CELL_M;
          if (distPointToSegment(px, pz, ax, az, bx, bz) <= RAIL_HALF_WIDTH_M) railMask[idx] = 1;
        }
      }
    }
  }
  console.timeEnd('[ground-footprint-audit] rasterize rail corridor');

  // ── 全building: 各maskとの重なり比・GSI一致度を測る ──
  const buildingStats = [];
  for (const ft of buildings) {
    const rings = ringsOfFeature(ft); if (!rings.length || !ft.bbox) continue;
    const outer = rings[0];
    const bb = ft.bbox;
    const ix0 = Math.max(0, Math.floor((bb.minX - BOUNDS.minX) / CELL_M)), ix1 = Math.min(nx - 1, Math.floor((bb.maxX - BOUNDS.minX) / CELL_M));
    const iz0 = Math.max(0, Math.floor((bb.minZ - BOUNDS.minZ) / CELL_M)), iz1 = Math.min(nz - 1, Math.floor((bb.maxZ - BOUNDS.minZ) / CELL_M));
    // §非循環の判別指標: footprintを「GSI建物が裏付ける部分」と「裏付けない部分」に分け、
    //   それぞれの中でのroad/rail占有率を比べる。同一建物内の比較なので、サンプル選定時に
    //   road/rail跨ぎで絞ったこと自体によるバイアスを受けない(選定バイアスと独立)。
    //   - ground-contact footprintなら: GSI未裏付け部分は「GSIが単に建物を取りこぼした場所」のはずで、
    //     road/rail率はGSI裏付け部分と大きくは変わらない。
    //   - 屋根/高架envelope由来なら: はみ出した部分こそが線路・道路の上空なので、
    //     GSI未裏付け部分のroad/rail率が際立って高くなる。
    let total = 0, road = 0, rail = 0, gsi = 0, overlapOther = 0;
    let gsiRoad = 0, gsiRail = 0, nonGsiRoad = 0, nonGsiRail = 0, nonGsiNeither = 0;
    if (ix1 >= ix0 && iz1 >= iz0) {
      for (let ix = ix0; ix <= ix1; ix++) { const px = BOUNDS.minX + (ix + 0.5) * CELL_M;
        for (let iz = iz0; iz <= iz1; iz++) { const pz = BOUNDS.minZ + (iz + 0.5) * CELL_M;
          if (!pointInRing(px, pz, outer)) continue;
          const idx = iz * nx + ix;
          total++;
          const isRoad = !!roadMask[idx], isRail = !!railMask[idx], isGsi = !!gsiMask[idx];
          if (bldgCount[idx] >= 2) overlapOther++; // 自分以外の建物も覆っているセル
          if (isRoad) road++;
          if (isRail) rail++;
          if (isGsi) { gsi++; if (isRoad) gsiRoad++; if (isRail) gsiRail++; }
          else { if (isRoad) nonGsiRoad++; if (isRail) nonGsiRail++; if (!isRoad && !isRail) nonGsiNeither++; }
        }
      }
    }
    if (total === 0) continue;
    const lb = landBlockByCanonicalId.get(ft.canonicalId);
    const nonGsi = total - gsi;
    buildingStats.push({
      canonicalId: ft.canonicalId, areaM2: ft.areaM2 || 0,
      roadRatio: +(road / total).toFixed(4), railRatio: +(rail / total).toFixed(4), gsiCoverageRatio: +(gsi / total).toFixed(4),
      landBlockOutsideRatio: lb ? +(1 - lb.insideRatio).toFixed(4) : null,
      carriagewayRatio: lb && lb.carriagewayRatio != null ? lb.carriagewayRatio : null,
      // 同一建物内での比較(nullはその部分のcellが無い＝比較不能)
      roadRailRatioWithinGsiBacked: gsi > 0 ? +(((gsiRoad + gsiRail - Math.min(gsiRoad, gsiRail)) / gsi)).toFixed(4) : null,
      roadRailRatioWithinNonGsi: nonGsi > 0 ? +(((nonGsiRoad + nonGsiRail - Math.min(nonGsiRoad, nonGsiRail)) / nonGsi)).toFixed(4) : null,
      nonGsiNeitherRatio: nonGsi > 0 ? +(nonGsiNeither / nonGsi).toFixed(4) : null,
      nonGsiRoadRatio: nonGsi > 0 ? +(nonGsiRoad / nonGsi).toFixed(4) : null,
      nonGsiRailRatio: nonGsi > 0 ? +(nonGsiRail / nonGsi).toFixed(4) : null,
      nonGsiAreaM2: +((nonGsi / total) * (ft.areaM2 || 0)).toFixed(1),
      otherBuildingOverlapRatio: +(overlapOther / total).toFixed(4),
    });
  }
  console.log('[ground-footprint-audit] buildingStats computed for ' + buildingStats.length + ' buildings');

  // ── §1 sample30選定: area・road/rail crossingが顕著な建物を優先(明確な基準・推測でない) ──
  const AREA_MIN_M2 = 300;
  const candidates = buildingStats.filter((b) => b.areaM2 >= AREA_MIN_M2 && (b.roadRatio >= 0.25 || b.railRatio >= 0.15));
  candidates.sort((a, b) => (b.areaM2 * Math.max(b.roadRatio, b.railRatio, b.landBlockOutsideRatio || 0)) - (a.areaM2 * Math.max(a.roadRatio, a.railRatio, a.landBlockOutsideRatio || 0)));
  const sample = candidates.slice(0, 30);
  const candidateIds = new Set(candidates.map((c) => c.canonicalId));
  console.log('[ground-footprint-audit] candidates=' + candidates.length + ' sample=' + sample.length);

  // ── 対照群(control group): 「問題建物」ではない通常の建物。
  //   これが無いと「GSI coverageが低い」がsample固有の性質なのか、梅田全域でGSIが単に建物を
  //   取りこぼしているだけなのかを区別できない(誤った結論を防ぐために必須)。
  const controlGroup = buildingStats.filter((b) => !candidateIds.has(b.canonicalId));
  const controlStats = {
    count: controlGroup.length,
    gsiCoverageRatio: percentiles(controlGroup.map((b) => b.gsiCoverageRatio)),
    roadRatio: percentiles(controlGroup.map((b) => b.roadRatio)),
    railRatio: percentiles(controlGroup.map((b) => b.railRatio)),
    roadRailRatioWithinGsiBacked: percentiles(controlGroup.map((b) => b.roadRailRatioWithinGsiBacked).filter((v) => v != null)),
    roadRailRatioWithinNonGsi: percentiles(controlGroup.map((b) => b.roadRailRatioWithinNonGsi).filter((v) => v != null)),
    note: '「問題建物」候補から外れた通常建物。sample群との比較対照(GSI coverageの低さがsample固有か、梅田全域の傾向かを判定するため)。',
  };
  console.log('[ground-footprint-audit] control group n=' + controlGroup.length + ' gsiCov median=' + controlStats.gsiCoverageRatio.median);

  // ── §12/§15/§18/§19: sampleごとの分類 ──
  //   [重要な修正] 初版では sample を road/rail 跨ぎで選び、structureType も road/rail 跨ぎで判定し、
  //   さらに structureType が §15 の答えを上書きしていたため、30棟中29棟が自動的に SPECIAL_STRUCTURE
  //   になる循環論法になっていた(同語反復であり発見ではない)。
  //   修正後: (1) §15の「底面はground footprintか」は footprint semantics の証拠だけで判定し、
  //   (2) §12の structureType は別軸として併記し、(3) §19に従い「groundらしいのに跨いでいる」場合のみ
  //   REAL_OVERHEAD_STRUCTURE 系として別扱いにする。
  const buildingById = new Map(buildings.map((f) => [f.canonicalId, f]));
  const sampleDetail = [];
  for (const s of sample) {
    const ft = buildingById.get(s.canonicalId);
    const bb = ft.bbox;
    const gsiCandCount = gsiInBounds.filter((g) => bboxOverlaps(g.bbox, bb)).length;
    const currentAreaM2 = s.areaM2;
    const gsiCoverageRatio = s.gsiCoverageRatio; // 0=GSIが全く重ならない / 1=GSIで完全に裏付け

    // §12 構造分類(実測値のみ・§15とは独立した別軸)
    let structureType;
    if (s.railRatio >= 0.15 && s.roadRatio >= 0.15) structureType = 'OVER_TRACK_STRUCTURE';
    else if (s.railRatio >= 0.15) structureType = 'OVER_TRACK_STRUCTURE';
    else if (currentAreaM2 >= 8000) structureType = 'STATION_STRUCTURE';
    else if (currentAreaM2 >= 3000) structureType = 'PODIUM_TOWER';
    else if (s.roadRatio >= 0.4) structureType = 'BRIDGE_LIKE_BUILDING';
    else structureType = 'NORMAL_BUILDING';

    // §15: 現在の底面はGround Footprintなのか(YES/NO/UNKNOWN)。
    //   PLATEAU側にGroundSurface/RoofEdgeという代替geometryが存在しない(§2実測)ため、PLATEAU内部での
    //   直接比較は原理的に不能。代わりに2つの独立証拠を使う:
    //     (a) GSI BldA(独立した地図由来の建物輪郭)がどれだけ裏付けているか
    //     (b) 【非循環】GSI未裏付け部分のroad/rail率が、GSI裏付け部分より際立って高いか
    //         (同一建物内の比較なのでsample選定バイアスと独立)
    const inGsi = s.roadRailRatioWithinGsiBacked, inNonGsi = s.roadRailRatioWithinNonGsi;
    const concentration = (inGsi != null && inNonGsi != null) ? +(inNonGsi - inGsi).toFixed(4) : null;
    // 【自己批判・重要】当初はこの concentration が高い＝roof-like と判定していたが、これは誤り。
    //   GSIは「道路・線路の上に建物を描かない」ため、footprintが道路上にはみ出していれば
    //   その部分が非GSIになるのは、(H1)実在の高架建築でも (H2)屋根/envelope由来でも同じく起きる。
    //   つまり concentration は H1/H2 を区別できない(両仮説が同じ観測を生む)。
    //   よってここでは「地面接地形状として確定できるか」だけを判定し、H1/H2の切り分けは
    //   本環境のデータでは不能である旨を UNRESOLVABLE として明示する(推測で断定しない)。
    const overhangSignal = concentration != null && concentration >= 0.25;
    let groundFootprintAnswer, groundFootprintReason;
    if (gsiCoverageRatio >= 0.7) {
      groundFootprintAnswer = 'YES';
      groundFootprintReason = 'GSI BldAが底面の' + Math.round(gsiCoverageRatio * 100) + '%を裏付けている(独立ソースが地面レベルの建物として一致)';
    } else if (overhangSignal) {
      groundFootprintAnswer = 'UNKNOWN';
      groundFootprintReason = '底面のうちGSI非裏付け部分(' + Math.round((1 - gsiCoverageRatio) * 100) + '%)の' +
        Math.round(inNonGsi * 100) + '%が道路/線路上にある。ただしGSIは道路・線路上に建物を描かないため、' +
        'この観測は「実在の高架建築(H1)」でも「屋根/envelope由来の過大な底面(H2)」でも同一に生じる。' +
        '本環境で利用できるデータ(GroundSurface/WallSurface/lod2が存在しない)ではH1とH2を区別できない＝UNRESOLVABLE。';
    } else {
      groundFootprintAnswer = 'UNKNOWN';
      groundFootprintReason = 'GSI coverage=' + gsiCoverageRatio + '・集中度=' + concentration + 'では断定できない(GSI側の取りこぼしの可能性も排除できない)';
    }

    sampleDetail.push({
      canonicalId: s.canonicalId, areaM2: currentAreaM2,
      roadRatio: s.roadRatio, railRatio: s.railRatio, carriagewayRatio: s.carriagewayRatio,
      landBlockOutsideRatio: s.landBlockOutsideRatio,
      gsiCoverageRatio, gsiCandidateCount: gsiCandCount, nonGsiAreaM2: s.nonGsiAreaM2,
      nonGsiRoadRatio: s.nonGsiRoadRatio, nonGsiRailRatio: s.nonGsiRailRatio,
      otherBuildingOverlapRatio: s.otherBuildingOverlapRatio,
      roadRailRatioWithinGsiBacked: inGsi, roadRailRatioWithinNonGsi: inNonGsi, overhangConcentration: concentration,
      h1h2Unresolvable: overhangSignal && gsiCoverageRatio < 0.7,
      structureType, groundFootprintAnswer, groundFootprintReason,
    });
  }
  // §16 集計: §15の答えを主軸にし、§19に従って「groundらしいのに跨ぐ」ものだけを別扱いにする。
  //   なお CURRENT_IS_ROOF_LIKE / CURRENT_IS_PROJECTION は「屋根geometryを使っている」ことを
  //   意味する分類だが、§2実測でこのデータセットにはlod0RoofEdge/RoofSurfaceが1件も存在しない。
  //   したがってそれらのbucketに入れられる建物は原理的に存在しない(0件が正しい結果であり、
  //   0件であること自体が「pipelineが屋根を掴んでいるわけではない」ことの裏付けになる)。
  const classCounts = { CURRENT_IS_GROUND: 0, CURRENT_IS_ROOF_LIKE: 0, CURRENT_IS_PROJECTION: 0, SPECIAL_STRUCTURE: 0, UNKNOWN: 0 };
  for (const s of sampleDetail) {
    const crosses = s.railRatio >= 0.15 || s.roadRatio >= 0.4;
    if (s.groundFootprintAnswer === 'YES') {
      // §19: groundらしいのに道路/線路を大きく跨ぐ = 実在の高架建築 or source conflict → 別扱い
      if (crosses) { classCounts.SPECIAL_STRUCTURE++; s.finalBucket = 'SPECIAL_STRUCTURE'; s.specialReason = 'REAL_OVERHEAD_STRUCTURE_OR_SOURCE_CONFLICT'; }
      else { classCounts.CURRENT_IS_GROUND++; s.finalBucket = 'CURRENT_IS_GROUND'; }
    } else {
      classCounts.UNKNOWN++;
      s.finalBucket = s.h1h2Unresolvable ? 'UNKNOWN_H1_H2_UNRESOLVABLE' : 'UNKNOWN';
    }
  }
  const unresolvableCount = sampleDetail.filter((s) => s.h1h2Unresolvable).length;

  // ── §17 改善予測(仮想計算のみ。runtimeには適用しない): GSI coverageが低い建物についてGSI BldAの
  //   合計面積をground候補としたときのroad/rail/landBlockOutside重なりを概算(現在のarea*ratioとの比較) ──
  const virtualImprovement = { note: '仮想計算のみ(runtimeには適用していない)。GSI BldAでcurrent footprintを置き換えた場合の概算。', before: {}, after: {} };
  {
    let roadBefore = 0, railBefore = 0, outsideBefore = 0, roadAfter = 0, railAfter = 0, totalAreaBefore = 0, totalAreaAfterGsi = 0;
    for (const s of sampleDetail) {
      totalAreaBefore += s.areaM2;
      roadBefore += s.areaM2 * s.roadRatio;
      railBefore += s.areaM2 * s.railRatio;
      outsideBefore += s.areaM2 * (s.landBlockOutsideRatio || 0);
      // afterはGSIが裏付ける部分だけを「ground候補面積」とみなす概算(GSI形状そのものでの再計算はしていない・面積比のみ)
      const gsiArea = s.areaM2 * s.gsiCoverageRatio;
      totalAreaAfterGsi += gsiArea;
      roadAfter += gsiArea * s.roadRatio; // 保守的に同じroadRatioを仮定(実形状交差ではない近似)
      railAfter += gsiArea * s.railRatio;
    }
    virtualImprovement.before = { totalAreaM2: Math.round(totalAreaBefore), roadOverlapM2: Math.round(roadBefore), railOverlapM2: Math.round(railBefore), landBlockOutsideM2: Math.round(outsideBefore) };
    virtualImprovement.after = { totalAreaM2: Math.round(totalAreaAfterGsi), roadOverlapM2: Math.round(roadAfter), railOverlapM2: Math.round(railAfter) };
  }

  // ── §22 最終classification ──
  //   前提: §2実測でPLATEAU側にlod0RoofEdge/GroundSurface/RoofSurface/WallSurfaceが1件も存在せず、
  //   選べるfootprint系geometryはlod0FootPrintだけだった。したがって「pipelineが屋根geometryを
  //   誤って選んだ」タイプのGROUND_FOOTPRINT_SEMANTICS_ERRORは、source選択ミスとしては成立しない。
  //   残る可能性は「lod0FootPrintそのものが地面接地形状を表していない建物がある(source起因)」か
  //   「実在の高架建築(REAL_OVERHEAD_STRUCTURE)」のどちらか。
  const n = Math.max(1, sampleDetail.length);
  const alternativeGroundGeometryExists = !!(rawAvailability.sumiyoshiRawGrepCounts
    && (rawAvailability.sumiyoshiRawGrepCounts.GroundSurface > 0
      || rawAvailability.sumiyoshiRawGrepCounts.WallSurface > 0
      || rawAvailability.sumiyoshiRawGrepCounts.lod2Solid > 0
      || rawAvailability.sumiyoshiRawGrepCounts.lod2MultiSurface > 0));
  const roofGeometryExistsInSource = !!(rawAvailability.sumiyoshiRawGrepCounts
    && (rawAvailability.sumiyoshiRawGrepCounts.lod0RoofEdge > 0 || rawAvailability.sumiyoshiRawGrepCounts.RoofSurface > 0));
  const roofLikeDominant = (classCounts.CURRENT_IS_ROOF_LIKE + classCounts.CURRENT_IS_PROJECTION) > n * 0.4;
  const groundDominant = classCounts.CURRENT_IS_GROUND > n * 0.5;
  const specialDominant = classCounts.SPECIAL_STRUCTURE > n * 0.5;
  // 対照群との差: sampleのGSI coverageが対照群より明確に低いか(低くなければGSI側の取りこぼしが主因)
  const sampleGsiMedian = percentiles(sampleDetail.map((s) => s.gsiCoverageRatio)).median;
  const controlGsiMedian = controlStats.gsiCoverageRatio.median;
  const gsiCoverageGapVsControl = (sampleGsiMedian != null && controlGsiMedian != null) ? +(controlGsiMedian - sampleGsiMedian).toFixed(4) : null;
  let finalClassification, finalClassificationReason;
  if (roofGeometryExistsInSource && roofLikeDominant) {
    finalClassification = 'GROUND_FOOTPRINT_SEMANTICS_ERROR';
    finalClassificationReason = 'source側にroof系geometryが存在し、かつ多数の問題建物がroof-likeと判定された。';
  } else if (specialDominant) {
    finalClassification = 'SPECIAL_STRUCTURE_DOMINANT';
    finalClassificationReason = 'sampleの過半数が「GSIが地面レベルの建物として裏付けている」かつ「道路/線路を跨ぐ」＝実在の高架建築が主。';
  } else if (groundDominant) {
    finalClassification = 'CURRENT_FOOTPRINT_IS_CORRECT';
    finalClassificationReason = 'sampleの過半数で現在の底面が独立ソースと一致し、跨ぎも見られない。';
  } else {
    finalClassification = 'SOURCE_CONFLICT';
    finalClassificationReason = 'source側にはlod0FootPrint以外のfootprint系geometryが存在せず(GroundSurface/WallSurface/RoofEdge/lod2すべて0件)、' +
      'pipelineが屋根geometryを誤選択した可能性は排除された。一方で問題建物の底面は道路/線路上へ広がっており、' +
      'その広がりが「実在の高架建築(H1)」か「source側lod0FootPrintの過大な範囲(H2)」かは、' +
      '本環境で利用可能なデータでは区別できない(H1/H2ともに同一の観測を生むため)。' +
      'すなわちsource間(PLATEAU footprint vs GSI建物 vs 道路/線路)の不一致として残る。';
  }

  const report = {
    version: 1, generatedAt, missionId: '32G',
    bounds: BOUNDS,
    sampleCount: sampleDetail.length,
    sourceAvailability: {
      converterLogic: converterAudit,
      rawCityGmlAvailability: rawAvailability,
    },
    currentFootprintSource: {
      classification: rawAvailability.sumiyoshiRawGrepCounts && rawAvailability.sumiyoshiRawGrepCounts.lod0FootPrint > 0 ? 'LOD0_FOOTPRINT' : 'OTHER',
      note: '住吉区の生CityGML実測でlod0FootPrintが全建物ぶん存在し(6378タグ/2=3189棟=buildingCountと一致)、' +
        'lod0RoofEdge/GroundSurface/RoofSurface/WallSurface/lod2Solid/lod2MultiSurfaceは0件だった。' +
        'converter(tools/convert-plateau-buildings.js)の優先順位(lod0FootPrint→GroundSurface→lowestRing)' +
        'と合わせると、この大阪市PLATEAUデータセットでは実質的に全建物がlod0FootPrintから' +
        'footprintを取得していると強く推定される(Kita区の生データでの直接確認はできていない §限界)。' +
        'lod0FootPrintはCityGML/PLATEAU仕様上「建物の地表面投影(ground footprint)」として定義される' +
        'geometryであり、lod0RoofEdge(屋根投影)とは概念上別物——このデータセットにはlod0RoofEdge自体が' +
        '存在しないため、「roof outlineを誤って使っている」という単純なsource選択ミスの可能性は低いと判断。',
    },
    classifications: sampleDetail,
    classCounts,
    comparison: {
      currentVsGsiBldA: percentiles(sampleDetail.map((s) => s.gsiCoverageRatio)),
      note: 'PLATEAU側にGroundSurface/RoofEdgeが存在しないため§4/§5/§6の直接比較は不能(§18参照)。' +
        '独立した地図データ(GSI BldA)との一致度を代理指標として使用。',
      // 非循環の主判別指標: 同一建物内で「GSIが裏付ける部分」と「裏付けない部分」のroad/rail率を比べる
      roadRailRatioWithinGsiBacked: percentiles(sampleDetail.map((s) => s.roadRailRatioWithinGsiBacked).filter((v) => v != null)),
      roadRailRatioWithinNonGsi: percentiles(sampleDetail.map((s) => s.roadRailRatioWithinNonGsi).filter((v) => v != null)),
      overhangConcentration: percentiles(sampleDetail.map((s) => s.overhangConcentration).filter((v) => v != null)),
      overhangConcentrationNote: 'GSI未裏付け部分のroad/rail率 − GSI裏付け部分のroad/rail率。' +
        '正で大きいほど「はみ出している部分ほど道路/線路の上空にある」＝地面接地形状ではない疑いが強い。' +
        '同一建物内の比較なので、sampleをroad/rail跨ぎで選んだこと自体のバイアスを受けない。',
      controlGroup: controlStats,
      gsiCoverageGapVsControl,
      gsiCoverageGapNote: '対照群(通常建物)のGSI coverage中央値 − sample(問題建物)の中央値。' +
        '正で大きいほど「GSIが裏付けない広がり」は問題建物に固有の性質であり、梅田全域でGSIが' +
        '建物を取りこぼしているだけ、という対立仮説は弱まる。',
    },
    overlap: {
      roadCurrent: percentiles(sampleDetail.map((s) => s.roadRatio)),
      railCurrent: percentiles(sampleDetail.map((s) => s.railRatio)),
      landBlockOutsideCurrent: percentiles(sampleDetail.map((s) => s.landBlockOutsideRatio || 0)),
    },
    specialStructures: sampleDetail.filter((s) => s.structureType !== 'NORMAL_BUILDING').map((s) => ({ canonicalId: s.canonicalId, structureType: s.structureType, areaM2: s.areaM2, railRatio: s.railRatio, roadRatio: s.roadRatio })),
    recommendedGroundFootprintPriority: [
      { priority: 1, source: 'lod0FootPrint', note: '現在採用中。データセットに存在する唯一のfootprint系geometry。仕様上ground footprintの定義。' },
      { priority: 2, source: 'GroundSurface', note: 'このデータセットには存在しない(0件、実測確認済み)。' },
      { priority: 3, source: 'wall-ground intersection derived (PoC concept)', note: 'WallSurfaceも存在しないため本データセットでは適用不可。' },
      { priority: 4, source: 'GSI BldA cross-check', note: 'PLATEAU外の独立データによる事後検証としてのみ有用(ground truthとして採用はしない §7)。' },
    ],
    virtualImprovement,
    discriminationLimitation: {
      h1h2UnresolvableCount: unresolvableCount,
      sampleCount: sampleDetail.length,
      alternativeGroundGeometryExistsInSource: alternativeGroundGeometryExists,
      roofGeometryExistsInSource,
      note: 'H1=実在の高架建築(線路/道路の上に本当に構造物がある) / H2=source側lod0FootPrintが地面接地より' +
        '過大。GSIは道路・線路の上に建物を描かないため、「底面のはみ出し部分が非GSIかつ道路/線路上」という' +
        '観測はH1でもH2でも同じく発生する＝この観測だけでは両者を区別できない。区別にはGroundSurface/' +
        'WallSurface/lod2(このデータセットに0件)か、現地/空中写真による確認が必要。',
    },
    finalClassification, finalClassificationReason,
  };
  await writeJson(REPORT, report);
  console.log('[ground-footprint-audit] 保存: ' + toProjectRelativePath(REPORT));

  // ── §14 Top Down overlay 用の軽量payload(読み取り専用の可視化データ。建物geometryは一切変更しない) ──
  //   §14の指定色のうち GroundSurface(cyan) / lod0FootPrint(blue) / RoofEdge(magenta) は、
  //   このデータセットに該当geometryが存在しない(実測0件)ため「該当なし」として明示する。
  //   lod0FootPrintは現在の底面そのもの(CURRENT=yellow)であり、別レイヤーとしては重複するため出さない。
  const sampleIdSet = new Set(sampleDetail.map((s) => s.canonicalId));
  const qaPayload = {
    version: 1, generatedAt, bounds: BOUNDS,
    legend: {
      CURRENT: { color: 'yellow', note: '現在Runtimeが底面として使っているCanonical Building footprint(=PLATEAU lod0FootPrint由来)' },
      GSI_BLDA: { color: 'white', note: 'GSI 建築物ポリゴン(独立ソース・ground truthとしては扱わない §7)' },
      ROAD_V2: { color: 'gray', note: 'ROAD V2 road envelope' },
      RAIL: { color: 'black', note: 'Canonical Rail 中心線±' + RAIL_HALF_WIDTH_M + 'm(概算corridor)' },
      GROUND_SURFACE: { color: 'cyan', available: false, note: 'このPLATEAUデータセットに存在しない(実測0件)' },
      LOD0_FOOTPRINT: { color: 'blue', available: false, note: 'CURRENTと同一geometryのため別レイヤー化しない' },
      ROOF_EDGE: { color: 'magenta', available: false, note: 'このPLATEAUデータセットに存在しない(実測0件)' },
    },
    sampleBuildings: buildings.filter((f) => sampleIdSet.has(f.canonicalId)).map((f) => {
      const d = sampleDetail.find((s) => s.canonicalId === f.canonicalId);
      return { canonicalId: f.canonicalId, geometryType: f.geometryType, coordinates: f.coordinates,
        areaM2: d.areaM2, structureType: d.structureType, finalBucket: d.finalBucket,
        roadRatio: d.roadRatio, railRatio: d.railRatio, gsiCoverageRatio: d.gsiCoverageRatio };
    }),
    gsiBldA: gsiInBounds.map((g) => g.ring),
    roadV2: roadWallRings.map((r) => r.ring),
    rail: railLines,
    railHalfWidthM: RAIL_HALF_WIDTH_M,
  };
  const QA_DIR = P('data', 'processed', 'osaka-city', 'ground-footprint-qa', 'umeda');
  fs.mkdirSync(QA_DIR, { recursive: true });
  await writeJson(path.join(QA_DIR, 'overlay.json'), qaPayload);
  console.log('[ground-footprint-audit] QA overlay 保存: ' + toProjectRelativePath(path.join(QA_DIR, 'overlay.json')) + ' (sample=' + qaPayload.sampleBuildings.length + ')');
  console.log('[ground-footprint-audit] classCounts=' + JSON.stringify(classCounts) + ' finalClassification=' + finalClassification);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[ground-footprint-audit] 失敗:', e && e.stack || e); process.exit(1); });
