#!/usr/bin/env node
// tools/build-ward-building-datasets.js
// P1-4: N03 Ward polygon で全建物を24区へ分類し、区ごとの建物 dataset / tile を生成する。
//
// 実行:
//   node tools/build-ward-building-datasets.js
//   node tools/build-ward-building-datasets.js --buildings temp/ward-poc-all-buildings.jsonl \
//     --ward-polygons data/processed/osaka-city/boundaries/ward-classification-polygons.json \
//     --out data/processed/osaka-city/buildings --tile-size 500 [--force] [--dry-run]
//
// 方針（P1-4指令）:
//  - authoritative source は N03 point-in-polygon。building.ward は一切使わない（診断のみ）。
//  - unclassified（区外・ambiguous・不正フットプリント）は最近傍区へ割り当てず隔離し、原因別統計を出す。
//  - 既存3区の dataset/tile 形式（manifest フィールド・tile JSON 形状・tile_<tx>_<tz>.json 命名）に合わせる。
//  - registry の production 切替はしない。成功した区を dataReady 候補として報告するのみ。
//
// 出力先の安全ガード: data/processed/ または temp/ 配下のみ許可。

import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { writeJson } from './lib/area.js';
import { PROJECT_ROOT, resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { classifyPointToWard, nearestWardDistance } from './lib/point-in-polygon.js';
import { representativePoint } from './lib/building-representative-point.js';

function parseArgs(argv) {
  const a = { buildings: null, wardPolygons: null, out: null, tileSize: 500, force: false, dryRun: false, layout: 'nested' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--buildings') a.buildings = argv[++i];
    else if (argv[i] === '--ward-polygons') a.wardPolygons = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--tile-size') a.tileSize = parseInt(argv[++i], 10) || 500;
    else if (argv[i] === '--layout') a.layout = argv[++i]; // nested (<wardId>/tiles/) | flat (<datasetId>/tile_x_z.json)
    else if (argv[i] === '--force') a.force = true;
    else if (argv[i] === '--dry-run') a.dryRun = true;
  }
  return a;
}

function loadRegistry() {
  return JSON.parse(fs.readFileSync(resolveProjectPath(path.join('config', 'wards', 'registry.json')), 'utf-8').replace(/^﻿/, ''));
}

function assertSafeOut(outAbs) {
  const allowed = [
    path.join(PROJECT_ROOT, 'data', 'processed'),
    path.join(PROJECT_ROOT, 'temp'),
    path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'buildings'),
  ];
  const deny = [
    path.join(PROJECT_ROOT, 'public', 'data', 'buildings'),
    path.join(PROJECT_ROOT, 'public', 'data', 'overlays'),
    path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.html'),
  ];
  const inside = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  for (const d of deny) if (inside(d, outAbs) || inside(outAbs, d)) throw new Error(`出力先が保護領域と重なる: ${d}`);
  if (!allowed.some((r) => inside(r, outAbs))) throw new Error(`出力先は data/processed/ または temp/ 配下のみ許可: ${outAbs}`);
}

function fpBounds(fp, acc) {
  for (const [x, z] of fp) {
    if (x < acc.minX) acc.minX = x;
    if (x > acc.maxX) acc.maxX = x;
    if (z < acc.minZ) acc.minZ = z;
    if (z > acc.maxZ) acc.maxZ = z;
  }
}

/**
 * 24区 建物 dataset / tile を生成する（テストから直接呼べるようCLIから分離）。
 * @param {{buildings:string, wardPolygons:string, out:string, tileSize?:number, force?:boolean, dryRun?:boolean, writeReport?:boolean}} opts
 * @returns {Promise<{rootManifest:object, report:object, reportPath:string|null, outAbs:string}>}
 */
