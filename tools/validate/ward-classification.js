#!/usr/bin/env node
// tools/validate/ward-classification.js
// P1-3: Ward polygon データセットの検証CLI。
//
// 実行:
//   node tools/validate/ward-classification.js
//   node tools/validate/ward-classification.js --input <ward-polygons.json> --report <path>
//
// 既定入力: data/processed/osaka-city/boundaries/ward-classification-polygons.json
// error重大度の失敗があれば exit 1。

import { readFile } from 'fs/promises';
import path from 'path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { validateWardClassification } from '../lib/ward-classification-validator.js';

function parseArgs(argv) {
  const args = { input: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') args.input = argv[++i];
    else if (argv[i] === '--report') args.report = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolveProjectPath(args.input ||
    path.join('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
  const registryPath = resolveProjectPath(path.join('config', 'wards', 'registry.json'));

  const payload = JSON.parse((await readFile(inputPath, 'utf-8')).replace(/^﻿/, ''));
  const registry = JSON.parse((await readFile(registryPath, 'utf-8')).replace(/^﻿/, ''));

  const result = validateWardClassification(payload, registry);

  console.log('=== Ward classification 検証 ===');
  console.log(`入力: ${toProjectRelativePath(inputPath)}`);
  console.log(`区数: ${result.summary.wardCount} / registry ${result.summary.registryWardCount} / 座標規約: ${result.summary.coordinateConvention}`);
  console.log('');
  for (const c of result.checks) {
    const mark = c.pass ? 'PASS' : (c.severity === 'warning' ? 'WARN' : 'FAIL');
    console.log(`  [${mark}] ${c.name}: ${c.detail}`);
  }

  if (args.report) {
    const reportPath = resolveProjectPath(args.report);
    await writeJson(reportPath, { generatedAt: new Date().toISOString(), input: toProjectRelativePath(inputPath), ...result });
    console.log(`\n保存: ${toProjectRelativePath(reportPath)}`);
  }
  console.log(result.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Ward classification 検証でエラー:', err.message);
  process.exit(1);
});
