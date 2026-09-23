#!/usr/bin/env node
// tools/build-city-layer-tiles.js
// P1-6: 大阪市24区 都市レイヤー（道路・河川・公園・鉄道）を共通タイルグリッドへ変換・タイル化する。
//
// 実行:
//   node tools/build-city-layer-tiles.js --layer roads --raw data/raw/osaka-city/roads-osm.json
//   node tools/build-city-layer-tiles.js --layer waterways --raw <path> --public
//   node tools/build-city-layer-tiles.js --layer all   (data/raw/osaka-city/<layer>-osm.json を4種すべて)
//
// - 座標変換は既存 tools/convert/{roads,parks,railways,waterways}.js を流用（geoToLocal=北z正）し、
//   本ツールで z を反転して znorth-neg-v1（北 = z 負、建物・HTML と同一）に揃える。
// - feature は bbox が重なる全タイルへ複製配置（クリップしない。load 時に id で dedup）。
// - 河川は tools/convert/waterways.js（assembleMultipolygon / stitchWays 済み）+ geometry-anomaly で検証。
// - 出力: data/processed/osaka-city/<layer>/{manifest.json, tiles/tile_<tx>_<tz>.json}
//         --public 指定時は public/map-data/osaka-city/<layer>/ へ flat 形式でもコピー。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadAreaConfig, writeJson } from './lib/area.js';
import { resolveProjectPath, toProjectRelativePath, PROJECT_ROOT, isMainModule } from './lib/paths.js';
import { createCityTileGrid, boundsOfPoints } from './lib/city-tile-grid.js';
import { analyzeRing } from './lib/geometry-anomaly.js';
import { buildWardIndex, featureWardOverlap } from './lib/feature-ward-overlap.js';
import { clipPolylineToWards, isUnclipped } from './lib/polyline-ward-clip.js';
import { convertRoadsWithReport } from './convert/roads.js';
import { convertParks } from './convert/parks.js';
import { convertRailways } from './convert/railways.js';
import { reclassifyRailNetwork } from './lib/rail-lod.js';
import { convertWaterwaysWithReport } from './convert/waterways.js';

const LAYERS = ['roads', 'parks', 'railways', 'waterways'];

function parseArgs(argv) {
  const a = { layer: null, raw: null, area: 'osaka-city', out: null, public: false, tileSize: null, report: true, force: false, wardFilter: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--layer') a.layer = argv[++i];
    else if (argv[i] === '--raw') a.raw = argv[++i];
    else if (argv[i] === '--area') a.area = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--public') a.public = true;
    else if (argv[i] === '--force') a.force = true;   // 出力先レイヤーの旧 tile を消してから書き直す
    else if (argv[i] === '--no-ward-filter') a.wardFilter = false;
    else if (argv[i] === '--tile-size') a.tileSize = parseInt(argv[++i], 10) || null;
  }
  return a;
}

/** [P1-6F] --force 時: レイヤーの旧 tile_*.json / manifest.json を消してから書く（stale tile を残さない）。 */
function clearLayerDir(root, layer) {
  for (const dir of [path.join(root, layer), path.join(root, layer, 'tiles')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/^tile_-?\d+_-?\d+\.json$/.test(f) || f === 'manifest.json') {
        try { fs.rmSync(path.join(dir, f)); } catch { /* noop */ }
      }
    }
  }
}

function readRawElements(rawPath) {
  const j = JSON.parse(fs.readFileSync(resolveProjectPath(rawPath), 'utf-8'));
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.elements)) return j.elements;
  throw new Error(`raw データが Overpass 応答（{elements:[...]}）でも配列でもありません: ${rawPath}`);
}

const negZ = (pts) => pts.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(-z * 100) / 100]);
const featureId = (layer, obj) => `${layer}_${crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 14)}`;

/**
 * layer 名 + 生 Overpass elements → znorth-neg-v1 の feature 配列（各 feature は id/geometry を持つ）。
 * @returns {{features:object[], meta:object}}
 */
