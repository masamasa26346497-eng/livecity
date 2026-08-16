#!/usr/bin/env node
// tools/download/index.js
// 実行: node tools/download/index.js --area osaka-sumiyoshi [--layers roads,parks] [--force]
//
// 重要: このスクリプトは実際にOverpass APIへネットワーク接続する。
// Claude Codeの隔離環境(ネットワーク無効)では実行できない。
// ネットワーク接続可能なローカルPCまたはCI環境で実行すること。

import { loadAreaConfig, rawDir, ensureDir, writeJson, readJsonIfExists } from '../lib/area.js';
import { buildOverpassQuery, runOverpassQuery } from '../lib/overpass.js';
import { isMainModule } from '../lib/paths.js';
import path from 'path';
import { existsSync } from 'fs';

function parseArgs(argv) {
  const args = { area: null, layers: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
    else if (argv[i] === '--layers') args.layers = argv[++i].split(',').map((s) => s.trim());
    else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

async function downloadLayer(areaId, areaConfig, layerName, layerConfig, force) {
  const outDir = rawDir(areaId);
  await ensureDir(outDir);
  const outPath = path.join(outDir, layerConfig.outputFile);
  const metaPath = outPath.replace(/\.json$/, '.meta.json');

  if (layerConfig.source === 'manual-upload') {
    console.log(`[SKIP] ${layerName}: 手動アップロード方式のレイヤーのため自動取得対象外。`);
    console.log(`       ${layerConfig.note || ''}`);
    console.log(`       配置先: data/raw/${areaId}/${path.basename(outDir)}/`);
    return { layerName, status: 'manual-required' };
  }

  if (!force && existsSync(outPath)) {
    console.log(`[SKIP] ${layerName}: 既存ファイルあり (${outPath})。再取得する場合は --force を指定。`);
    return { layerName, status: 'skipped-exists' };
  }

  console.log(`[FETCH] ${layerName}: Overpass APIへクエリ送信中...`);
  const query = buildOverpassQuery(areaConfig.bbox, layerConfig.osmFilter);

  try {
    const result = await runOverpassQuery(query, {
      onRetry: (attempt, reason) => {
        console.log(`  [RETRY ${attempt}] ${layerName}: ${reason} のため再試行します...`);
      },
    });

    await writeJson(outPath, result);
    await writeJson(metaPath, {
      layer: layerName,
      source: 'Overpass API (OpenStreetMap)',
      fetchedAt: new Date().toISOString(),
      query,
      bbox: areaConfig.bbox,
      elementCount: Array.isArray(result.elements) ? result.elements.length : 0,
      license: areaConfig.license && areaConfig.license.osm || 'ODbL 1.0 (OpenStreetMap contributors)',
      attribution: '© OpenStreetMap contributors',
    });
    console.log(`[OK] ${layerName}: ${result.elements ? result.elements.length : 0}件を ${outPath} へ保存しました。`);
    return { layerName, status: 'downloaded', count: result.elements ? result.elements.length : 0 };
  } catch (err) {
    console.error(`[FAIL] ${layerName}: ${err.message}`);
    console.error(`       他のレイヤーの取得は継続します。このレイヤーだけ再実行するには:`);
    console.error(`       npm run data:download -- --area ${areaId} --layers ${layerName} --force`);
    return { layerName, status: 'failed', error: err.message };
  }
}

async function main(args) {
  const areaConfig = await loadAreaConfig(args.area);
  console.log(`=== データ取得開始: ${areaConfig.name} (${args.area}) ===`);

  const layerNames = args.layers || Object.keys(areaConfig.layers).filter((k) => areaConfig.layers[k].enabled);
  const results = [];

  for (const layerName of layerNames) {
    const layerConfig = areaConfig.layers[layerName];
    if (!layerConfig) {
      console.warn(`[WARN] 未知のレイヤー指定: ${layerName} (スキップ)`);
      continue;
    }
    const result = await downloadLayer(args.area, areaConfig, layerName, layerConfig, args.force);
    results.push(result);
  }

  console.log('\n=== 取得結果サマリ ===');
  for (const r of results) {
    console.log(`  ${r.layerName}: ${r.status}${r.count !== undefined ? ` (${r.count}件)` : ''}`);
  }

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) {
    console.error(`\n${failed.length}件のレイヤーで取得に失敗しました。上記の再実行コマンドを使ってください。`);
    process.exitCode = 1;
  }
  return results;
}

// run(args): オーケストレーター(tools/orchestrate.js)から直接呼び出すための公開関数。
// argsは {area, layers, force} を持つプレーンオブジェクト。process.argvには依存しない。
export async function run(args) {
  if (!args.area) {
    throw new Error('area引数が指定されていません。');
  }
  return main(args);
}

// CLIから直接実行された場合のみ、process.argvを解析してmain()を呼ぶ。
// isMainModule()はpathToFileURL()でprocess.argv[1]を正しいfile URL形式に変換してから
// import.meta.urlと比較する（文字列連結ではWindowsのネイティブパス形式と一致しないため）。
if (isMainModule(import.meta.url)) {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (!cliArgs.area) {
    console.error('使用法: node tools/download/index.js --area <areaId> [--layers a,b] [--force]');
    process.exit(1);
  }
  main(cliArgs).catch((err) => {
    console.error('予期しないエラー:', err);
    process.exit(1);
  });
}
