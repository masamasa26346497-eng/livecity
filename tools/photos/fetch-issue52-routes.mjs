#!/usr/bin/env node
// Issue #52: Wikidata P18 の取得 → Commons imageinfo → 統一候補 → 照合 → 採用/保留レポート。
// 取得は lib/safe-fetch.mjs 経由のみ（読み取り専用・許可ホスト限定・リダイレクト先検証・間隔・リトライ上限・キャッシュ）。
// 公開索引は変更しない。出力は data/photos/issue52-import-report.json と data/photos/issue52-adopted.json（レビュー後に mergeIntoIndex で接続）。
//   node tools/photos/fetch-issue52-routes.mjs --offline            キャッシュのみで再実行（外部通信なし）
//   node tools/photos/fetch-issue52-routes.mjs --limit 200          取得対象の建物数の上限（小分け・再開可能: 取得済みはキャッシュから）
// 注意: 外部取得は権限が付与されるまで実行しない。このスクリプトを実行しただけでは索引は変わらない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFetcher } from './lib/safe-fetch.mjs';
import { fromWikidataEntities, parseImageInfo, enrichRefs } from './lib/route-adapters.mjs';
import { importCandidates } from './lib/import-candidates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

export const wikidataUrl = (qids) => 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=' + qids.join('%7C');
export const imageInfoUrl = (files) => 'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url%7Cextmetadata%7Csize&iiurlwidth=320&titles='
  + files.map((f) => encodeURIComponent('File:' + f)).join('%7C');

// getJson: (url) => Promise<json>。試験では記録済みレスポンスを返す関数を渡す。
export async function run(index, getJson, opts) {
  const o = opts || {};
  const qidToCanonical = {}, buildings = {};
  let entries = Object.entries(index.byCanonicalId || {}).filter(([, e]) => /^Q\d+$/.test(e.wikidataId || ''));
  if (o.limit) entries = entries.slice(0, o.limit);
  for (const [id, e] of entries) {
    (qidToCanonical[e.wikidataId] = qidToCanonical[e.wikidataId] || []).push(id);
    buildings[id] = { names: [e.buildingName, e.curatedName, e.wikidataLabel].filter(Boolean), addressTokens: [], otherNames: [], otherAddressTokens: [] };
  }
  const refs = [], skipped = [];
  for (const qs of chunk(Object.keys(qidToCanonical), 50)) {
    const r = fromWikidataEntities(await getJson(wikidataUrl(qs)), qidToCanonical);
    refs.push(...r.refs); skipped.push(...r.skipped);
  }
  const info = new Map();
  for (const fs_ of chunk([...new Set(refs.map((r) => r.file))], 40)) for (const [k, v] of parseImageInfo(await getJson(imageInfoUrl(fs_)))) info.set(k, v);
  const { candidates, unresolved } = enrichRefs(refs, info, buildings, { fetchedAt: o.fetchedAt || new Date().toISOString().slice(0, 10) });
  const res = importCandidates(candidates, index, { relocated: o.relocated });
  return { result: res, skipped, unresolved, targets: entries.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/building-photo-index.json'), 'utf8'));
  const fetcher = createFetcher({ fetchImpl: globalThis.fetch, cacheDir: path.join(root, 'data/photos/cache'), offline: args.includes('--offline'), minIntervalMs: 1000 });
  const li = args.indexOf('--limit');
  const out = await run(idx, (u) => fetcher.getJson(u), { limit: li >= 0 ? +args[li + 1] : 0 });
  fs.mkdirSync(path.join(root, 'data/photos'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/photos/issue52-import-report.json'), JSON.stringify({ targets: out.targets, stats: out.result.stats, skipped: out.skipped, unresolved: out.unresolved, held: out.result.held, fetcher: fetcher.stats }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'data/photos/issue52-adopted.json'), JSON.stringify(out.result.adopted, null, 2) + '\n');
  console.log(JSON.stringify({ targets: out.targets, stats: out.result.stats, fetcher: fetcher.stats }, null, 2));
}
