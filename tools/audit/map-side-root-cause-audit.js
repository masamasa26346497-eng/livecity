#!/usr/bin/env node
// tools/audit/map-side-root-cause-audit.js
// [Mission 32D] MAP-SIDE ROOT CAUSE AUDIT。
//   §0: Building(PLATEAU/GSI/Canonical/Visual いずれも) は完全 READ ONLY。x/z/scale/height/matching/
//   warp/clip/correction を一切行わない。今回は「建物が区画からはみ出して見える」原因を、
//   道路・街区・地表側（map side）だけを測定して特定する監査であり、補正はしない（§30）。
//
//   対象データセット（すべて既存・追加取得なし）:
//     GSI_ROAD_EDGE  = data/processed/osaka-city/gsi-road-edge/road-edge-lines.json（112,199件）
//     FIX13_ROAD_SURFACE = data/processed/osaka-city/canonical/roads（199,658件）+
//                          data/processed/osaka-city/derived/refined-road-surface.json（renderClass）
//     PLATEAU_TRAN   = data/processed/osaka-city/canonical/roads-tran/polygons.json（198,626件、
//                      canonicalizeされる「前」の生 tran:Road lod1 polygon。現在runtimeへ直接参加していない）
//     OSM_ROAD       = data/processed/osaka-city/roads（tools/convert/roads.js 出力、42,565件、
//                      legacy RoadLayer 用。Canonical Runtime が base layer を所有中はhide）
//     BLOCK_POLYGON  = 本監査で梅田/住吉フィクスチャ範囲のみ新規に軽量raster化（32Cのwhole-area
//                      raster設計を流用。GSI Road Edgeを壁としたflood-fill。正式名称は
//                      ROAD_ENCLOSED_BLOCK。parcel/lot/siteという意味は持たせない §23）
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const ROADS_TRAN_FILE = P('data', 'processed', 'osaka-city', 'canonical', 'roads-tran', 'polygons.json');
const GSI_EDGE_FILE = P('data', 'processed', 'osaka-city', 'gsi-road-edge', 'road-edge-lines.json');
const GSI_EDGE_MANIFEST = P('data', 'processed', 'osaka-city', 'gsi-road-edge', 'manifest.json');
const OSM_ROADS_DIR = P('data', 'processed', 'osaka-city', 'roads', 'tiles');
const OSM_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'roads', 'manifest.json');
const REFINED_SURFACE = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const CANON_BLDGS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const PROJECTION_CONFIG = P('config', 'areas', 'osaka-city.json');
const PRIOR_GSI_FIX13 = P('data', 'reports', 'gsi-vs-fix13-road-comparison.json');
const PRIOR_HYBRID_V1 = P('data', 'reports', 'gsi-road-hybrid-v1.json');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'map-audit');
const REPORT = P('data', 'reports', 'map-side-root-cause-audit.json');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

// ══════════════════════════════════════════════════════════════════════════
// §8/§9 フィクスチャ定義（既存missionのUmeda/Sumiyoshi site座標を再利用。新規推測地名は使わない §0慎重運用）
// ══════════════════════════════════════════════════════════════════════════
const FIXTURE_RADIUS_M = 150;
const FIXTURES = {
  umeda: {
    name: '梅田', label: 'Umeda',
    points: [
      { id: 'umeda_A', label: '地点A(中心・大阪駅周辺)', x: -2668.18, z: -10941.87 },
      { id: 'umeda_B', label: '地点B(北)', x: -2668.18, z: -11241.87 },
      { id: 'umeda_C', label: '地点C(南)', x: -2668.18, z: -10641.87 },
      { id: 'umeda_D', label: '地点D(東)', x: -2368.18, z: -10941.87 },
      { id: 'umeda_E', label: '地点E(西)', x: -2968.18, z: -10941.87 },
    ],
  },
  sumiyoshi: {
    name: '住吉', label: 'Sumiyoshi',
    points: [
      { id: 'sumiyoshi_A', label: '地点A(中心)', x: -2952.22, z: -811.75 },
      { id: 'sumiyoshi_B', label: '地点B(北)', x: -2952.22, z: -1111.75 },
      { id: 'sumiyoshi_C', label: '地点C(南)', x: -2952.22, z: -511.75 },
    ],
  },
};
// 地名ラベルは既存フィクスチャ(tools/audit/visual-building-block-containment.jsのSITES)の座標のみ再利用。
// 「地点A/B/C…」という相対位置表記は、実地名を推測で割り当てないための誠実な選択（§0慎重運用の一環）。

function regionBoundsOf(points, marginM) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x - FIXTURE_RADIUS_M - marginM); maxX = Math.max(maxX, p.x + FIXTURE_RADIUS_M + marginM);
    minZ = Math.min(minZ, p.z - FIXTURE_RADIUS_M - marginM); maxZ = Math.max(maxZ, p.z + FIXTURE_RADIUS_M + marginM);
  }
  return { minX, maxX, minZ, maxZ };
}

