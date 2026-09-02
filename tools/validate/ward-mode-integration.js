#!/usr/bin/env node
// tools/validate/ward-mode-integration.js
// P1-5: 24区 建物 dataset を Live City 本体(ward-ux-v1.html)の Ward Mode へ接続した状態を検証する。
//
// 実行:
//   node tools/validate/ward-mode-integration.js
//   node tools/validate/ward-mode-integration.js --datasets public/map-data/osaka-city/buildings \
//     --html public/osaka_3d_buildings.ward-ux-v1.html --report data/reports/ward-mode-integration-validation.json
//
// error重大度の失敗があれば exit 1。dataReady=true を registry へ反映する前にこれを通すこと（指令#4）。

import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { validateWardModeIntegration } from '../lib/ward-mode-integration-validator.js';

function parseArgs(argv) {
  const a = { datasets: null, html: null, wardPolygons: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--datasets') a.datasets = argv[++i];
    else if (argv[i] === '--html') a.html = argv[++i];
    else if (argv[i] === '--ward-polygons') a.wardPolygons = argv[++i];
    else if (argv[i] === '--report') a.report = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetRoot = resolveProjectPath(args.datasets || path.join('public', 'map-data', 'osaka-city', 'buildings'));
  const htmlPath = resolveProjectPath(args.html || path.join('public', 'osaka_3d_buildings.ward-ux-v1.html'));
  const wardPolygonsPath = resolveProjectPath(args.wardPolygons || path.join('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
  const registry = JSON.parse(fs.readFileSync(resolveProjectPath(path.join('config', 'wards', 'registry.json')), 'utf-8').replace(/^﻿/, ''));

  const result = validateWardModeIntegration({ datasetRoot, htmlPath, wardPolygonsPath, registry });

  console.log('=== Ward Mode 24区統合 検証 ===');
  console.log(`dataset: ${toProjectRelativePath(datasetRoot)}`);
  console.log(`HTML: ${toProjectRelativePath(htmlPath)}`);
  console.log('');
  for (const c of result.checks) {
    const mark = c.pass ? 'PASS' : (c.severity === 'warning' ? 'WARN' : 'FAIL');
    console.log(`  [${mark}] ${c.name}: ${c.detail}`);
  }

  if (args.report) {
    const reportPath = resolveProjectPath(args.report);
    await writeJson(reportPath, { generatedAt: new Date().toISOString(), datasetRoot: toProjectRelativePath(datasetRoot), htmlPath: toProjectRelativePath(htmlPath), ...result });
    console.log(`\n保存: ${toProjectRelativePath(reportPath)}`);
  }
  console.log(result.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => { console.error('統合検証でエラー:', err.message); process.exit(1); });
