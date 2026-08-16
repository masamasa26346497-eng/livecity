#!/usr/bin/env node
// tools/orchestrate.js
//
// 既存の "npm run A && npm run B -- --area X" 方式では、--area がBにしか渡らない
// バグがあった（実際に再現確認済み）。本スクリプトはNode.js側で明示的に各ステップを
// 呼び出し、area引数を確実に全工程へ伝播させる。
//
// 使用法:
//   node tools/orchestrate.js <pipeline> --area <areaId> [--layers a,b] [--force]
//
// pipeline:
//   urban          既存のOSM道路・公園・施設パイプライン一括実行（download→process）
//   demographics   人口統計のdownload→process
//   mobility       移動統計のdownload→process（フェーズD実装後に有効化）
//   facilities     施設のdownload→process（フェーズC実装後に有効化）
//   transit        公共交通のdownload→process（フェーズG実装後に有効化）
//   hazards        防災のdownload→process（フェーズE実装後に有効化）
//   shelters       避難所のdownload→process（フェーズE実装後に有効化）
//   accessibility  バリアフリーのdownload→process（フェーズG実装後に有効化）
//   projections    将来人口のdownload→process（フェーズF実装後に有効化）

function parseArgs(argv) {
  const args = { pipeline: argv[0], area: null, layers: null, force: false, step: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
    else if (argv[i] === '--layers') args.layers = argv[++i].split(',').map((s) => s.trim());
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--step') args.step = argv[++i]; // 'download' | 'process' のみ実行したい場合
  }
  return args;
}

// pipeline名 -> {download, process} という、各フェーズが実装する標準モジュール形状。
// 各モジュールは async function run(args) を named export "run" として公開する規約にする。
// フェーズが未実装のものはここに追加するだけで有効化できる（呼び出し側のコードは変更不要）。
const PIPELINES = {
  urban: {
    download: () => import('./download/index.js'),
    process: () => import('./convert/index.js'),
  },
  demographics: {
    download: () => import('./download/census/index.js'),
    process: () => import('./convert/demographics/index.js'),
  },
  // 以下は対応フェーズの実装完了後に有効化する（現時点ではpipeline名を指定するとエラーで案内する）
  mobility: null,
  facilities: {
    download: () => import('./download/facilities.js'),
    process: () => import('./process/facilities/index.js'),
  },
  transit: null,
  hazards: null,
  shelters: null,
  accessibility: null,
  projections: null,
};

async function runStep(moduleLoader, args, stepLabel) {
  if (!moduleLoader) return null;
  const mod = await moduleLoader();
  if (typeof mod.run !== 'function') {
    throw new Error(`${stepLabel}: モジュールが run(args) をexportしていません。`);
  }
  console.log(`\n========== ${stepLabel} ==========`);
  return await mod.run(args);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pipeline || !args.area) {
    console.error('使用法: node tools/orchestrate.js <pipeline> --area <areaId> [--layers a,b] [--force] [--step download|process]');
    console.error(`利用可能なpipeline: ${Object.keys(PIPELINES).join(', ')}`);
    process.exit(1);
  }

  const pipeline = PIPELINES[args.pipeline];
  if (pipeline === undefined) {
    console.error(`未知のpipeline: ${args.pipeline}`);
    process.exit(1);
  }
  if (pipeline === null) {
    console.error(`pipeline "${args.pipeline}" はまだ実装されていません（対応フェーズ完了後に有効化されます）。`);
    process.exit(1);
  }

  try {
    let downloadResults = null;
    if (!args.step || args.step === 'download') {
      downloadResults = await runStep(pipeline.download, args, `${args.pipeline}:download`);
      if (Array.isArray(downloadResults)) {
        const failed = downloadResults.filter((r) => r.status === 'failed');
        if (failed.length === downloadResults.length && downloadResults.length > 0) {
          console.warn(`\n[WARN] ${args.pipeline}:download の全レイヤーが失敗しました。後続のprocessは既存データのみで実行されます（空データの上書きは行いません）。`);
        }
      }
    }
    if (!args.step || args.step === 'process') {
      await runStep(pipeline.process, args, `${args.pipeline}:process`);
    }
  } catch (err) {
    console.error(`\n[ERROR] ${args.pipeline}パイプラインでエラーが発生しました:`, err.message);
    process.exitCode = 1;
  }
}

main();