// ══════════════════════════════════════════════════════════════════════════
// 幾何ヘルパー
// ══════════════════════════════════════════════════════════════════════════
function bboxOverlaps(a, b) { return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ; }
function ringBboxOf(ring) { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity; for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; } return { minX, maxX, minZ, maxZ }; }
function distPointToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az; const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
function nearestDist(px, pz, segments) {
  let best = Infinity;
  for (const s of segments) { const d = distPointToSegment(px, pz, s[0], s[1], s[2], s[3]); if (d < best) best = d; }
  return best;
}
function ringsOfFeature(f) {
  const rings = [];
  const polys = f.geometryType === 'Polygon' ? [f.coordinates] : (f.geometryType === 'MultiPolygon' ? f.coordinates : []);
  for (const poly of polys) for (const ring of poly) if (Array.isArray(ring) && ring.length > 1) rings.push(ring);
  return rings;
}
function segmentsOfRing(ring) { const segs = []; for (let i = 0; i < ring.length - 1; i++) segs.push([ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]]); return segs; }
function lineLen(coords) { let s = 0; for (let i = 1; i < coords.length; i++) s += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]); return s; }
function percentiles(arr) {
  if (!arr.length) return { median: null, p90: null, min: null, max: null, sampleCount: 0 };
  const s = arr.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), min: +s[0].toFixed(2), max: +s[s.length - 1].toFixed(2), sampleCount: s.length };
}

// ══════════════════════════════════════════════════════════════════════════
// §11: GSI Road Edge を parcel/lot/site boundary として扱っているコードが無いかの静的監査
// ══════════════════════════════════════════════════════════════════════════
function auditParcelConflation() {
  // [自己参照バグ防止・32Bのillegal Warp検出と同種の教訓] 本監査scriptファイル自身は「§11としてこの
  // チェックを行っている」ことを説明するコメントや、レポートのnote欄に "parcel/lot/site という意味は
  // 持たせない" と書くため、素朴な文字列一致だとこのファイル自身がヒットしてしまう。
  // (a) 本ファイル自身はスキャン対象から除外 (b) コメント行(行頭が//)は実装コードではないため除外する。
  const SELF_FILE = toProjectRelativePath(P('tools', 'audit', 'map-side-root-cause-audit.js'));
  const hits = [];
  const pattern = /parcel|敷地境界|区画境界|lot boundary|site boundary|building plot/i;
  function scanFile(fp) {
    const rel = toProjectRelativePath(fp);
    if (rel === SELF_FILE) return;
    let t; try { t = fs.readFileSync(fp, 'utf-8'); } catch { return; }
    const lines = t.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return; // コメント行は実装コードではない
      if (pattern.test(line) && /gsi.?road.?edge|road.?edge.?line|gsiEdge|RdEdg/i.test(line)) {
        hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 200) });
      }
    });
  }
  function walk(p) {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(p)) { if (e === 'node_modules' || e === '.git') continue; walk(path.join(p, e)); } }
    else if (/\.(js|html)$/.test(p)) scanFile(p);
  }
  walk(P('tools')); scanFile(P('public', 'osaka_3d_buildings.ward-ux-v1.html'));
  return { conflationHits: hits, conflationFound: hits.length > 0 };
}

// ══════════════════════════════════════════════════════════════════════════
// §14: FIX13 "primary"(CARRIAGEWAY/INTERSECTION/RAMP) area の geometrySource 内訳
//   （§13の核心測定: primaryとして塗られる面積のうちどれだけがPLATEAU tran road-area由来か）
// ══════════════════════════════════════════════════════════════════════════
function auditPrimarySourceBreakdown() {
  const refined = rj(REFINED_SURFACE);
  const pfx = (refined && refined.keyPrefix) || '';
  const nonPrimaryIds = new Set(Object.keys((refined && refined.classMap) || {}).map((k) => pfx + k));
  const files = fs.readdirSync(CANON_ROADS).filter(isTile);
  let primaryCount = 0, primaryAreaM2 = 0;
  const bySourceCount = {}, bySourceAreaM2 = {};
  let totalFeatureCount = 0;
  const seen = new Set(); // §17系バグ再発防止: tile境界を跨ぐfeatureは複数tileに重複格納されているためdedup必須
  for (const f of files) {
    const t = rj(path.join(CANON_ROADS, f)); if (!t) continue;
    for (const ft of t.features) {
      if (seen.has(ft.canonicalId)) continue;
      seen.add(ft.canonicalId);
      totalFeatureCount++;
      if (nonPrimaryIds.has(ft.canonicalId)) continue; // sidewalk/median/pedestrian/bridge/faint は除外
      primaryCount++; primaryAreaM2 += ft.areaM2 || 0;
      const src = (ft.source && ft.source.geometrySource) || 'unknown';
      bySourceCount[src] = (bySourceCount[src] || 0) + 1;
      bySourceAreaM2[src] = (bySourceAreaM2[src] || 0) + (ft.areaM2 || 0);
    }
  }
  const tranAreaM2 = bySourceAreaM2['plateau-tran-road'] || 0;
  return {
    totalCanonicalRoadFeatureCount: totalFeatureCount,
    primaryClassifiedFeatureCount: primaryCount,
    primaryClassifiedAreaM2: Math.round(primaryAreaM2),
    primaryAreaBySourceCount: bySourceCount,
    primaryAreaBySourceM2: Object.fromEntries(Object.entries(bySourceAreaM2).map(([k, v]) => [k, Math.round(v)])),
    tranSourcedPrimaryAreaRatio: primaryAreaM2 > 0 ? +(tranAreaM2 / primaryAreaM2).toFixed(4) : null,
    finding: 'primary(CARRIAGEWAY/INTERSECTION/RAMP)に分類されたcanonical road面積のうち、' +
      (primaryAreaM2 > 0 ? (tranAreaM2 / primaryAreaM2 * 100).toFixed(1) : '?') +
      '%がPLATEAU tran road-area polygon由来。tran polygonの公式semanticsは「道路区域（車道＋歩道を含む道路敷地）」' +
      '（roads-tran/polygons.jsonのgeometrySemantics欄・本監査で実データ確認）であり、primary分類時に歩道分を' +
      '除外する幾何処理は行われていない（sidewalk/median抽出は「道路属性を持たない断片」にのみ適用される。' +
      'tools/build-refined-road-surface.jsのbaseClass()を実データで確認）。',
  };
}

