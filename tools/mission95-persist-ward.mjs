#!/usr/bin/env node
// Mission 95: 1 区の変換出力を検査し、pack -> private repo へ upload -> 再取得 sha256 検証 までを同期実行する。
// 使うのは Mission87 の関数のみ（--repo 明示・private 必須・専用 token・SHA 一致必須）。公開 repo / --allow-public は不可。
//   node tools/mission95-persist-ward.mjs --ward nishi --repo owner/livecity-3d-data [--root temp/mission80] [--execute]
import { pack, upload, verify, loadManifest, validWard, validRepo } from './mission87-persist.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const ward = opt('ward'), repo = opt('repo'), root = opt('root', 'temp/mission80');
  if (!validWard(ward)) throw new Error('invalid --ward');
  if (!validRepo(repo)) throw new Error('--repo owner/name is mandatory');
  if (a.includes('--allow-public')) throw new Error('--allow-public is not accepted here');
  const m0 = loadManifest();
  if (!m0.wards[ward] || !['packed', 'uploaded', 'verified'].includes(m0.wards[ward].status)) pack(ward, root);
  const up = upload(ward, { execute: a.includes('--execute'), repo });
  if (!a.includes('--execute')) { console.log(JSON.stringify({ dryRun: true, ward })); return; }
  const v = verify(ward, { repo });
  console.log(JSON.stringify({ ward, upload: up, verified: true, sha256: v.sha256 }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); }
}