function convertLayer(layer, rawElements, projection) {
  if (layer === 'roads') {
    // [Mission23] 生活道路・細街路まで。私有 driveway/parking_aisle/access=private は convert 側で除外。
    const { roads, skippedIneligible, skipReasons, sourceWays } = convertRoadsWithReport(rawElements, projection);
    const features = roads.map((r) => {
      const p = negZ(r.p);
      const f = { id: featureId('road', p), kind: 'line', highway: r.highway, p };
      if (r.name) f.name = r.name;
      if (r.width != null) f.width = r.width;
      if (r.lanes != null) f.lanes = r.lanes;
      // [Mission23] tier/detail/access/service/bridge/tunnel/oneway を保持（LOD/coverage/高架分類用）
      if (r.tier) f.tier = r.tier;
      if (r.detail) f.detail = r.detail;
      if (r.oneway) f.oneway = r.oneway;
      if (r.service) f.service = r.service;          // [Mission26] §4/§7 serviceType
      if (r.surface) f.surface = r.surface;          // [Mission26] §7
      if (r.tracktype) f.tracktype = r.tracktype;    // [Mission26] §6
      if (r.access) f.access = r.access;
      if (r.layer != null) f.layer = r.layer;        // [Mission26] §7
      if (r.ultraLocal) f.ultraLocal = true;         // [Mission26] §5/§11 alley / track
      if (r.bridge) f.bridge = true;
      if (r.tunnel) f.tunnel = true;
      if (r.underground) f.underground = true;
      if (r.source) f.source = { type: r.source.type, id: r.source.id, name: r.source.name || '' };
      return f;
    });
    return { features, meta: { sourceWays, skippedIneligible, skipReasons } };
  }
  if (layer === 'parks') {
    const parks = convertParks(rawElements, projection); // [{tag, name, p}]（+z, area）
    const features = parks.map((pk) => {
      const p = negZ(pk.p);
      return { id: featureId('park', p), kind: 'area', tag: pk.tag, name: pk.name || '', p };
    });
    return { features, meta: { sourceWays: rawElements.filter((e) => e.type === 'way' && e.tags && (e.tags.leisure === 'park' || e.tags.landuse)).length } };
  }
  if (layer === 'railways') {
    const { lines, stations } = convertRailways(rawElements, projection);
    const features = [];
    const railFeats = lines.map((l) => ({ railway: l.railway, name: l.name || '', p: negZ(l.p) }));
    // [Mission24] ネットワーク連結で major を救済（本線の橋・分岐断片が local→FAR で消える問題）
    const railClasses = reclassifyRailNetwork(railFeats);
    railFeats.forEach((rf, i) => {
      const f = { id: featureId('rail', rf.p), kind: 'line', railway: rf.railway, p: rf.p };
      if (rf.name) f.name = rf.name; // [Mission24] 路線名
      const rc = railClasses.get(i);
      if (rc && rc !== 'excluded') f.railClass = rc; // major / urban / local
      features.push(f);
    });
    for (const s of stations) {
      const p = [Math.round(s.p[0] * 100) / 100, Math.round(-s.p[1] * 100) / 100];
      features.push({ id: featureId('station', { n: s.name, p }), kind: 'station', name: s.name || '', p: [p] }); // p は [[x,z]] に統一（tile割当共通化）
    }
    return { features, meta: { lines: lines.length, stations: stations.length } };
  }
  if (layer === 'waterways') {
    const { items, unclosed } = convertWaterwaysWithReport(rawElements, projection);
    const features = [];
    let oversized = 0, selfInt = 0;
    for (const w of items) {
      const p = negZ(w.p);
      const holes = (w.holes || []).map(negZ);
      // geometry 異常チェック（面のみ）。壊れは黙って描画しない = feature に broken フラグを立てて除外集計。
      let broken = false;
      if (w.kind === 'area') {
        for (const ring of [p, ...holes]) {
          const ev = analyzeRing(ring, { oversizedAbs: 350, oversizedMedianMult: 15, oversizedBboxRatio: 0.33 });
          if (ev.oversizedSegments > 0) { broken = true; oversized++; }
          if (ev.selfIntersections > 0) { broken = true; selfInt++; }
        }
      }
      if (broken) continue;
      const f = { id: featureId('water', { p, holes, k: w.kind }), kind: w.kind, subtype: w.type, name: w.name || '', waterClass: w.waterClass || w.type, p };
      if (holes.length) f.holes = holes;
      // [Mission22] 河川ネットワーク用: 幅タグ / 地表判定 / waterway タグ種別を保持
      if (w.waterwayTag) f.waterwayTag = w.waterwayTag;
      if (w.surface === false) f.surface = false;
      if (w.width != null) f.width = w.width;
      if (w.intermittent) f.intermittent = true;
      if (w.source) {
        f.source = { type: w.source.type, id: w.source.id, name: w.source.name || '' };
        if (w.source.memberWayIds && w.source.memberWayIds.length) f.source.memberWayIds = w.source.memberWayIds;
      }
      features.push(f);
    }
    return { features, meta: { items: items.length, kept: features.length, unclosedRelations: unclosed.length, oversizedDropped: oversized, selfIntersectionDropped: selfInt, unclosed } };
  }
  throw new Error(`未知の layer: ${layer}`);
}

