#!/usr/bin/env node
// tools/build-osm-building-fallback.js
// [Mission21B] PLATEAU 建物コーパスの欠落領域だけを OSM building footprint で補完し、
//   建物 dataset "osaka-osm-fallback" を生成して root manifest へ追記する。
// ══════════════════════════════════════════════════════════════════════════════════
// ネットワーク不要（data/raw/osm/osaka-latest.osm.pbf をローカル読み）。
//
// 実装順（§18）で raw/classification/tile/runtime/gap 監査を経て
//   「raw PLATEAU 欠落が主因」と確定した場合のみ実行する。
//
// 出力:
//   public/map-data/osaka-city/buildings/osaka-osm-fallback/manifest.json + tile_{tx}_{tz}.json
//   public/map-data/osaka-city/buildings/manifest.json（datasets へ追記）
//   data/reports/osm-building-fallback.json
//
// 実行: node tools/build-osm-building-fallback.js [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { pbfPrimitiveStream } from './lib/osm-pbf-stream.js';
import { flattenWardPolygons, pointInRing } from './lib/water-surface.js';
import {
  buildPlateauPresenceGrid, isInPlateauHole, toFallbackRecord, ringArea, ringBbox, ringCentroid,
  buildFootprintDensityGrid, isSparseMismatch, buildPlateauDedupIndex, isDuplicateOfPlateau,
  isFallbackEligibleBuilding, isValidFootprint,
  SPARSE_AREA_RATIO, SPARSE_MIN_OSM_COUNT,
} from './lib/osm-building-fallback.js';

const PBF = resolveProjectPath(path.join('data', 'raw', 'osm', 'osaka-latest.osm.pbf'));
const BUILD_DIR = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'buildings'));
const WARDS = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
const AREA = resolveProjectPath(path.join('config', 'areas', 'osaka-city.json'));
const OUT_DS = path.join(BUILD_DIR, 'osaka-osm-fallback');
const ROOT_MANIFEST = path.join(BUILD_DIR, 'manifest.json');
const REPORT = resolveProjectPath(path.join('data', 'reports', 'osm-building-fallback.json'));

const TILE_SIZE = 500;
const CELL_M = 50;           // PLATEAU presence grid 解像度
const MIN_FP_AREA_M2 = 8;    // これ未満は誤 footprint
const MAX_FP_AREA_M2 = 60000; // これ超は面/敷地ポリゴンの誤り

function loadWards() {
  const raw = JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards || [];
  return flattenWardPolygons(raw).map((w) => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, z] of w.outer) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
    return { ...w, _bb: { a, b, c, d } };
  });
}
function wardAt(x, z, wards) {
  for (const w of wards) {
    const bb = w._bb;
    if (x < bb.a || x > bb.b || z < bb.c || z > bb.d) continue;
    if (!pointInRing(x, z, w.outer)) continue;
    let hole = false;
    for (const h of (w.holes || [])) if (pointInRing(x, z, h)) { hole = true; break; }
    if (!hole) return w.wardId;
  }
  return null;
}

