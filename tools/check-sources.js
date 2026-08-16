#!/usr/bin/env node
// tools/check-sources.js
// 実行: node tools/check-sources.js
//
// 重要: 各データセットのsourcePage/downloadUrlへHEADリクエストを送り、到達可能性を確認する。
// ネットワーク接続が必要なため、Claude Code環境では実行できない。
import { loadAllDatasets } from './lib/dataset.js';

async function checkUrl(url) {
  if (!url) return { reachable: null, note: 'URL未設定（page-link-detection方式）' };
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return { reachable: res.ok, status: res.status };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

async function main() {
  const datasets = await loadAllDatasets();
  console.log(`=== ${datasets.length}件のデータセットの取得元を確認中 ===\n`);
  for (const d of datasets) {
    console.log(`■ ${d.id}`);
    const pageCheck = await checkUrl(d.sourcePage);
    console.log(`  配布ページ: ${d.sourcePage} -> ${pageCheck.reachable === null ? '(チェック不可)' : pageCheck.reachable ? 'OK' : `NG (${pageCheck.status || pageCheck.error})`}`);
    if (d.downloadUrl) {
      const downloadCheck = await checkUrl(d.downloadUrl);
      console.log(`  ダウンロードURL: ${d.downloadUrl} -> ${downloadCheck.reachable ? 'OK' : `NG (${downloadCheck.status || downloadCheck.error})`}`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
