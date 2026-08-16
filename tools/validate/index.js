#!/usr/bin/env node
// tools/validate/index.js
// 実行: node tools/validate/index.js --area osaka-sumiyoshi
// data/manifests/{areaId}.json を読み込み、検証結果のサマリを表示する。
// data:process が既にマニフェストを生成しているため、本コマンドは再確認用。

import { manifestPath, readJsonIfExists } from '../lib/area.js';

function parseArgs(argv) {
  const args = { area: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.area) {
    console.error('使用法: node tools/validate/index.js --area <areaId>');
    process.exit(1);
  }
  const manifest = await readJsonIfExists(manifestPath(args.area));
  if (!manifest) {
    console.error(`マニフェストが見つかりません。先に npm run data:process -- --area ${args.area} を実行してください。`);
    process.exit(1);
  }

  console.log(`=== ${manifest.areaName} (${manifest.areaId}) 検証結果 ===`);
  console.log(`生成日時: ${manifest.generatedAt}`);
  let anyFail = false;
  for (const [layerName, info] of Object.entries(manifest.layers)) {
    const mark = info.validation === 'pass' ? 'PASS' : info.validation === 'fail' ? 'FAIL' : info.status;
    console.log(`  ${layerName}: ${mark}${info.recordCount !== undefined ? ` (${info.recordCount}件)` : ''}`);
    if (info.validation === 'fail') {
      anyFail = true;
      for (const check of info.checks || []) {
        if (!check.pass) console.log(`    ✗ ${check.name}: ${check.detail}`);
      }
    }
  }
  if (anyFail) process.exitCode = 1;
}

main().catch((err) => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