function featureBounds(f) {
  if (f.kind === 'station') return boundsOfPoints(f.p);
  const pts = [...f.p, ...(f.holes || []).flat()];
  return boundsOfPoints(pts);
}

function bboundsOf(f) {
  const b = featureBounds(f);
  return { ...b, diag: Number.isFinite(b.minX) ? Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) : 0 };
}

async function buildOne(layer, rawPath, areaConfig, grid, outRoot, publicRoot, wardIndex, opts = {}) {
  const rawElements = readRawElements(rawPath);
  const { features: allFeatures, meta } = convertLayer(layer, rawElements, areaConfig.projection);

  if (opts.force) {
    clearLayerDir(outRoot, layer);
    if (publicRoot) clearLayerDir(publicRoot, layer);
  }

  // [P1-6F] 24区の陸域ポリゴンと重ならない feature を除外する（24区 bbox 矩形の隅をかすめる
  //   尼崎側の巨大河川ポリゴン等が「左上へ数km伸びる楔形」として描画されていた）。
  let droppedOutsideWards = 0;
  const droppedSample = [];
  let features = allFeatures;
  let clippedLineCount = 0;
  if (wardIndex && wardIndex.length) {
    features = [];
    for (const f of allFeatures) {
      if (f.kind === 'line') {
        // [P1-7B] 折れ線（道路・鉄道・河川中心線）は bbox の keep/drop ではなく実クリップする。
        //   市境を跨ぐ長い道路・鉄道を「大阪市側部分だけ」残す（丸ごと残す/丸ごと消すのどちらもしない）。
        const runs = clipPolylineToWards(f.p, wardIndex, 150);
        if (!runs.length) {
          droppedOutsideWards++;
          if (droppedSample.length < 12) droppedSample.push({ id: f.id, name: f.name || '', source: f.source || null, points: f.p.length, wardFraction: 0 });
          continue;
        }
        if (isUnclipped(f.p, runs)) { features.push(f); continue; }
        clippedLineCount++;
        runs.forEach((run, i) => { features.push({ ...f, id: `${f.id}_c${i}`, p: run }); });
        continue;
      }
      const pts = f.kind === 'station' ? f.p : [...(f.p || []), ...((f.holes || []).flat())];
      const ov = featureWardOverlap(pts, wardIndex, { bufferM: 500, sample: 80 });
      let keep = ov.inCount >= 1;
      // 巨大な面フィーチャが24区にほんの少ししか掛かっていない場合は除外
      //   （尼崎側の猪名川河口デルタ rel/8445877 = 12% しか大阪市に無い 5.2km ポリゴン等）。
      if (keep && f.kind === 'area' && ov.fraction < 0.25 && bboundsOf(f).diag > 3500) keep = false;
      if (keep) { features.push(f); continue; }
      droppedOutsideWards++;
      if (droppedSample.length < 12) droppedSample.push({ id: f.id, name: f.name || '', source: f.source || null, points: pts.length, wardFraction: +ov.fraction.toFixed(2) });
    }
  }
  meta.droppedOutsideWards = droppedOutsideWards;
  meta.clippedLineFeatures = clippedLineCount; // [P1-7B] 市境で実クリップした line feature 数（分割元の件数）
  if (droppedSample.length) meta.droppedOutsideWardsSample = droppedSample;

  // タイル割当（bbox 重なる全タイルへ）
  const tileMap = new Map(); // "tx_tz" -> feature[]
  let assigned = 0, outOfGrid = 0;
  const layerBounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const f of features) {
    const fb = featureBounds(f);
    if (!Number.isFinite(fb.minX)) { outOfGrid++; continue; }
    if (fb.minX < layerBounds.minX) layerBounds.minX = fb.minX;
    if (fb.maxX > layerBounds.maxX) layerBounds.maxX = fb.maxX;
    if (fb.minZ < layerBounds.minZ) layerBounds.minZ = fb.minZ;
    if (fb.maxZ > layerBounds.maxZ) layerBounds.maxZ = fb.maxZ;
    const tids = grid.tilesForBounds(fb);
    if (!tids.length) { outOfGrid++; continue; }
    assigned++;
    for (const tid of tids) {
      if (!tileMap.has(tid)) tileMap.set(tid, []);
      tileMap.get(tid).push(f);
    }
  }

  const generatedAt = new Date().toISOString();
  const source = {
    layer, raw: toProjectRelativePath(resolveProjectPath(rawPath)),
    canonical: 'OpenStreetMap via Overpass API (ODbL 1.0)',
    convert: `tools/convert/${layer === 'waterways' ? 'waterways' : layer}.js + z反転(znorth-neg-v1)`,
    tileGrid: { tileSize: grid.tileSize, buffer: grid.buffer, cols: grid.cols, rows: grid.rows },
  };

  const tiles = [];
  const totalFeatureTileEntries = [...tileMap.values()].reduce((s, a) => s + a.length, 0);
  for (const [tid, arr] of [...tileMap.entries()].sort()) {
    const [tx, tz] = tid.split('_').map(Number);
    const rel = `tiles/tile_${tx}_${tz}.json`;
    tiles.push({ tx, tz, file: rel, count: arr.length });
    const payload = { tx, tz, tileSize: grid.tileSize, count: arr.length, features: arr };
    fs.mkdirSync(path.join(outRoot, layer, 'tiles'), { recursive: true });
    fs.writeFileSync(path.join(outRoot, layer, 'tiles', `tile_${tx}_${tz}.json`), JSON.stringify(payload));
    if (publicRoot) {
      fs.mkdirSync(path.join(publicRoot, layer), { recursive: true });
      fs.writeFileSync(path.join(publicRoot, layer, `tile_${tx}_${tz}.json`), JSON.stringify(payload));
    }
  }

  const manifest = {
    version: 1, layer, city: 'osaka-city',
    coordinateSystem: 'meters-local', coordinateConvention: 'znorth-neg-v1',
    tileSize: grid.tileSize, buffer: grid.buffer,
    grid: { originTx: grid.originTx, originTz: grid.originTz, cols: grid.cols, rows: grid.rows, tileCount: grid.tileCount },
    bboxLocal: grid.bboxLocal,
    featureCount: features.length, assignedFeatures: assigned, outOfGridFeatures: outOfGrid,
    tileCount: tiles.length, featureTileEntries: totalFeatureTileEntries,
    layerBounds: Number.isFinite(layerBounds.minX) ? layerBounds : null,
    layerMeta: meta,
    source, generatedAt, tiles,
  };
  fs.mkdirSync(path.join(outRoot, layer), { recursive: true });
  fs.writeFileSync(path.join(outRoot, layer, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (publicRoot) {
    fs.mkdirSync(path.join(publicRoot, layer), { recursive: true });
    fs.writeFileSync(path.join(publicRoot, layer, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  return manifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const areaConfig = await loadAreaConfig(args.area);
  const tileSize = args.tileSize || (areaConfig.tiling && areaConfig.tiling.tileSizeMeters) || 2000;
  const grid = createCityTileGrid({ bbox: areaConfig.bbox, projection: areaConfig.projection, tileSizeMeters: tileSize });

  const outRoot = resolveProjectPath(args.out || path.join('data', 'processed', 'osaka-city'));
  const publicRoot = args.public ? path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city') : null;

  // [P1-6F] 24区の陸域ポリゴン（feature の 24区外除外に使う）
  let wardIndex = null;
  if (args.wardFilter) {
    const wpPath = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
    if (fs.existsSync(wpPath)) {
      try { wardIndex = buildWardIndex(JSON.parse(fs.readFileSync(wpPath, 'utf-8').replace(/^﻿/, ''))); }
      catch (e) { console.warn('  [warn] ward-classification-polygons.json 読込失敗、24区外フィルタ無効:', e.message); }
    } else {
      console.warn('  [warn] ward-classification-polygons.json が無いため 24区外フィルタ無効');
    }
  }

  const layers = args.layer === 'all' || !args.layer ? LAYERS : [args.layer];
  const results = {};
  console.log('=== 都市レイヤー tile 生成（大阪市24区）===');
  console.log(`tile grid: ${grid.tileSize}m / ${grid.cols}×${grid.rows} = ${grid.tileCount} tiles / buffer ${grid.buffer}m / znorth-neg-v1`);
  console.log(`24区外フィルタ: ${wardIndex ? `有効（区ポリゴン ${wardIndex.length}）` : '無効'}` + (args.force ? ' / --force（旧 tile を削除して再生成）' : ''));
  for (const layer of layers) {
    const rawPath = args.raw || path.join('data', 'raw', 'osaka-city', `${layer}-osm.json`);
    if (!fs.existsSync(resolveProjectPath(rawPath))) {
      console.log(`  [SKIP] ${layer}: raw が無い (${rawPath})。tools/download/city-tiles.js で取得してください。`);
      results[layer] = { skipped: true, rawPath };
      continue;
    }
    const m = await buildOne(layer, rawPath, areaConfig, grid, outRoot, publicRoot, wardIndex, { force: args.force });
    results[layer] = m;
    const lm = m.layerMeta || {};
    console.log(`  [OK] ${layer}: feature ${m.featureCount} / tile ${m.tileCount} / entries ${m.featureTileEntries}` +
      ` / 24区外除外 ${lm.droppedOutsideWards || 0}` +
      (layer === 'waterways' ? ` / unclosed ${lm.unclosedRelations} / 巨大seg除外 ${lm.oversizedDropped} / 自己交差除外 ${lm.selfIntersectionDropped}` : '') +
      (layer === 'railways' ? ` / line ${lm.lines} station ${lm.stations}` : ''));
  }

  const reportPath = resolveProjectPath(path.join('data', 'reports', 'city-layer-tiles-generation.json'));
  await writeJson(reportPath, {
    generatedAt: new Date().toISOString(), area: args.area,
    tileGrid: { tileSize: grid.tileSize, cols: grid.cols, rows: grid.rows, tileCount: grid.tileCount, buffer: grid.buffer, bboxLocal: grid.bboxLocal, fullLatLonBbox: grid.fullLatLonBbox() },
    layers: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.skipped ? v : {
      featureCount: v.featureCount, tileCount: v.tileCount, featureTileEntries: v.featureTileEntries,
      layerBounds: v.layerBounds, layerMeta: v.layerMeta,
    }])),
  });
  console.log(`\nレポート: ${toProjectRelativePath(reportPath)}`);
  console.log(`出力: ${toProjectRelativePath(outRoot)}/{${layers.join(',')}}` + (publicRoot ? ` + public/map-data/osaka-city/` : ''));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error('都市レイヤー生成でエラー:', e.message, e.stack); process.exit(1); });
}

export { convertLayer, buildOne };