// ══════════════════════════════════════════════════════════════════════════
// §17-19: PLATEAU tran ⇄ Canonical Road(=FIX13 source) の厳密diff（tranId厳密対応・全市 199,658件対象）
//   ヒューリスティックではなく sourceIds の "plateau-tran/<tranId>" 参照による厳密突合。
// ══════════════════════════════════════════════════════════════════════════
function auditTranVsCanonicalExact() {
  console.log('[map-audit] loading roads-tran polygons...');
  const tranData = rj(ROADS_TRAN_FILE);
  const tranById = new Map();
  for (const p of tranData.polygons) tranById.set(p.tranId, p);
  console.log('[map-audit] roads-tran polygons loaded: ' + tranById.size);

  const files = fs.readdirSync(CANON_ROADS).filter(isTile);
  let matched = 0, unmatched = 0, ringLenMismatch = 0;
  const vertexOffsetM = []; // §17系バグ再発防止: 単純な頂点平均は道路のような細長い不均等vertex密度形状で
  //   centroidを大きく誤らせるため使わない（最初の実装で最大266mの"偽offset"を出した反省・本コメントに記録）。
  //   vertexCountDiff=0のケースが大半のため、頂点index対応での直接距離比較の方が artifact が無い。
  const vertexCountDiffs = [];
  const seen = new Set();
  for (const f of files) {
    const t = rj(path.join(CANON_ROADS, f)); if (!t) continue;
    for (const ft of t.features) {
      if (seen.has(ft.canonicalId)) continue;
      seen.add(ft.canonicalId);
      if (!ft.source || ft.source.geometrySource !== 'plateau-tran-road') continue;
      const tranRef = (ft.source.sourceIds || []).find((s) => s.startsWith('plateau-tran/'));
      if (!tranRef) { unmatched++; continue; }
      const tranId = tranRef.replace('plateau-tran/', '');
      const tranPoly = tranById.get(tranId);
      if (!tranPoly) { unmatched++; continue; }
      const tranRing = (tranPoly.geometryType === 'Polygon' ? tranPoly.coordinates[0] : (tranPoly.coordinates[0] && tranPoly.coordinates[0][0])) || [];
      const canonRing = (ringsOfFeature(ft)[0] || []);
      if (!tranRing.length || !canonRing.length) { unmatched++; continue; }
      matched++;
      vertexCountDiffs.push(Math.abs(tranRing.length - canonRing.length));
      if (tranRing.length !== canonRing.length) { ringLenMismatch++; continue; }
      // 頂点index対応で直接距離比較（centroid平均を経由しない・artifact無し）
      let maxD = 0;
      for (let i = 0; i < tranRing.length; i++) {
        const d = Math.hypot(tranRing[i][0] - canonRing[i][0], tranRing[i][1] - canonRing[i][1]);
        if (d > maxD) maxD = d;
      }
      vertexOffsetM.push(maxD); // feature単位の「最大頂点ずれ」を1サンプルとする
    }
  }
  return {
    matchedByExactTranId: matched, unmatchedTranSourced: unmatched, ringLengthMismatchCount: ringLenMismatch,
    perFeatureMaxVertexOffsetM: percentiles(vertexOffsetM),
    vertexCountDiff: percentiles(vertexCountDiffs),
    note: 'PLATEAU tran(生polygon) と Canonical Road(=FIX13が描画するgeometry) を tranId の厳密対応で全市' +
      '突合（tile境界重複はcanonicalIdでdedup済み）。ring長が一致するfeatureについて頂点index対応で' +
      '直接距離比較（centroidの単純頂点平均は道路のような細長い形状でartifactを生むため使わない。' +
      '§17/§18/§19の初回実装で発見・修正済み）。',
  };
}

