#!/usr/bin/env node
// tools/ci/classify-tap-failures.js
// 実行: node tools/ci/classify-tap-failures.js <tap-or-actions-log> [--json]
//
// 目的（Mission 38）: node --test の TAP ログから失敗テストを抜き出し、失敗メッセージの
// 機械的な手がかりでカテゴリ分けする。ネットワーク不使用・読み取り専用。
// 分類は「ログ上の文字列」だけが根拠。コードを実行して原因を確定したものではない。
//   data-missing : ENOENT / 「manifest が無い」等、生成データ欠落を示す文字列
//   env-or-dep   : MODULE_NOT_FOUND / ECONN / timeout 等
//   not-defined  : ReferenceError (… is not defined)。コード側の不具合の疑い
//   assertion    : 上記以外の AssertionError
//   unknown      : 手がかりなし（推測で割り当てない）
import { readFileSync } from 'fs';

export const CATEGORIES = [
  ['data-missing', /ENOENT|が無い|が存在し|not found|no such file/i],
  ['env-or-dep', /MODULE_NOT_FOUND|ECONN|ETIMEDOUT|timed out|EACCES|ERR_MODULE_NOT_FOUND/i],
  ['not-defined', /ReferenceError|is not defined/],
  ['assertion', /AssertionError|ERR_ASSERTION|expected|actual/i],
];

export function classify(text) {
  for (const [name, re] of CATEGORIES) if (re.test(text)) return name;
  return 'unknown';
}

export function parseFailures(log) {
  const lines = log.split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ''));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    const block = [];
    for (let j = i + 1; j < lines.length && !/^(not )?ok \d+ /.test(lines[j]); j++) block.push(lines[j]);
    const text = block.join('\n');
    const err = /error: ['"|>-]?\s*(.*)/.exec(text);
    out.push({ name: m[1], error: err ? err[1].slice(0, 200) : '', category: classify(`${m[1]}\n${text}`) });
  }
  return out;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: classify-tap-failures.js <log> [--json]');
    process.exit(2);
  }
  const fails = parseFailures(readFileSync(file, 'utf8'));
  if (process.argv.includes('--json')) return console.log(JSON.stringify(fails, null, 2));
  const counts = {};
  fails.forEach((f) => (counts[f.category] = (counts[f.category] || 0) + 1));
  console.log(`failures: ${fails.length}`);
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  fails.forEach((f) => console.log(`[${f.category}] ${f.name} :: ${f.error}`));
}

import path from 'path';
import { fileURLToPath } from 'url';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
