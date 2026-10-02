#!/usr/bin/env node
// tools/build-ward-polygons.js
// P1-3: N03行政区境界から point-in-polygon 判定用の Ward polygon データセットを生成する。
//
// 実行:
//   node tools/build-ward-polygons.js
//   node tools/build-ward-polygons.js --input <boundaries.json> --output <ward-polygons.json>
//
// 既定入力  : data/processed/osaka-city/boundaries/administrative-boundaries.json
// 既定出力  : data/processed/osaka-city/boundaries/ward-classification-polygons.json
//
// 出力は「N03 Ward polygon → 建物代表点 → point-in-polygon → wardId確定 → 区別dataset/tile生成」
// の次工程（P1-4）で再利用する。座標規約 znorth-neg-v1 を維持する。

import { readFile } from 'fs/promises';
import path from 'path';
import { writeJson } from './lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from './lib/paths.js';
import { buildWardPolygons } from './lib/ward-polygons.js';

function parseArgs(argv) {
  const args = { input: null, output: null, zAxis: 'auto' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') args.input = argv[++i];
    else if (argv[i] === '--output') args.output = argv[++i];
    else if (argv[i] === '--z-axis') args.zAxis = argv[++i]; // auto | as-is | negate
  }
  return args;
}

async function loadRegistry() {
  const p = resolveProjectPath(path.join('config', 'wards', 'registry.json'));
  return JSON.parse((await readFile(p, 'utf-8')).replace(/^﻿/, ''));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolveProjectPath(args.input ||
    path.join('data', 'processed', 'osaka-city', 'boundaries', 'administrative-boundaries.json'));
  const outputPath = resolveProjectPath(args.output ||
    path.join('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));

  const payload = JSON.parse((await readFile(inputPath, 'utf-8')).replace(/^﻿/, ''));
  const registry = await loadRegistry();

  const result = buildWardPolygons(payload, { registry, zAxis: args.zAxis });

  // registry 整合チェック（生成時に早期に気づけるように）
  const byId = new Map(registry.wards.map((w) => [w.id, w]));
  const problems = [];
  for (const w of result.wards) {
    const reg = byId.get(w.wardId);
    if (!reg) problems.push(`${w.wardId}: registryに存在しない`);
    else if (reg.code !== w.wardCode || reg.name !== w.wardName) {
      problems.push(`${w.wardId}: registryと不一致 (code ${w.wardCode}/${reg.code}, name ${w.wardName}/${reg.name})`);
    }
  }
  const missing = registry.wards.filter((w) => !result.wards.some((x) => x.wardId === w.id));

  console.log('=== Ward polygon 生成 ===');
  console.log(`入力: ${toProjectRelativePath(inputPath)}`);
  console.log(`座標規約: ${result.coordinateConvention}`);
  console.log(`z軸補正: ${result.zAxisApplied}${args.zAxis !== 'auto' ? ` (--z-axis ${args.zAxis} 指定)` : ' (auto)'}`);
  for (const d of result.zAxisDetection.detail) console.log(`   ${d}`);
  if (result.zAxisApplied === 'negate') {
    console.log('   → N03取り込みが北=z正で出力しているため z を反転して znorth-neg-v1 に揃えた。');
    console.log('     上流(tools/lib/n03-boundaries.js / projection.js)の恒久修正は要ユーザー判断。');
  }
  console.log(`区数: ${result.wards.length} / registry ${registry.wards.length}`);
  console.log('');
  for (const w of result.wards) {
    const bits = [`polygon ${w.polygonCount}`];
    if (w.exclaveCount) bits.push(`飛び地 ${w.exclaveCount}`);
    if (w.holeCount) bits.push(`hole ${w.holeCount}`);
    console.log(`  ${w.wardName.padEnd(6)} (${w.wardId}/${w.wardCode}): ${bits.join(' / ')}`);
  }
  if (missing.length) console.log(`\n未生成: ${missing.map((w) => w.name).join('、')}`);
  if (problems.length) {
    console.error('\nregistry整合エラー:');
    for (const p of problems) console.error('  ' + p);
    process.exit(1);
  }

  const payloadOut = {
    coordinateConvention: result.coordinateConvention,
    generatedAt: new Date().toISOString(),
    wards: result.wards,
    metadata: result.metadata,
  };
  await writeJson(outputPath, payloadOut);
  console.log(`\n保存: ${toProjectRelativePath(outputPath)}`);
  console.log(missing.length ? 'RESULT: PARTIAL' : 'RESULT: OK (24/24)');
  process.exit(missing.length ? 1 : 0);
}

main().catch((err) => {
  console.error('Ward polygon 生成でエラー:', err.message);
  process.exit(1);
});
