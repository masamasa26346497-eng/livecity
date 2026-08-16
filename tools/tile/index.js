#!/usr/bin/env node
// tools/tile/index.js
// 実行: node tools/tile/index.js --area <areaId>
//
// 現状は未使用（osaka-sumiyoshiはエリア規模が小さく、タイル分割不要のため
// config/areas/osaka-sumiyoshi.json の tiling.enabled は false になっている）。
//
// 将来、大阪市全域・大阪府全域へ拡張する際は、
// 1. エリアconfigの tiling.enabled を true にし、zoomLevels・tileSizeMetersを設定する
// 2. data:process の出力(public/map-data/{areaId}/*.json)を、本スクリプトが
//    タイルキー単位(例: "z10_x512_y341.json")のファイル群に分割する
// という流れを想定している。download/convert側のコード変更は不要。

import { loadAreaConfig, publicMapDataDir } from '../lib/area.js';

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
    console.error('使用法: node tools/tile/index.js --area <areaId>');
    process.exit(1);
  }
  const areaConfig = await loadAreaConfig(args.area);
  if (!areaConfig.tiling || !areaConfig.tiling.enabled) {
    console.log(`[SKIP] ${args.area}: タイル分割は無効化されています(tiling.enabled=false)。`);
    console.log(`       現在のエリア規模では不要です。大阪市全域等へ拡張する際に有効化してください。`);
    return;
  }
  console.log(`[TODO] タイル分割処理は未実装です。public/map-data/${args.area}/ の各レイヤーファイルを`);
  console.log(`       ${JSON.stringify(areaConfig.tiling.zoomLevels)} のズームレベルで分割する処理をここに実装する。`);
}

main().catch((err) => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
