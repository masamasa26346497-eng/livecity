#!/usr/bin/env node
// tools/update-dataset.js
// 実行: node tools/update-dataset.js <datasetId> --area <areaId> [--force]
//
// "npm run X -- --force" のような書き方では、--forceはシェル上で連結された
// 最後のコマンドにしか渡らない(既存のtools/orchestrate.jsが解決した同種の問題)。
// 本スクリプトはNode.js側でdownload→processを明示的に呼び出し、--area/--forceを
// 両工程へ確実に伝播させる。

function parseArgs(argv) {
  const args = { datasetId: argv[0], area: null, force: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
    else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.datasetId || !args.area) {
    console.error('使用法: node tools/update-dataset.js <datasetId> --area <areaId> [--force]');
    process.exit(1);
  }

  console.log(`\n========== ${args.datasetId}: download ==========`);
  const downloadMod = await import('./download/census/index.js');
  await downloadMod.run({ area: args.area, datasets: [args.datasetId], force: args.force });

  console.log(`\n========== ${args.datasetId}: process (demographics全体を再変換) ==========`);
  const processMod = await import('./convert/demographics/index.js');
  await processMod.run({ area: args.area });
}

main().catch((err) => {
  console.error('予期しないエラー:', err.message);
  process.exit(1);
});
