#!/usr/bin/env node
// tools/download/census/index.js
// 実行: node tools/download/census/index.js --area osaka-sumiyoshi [--datasets a,b] [--force]
//
// 重要: このスクリプトは実際に大阪市・社人研等のサイトへネットワーク接続する。
// Claude Codeの隔離環境では実行できない。ローカルPCまたはCI環境で実行すること。

import path from 'path';
import { existsSync } from 'fs';
import { loadAreaConfig, rawDir, ensureDir, writeJson, writeJsonCompact } from '../../lib/area.js';
import { loadDataset } from '../../lib/dataset.js';
import { buildMetadata } from '../../lib/metadata.js';
import { isMainModule } from '../../lib/paths.js';

function parseArgs(argv) {
  const args = { area: null, datasets: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
    else if (argv[i] === '--datasets') args.datasets = argv[++i].split(',').map((s) => s.trim());
    else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

/**
 * 配布ページのHTMLから、textPatternに一致するリンクのhrefを抽出する。
 * 規約に反するスクレイピングではなく、公開HTMLから「現在どのファイルが最新か」を
 * 判定するための最小限のリンク検出（ダウンロードURLが毎回変わることへの対応）。
 */
async function detectLinkFromPage(sourcePage, textPattern) {
  const res = await fetch(sourcePage);
  if (!res.ok) throw new Error(`配布ページの取得に失敗: HTTP ${res.status} (${sourcePage})`);
  const html = await res.text();
  // <a href="...">テキスト</a> という構造から、テキストパターンに一致するリンクのhrefを抽出する
  const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/g;
  const pattern = new RegExp(textPattern);
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const [, href, text] = match;
    if (pattern.test(text)) {
      // 相対URLの場合は絶対URLへ変換する
      return new URL(href, sourcePage).toString();
    }
  }
  return null;
}

async function downloadFile(url, context) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(
      `ネットワークエラー: ${err.message}\n` +
      `  データセット: ${context.datasetId}\n` +
      (context.statInfId ? `  statInfId: ${context.statInfId}\n` : '') +
      `  URL: ${url}\n` +
      `  保存先: ${context.outPath}\n` +
      `  再実行: npm run data:download:demographics -- --area ${context.areaId} --datasets ${context.datasetId} --force`
    );
  }
  if (!res.ok) {
    throw new Error(
      `ダウンロード失敗: HTTP ${res.status} ${res.statusText}\n` +
      `  データセット: ${context.datasetId}\n` +
      (context.statInfId ? `  statInfId: ${context.statInfId}\n` : '') +
      `  URL: ${url}\n` +
      `  保存先: ${context.outPath}\n` +
      `  再実行: npm run data:download:demographics -- --area ${context.areaId} --datasets ${context.datasetId} --force`
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer()); // 生バイトのまま取得する(文字列化経路を通さない)
  return buffer;
}

async function downloadDataset(areaId, datasetId, force) {
  const dataset = await loadDataset(datasetId);
  const outDir = path.join(rawDir(areaId), 'census');
  await ensureDir(outDir);
  const ext = dataset.format === 'xlsx' ? 'xlsx' : dataset.format === 'csv' ? 'csv' : 'bin';
  const outPath = path.join(outDir, `${datasetId}.${ext}`);
  const metaPath = path.join(outDir, `${datasetId}.meta.json`);

  if (!force && existsSync(outPath)) {
    console.log(`[SKIP] ${datasetId}: 既存ファイルあり (${outPath})。再取得する場合は --force を指定。`);
    return { datasetId, status: 'skipped-exists' };
  }

  let downloadUrl = dataset.downloadUrl;
  if (!downloadUrl && dataset.acquisitionMode === 'page-link-detection') {
    console.log(`[DETECT] ${datasetId}: 配布ページからリンクを検出中... (${dataset.sourcePage})`);
    downloadUrl = await detectLinkFromPage(dataset.sourcePage, dataset.linkDetection.textPattern);
    if (!downloadUrl) {
      throw new Error(
        `配布ページからリンクを検出できませんでした。サイト構成が変わった可能性があります。` +
        `手動確認: ${dataset.sourcePage}`
      );
    }
    console.log(`[DETECT] ${datasetId}: 検出したURL: ${downloadUrl}`);
  }
  if (!downloadUrl) {
    throw new Error(`${datasetId}: ダウンロードURLが取得できませんでした（acquisitionMode: ${dataset.acquisitionMode}）。`);
  }

  console.log(`[FETCH] ${datasetId}: ${downloadUrl}`);
  const buffer = await downloadFile(downloadUrl, {
    datasetId, areaId, outPath, statInfId: dataset.statInfId || null,
  });

  const fs = await import('fs/promises');
  await fs.writeFile(outPath, buffer);

  const metadata = buildMetadata(dataset, {
    valueType: dataset.valueType,
    downloadedAt: new Date().toISOString(),
    checksumSource: buffer,
  });
  metadata.downloadUrl = downloadUrl; // 検出されたURLで上書き（固定URLの場合はdataset.downloadUrlと同じ）
  await writeJson(metaPath, metadata);

  console.log(`[OK] ${datasetId}: ${buffer.length} bytes -> ${outPath}`);
  return { datasetId, status: 'downloaded', bytes: buffer.length };
}

async function main(args) {
  const areaConfig = await loadAreaConfig(args.area);
  if (!areaConfig.demographics || !areaConfig.demographics.enabled) {
    console.log(`[SKIP] ${args.area}: demographics設定が無効です。`);
    return [];
  }

  const datasetIds = args.datasets || areaConfig.demographics.datasets;
  const results = [];
  for (const datasetId of datasetIds) {
    try {
      const result = await downloadDataset(args.area, datasetId, args.force);
      results.push(result);
    } catch (err) {
      console.error(`[FAIL] ${datasetId}: ${err.message}`);
      results.push({ datasetId, status: 'failed', error: err.message });
    }
  }

  console.log('\n=== 人口統計取得結果サマリ ===');
  for (const r of results) {
    console.log(`  ${r.datasetId}: ${r.status}`);
  }
  return results;
}

export async function run(args) {
  if (!args.area) throw new Error('area引数が指定されていません。');
  return main(args);
}

if (isMainModule(import.meta.url)) {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (!cliArgs.area) {
    console.error('使用法: node tools/download/census/index.js --area <areaId> [--datasets a,b] [--force]');
    process.exit(1);
  }
  main(cliArgs).catch((err) => {
    console.error('予期しないエラー:', err);
    process.exit(1);
  });
}
