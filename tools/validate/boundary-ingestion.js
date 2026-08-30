#!/usr/bin/env node
// tools/validate/boundary-ingestion.js
// P1-2: 行政区境界（国土数値情報 N03）取り込み結果の自動検証。
//
// 実行:
//   node tools/validate/boundary-ingestion.js --input <ingest-output.json> [--area osaka-city] [--report <path>]
//
// --input   : tools/ingest/n03-administrative-boundaries.js の出力（{records, metadata}）
// --area    : 指定すると config/areas/{area}.json の projection で生WGS84 geometry もメートル系へ
//             変換して幾何検証する（変換済み出力の場合は不要）。
// --report  : 検証結果JSONの保存先（省略時 data/reports/boundary-ingestion-validation.json）。
//
// 終了コード: error重大度の失敗が1件でもあれば 1、それ以外は 0（warningのみは 0）。

import { readFile } from 'fs/promises';
import path from 'path';
import { loadAreaConfig, writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { validateBoundaryIngestion } from '../lib/boundary-ingestion-validator.js';

function parseArgs(argv) {
  const args = { input: null, area: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') args.input = argv[++i];
    else if (argv[i] === '--area') args.area = argv[++i];
    else if (argv[i] === '--report') args.report = argv[++i];
  }
  return args;
}

async function loadRegistry() {
  const registryPath = resolveProjectPath(path.join('config', 'wards', 'registry.json'));
  return JSON.parse(await readFile(registryPath, 'utf-8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('使用法: node tools/validate/boundary-ingestion.js --input <ingest-output.json> [--area osaka-city] [--report <path>]');
    process.exit(1);
  }

  const payload = JSON.parse(await readFile(resolveProjectPath(args.input), 'utf-8'));
  const registry = await loadRegistry();

  let projection = null;
  if (args.area) {
    const areaConfig = await loadAreaConfig(args.area);
    projection = areaConfig.projection || null;
  }

  const result = validateBoundaryIngestion(payload, registry, { projection, areaId: args.area });

  console.log('=== 行政区境界取り込み検証 ===');
  console.log(`入力: ${args.input}`);
  console.log(`レコード数: ${result.summary.recordCount} / registry区数: ${result.summary.registryWardCount}`);
  console.log(`座標系: 変換済み ${result.summary.convertedWards}区 / 生WGS84 ${result.summary.rawWards}区`);
  console.log('');
  for (const c of result.checks) {
    const mark = c.pass ? 'PASS' : (c.severity === 'warning' ? 'WARN' : 'FAIL');
    console.log(`  [${mark}] ${c.name}: ${c.detail}`);
  }
  console.log('');
  const oversized = result.wardReports.filter((w) => w.oversizedSegments > 0 || w.selfIntersections > 0);
  if (oversized.length) {
    console.log('幾何異常の疑いがある区:');
    for (const w of oversized) {
      console.log(`  ${w.wardName}: oversizedSeg=${w.oversizedSegments} selfIntersections=${w.selfIntersections} maxSeg=${w.maxSegment}m rings=${w.ringCount}`);
    }
    console.log('');
  }

  const reportPath = resolveProjectPath(args.report || path.join('data', 'reports', 'boundary-ingestion-validation.json'));
  await writeJson(reportPath, {
    generatedAt: new Date().toISOString(),
    input: args.input,
    area: args.area,
    ...result,
  });
  console.log(`検証結果を保存: ${toProjectRelativePath(reportPath)}`);
  console.log(result.ok ? 'RESULT: PASS' : 'RESULT: FAIL');

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('境界検証でエラーが発生しました:', err.message);
  process.exit(1);
});