export async function generateWardBuildingDatasets(opts) {
  const args = { tileSize: 500, force: false, dryRun: false, writeReport: true, layout: 'nested', ...opts };
  const LAYOUT = args.layout === 'flat' ? 'flat' : 'nested';
  // flat: <datasetId>/manifest.json + <datasetId>/tile_x_z.json（既存 ward-ux-v1.html ローダ互換）
  // nested: <wardId>/manifest.json + <wardId>/tiles/tile_x_z.json（P1-4 標準）
  const dirNameFor = (wardId, datasetId) => (LAYOUT === 'flat' ? datasetId : wardId);
  const tileRelPath = (tx, tz) => (LAYOUT === 'flat' ? `tile_${tx}_${tz}.json` : `tiles/tile_${tx}_${tz}.json`);
  const buildingsPath = resolveProjectPath(args.buildings || path.join('temp', 'ward-poc-all-buildings.jsonl'));
  const wpPath = resolveProjectPath(args.wardPolygons || path.join('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
  const outAbs = resolveProjectPath(args.out || path.join('data', 'processed', 'osaka-city', 'buildings'));
  const TS = args.tileSize;
  assertSafeOut(outAbs);

  const wp = JSON.parse(fs.readFileSync(wpPath, 'utf-8').replace(/^﻿/, ''));
  const wards = wp.wards;
  const registry = loadRegistry();
  const regById = new Map(registry.wards.map((w) => [w.id, w]));
  const nameById = new Map(registry.wards.map((w) => [w.id, w.name]));

  if (fs.existsSync(outAbs) && fs.readdirSync(outAbs).length && !args.force && !args.dryRun) {
    throw new Error(`出力先が空でない: ${toProjectRelativePath(outAbs)}  (--force で上書き、--dry-run で確認のみ)`);
  }

  // ── 分類 ──
  const buckets = new Map(); // wardId -> Map(tileKey -> building[])
  for (const w of wards) buckets.set(w.wardId, new Map());
  const unclassifiedTiles = new Map(); // tileKey -> building[]
  const unclassifiedInvalid = [];
  const wardBounds = new Map();
  for (const w of wards) wardBounds.set(w.wardId, { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
  const unclBounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };

  const seenIds = new Set();
  let total = 0, dupIds = 0;
  const wardCount = {};
  for (const w of wards) wardCount[w.wardId] = 0;
  let outsideCount = 0, ambiguousCount = 0, invalidCount = 0, boundaryResolved = 0;
  const methodCounts = {};
  const attrByN03 = { match: 0, mismatch: 0, n03OutsideButAttr: 0, noAttr: 0 };
  // unclassified(区外) の原因内訳
  const outsideByDistance = { '<=25m': 0, '<=100m': 0, '<=500m': 0, '>500m': 0 };
  const outsideNearestWard = {};

  const rl = readline.createInterface({ input: fs.createReadStream(buildingsPath, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    total++;
    let b;
    try { b = JSON.parse(s); } catch { invalidCount++; unclassifiedInvalid.push({ raw: s.slice(0, 120), reason: 'json-parse' }); continue; }

    const id = b && b.id;
    if (!id) { invalidCount++; unclassifiedInvalid.push({ id: null, reason: 'no-id' }); continue; }
    if (seenIds.has(id)) { dupIds++; continue; }
    seenIds.add(id);

    if (!Array.isArray(b.fp) || b.fp.length < 3) {
      invalidCount++;
      unclassifiedInvalid.push({ id, reason: 'footprint-too-small', fpLen: Array.isArray(b.fp) ? b.fp.length : 0 });
      continue;
    }
    const rp = representativePoint(b.fp);
    methodCounts[rp.method] = (methodCounts[rp.method] || 0) + 1;
    if (!rp.valid) {
      invalidCount++;
      unclassifiedInvalid.push({ id, reason: 'no-representative-point' });
      continue;
    }

    const res = classifyPointToWard(rp.x, rp.z, wards);
    if (res.status === 'boundary-resolved') boundaryResolved++;

    // building.ward 属性との一致（診断専用）
    const attrId = b.ward ? [...nameById.entries()].find(([, n]) => n === b.ward)?.[0] || null : null;
    if (!b.ward) attrByN03.noAttr++;
    else if (attrId && attrId === res.wardId) attrByN03.match++;
    else if (!res.wardId) attrByN03.n03OutsideButAttr++;
    else attrByN03.mismatch++;

    const rec = { id, fp: b.fp, z0: b.z0 ?? 0, dz: b.dz ?? b.h ?? 0, h: b.h ?? b.dz ?? 0, usage: b.usage ?? null, ulabel: b.ulabel ?? null, repX: rp.x, repZ: rp.z, repMethod: rp.method };

    const tx = Math.floor(rp.x / TS), tz = Math.floor(rp.z / TS);
    const tileKey = `${tx}_${tz}`;

    if (res.wardId) {
      wardCount[res.wardId]++;
      const tm = buckets.get(res.wardId);
      if (!tm.has(tileKey)) tm.set(tileKey, []);
      tm.get(tileKey).push(rec);
      fpBounds(b.fp, wardBounds.get(res.wardId));
    } else if (res.status === 'ambiguous') {
      ambiguousCount++;
      addUnclassified(rec, tileKey, 'ambiguous');
    } else {
      outsideCount++;
      const nd = nearestWardDistance(rp.x, rp.z, wards);
      const bucket = nd.distance == null ? '>500m' : nd.distance <= 25 ? '<=25m' : nd.distance <= 100 ? '<=100m' : nd.distance <= 500 ? '<=500m' : '>500m';
      outsideByDistance[bucket]++;
      if (nd.nearestWardId) outsideNearestWard[nd.nearestWardId] = (outsideNearestWard[nd.nearestWardId] || 0) + 1;
      rec.nearestWardId = nd.nearestWardId;
      rec.nearestWardDistance = nd.distance == null ? null : Math.round(nd.distance * 10) / 10;
      addUnclassified(rec, tileKey, 'outside-all-wards');
    }
  }

  function addUnclassified(rec, tileKey, reason) {
    rec.unclassifiedReason = reason;
    if (!unclassifiedTiles.has(tileKey)) unclassifiedTiles.set(tileKey, []);
    unclassifiedTiles.get(tileKey).push(rec);
    fpBounds(rec.fp, unclBounds);
  }

  const classifiedSum = Object.values(wardCount).reduce((a, b) => a + b, 0);
  const unclassifiedTotal = outsideCount + ambiguousCount + invalidCount;
  const invariant = classifiedSum + unclassifiedTotal + dupIds === total;

  // ── 出力 ──
  const source = {
    buildings: toProjectRelativePath(buildingsPath),
    wardPolygons: toProjectRelativePath(wpPath),
    wardPolygonsCoordinateConvention: wp.coordinateConvention,
    classification: 'N03 point-in-polygon (tools/lib/point-in-polygon.js). building.ward attribute NOT used.',
    tileSize: TS,
  };
  const generatedAt = new Date().toISOString();

  const datasets = [];
  for (const w of wards) {
    const tm = buckets.get(w.wardId);
    const reg = regById.get(w.wardId);
    const datasetId = reg ? reg.datasetId : `osaka-${w.wardId}`;
    const bnd = wardBounds.get(w.wardId);
    const bounds = Number.isFinite(bnd.minX) ? bnd : { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    const dirName = dirNameFor(w.wardId, datasetId);
    const tiles = [];
    for (const [key, arr] of [...tm.entries()].sort()) {
      const [tx, tz] = key.split('_').map(Number);
      tiles.push({ tx, tz, file: tileRelPath(tx, tz), count: arr.length });
      if (!args.dryRun) {
        const rel = tileRelPath(tx, tz);
        const fpath = path.join(outAbs, dirName, rel);
        fs.mkdirSync(path.dirname(fpath), { recursive: true });
        fs.writeFileSync(fpath, JSON.stringify({ tx, tz, tileSize: TS, lod: 1, count: arr.length, buildings: arr }));
      }
    }
    const manifest = {
      version: 1, id: datasetId, wardId: w.wardId, ward: w.wardName, wardCode: w.wardCode,
      coordinateSystem: 'meters-local', coordinateConvention: 'znorth-neg-v1', origin: null,
      tileSize: TS, lod: 1, layout: LAYOUT,
      totalBuildings: wardCount[w.wardId], tileCount: tiles.length,
      bounds, invalidSkipped: 0, duplicateSkipped: 0,
      source, generatedAt, tiles,
    };
    if (!args.dryRun) {
      fs.mkdirSync(path.join(outAbs, dirName), { recursive: true });
      fs.writeFileSync(path.join(outAbs, dirName, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
    datasets.push({
      id: datasetId, wardId: w.wardId, ward: w.wardName, wardCode: w.wardCode,
      manifest: `./${dirName}/manifest.json`, buildings: wardCount[w.wardId], tiles: tiles.length,
      bounds, polygonCount: w.polygonCount, holeCount: w.holeCount,
      dataReadyCandidate: wardCount[w.wardId] > 0 && tiles.length > 0,
    });
  }

  // unclassified dataset
  const unclTiles = [];
  for (const [key, arr] of [...unclassifiedTiles.entries()].sort()) {
    const [tx, tz] = key.split('_').map(Number);
    const rel = tileRelPath(tx, tz);
    unclTiles.push({ tx, tz, file: rel, count: arr.length });
    if (!args.dryRun) {
      const fpath = path.join(outAbs, 'unclassified', rel);
      fs.mkdirSync(path.dirname(fpath), { recursive: true });
      fs.writeFileSync(fpath, JSON.stringify({ tx, tz, tileSize: TS, lod: 1, count: arr.length, buildings: arr }));
    }
  }
  const unclassifiedManifest = {
    version: 1, id: 'osaka-city-unclassified', wardId: null, ward: null,
    coordinateSystem: 'meters-local', coordinateConvention: 'znorth-neg-v1', tileSize: TS, lod: 1, layout: LAYOUT,
    totalBuildings: outsideCount + ambiguousCount, tileCount: unclTiles.length,
    invalidFootprints: invalidCount,
    bounds: Number.isFinite(unclBounds.minX) ? unclBounds : { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    reasons: {
      'outside-all-wards': outsideCount,
      ambiguous: ambiguousCount,
      'invalid-footprint': invalidCount,
    },
    outsideByDistanceToNearestWard: outsideByDistance,
    outsideNearestWard,
    note: '最近傍区へは割り当てていない（P1-4指令#6）。<=25m は行政界のすぐ外（海岸線・河川縁でPLATEAUが境界を僅かに越えるケース）と推定。>500m は座標不良または真に市外。',
    source, generatedAt, tiles: unclTiles,
  };
  if (!args.dryRun) {
    fs.mkdirSync(path.join(outAbs, 'unclassified'), { recursive: true });
    fs.writeFileSync(path.join(outAbs, 'unclassified', 'manifest.json'), JSON.stringify(unclassifiedManifest, null, 2));
    if (unclassifiedInvalid.length) {
      fs.writeFileSync(path.join(outAbs, 'unclassified', 'invalid.json'), JSON.stringify({ count: unclassifiedInvalid.length, samples: unclassifiedInvalid.slice(0, 200) }, null, 2));
    }
  }

  const rootManifest = {
    version: 1, city: 'osaka-city', coordinateSystem: 'meters-local', coordinateConvention: 'znorth-neg-v1',
    tileSize: TS, layout: LAYOUT, origin: null, generatedAt, source,
    totals: { input: total, classified: classifiedSum, unclassified: unclassifiedTotal, duplicateIdsSkipped: dupIds, invariant },
    datasets,
    unclassified: { manifest: './unclassified/manifest.json', buildings: outsideCount + ambiguousCount, invalidFootprints: invalidCount, tiles: unclTiles.length },
  };
  if (!args.dryRun) {
    fs.mkdirSync(outAbs, { recursive: true });
    fs.writeFileSync(path.join(outAbs, 'manifest.json'), JSON.stringify(rootManifest, null, 2));
  }

  // ── 既存3区との差 ──
  const EXISTING = { sumiyoshi: 33594, higashisumiyoshi: 38266, hirano: 43843 };
  const knownDelta = {};
  for (const [id, prev] of Object.entries(EXISTING)) {
    const now = wardCount[id];
    knownDelta[id] = { existing: prev, n03: now, delta: now - prev, pct: prev ? Math.round(((now - prev) / prev) * 1000) / 10 : null };
  }

  const report = {
    generatedAt, source,
    totals: rootManifest.totals,
    methodCounts,
    wardBuildingCount: wardCount,
    wardTileCount: Object.fromEntries(datasets.map((d) => [d.wardId, d.tiles])),
    wardBounds: Object.fromEntries(datasets.map((d) => [d.wardId, d.bounds])),
    boundaryResolved,
    unclassified: {
      total: unclassifiedTotal,
      pct: total ? Math.round((unclassifiedTotal / total) * 10000) / 100 : 0,
      byReason: unclassifiedManifest.reasons,
      outsideByDistanceToNearestWard: outsideByDistance,
      outsideNearestWard,
    },
    buildingWardAttributeVsN03: attrByN03,
    knownWardDelta: knownDelta,
    dataReadyCandidates: datasets.filter((d) => d.dataReadyCandidate).map((d) => d.wardId),
    registryProductionSwitch: 'NOT PERFORMED (P1-4指令#10)。dataReady 切替はユーザー判断。',
  };
  let reportPath = null;
  if (args.writeReport) {
    reportPath = resolveProjectPath(path.join('data', 'reports', 'building-dataset-generation.json'));
    await writeJson(reportPath, report);
  }

  return { rootManifest, report, reportPath, outAbs, buildingsPath, meta: { total, classifiedSum, unclassifiedTotal, outsideCount, ambiguousCount, invalidCount, dupIds, invariant, datasets, knownDelta, outsideByDistance, dryRun: args.dryRun } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const r = await generateWardBuildingDatasets({
    buildings: args.buildings, wardPolygons: args.wardPolygons, out: args.out,
    tileSize: args.tileSize, force: args.force, dryRun: args.dryRun, layout: args.layout,
  });
  const m = r.meta;
  console.log('=== 24区 建物 dataset 生成 ===');
  console.log(`入力: ${toProjectRelativePath(r.buildingsPath)}  総数 ${m.total}`);
  console.log(`出力: ${toProjectRelativePath(r.outAbs)}${m.dryRun ? '  (--dry-run: 書き込みなし)' : ''}`);
  console.log('');
  for (const d of m.datasets) console.log(`  ${d.ward.padEnd(6)} (${d.wardId}): ${String(d.buildings).padStart(6)}棟 / ${String(d.tiles).padStart(3)}タイル`);
  console.log('');
  console.log(`  classified: ${m.classifiedSum}`);
  console.log(`  unclassified: ${m.unclassifiedTotal} (${r.report.unclassified.pct}%)  = 区外 ${m.outsideCount} + ambiguous ${m.ambiguousCount} + 不正fp ${m.invalidCount}`);
  console.log(`    区外の最近傍区までの距離: ${JSON.stringify(m.outsideByDistance)}`);
  console.log(`  重複ID(スキップ): ${m.dupIds}`);
  console.log(`  恒等式 classified + unclassified + dup === total: ${m.invariant}`);
  console.log('');
  console.log('  既存3区との差:');
  for (const [id, d] of Object.entries(m.knownDelta)) console.log(`    ${id}: ${d.existing} → ${d.n03} (${d.delta >= 0 ? '+' : ''}${d.delta}, ${d.pct}%)`);
  console.log('');
  console.log(`  dataReady候補: ${r.report.dataReadyCandidates.length}/24区`);
  if (r.reportPath) console.log(`\nレポート: ${toProjectRelativePath(r.reportPath)}`);
  console.log(m.invariant ? 'RESULT: OK' : 'RESULT: INVARIANT-FAIL');
  process.exit(m.invariant ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error('dataset生成でエラー:', err.message, err.stack); process.exit(1); });
}