function loadPlateauFootprints() {
  const fps = [];
  let count = 0;
  for (const ds of fs.readdirSync(BUILD_DIR)) {
    const p = path.join(BUILD_DIR, ds);
    if (!fs.statSync(p).isDirectory() || ds === 'unclassified' || ds === 'osaka-osm-fallback') continue;
    for (const f of fs.readdirSync(p)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      const t = JSON.parse(fs.readFileSync(path.join(p, f), 'utf-8'));
      for (const b of (t.buildings || [])) { if (Array.isArray(b.fp) && b.fp.length >= 3) { fps.push(b.fp); count++; } }
    }
  }
  return { fps, count };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!fs.existsSync(PBF)) { console.error('[stop] PBF なし: ' + toProjectRelativePath(PBF)); process.exit(1); }
  const area = JSON.parse(fs.readFileSync(AREA, 'utf-8'));
  const { centerLat: CLAT, centerLon: CLON, metersPerDegree: MPD } = area.projection;
  const cosf = Math.cos(CLAT * Math.PI / 180);
  const toXZ = (lat, lon) => [(lon - CLON) * cosf * MPD, -((lat - CLAT) * MPD)];

  const wards = loadWards();
  console.log('[osm-fallback] PLATEAU footprint 読み込み中…');
  const { fps: plateauFps, count: plateauCount } = loadPlateauFootprints();
  const presence = buildPlateauPresenceGrid(plateauFps, CELL_M);
  const platDensity100 = buildFootprintDensityGrid(plateauFps, 100); // sparse-mismatch 判定用
  const platDedup = buildPlateauDedupIndex(plateauFps, 40);          // polygon レベル duplicate 判定用
  console.log('[osm-fallback] PLATEAU ' + plateauCount + ' 棟 / 占有 ' + CELL_M + 'm cell ' + presence.size + ' / 100m density cell ' + platDensity100.size);

  // ── pass1: building way の refs + tags ──
  const bways = new Map();
  for await (const p of pbfPrimitiveStream(PBF)) {
    if (p.type !== 'way') continue;
    const t = p.tags || {};
    // [Mission29 §2] roof / construction / ruins / proposed / demolished 等は fallback 対象外。
    if (!isFallbackEligibleBuilding(t.building)) continue;
    bways.set(p.id, { refs: p.refs, tags: { building: t.building, height: t.height, 'building:levels': t['building:levels'], name: t.name } });
  }
  console.log('[osm-fallback] building way ' + bways.size);

  // ── pass2: node coords ──
  const need = new Set();
  for (const v of bways.values()) for (const r of v.refs) need.add(r);
  const coord = new Map();
  for await (const p of pbfPrimitiveStream(PBF)) {
    if (p.type !== 'node') continue;
    if (need.has(p.id) && Number.isFinite(p.lat) && Number.isFinite(p.lon)) coord.set(p.id, [p.lat, p.lon]);
  }
  console.log('[osm-fallback] node 解決 ' + coord.size + '/' + need.size);

  // ── loop 1: 全 building way の footprint を組み立て、in-city のものを軽量 index 化 + OSM 密度 grid ──
  const stats = { buildingWays: bways.size, withGeom: 0, inCity: 0, outCity: 0, inPlateauHole: 0, sparseMismatch: 0, dupRejected: 0, badFootprint: 0, tooSmall: 0, tooBig: 0, selfIntersect: 0, emitted: 0 };
  const inCity = []; // { wid, ring, cx0, cz0, ward, tags, cx100, cz100, area }
  const osmGrid100 = {};            // "cx,cz" @ 100m -> in-city OSM building count
  const osmDensity100 = new Map();  // "cx,cz" @ 100m -> {count, area}
  for (const [wid, v] of bways) {
    const ring = [];
    for (const r of v.refs) { const ll = coord.get(r); if (ll) ring.push(toXZ(ll[0], ll[1])); }
    if (ring.length < 4) { stats.badFootprint++; continue; }
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    if (ring.length < 3) { stats.badFootprint++; continue; }
    stats.withGeom++;
    // [Mission29 §9] footprint 品質: 頂点数・面積・非有限・自己交差を除外
    const vf = isValidFootprint(ring, { minArea: MIN_FP_AREA_M2, maxArea: MAX_FP_AREA_M2 });
    if (!vf.ok) {
      if (vf.reason === 'too-small') stats.tooSmall++;
      else if (vf.reason === 'too-big') stats.tooBig++;
      else if (vf.reason === 'self-intersect') stats.selfIntersect++;
      else stats.badFootprint++;
      continue;
    }
    const a = vf.area;
    const cen = ringCentroid(ring);
    const cx0 = cen[0], cz0 = cen[1];
    const ward = wardAt(cx0, cz0, wards);
    if (!ward) { stats.outCity++; continue; }
    stats.inCity++;
    const cx100 = Math.floor(cx0 / 100), cz100 = Math.floor(cz0 / 100);
    const gk = cx100 + ',' + cz100;
    osmGrid100[gk] = (osmGrid100[gk] || 0) + 1;
    const od = osmDensity100.get(gk) || { count: 0, area: 0 };
    od.count++; od.area += a; osmDensity100.set(gk, od);
    inCity.push({ wid, ring, cx0, cz0, ward, tags: v.tags, gk });
  }
  console.log('[osm-fallback] in-city OSM building ' + inCity.length);

  // ── sparse-mismatch な 100m cell を確定 ──
  const sparseCells = new Set();
  for (const [gk, od] of osmDensity100) {
    if (isSparseMismatch(platDensity100.get(gk), od)) sparseCells.add(gk);
  }
  console.log('[osm-fallback] sparse-mismatch cell (OSM面積 >= ' + SPARSE_AREA_RATIO + '× PLATEAU かつ OSM棟 >= ' + SPARSE_MIN_OSM_COUNT + '): ' + sparseCells.size);

  // ── loop 2: 採用判定（hole または sparse-mismatch）+ polygon レベル duplicate 排除 ──
  const byWard = {}, byHeightSource = { 'osm-height': 0, 'osm-levels': 0, 'class-default': 0, 'generic-default': 0 };
  const byReason = { hole: 0, 'sparse-mismatch': 0 };
  const byUsage = {}; const confBuckets = { 'high(>=0.8)': 0, 'mid(0.5-0.8)': 0, 'low(<0.5)': 0 }; let confSum = 0;
  // [fallback建物の色/範囲] 用途カテゴリ内訳・null usage 件数・区所属の健全性。
  const byCategory = {};
  let nullUsageCount = 0;          // usage(raw OSM タグ)が無い（generic 'yes'）件数
  let missingWardId = 0;           // wardId が付かなかった件数（本来 0。centroid-in-ward を必須にしているため）
  let straddleWardId = 0;          // footprint 頂点が centroid と別の区にまたがる件数（centroid 基準で所属確定）
  const tilesMap = new Map();
  const seen = new Set();
  for (const rec0 of inCity) {
    const { wid, ring, cx0, cz0, ward, tags, gk } = rec0;
    const inHole = isInPlateauHole(cx0, cz0, presence, CELL_M);
    const inSparse = sparseCells.has(gk);
    if (!inHole && !inSparse) continue;
    // duplicate 排除（centroid-in-polygon / bbox IoU。近接距離では判定しない）
    //   build 側は validator（IoU 0.30）より厳しめ（0.22）に取り、境界ケースを確実に除外する。
    if (isDuplicateOfPlateau(ring, platDedup, 0.22)) { stats.dupRejected++; continue; }
    if (seen.has(wid)) continue;
    seen.add(wid);
    const reason = inHole ? 'hole' : 'sparse-mismatch';
    if (inHole) stats.inPlateauHole++; else stats.sparseMismatch++;
    byReason[reason]++;
    // [fallback範囲] §4 区所属ルール: footprint centroid が入る区に所属（centroid ベースで統一）。
    //   centroid が確実に区内なので ward は非 null。footprint が隣区へまたぐ場合も centroid の区で確定。
    const rec = toFallbackRecord(wid, ring.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]), tags, reason, ward);
    if (!rec.wardId) missingWardId++;
    else if (ring.some(([x, z]) => { const w2 = wardAt(x, z, wards); return w2 && w2 !== ward; })) straddleWardId++;
    byWard[ward] = (byWard[ward] || 0) + 1;
    byCategory[rec.usageCategory] = (byCategory[rec.usageCategory] || 0) + 1;
    if (!rec.usage) nullUsageCount++;
    byHeightSource[rec.heightSource] = (byHeightSource[rec.heightSource] || 0) + 1;
    byUsage[rec.usage || 'yes'] = (byUsage[rec.usage || 'yes'] || 0) + 1;
    confSum += rec.confidence;
    if (rec.confidence >= 0.8) confBuckets['high(>=0.8)']++; else if (rec.confidence >= 0.5) confBuckets['mid(0.5-0.8)']++; else confBuckets['low(<0.5)']++;
    const tx = Math.floor(rec.repX / TILE_SIZE), tz = Math.floor(rec.repZ / TILE_SIZE);
    const tk = tx + '_' + tz;
    if (!tilesMap.has(tk)) tilesMap.set(tk, []);
    tilesMap.get(tk).push(rec);
    stats.emitted++;
  }

  // bounds
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const arr of tilesMap.values()) for (const r of arr) {
    for (const [x, z] of r.fp) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
  }
  const tiles = [...tilesMap.entries()].sort().map(([k, arr]) => {
    const [tx, tz] = k.split('_').map(Number);
    return { tx, tz, file: `tile_${tx}_${tz}.json`, count: arr.length };
  });
  const generatedAt = new Date().toISOString();
  const dsManifest = {
    version: 1, id: 'osaka-osm-fallback', wardId: null, ward: 'OSM補完（PLATEAU欠落領域のみ）',
    coordinateSystem: 'meters-local', coordinateConvention: 'znorth-neg-v1', tileSize: TILE_SIZE, lod: 1, layout: 'flat',
    totalBuildings: stats.emitted, tileCount: tiles.length,
    bounds: Number.isFinite(minX) ? { minX, maxX, minZ, maxZ } : { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    invalidSkipped: 0, duplicateSkipped: stats.dupRejected,
    source: {
      buildings: 'data/raw/osm/osaka-latest.osm.pbf (building=* ways, ODbL 1.0)',
      method: '(hole) PLATEAU footprint が ' + CELL_M + 'm cell + 8近傍まで無い / (sparse-mismatch) OSM footprint 面積 >= ' + SPARSE_AREA_RATIO + '× PLATEAU かつ OSM棟 >= ' + SPARSE_MIN_OSM_COUNT + '。duplicate は centroid-in-polygon / bbox IoU>=0.3 で排除（近接距離では判定しない）。height は OSM height → building:levels×3.2 → heightUnknown（表示用 renderHeight=6m と分離）。',
      wardPolygons: toProjectRelativePath(WARDS),
    },
    reasonCounts: byReason,
    heightSourceCounts: byHeightSource,
    byWard, byCategory,
    usageNormalization: { nullRawUsage: nullUsageCount, emitted: stats.emitted, allRecordsHaveCategory: true, allRecordsHaveLabel: true },
    wardScope: { rule: 'centroid-in-ward', missingWardId, straddleWardId, wardsWithFallback: Object.keys(byWard).length },
    generatedAt, tiles,
  };

  console.log('[osm-fallback] stats: ' + JSON.stringify(stats));
  console.log('[osm-fallback] reason: ' + JSON.stringify(byReason));
  console.log('[osm-fallback] heightSource: ' + JSON.stringify(byHeightSource));
  console.log('[osm-fallback] confidence mean=' + (stats.emitted ? (confSum / stats.emitted).toFixed(3) : 0) + ' buckets=' + JSON.stringify(confBuckets));
  console.log('[osm-fallback] byUsage(top): ' + Object.entries(byUsage).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([u, n]) => u + ':' + n).join(' '));
  console.log('[osm-fallback] byCategory: ' + JSON.stringify(byCategory) + '  nullRawUsage=' + nullUsageCount + ' (category/label は全件付与)');
  console.log('[osm-fallback] wardScope: rule=centroid-in-ward missingWardId=' + missingWardId + ' straddleWardId=' + straddleWardId);
  console.log('[osm-fallback] byWard: ' + JSON.stringify(byWard));

  const report = {
    generatedAt, pbf: toProjectRelativePath(PBF),
    plateauFootprints: plateauCount, presenceCells: presence.size, cellM: CELL_M,
    sparseMismatch: { areaRatio: SPARSE_AREA_RATIO, minOsmCount: SPARSE_MIN_OSM_COUNT, cells: sparseCells.size },
    stats, byWard, reasonCounts: byReason, heightSourceCounts: byHeightSource,
    byUsage, // [Mission29 §2]
    byCategory, // [fallback建物の色] 描画カテゴリ内訳
    usageNormalization: { nullRawUsage: nullUsageCount, emitted: stats.emitted }, // raw OSM usage 無し（generic）件数。category/label は全件付与
    wardScope: { rule: 'centroid-in-ward', missingWardId, straddleWardId }, // [fallback範囲] §4 区所属
    confidence: { mean: stats.emitted ? +(confSum / stats.emitted).toFixed(3) : 0, buckets: confBuckets }, // [Mission29 §11]
    footprintQuality: { selfIntersect: stats.selfIntersect, tooSmall: stats.tooSmall, tooBig: stats.tooBig, badFootprint: stats.badFootprint }, // [Mission29 §9]
    duplicatesRejected: stats.dupRejected,
    tileCount: tiles.length, bounds: dsManifest.bounds,
    RESULT: stats.emitted > 0 ? 'PASS' : 'EMPTY',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  // audit / reconciliation 用: 100m cell ごとの PLATEAU / OSM / fallback の {count, area}
  const fbGrid = {};
  for (const arr of tilesMap.values()) for (const r of arr) {
    const k = Math.floor(r.repX / 100) + ',' + Math.floor(r.repZ / 100);
    const e = fbGrid[k] || { count: 0, area: 0 };
    e.count++; e.area += ringArea(r.fp);
    fbGrid[k] = e;
  }
  const platGridObj = {}; for (const [k, v] of platDensity100) platGridObj[k] = { count: v.count, area: Math.round(v.area) };
  const osmGridObj = {}; for (const [k, v] of osmDensity100) osmGridObj[k] = { count: v.count, area: Math.round(v.area) };
  for (const k of Object.keys(fbGrid)) fbGrid[k].area = Math.round(fbGrid[k].area);
  // 100m cell が実際に PLATEAU footprint で覆われているか（50m presence grid の 4 sub-cell のうち >=2）。
  //   centroid-keyed の platGridObj は巨大 footprint を隣 cell に付けてしまうため、この bbox ベース判定を併記。
  const platCoveredCells = {};
  for (const key of presence) {
    const [scx, scz] = key.split(',').map(Number);
    const k100 = Math.floor(scx * CELL_M / 100) + ',' + Math.floor(scz * CELL_M / 100);
    platCoveredCells[k100] = (platCoveredCells[k100] || 0) + 1;
  }
  fs.writeFileSync(resolveProjectPath(path.join('data', 'reports', 'osm-building-incity-grid.json')),
    JSON.stringify({ cellM: 100, generatedAt, counts: osmGrid100, plateau: platGridObj, osm: osmGridObj, fallback: fbGrid, sparseCells: [...sparseCells], plateauSubCells: platCoveredCells }));

  if (dryRun) { console.log('[osm-fallback] --dry-run: 書き込みなし'); return; }

  // tiles + manifest
  fs.mkdirSync(OUT_DS, { recursive: true });
  // [Mission29] 旧 run の tile を残さない（採用条件変更で消えた tile の stale 建物を防ぐ）。
  for (const f of fs.readdirSync(OUT_DS)) if (/^tile_.*\.json$/.test(f)) fs.unlinkSync(path.join(OUT_DS, f));
  for (const [k, arr] of tilesMap) {
    const [tx, tz] = k.split('_').map(Number);
    fs.writeFileSync(path.join(OUT_DS, `tile_${tx}_${tz}.json`), JSON.stringify({ tx, tz, tileSize: TILE_SIZE, lod: 1, count: arr.length, buildings: arr }));
  }
  fs.writeFileSync(path.join(OUT_DS, 'manifest.json'), JSON.stringify(dsManifest, null, 2));

  // root manifest へ追記（既存 datasets は不変。fallback を 1 件足す）
  const root = JSON.parse(fs.readFileSync(ROOT_MANIFEST, 'utf-8'));
  root.datasets = root.datasets.filter((d) => d.id !== 'osaka-osm-fallback');
  root.datasets.push({
    id: 'osaka-osm-fallback', wardId: null, ward: 'OSM補完（PLATEAU欠落領域のみ）', wardCode: null,
    manifest: './osaka-osm-fallback/manifest.json', buildings: stats.emitted, tiles: tiles.length,
    bounds: dsManifest.bounds, polygonCount: 0, holeCount: 0, dataReadyCandidate: stats.emitted > 0,
    kind: 'osm-fallback',
  });
  root.osmFallback = {
    manifest: './osaka-osm-fallback/manifest.json', buildings: stats.emitted, tiles: tiles.length,
    heightUnknown: byHeightSource['class-default'] + byHeightSource['generic-default'],
    heightSourceCounts: byHeightSource,
    confidenceMean: stats.emitted ? +(confSum / stats.emitted).toFixed(3) : 0,
    reasonCounts: byReason, duplicatesRejected: stats.dupRejected,
    footprintRejected: { selfIntersect: stats.selfIntersect, tooSmall: stats.tooSmall, tooBig: stats.tooBig },
    byWard, byCategory, // [fallback建物の色/範囲] 区別・カテゴリ別内訳
    usageNormalization: { nullRawUsage: nullUsageCount }, // category / label は全件非 null
    wardScope: { rule: 'centroid-in-ward', missingWardId, straddleWardId },
  };
  fs.writeFileSync(ROOT_MANIFEST, JSON.stringify(root, null, 2));

  console.log('[osm-fallback] 書込: ' + toProjectRelativePath(OUT_DS) + '  tiles ' + tiles.length + ' / 建物 ' + stats.emitted);
  console.log('[osm-fallback] root manifest へ osaka-osm-fallback を追記');
  console.log('保存:', toProjectRelativePath(REPORT), '  RESULT:', report.RESULT);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[osm-fallback] 失敗:', e && e.stack || e); process.exit(1); });
