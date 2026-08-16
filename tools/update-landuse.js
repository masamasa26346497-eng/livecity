#!/usr/bin/env node
// tools/update-landuse.js
// 実行: node tools/update-landuse.js --area osaka-sumiyoshi [--force]
//
// 土地利用(landuse)データの「取得 → 変換」を一括で実行する。
//   1) tools/download/landuse.js  : Overpass APIから3群に分けて取得 → data/raw/<area>/landuse-osm.json
//   2) tools/convert/landuse.js   : ローカル座標へ変換         → data/processed/<area>/landuse.json
//
// 取得が失敗した場合、変換は実行されず、既存の processed データも変更されない。
//
// 注意: 取得ステップはネットワーク接続が必要。
// Claude Codeの隔離環境では実行できないため、ネットワークの通るローカルPC等で実行すること。
import { downloadLanduse } from './download/landuse.js';
import { convertLanduse } from './convert/landuse.js';
import { isMainModule } from './lib/paths.js';

function parseArgs(argv) {
  const args = { area: null, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--area') args.area = argv[++i] || null;
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`
土地利用(landuse)データの取得と変換を一括実行

使い方:
  node tools/update-landuse.js --area <areaId> [--force]
  npm run data:update:landuse -- --area <areaId>

オプション:
  --area <areaId>   対象エリアID (例: osaka-sumiyoshi)  ※必須
  --force           既存の生データがあっても再取得する
  --help, -h        このヘルプを表示

処理:
  1) Overpass APIから取得 → data/raw/<areaId>/landuse-osm.json
  2) ローカル座標へ変換   → data/processed/<areaId>/landuse.json

取得に失敗した場合、変換は行われず既存データも変更されません。
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.area) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  console.log('=== [1/2] 取得 ===');
  await downloadLanduse({ area: args.area, force: args.force });

  console.log('\n=== [2/2] 変換 ===');
  await convertLanduse({ area: args.area });

  console.log('\n完了しました。');
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n失敗しました: ${err.message}`);
    process.exit(1);
  });
}
