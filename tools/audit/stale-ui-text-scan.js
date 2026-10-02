#!/usr/bin/env node
// tools/audit/stale-ui-text-scan.js
// [Mission 32R §13] 旧 3 区（南港南）時代の UI 文言の残存をリポジトリ全体で数える。
//   対象語: 南港南 / 弁天町駅 / 徒歩12分
//   data/raw・node_modules・.git と画像等のバイナリは除外。巨大ファイルも行単位で全部読む。
//   各ヒットは「UI コード / テスト・検証コード（検出用の文字列）/ データ値（地名として正しい）/ 過去レポートの記録」に分類する。
//   実行: node tools/audit/stale-ui-text-scan.js --label=before|after
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';

export const TERMS = ['南港南', '弁天町駅', '徒歩12分'];
const ROOT = resolveProjectPath('.');
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude']);
const SKIP_PREFIX = ['data/raw/'];
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.geojson', '.html', '.md', '.txt', '.css', '.csv', '.jsonl', '.yml', '.yaml']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = toProjectRelativePath(p).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || SKIP_PREFIX.some((s) => (rel + '/').startsWith(s))) continue;
      yield* walk(p);
    } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) && !/-DESKTOP-/.test(e.name) && !/^stale-ui-text-scan-.*\.json$/.test(e.name)) {
      // ↑ このスキャン自身の出力（ヒット一覧）は数えない
      yield { p, rel };
    }
  }
}

export function classify(rel, line) {
  if (/^public\/osaka_3d_buildings\.ward-ux-v1\.html$/.test(rel)) {
    if (/^\s*\/\//.test(line) || /\/\/ \[Mission 32[QR]/.test(line)) return 'dev-html-comment';
    return 'dev-html-ui';
  }
  if (/^public\/osaka_3d_buildings(\.fullward-v3)?\.html$/.test(rel)) return 'production-or-protected-html（変更禁止）';
  if (/^public\/.*\.html$/.test(rel) || /^(temp|backup|handoff|livecity)\//.test(rel)) return 'archived-html-copy（旧実験・staging のコピー。dev/production ではない）';
  if (/^public\//.test(rel)) return 'public-data';
  if (/^(tests|tools\/validate|tools\/audit)\//.test(rel)) return 'test-or-validator-string';
  if (/^data\/reports\//.test(rel) || /^MISSION.*\.md$/.test(rel)) return 'historical-report-record';
  if (/^data\/processed\//.test(rel)) return 'data-value';
  return 'other';
}

export async function scan() {
  const hits = [];
  let files = 0;
  for (const { p, rel } of walk(ROOT)) {
    files++;
    const st = fs.statSync(p);
    if (st.size < 8 * 1024 * 1024) {
      const t = fs.readFileSync(p, 'utf-8');
      if (!TERMS.some((w) => t.includes(w))) continue;
      t.split(/\r?\n/).forEach((line, i) => { for (const w of TERMS) if (line.includes(w)) hits.push({ file: rel, line: i + 1, term: w, cls: classify(rel, line), text: snippet(line, w) }); });
    } else {
      const rl = readline.createInterface({ input: fs.createReadStream(p, { encoding: 'utf-8' }), crlfDelay: Infinity });
      let i = 0;
      for await (const line of rl) { i++; for (const w of TERMS) if (line.includes(w)) hits.push({ file: rel, line: i, term: w, cls: classify(rel, line), text: snippet(line, w) }); }
    }
  }
  return { files, hits };
}
function snippet(line, w) { const k = line.indexOf(w); return line.slice(Math.max(0, k - 60), k + 60).trim(); }

async function main() {
  const label = (process.argv.find((a) => a.startsWith('--label=')) || '--label=scan').slice(8);
  const t0 = Date.now();
  const { files, hits } = await scan();
  const byClass = {}, byTerm = {}, byFile = {};
  for (const h of hits) { byClass[h.cls] = (byClass[h.cls] || 0) + 1; byTerm[h.term] = (byTerm[h.term] || 0) + 1; byFile[h.file] = (byFile[h.file] || 0) + 1; }
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '32R', label, terms: TERMS, filesScanned: files, total: hits.length, byTerm, byClass, byFile, hits, elapsedMs: Date.now() - t0 };
  fs.writeFileSync(resolveProjectPath(path.join('data', 'reports', `stale-ui-text-scan-${label}.json`)), JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  main().then((o) => {
    console.log(JSON.stringify({ files: o.filesScanned, total: o.total, byTerm: o.byTerm, byClass: o.byClass, byFile: o.byFile, sec: Math.round(o.elapsedMs / 1000) }, null, 1));
    for (const h of o.hits.filter((x) => x.cls.startsWith('dev-html') || x.cls.startsWith('production'))) console.log('  ', h.file + ':' + h.line, h.cls, h.text);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
