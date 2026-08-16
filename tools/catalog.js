#!/usr/bin/env node
// tools/catalog.js
// 実行: node tools/catalog.js
// config/datasets/ 配下の全データセット定義を一覧表示する。
import { loadAllDatasets } from './lib/dataset.js';

async function main() {
  const datasets = await loadAllDatasets();
  if (!datasets.length) {
    console.log('config/datasets/ にデータセット定義がありません。');
    return;
  }
  console.log(`=== データセットカタログ（${datasets.length}件） ===\n`);
  for (const d of datasets) {
    console.log(`■ ${d.id}`);
    console.log(`  タイトル: ${d.title}`);
    console.log(`  提供元: ${d.provider}`);
    console.log(`  分類: ${d.classification || '未分類'}  取得方式: ${d.acquisitionMode}`);
    console.log(`  地域粒度: ${d.geographicLevel}  valueType: ${d.valueType}`);
    console.log(`  ライセンス: ${d.license}`);
    console.log(`  有効: ${d.enabled ? 'はい' : 'いいえ'}`);
    if (d.notes) console.log(`  注記: ${d.notes}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
