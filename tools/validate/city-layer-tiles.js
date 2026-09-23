#!/usr/bin/env node
// tools/validate/city-layer-tiles.js
// P1-6: 都市レイヤー tile（道路・河川・公園・鉄道）の共通検証CLI。河川は water validator を併用。
//
// 実行:
//   node tools/validate/city-layer-tiles.js
//   node tools/validate/city-layer-tiles.js --layer roads --root data/processed/osaka-city
//   node tools/validate/city-layer-tiles.js --report data/reports/city-layer-tiles-validation.json

import fs from 'node:fs';
import path from 'node:path';
import { loadAreaConfig, writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { createCityTileGrid } from '../lib/city-tile-grid.js';
import { validateCityLayer } from '../lib/city-layer-validator.js';
import { validateWaterGeometry } from '../lib/water-geometry-validator.js';
import { validateWaterSemantics } from '../lib/water-semantic-validator.js';

const LAYERS = ['roads', 'parks', 'railways', 'waterways'];

function parseArgs(argv) {
  const a = { layer: null, root: null, area: 'osaka-city', wardPolygons: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--layer') a.layer = argv[++i];
    else if (argv[i] === '--root') a.root = argv[++i];
    else if (argv[i] === '--area') a.area = argv[++i];
    else if (argv[i] === '--ward-polygons') a.wardPolygons = argv[++i];
    else if (argv[i] === '--report') a.report = argv[++i];
  }
  return a;
}

// 河川 tile を OSM_WATER 相当（{kind, p, holes}）へ均して water validator に渡す。
function waterItemsFromTiles(layerRoot, man) {
  const items = [];
  const seen = new Set();
  for (const t of (man.tiles || [])) {
    const tf = path.join(layerRoot, t.file);
    if (!fs.existsSync(tf)) continue;
    for (const f of (JSON.parse(fs.readFileSync(tf, 'utf-8')).features || [])) {
      if (f.id && seen.has(f.id)) continue;
      if (f.id) seen.add(f.id);
      items.push({ id: f.id, name: f.name, kind: f.kind, subtype: f.subtype, p: f.p, holes: f.holes, source: f.source });
    }
  }
  return items;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const areaConfig = await loadAreaConfig(args.area);
  const grid = createCityTileGrid({
    bbox: areaConfig.bbox, projection: areaConfig.projection,
    tileSizeMeters: (areaConfig.tiling && areaConfig.tiling.tileSizeMeters) || 2000,
  });
  const root = resolveProjectPath(args.root || path.join('data', 'processed', 'osaka-city'));

  let wardPolygons = null;
  const wpPath = resolveProjectPath(args.wardPolygons || path.join('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
  if (fs.existsSync(wpPath)) { try { wardPolygons = JSON.parse(fs.readFileSync(wpPath, 'utf-8').replace(/^﻿/, '')); } catch { /* noop */ } }

  const layers = args.layer && args.layer !== 'all' ? [args.layer] : LAYERS;
  const results = {};
  let anyFail = false;

  for (const layer of layers) {
    const layerRoot = path.join(root, layer);
    if (!fs.existsSync(path.join(layerRoot, 'manifest.json'))) {
      console.log(`  [SKIP] ${layer}: 未生成 (${toProjectRelativePath(layerRoot)})`);
      results[layer] = { skipped: true };
      continue;
    }
    const r = validateCityLayer(layerRoot, { grid, wardPolygons });
    results[layer] = r;
    console.log(`=== ${layer} ===`);
    for (const c of r.checks) {
      const mark = c.pass ? 'PASS' : (c.severity === 'warning' ? 'WARN' : 'FAIL');
      console.log(`  [${mark}] ${c.name}: ${c.detail}`);
    }
    if (layer === 'waterways') {
      const man = JSON.parse(fs.readFileSync(path.join(layerRoot, 'manifest.json'), 'utf-8'));
      const items = waterItemsFromTiles(layerRoot, man);
      const wr = validateWaterGeometry(items);
      console.log('  -- water geometry validator --');
      for (const c of wr.checks) console.log(`  [${c.pass ? 'PASS' : (c.severity === 'warning' ? 'WARN' : 'FAIL')}] water:${c.name}: ${c.detail}`);
      r.water = wr;
      if (!wr.ok) anyFail = true;
      // [P1-6F] 意味的検証（独立 outer 誤連結 / 暗黙 closure / 疎ノード巨大三角形）
      const sr = validateWaterSemantics(items.map((it) => ({ id: it.id, name: it.name, kind: it.kind, p: it.p, holes: it.holes, source: it.source })));
      console.log('  -- water semantic validator --');
      console.log(`  [${sr.ok ? 'PASS' : 'FAIL'}] water-semantic: area=${sr.summary.areaFeatures} error=${sr.summary.errorCount} warn=${sr.summary.warnCount}`);
      for (const e of sr.errors) console.log(`  [FAIL] water-semantic: ${e.id} ${e.reason}`);
      for (const w of sr.warnings.slice(0, 15)) console.log(`  [WARN] water-semantic: ${w.id} [${w.name || ''}] src=${w.source ? w.source.type + '/' + w.source.id : '?'} — ${w.reason}`);
      if (sr.warnings.length > 15) console.log(`  [WARN] water-semantic: … 他 ${sr.warnings.length - 15} 件`);
      r.waterSemantic = sr;
      if (!sr.ok) anyFail = true;
    }
    if (!r.ok) anyFail = true;
    console.log('');
  }

  const reportPath = resolveProjectPath(args.report || path.join('data', 'reports', 'city-layer-tiles-validation.json'));
  await writeJson(reportPath, { generatedAt: new Date().toISOString(), root: toProjectRelativePath(root), grid: { tileSize: grid.tileSize, cols: grid.cols, rows: grid.rows }, results });
  console.log(`保存: ${toProjectRelativePath(reportPath)}`);
  console.log(anyFail ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => { console.error('検証でエラー:', e.message); process.exit(1); });
