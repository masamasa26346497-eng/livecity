#!/usr/bin/env node
// tools/validate/ward-building-datasets.js
// P1-4: 24区 建物 dataset / tile の検証CLI。
//
// 実行:
//   node tools/validate/ward-building-datasets.js
//   node tools/validate/ward-building-datasets.js --datasets data/processed/osaka-city/buildings \
//     --buildings temp/ward-poc-all-buildings.jsonl --report data/reports/ward-building-datasets-validation.json
//
// error重大度の失敗があれば exit 1。

import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { validateWardBuildingDatasets } from '../lib/ward-building-dataset-validator.js';

function parseArgs(argv) {
  const a = { datasets: null, buildings: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--datasets') a.datasets = argv[++i];
    else if (argv[i] === '--buildings') a.buildings = argv[++i];
    else if (argv[i] === '--report') a.report = argv[++i];
  }
  return a;
}

async function countLines(p) {
  let n = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(p, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) n++;
  return n;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetRoot = resolveProjectPath(args.datasets || path.join('data', 'processed', 'osaka-city', 'buildings'));
  const registry = JSON.parse(fs.readFileSync(resolveProjectPath(path.join('config', 'wards', 'registry.json')), 'utf-8').replace(/^﻿/, ''));

  let inputTotal;
  const buildingsPath = resolveProjectPath(args.buildings || path.join('temp', 'ward-poc-all-buildings.jsonl'));
  if (fs.existsSync(buildingsPath)) inputTotal = await countLines(buildingsPath);

  const result = validateWardBuildingDatasets(datasetRoot, { registry, inputTotal });

  console.log('=== 24区 建物 dataset 検証 ===');
  console.log(`dataset: ${toProjectRelativePath(datasetRoot)}`);
  console.log(`dataset数: ${result.summary.datasetCount} / classified(走査) ${result.summary.classifiedScanned} / unclassified(走査) ${result.summary.unclassifiedScanned}`);
  console.log('');
  for (const c of result.checks) {
    const mark = c.pass ? 'PASS' : (c.severity === 'warning' ? 'WARN' : 'FAIL');
    console.log(`  [${mark}] ${c.name}: ${c.detail}`);
  }

  if (args.report) {
    const reportPath = resolveProjectPath(args.report);
    await writeJson(reportPath, { generatedAt: new Date().toISOString(), datasetRoot: toProjectRelativePath(datasetRoot), ...result });
    console.log(`\n保存: ${toProjectRelativePath(reportPath)}`);
  }
  console.log(result.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => { console.error('検証でエラー:', err.message); process.exit(1); });