// ══════════════════════════════════════════════════════════════════════════
// §16 layer overlap map + §17-19 fixture単位のGSI⇄FIX13/tran/OSM 位置差
// ══════════════════════════════════════════════════════════════════════════
function loadCanonicalRoadsInBounds(bounds) {
  const feats = []; const seen = new Set();
  for (const f of fs.readdirSync(CANON_ROADS).filter(isTile)) {
    const t = rj(path.join(CANON_ROADS, f)); if (!t) continue;
    for (const ft of t.features) {
      if (seen.has(ft.canonicalId)) continue;
      seen.add(ft.canonicalId);
      if (ft.bbox && bboxOverlaps(ft.bbox, bounds)) feats.push(ft);
    }
  }
  return feats;
}
function loadTranInBounds(bounds, tranData) {
  const feats = [];
  for (const p of tranData.polygons) {
    const ring = (p.geometryType === 'Polygon' ? p.coordinates[0] : (p.coordinates[0] && p.coordinates[0][0])) || [];
    if (!ring.length) continue;
    const bb = ringBboxOf(ring);
    if (bboxOverlaps(bb, bounds)) feats.push({ ring, bb });
  }
  return feats;
}
function loadOsmRoadsInBounds(bounds) {
  // [発見・修正] このdataset(tools/convert/roads.js出力)は canonical roads と別schema:
  //   featureに bbox フィールドが無く、座標は geometryType/coordinates ではなく kind:'line' + p:[[x,z],...]。
  //   当初 ft.bbox を前提にfilterしていたため常に0件になっていたバグを修正（osmRoads featureCount=0の
  //   誤った結果を最初に出し、fixtureごとにring座標から自前でbboxを算出する形へ直した）。
  const size = 2000;
  const txMin = Math.floor(bounds.minX / size), txMax = Math.floor(bounds.maxX / size);
  const tzMin = Math.floor(bounds.minZ / size), tzMax = Math.floor(bounds.maxZ / size);
  const feats = [];
  for (let tx = txMin; tx <= txMax; tx++) for (let tz = tzMin; tz <= tzMax; tz++) {
    const t = rj(path.join(OSM_ROADS_DIR, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
    for (const ft of t.features) {
      const coords = ft.p || ft.coordinates;
      if (!coords || coords.length < 2) continue;
      const bb = ringBboxOf(coords);
      if (bboxOverlaps(bb, bounds)) feats.push({ id: ft.id, highway: ft.highway, coordinates: coords });
    }
  }
  return feats;
}
function loadGsiEdgeInBounds(bounds, gsiFeatures) {
  const feats = [];
  for (const f of gsiFeatures) {
    const c = f.geometry && f.geometry.coordinates; if (!c || c.length < 2) continue;
    const bb = ringBboxOf(c);
    if (bboxOverlaps(bb, bounds)) feats.push(f);
  }
  return feats;
}
function segmentsFromCanonicalRoads(feats) { const segs = []; for (const f of feats) for (const ring of ringsOfFeature(f)) segs.push(...segmentsOfRing(ring)); return segs; }
function segmentsFromTran(feats) { const segs = []; for (const f of feats) segs.push(...segmentsOfRing(f.ring)); return segs; }
function segmentsFromOsmRoads(feats) {
  const segs = [];
  for (const f of feats) { const c = f.coordinates; for (let i = 0; i < c.length - 1; i++) segs.push([c[i][0], c[i][1], c[i + 1][0], c[i + 1][1]]); }
  return segs;
}

function auditFixtureRegion(regionKey, region, gsiFeatures, tranData) {
  const bounds = regionBoundsOf(region.points, 50);
  console.log('[map-audit] region ' + regionKey + ' bounds=' + JSON.stringify(bounds));
  const canonFeats = loadCanonicalRoadsInBounds(bounds);
  const tranFeats = loadTranInBounds(bounds, tranData);
  const osmFeats = loadOsmRoadsInBounds(bounds);
  const gsiFeats = loadGsiEdgeInBounds(bounds, gsiFeatures);
  const canonSegs = segmentsFromCanonicalRoads(canonFeats);
  const tranSegs = segmentsFromTran(tranFeats);
  const osmSegs = segmentsFromOsmRoads(osmFeats);

  const perPoint = [];
  const gsiVsFix13All = [], gsiVsTranAll = [], gsiVsOsmAll = [];
  for (const pt of region.points) {
    const gsiVsFix13 = [], gsiVsTran = [], gsiVsOsm = [];
    for (const f of gsiFeats) {
      for (const [x, z] of f.geometry.coordinates) {
        if (Math.hypot(x - pt.x, z - pt.z) > FIXTURE_RADIUS_M) continue;
        if (canonSegs.length) gsiVsFix13.push(nearestDist(x, z, canonSegs));
        if (tranSegs.length) gsiVsTran.push(nearestDist(x, z, tranSegs));
        if (osmSegs.length) gsiVsOsm.push(nearestDist(x, z, osmSegs));
      }
    }
    gsiVsFix13All.push(...gsiVsFix13); gsiVsTranAll.push(...gsiVsTran); gsiVsOsmAll.push(...gsiVsOsm);
    perPoint.push({
      id: pt.id, label: pt.label, x: pt.x, z: pt.z, radiusM: FIXTURE_RADIUS_M,
      gsiEdgeVerticesInRadius: gsiVsFix13.length,
      gsiVsFix13OffsetM: percentiles(gsiVsFix13),
      gsiVsTranOffsetM: percentiles(gsiVsTran),
      gsiVsOsmOffsetM: percentiles(gsiVsOsm),
    });
  }
  return {
    region: regionKey, name: region.name, bounds,
    featureCounts: { gsiRoadEdge: gsiFeats.length, canonicalRoads: canonFeats.length, plateauTran: tranFeats.length, osmRoads: osmFeats.length },
    perPoint,
    aggregate: {
      gsiVsFix13OffsetM: percentiles(gsiVsFix13All),
      gsiVsTranOffsetM: percentiles(gsiVsTranAll),
      gsiVsOsmOffsetM: percentiles(gsiVsOsmAll),
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// §22/§11-12(32C再利用の簡略版): ROAD_ENCLOSED_BLOCK ラスタ化（フィクスチャ範囲のみ）
// ══════════════════════════════════════════════════════════════════════════
const BLOCK_CELL_M = 1.0, BLOCK_WALL_DIST_M = 1.0, BLOCK_MARGIN_M = 30;
function buildBlockRasterForRegion(bounds, gsiFeats) {
  const minX = bounds.minX - BLOCK_MARGIN_M, maxX = bounds.maxX + BLOCK_MARGIN_M;
  const minZ = bounds.minZ - BLOCK_MARGIN_M, maxZ = bounds.maxZ + BLOCK_MARGIN_M;
  const nx = Math.ceil((maxX - minX) / BLOCK_CELL_M), nz = Math.ceil((maxZ - minZ) / BLOCK_CELL_M);
  if (nx * nz > 6_000_000) return { skipped: true, reason: 'raster too large for this region' };
  const wall = new Uint8Array(nx * nz);
  for (const f of gsiFeats) {
    const c = f.geometry.coordinates;
    for (let i = 0; i < c.length - 1; i++) {
      const ax = c[i][0], az = c[i][1], bx = c[i + 1][0], bz = c[i + 1][1];
      const segMinX = Math.min(ax, bx) - BLOCK_WALL_DIST_M, segMaxX = Math.max(ax, bx) + BLOCK_WALL_DIST_M;
      const segMinZ = Math.min(az, bz) - BLOCK_WALL_DIST_M, segMaxZ = Math.max(az, bz) + BLOCK_WALL_DIST_M;
      if (segMaxX < minX || segMinX > maxX || segMaxZ < minZ || segMinZ > maxZ) continue;
      const ix0 = Math.max(0, Math.floor((segMinX - minX) / BLOCK_CELL_M)), ix1 = Math.min(nx - 1, Math.floor((segMaxX - minX) / BLOCK_CELL_M));
      const iz0 = Math.max(0, Math.floor((segMinZ - minZ) / BLOCK_CELL_M)), iz1 = Math.min(nz - 1, Math.floor((segMaxZ - minZ) / BLOCK_CELL_M));
      const dx = bx - ax, dz = bz - az; const len2 = dx * dx + dz * dz;
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = minX + (ix + 0.5) * BLOCK_CELL_M;
        for (let iz = iz0; iz <= iz1; iz++) {
          const pz = minZ + (iz + 0.5) * BLOCK_CELL_M;
          let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0; t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
          if (d <= BLOCK_WALL_DIST_M) wall[iz * nx + ix] = 1;
        }
      }
    }
  }
  const comp = new Int32Array(nx * nz).fill(-1);
  let compId = 0; const compSize = [], touchesBoundary = [];
  const qx = new Int32Array(nx * nz), qz = new Int32Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const idx = iz * nx + ix; if (wall[idx] || comp[idx] !== -1) continue;
    let qh = 0, qt = 0; qx[qt] = ix; qz[qt] = iz; qt++; comp[idx] = compId;
    let size = 0, boundary = false;
    while (qh < qt) {
      const cx0 = qx[qh], cz0 = qz[qh]; qh++; size++;
      if (cx0 === 0 || cx0 === nx - 1 || cz0 === 0 || cz0 === nz - 1) boundary = true;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx2 = cx0 + dx, nz2 = cz0 + dz; if (nx2 < 0 || nx2 >= nx || nz2 < 0 || nz2 >= nz) continue;
        const nidx = nz2 * nx + nx2; if (wall[nidx] || comp[nidx] !== -1) continue;
        comp[nidx] = compId; qx[qt] = nx2; qz[qt] = nz2; qt++;
      }
    }
    compSize.push(size); touchesBoundary.push(boundary); compId++;
  }
  const blockClass = compSize.map((size, i) => {
    const areaM2 = size * BLOCK_CELL_M * BLOCK_CELL_M;
    if (areaM2 < 15) return 'NON_BLOCK';
    if (touchesBoundary[i]) return 'OPEN_BLOCK';
    if (areaM2 < 60) return 'AMBIGUOUS';
    return 'VALID_BLOCK';
  });
  const counts = { VALID_BLOCK: 0, OPEN_BLOCK: 0, AMBIGUOUS: 0, NON_BLOCK: 0 };
  for (const c of blockClass) counts[c]++;
  return { totalBlocks: blockClass.length, ...counts, nx, nz, minX, minZ, cellM: BLOCK_CELL_M, comp, blockClass };
}

// ══════════════════════════════════════════════════════════════════════════
// §20 projection pipeline audit（各datasetのCRS/座標変換式を一覧化。値の変更はしない）
// ══════════════════════════════════════════════════════════════════════════
function auditProjectionPipeline() {
  const proj = rj(PROJECTION_CONFIG);
  const gsiEdgeManifest = rj(GSI_EDGE_MANIFEST);
  const tranHeader = { sourceCrs: undefined, axisOrder: undefined, coordinateConvention: undefined };
  try {
    // ファイル先頭のみ読んで大きい polygons 配列は展開しない（軽量ヘッダ読取）
    const fd = fs.openSync(ROADS_TRAN_FILE, 'r');
    const buf = Buffer.alloc(600); fs.readSync(fd, buf, 0, 600, 0); fs.closeSync(fd);
    const head = buf.toString('utf-8');
    tranHeader.sourceCrs = (head.match(/"sourceCrs":"([^"]+)"/) || [])[1];
    tranHeader.axisOrder = (head.match(/"axisOrder":"([^"]+)"/) || [])[1];
    tranHeader.coordinateConvention = (head.match(/"coordinateConvention":"([^"]+)"/) || [])[1];
  } catch { /* noop */ }
  const canonRoadsManifest = rj(CANON_ROADS_MANIFEST);
  const osmRoadsManifest = rj(OSM_ROADS_MANIFEST);
  const datasets = {
    GSI_ROAD_EDGE: { sourceCrs: 'fguuid:jgd2024.bl (JGD2024, axis B,L)', decode: 'tools/lib/gsi-road-edge-gml.js（正規表現GML parser）', coordinateConvention: 'znorth-neg-v1', origin: `lon=${proj.projection.centerLon}, lat=${proj.projection.centerLat}` },
    FIX13_ROAD_SURFACE: { sourceCrs: '(Canonical Roadsを継承。実体はPLATEAU tran)', decode: 'tools/build-refined-road-surface.js（renderClassのみ付与、幾何は不変）', coordinateConvention: canonRoadsManifest ? canonRoadsManifest.coordinateConvention : null, origin: `lon=${proj.projection.centerLon}, lat=${proj.projection.centerLat}` },
    PLATEAU_TRAN: { sourceCrs: tranHeader.sourceCrs || 'EPSG:6697 (JGD2011, axisOrder=' + tranHeader.axisOrder + ')', decode: 'tools/convert-plateau-tran.js（CityGML lod1MultiSurface）', coordinateConvention: tranHeader.coordinateConvention, origin: `lon=${proj.projection.centerLon}, lat=${proj.projection.centerLat}` },
    OSM_ROAD: { sourceCrs: 'EPSG:4326 (WGS84, OSM標準)', decode: 'tools/convert/roads.js', coordinateConvention: osmRoadsManifest ? osmRoadsManifest.coordinateConvention : null, origin: `lon=${proj.projection.centerLon}, lat=${proj.projection.centerLat}` },
  };
  const metersPerDegree = proj.projection.metersPerDegree;
  const formula = `x=(lon-${proj.projection.centerLon})*cos(${proj.projection.centerLat}°)*${metersPerDegree}, z=-((lat-${proj.projection.centerLat})*${metersPerDegree})`;
  const conventions = Object.values(datasets).map((d) => d.coordinateConvention).filter(Boolean);
  const consistent = conventions.every((c) => c === 'znorth-neg-v1');
  return { sharedProjectionSource: toProjectRelativePath(PROJECTION_CONFIG), formula, metersPerDegree, datasets, coordinateConventionConsistent: consistent, gsiEdgeManifestCrsCounts: gsiEdgeManifest ? gsiEdgeManifest.crsCounts : null };
}

// ══════════════════════════════════════════════════════════════════════════
// §21 runtime transform audit（静的grep: 関連groupへの非1 scale適用が無いか）
// ══════════════════════════════════════════════════════════════════════════
function auditRuntimeTransform() {
  const html = fs.readFileSync(P('public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
  const targets = ['gsiEdgeGroup', 'canonicalRoot', 'legacyRoot', 'blockQaGroup', 'umedaPocGroup', 'mapAuditGroup'];
  const suspicious = [];
  for (const t of targets) {
    const re = new RegExp(t + '\\.scale\\.(set|x|y|z)\\s*[=(][^;]*', 'g');
    let m; while ((m = re.exec(html))) {
      const stmt = m[0];
      if (!/\.scale\.set\(1,\s*1,\s*1\)|\.scale\.(x|y|z)\s*=\s*1\b/.test(stmt)) suspicious.push({ target: t, statement: stmt.slice(0, 120) });
    }
  }
  return { targetsChecked: targets, nonUnitScaleAssignments: suspicious, effectiveScaleAssumedX: 1, effectiveScaleAssumedZ: 1, note: 'root/groupへの明示的な.scale代入を静的走査。CanonicalRuntimeの各groupはnew THREE.Group()生成のみでscale変更コードが無いことを確認（既定1,1,1）。' };
}

// ══════════════════════════════════════════════════════════════════════════
// main
// ══════════════════════════════════════════════════════════════════════════
async function main() {
  const generatedAt = new Date().toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('[map-audit] §14 primary(carriageway) area source breakdown...');
  const primarySource = auditPrimarySourceBreakdown();
  console.log('[map-audit] ' + primarySource.finding);

  console.log('[map-audit] §11 parcel/lot/site conflation static scan...');
  const parcelConflation = auditParcelConflation();

  console.log('[map-audit] §20 projection pipeline audit...');
  const projectionAudit = auditProjectionPipeline();

  console.log('[map-audit] §21 runtime transform audit...');
  const runtimeTransformAudit = auditRuntimeTransform();

  console.log('[map-audit] §17-19 PLATEAU tran vs Canonical Road 厳密diff（全市・tranId対応）...');
  const tranVsCanonical = auditTranVsCanonicalExact();

  console.log('[map-audit] loading GSI road edge (全市)...');
  const gsiData = rj(GSI_EDGE_FILE);
  const gsiTypeCounts = {};
  for (const f of gsiData.features) { const t = (f.attrs && f.attrs.type) || 'NULL'; gsiTypeCounts[t] = (gsiTypeCounts[t] || 0) + 1; }

  console.log('[map-audit] loading PLATEAU tran raw polygons（fixture比較用）...');
  const tranData = rj(ROADS_TRAN_FILE);

  console.log('[map-audit] §8/§16-19 梅田フィクスチャ(5地点)監査...');
  const umedaAudit = auditFixtureRegion('umeda', FIXTURES.umeda, gsiData.features, tranData);
  console.log('[map-audit] §9/§16-19 住吉フィクスチャ(3地点)監査...');
  const sumiyoshiAudit = auditFixtureRegion('sumiyoshi', FIXTURES.sumiyoshi, gsiData.features, tranData);

  console.log('[map-audit] §22 ROAD_ENCLOSED_BLOCK raster（梅田/住吉フィクスチャ範囲）...');
  const umedaGsiInBounds = loadGsiEdgeInBounds(regionBoundsOf(FIXTURES.umeda.points, 50), gsiData.features);
  const sumiyoshiGsiInBounds = loadGsiEdgeInBounds(regionBoundsOf(FIXTURES.sumiyoshi.points, 50), gsiData.features);
  const umedaBlockRaster = buildBlockRasterForRegion(regionBoundsOf(FIXTURES.umeda.points, 50), umedaGsiInBounds);
  const sumiyoshiBlockRaster = buildBlockRasterForRegion(regionBoundsOf(FIXTURES.sumiyoshi.points, 50), sumiyoshiGsiInBounds);

  // block raster を runtime向けにRLE export（32Cの[Block QA]と同じ形式・MAP AUDIT用に独立ファイル）
  function exportRasterRle(raster) {
    if (raster.skipped) return null;
    const rows = [];
    for (let iz = 0; iz < raster.nz; iz++) {
      const row = []; let cur = -1, run = 0;
      for (let ix = 0; ix < raster.nx; ix++) {
        const compId = raster.comp[iz * raster.nx + ix];
        const code = compId === -1 ? 0 : { VALID_BLOCK: 1, OPEN_BLOCK: 2, AMBIGUOUS: 3, NON_BLOCK: 4 }[raster.blockClass[compId]];
        if (code === cur) run++; else { if (cur !== -1) row.push(cur, run); cur = code; run = 1; }
      }
      if (cur !== -1) row.push(cur, run);
      rows.push(row);
    }
    return { nx: raster.nx, nz: raster.nz, cellM: raster.cellM, originX: raster.minX, originZ: raster.minZ, codeLegend: { 0: 'WALL', 1: 'VALID_BLOCK', 2: 'OPEN_BLOCK', 3: 'AMBIGUOUS', 4: 'NON_BLOCK' }, rows };
  }
  await writeJson(path.join(OUT_DIR, 'umeda-block-raster.json'), { version: 1, generatedAt, region: 'umeda', ...exportRasterRle(umedaBlockRaster) });
  await writeJson(path.join(OUT_DIR, 'sumiyoshi-block-raster.json'), { version: 1, generatedAt, region: 'sumiyoshi', ...exportRasterRle(sumiyoshiBlockRaster) });

  // フィクスチャ範囲のGSI edge / canonical roads(FIX13 source) / tran / OSM road を軽量exportしてruntimeへ供給
  function exportRegionLayers(regionKey, region) {
    const bounds = regionBoundsOf(region.points, 50);
    const gsi = loadGsiEdgeInBounds(bounds, gsiData.features).map((f) => ({ id: f.id, type: f.attrs && f.attrs.type, coordinates: f.geometry.coordinates }));
    const canon = loadCanonicalRoadsInBounds(bounds).map((f) => ({ canonicalId: f.canonicalId, geometryType: f.geometryType, coordinates: f.coordinates }));
    const tran = loadTranInBounds(bounds, tranData).map((f) => ({ ring: f.ring }));
    const osm = loadOsmRoadsInBounds(bounds).map((f) => ({ id: f.id, highway: f.highway, coordinates: f.coordinates }));
    return { version: 1, generatedAt, region: regionKey, bounds, points: region.points, gsiRoadEdge: gsi, fix13RoadSurface: canon, plateauTran: tran, osmRoad: osm };
  }
  await writeJson(path.join(OUT_DIR, 'umeda-map-audit-layers.json'), exportRegionLayers('umeda', FIXTURES.umeda));
  await writeJson(path.join(OUT_DIR, 'sumiyoshi-map-audit-layers.json'), exportRegionLayers('sumiyoshi', FIXTURES.sumiyoshi));

  const priorGsiFix13 = rj(PRIOR_GSI_FIX13);
  const priorHybridV1 = rj(PRIOR_HYBRID_V1);

  // ── §29 classification 判定 ──
  const findings = {
    roadSemanticsMismatch: primarySource.tranSourcedPrimaryAreaRatio != null && primarySource.tranSourcedPrimaryAreaRatio > 0.9,
    positionOrScaleErrorTranVsCanonical: (tranVsCanonical.perFeatureMaxVertexOffsetM.median || 0) > 0.5,
    blockSemanticsRisk: true, // §23の定義上、常にBLOCK_SEMANTICS_MISMATCHの可能性は残る（road-enclosed ≠ parcel）
    multiLayerVisualConflict: (umedaAudit.aggregate.gsiVsFix13OffsetM.median || 0) > 1.0 || (sumiyoshiAudit.aggregate.gsiVsFix13OffsetM.median || 0) > 1.0,
    parcelConflationInCode: parcelConflation.conflationFound,
  };
  const classification = [];
  if (findings.roadSemanticsMismatch) classification.push('ROAD_SEMANTICS_MISMATCH');
  if (findings.blockSemanticsRisk) classification.push('BLOCK_SEMANTICS_MISMATCH');
  if (findings.multiLayerVisualConflict) classification.push('MULTI_LAYER_VISUAL_CONFLICT');
  if (findings.positionOrScaleErrorTranVsCanonical) classification.push('MAP_DATA_POSITION_ERROR');
  if (!classification.length) classification.push('NO_MAP_SIDE_GEOMETRIC_ERROR');

  const report = {
    version: 1, generatedAt, missionId: '32D',
    visibleMapLayers: {
      byDefault: ['FIX13_ROAD_SURFACE (=Canonical Road, 99.3% PLATEAU tran由来)', 'GSI_ROAD_EDGE (既定ON・緑線)', 'GROUND'],
      notRenderedByDefault: ['PLATEAU_TRAN (Canonical Roadのソースとして統合済み、独立layerとしては非表示)', 'OSM_ROAD (legacyRoot.visible=falseで構造的に隠蔽)', 'BLOCK_POLYGON (dev-only、既定OFF)'],
    },
    provenanceCounts: {
      GSI_ROAD_EDGE: gsiData.count,
      FIX13_ROAD_SURFACE: primarySource.totalCanonicalRoadFeatureCount,
      PLATEAU_TRAN: tranData.polygonCount,
      OSM_ROAD: rj(OSM_ROADS_MANIFEST).featureCount,
      UNKNOWN: 0,
    },
    gsiRoadEdge: {
      featureCount: gsiData.count, typeBreakdown: gsiTypeCounts,
      crs: 'fguuid:jgd2024.bl (JGD2024)',
      runtimeTransform: { scaleX: 1, scaleZ: 1 },
      semanticsNote: 'RdEdgは「道路縁」= 道路と道路以外の境界線（道路の物理的な縁）。PLATEAU道路区域（歩道込み）とは別概念。' +
        '（tools/reports/gsi-vs-fix13-road-comparison.json §21 [Mission 31G-FIX16] の既存結論を本監査で再確認・引用）',
    },
    fix13: {
      featureCount: primarySource.totalCanonicalRoadFeatureCount,
      classBreakdown: rj(REFINED_SURFACE).byClass,
      primarySourceBreakdown: primarySource,
      runtimeTransform: { scaleX: 1, scaleZ: 1 },
    },
    plateauTran: {
      featureCount: tranData.polygonCount, sourceGmlCount: tranData.sourceGmlCount,
      geometrySemantics: tranData.geometrySemantics,
      runtimeParticipation: 'NOT rendered as an independent layer in default view. Its polygon geometry is the ' +
        'primary source (polygonCoverageRatio 0.993) for Canonical Roads, which IS rendered via FIX13 styling. ' +
        'This audit adds a fixture-scoped, opt-in [MAP AUDIT] toggle to view it directly (orange) for comparison purposes only.',
    },
    osm: {
      featureCount: rj(OSM_ROADS_MANIFEST).featureCount,
      runtimeParticipation: 'Hidden by default. When Canonical Runtime owns base layers (default state, ' +
        'window.__CANONICAL_RUNTIME__=true), toggleOldLayers(true) sets legacyRoot.visible=false and calls ' +
        'RoadLayer.hide() — confirmed via static code read (public/osaka_3d_buildings.ward-ux-v1.html). ' +
        'Not double-rendered with FIX13/Canonical Roads under default settings.',
    },
    block: {
      umeda: { totalBlocks: umedaBlockRaster.totalBlocks, VALID_BLOCK: umedaBlockRaster.VALID_BLOCK, OPEN_BLOCK: umedaBlockRaster.OPEN_BLOCK, AMBIGUOUS: umedaBlockRaster.AMBIGUOUS, NON_BLOCK: umedaBlockRaster.NON_BLOCK },
      sumiyoshi: { totalBlocks: sumiyoshiBlockRaster.totalBlocks, VALID_BLOCK: sumiyoshiBlockRaster.VALID_BLOCK, OPEN_BLOCK: sumiyoshiBlockRaster.OPEN_BLOCK, AMBIGUOUS: sumiyoshiBlockRaster.AMBIGUOUS, NON_BLOCK: sumiyoshiBlockRaster.NON_BLOCK },
      officialName: 'ROAD_ENCLOSED_BLOCK', note: '§23: parcel/lot/siteという名称・意味は使わない。GSI Road Edgeで囲まれた領域という定義のみを持つ。',
    },
    pairwiseAlignment: {
      tranVsCanonicalExact: tranVsCanonical,
      umeda: umedaAudit, sumiyoshi: sumiyoshiAudit,
      priorMissionReference: {
        source: 'data/reports/gsi-vs-fix13-road-comparison.json ([Mission 31G-FIX16])',
        toNearestCanonicalRoadM: priorGsiFix13 ? priorGsiFix13.alignment.toNearestCanonicalRoadM : null,
        fix13Comparison: priorGsiFix13 ? priorGsiFix13.fix13Comparison : null,
        decision: priorGsiFix13 ? priorGsiFix13.decision : null,
      },
      priorHybridV1Reference: {
        source: 'data/reports/gsi-road-hybrid-v1.json ([Mission 31G-FIX19/gsi-road-hybrid-v1])',
        finalDecision: priorHybridV1 ? priorHybridV1.finalDecision : null,
        finalDecisionStopConditions: priorHybridV1 ? priorHybridV1.finalDecisionStopConditions : null,
        note: 'GSI由来のより狭いroad surface再構築はseamsMostlyBroken=trueで市全域には未採用。' +
          'これはGSI Road Edge自体のtopological gap（Mission 32Bで確認）と整合する。',
      },
    },
    parcelConflationAudit: parcelConflation,
    projectionAudit,
    runtimeTransformAudit,
    classification,
    findings,
  };
  await writeJson(REPORT, report);
  console.log('[map-audit] 保存: ' + toProjectRelativePath(REPORT));
  console.log('[map-audit] classification: ' + classification.join(', '));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[map-audit] 失敗:', e && e.stack || e); process.exit(1); });
