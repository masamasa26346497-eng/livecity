#!/usr/bin/env node
// tools/ci/parallel-merge-gate.js
// 実行: node tools/ci/parallel-merge-gate.js --base origin/main <refA> <refB>
//
// 目的（Mission 38）: 並列に作られた2つのブランチを統合する前の機械的チェック。読み取り専用。
// 判定は fail closed（不明・取得失敗・予期しない変更はすべて失敗）。
// 重要: 「同一ファイルの変更が無い」ことは意味上の競合が無いことを保証しない。
//       PASS でも両ブランチをマージした状態でのテストと人手レビューが必要。
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 触れてはならない／別承認が要るパス
export const CRITICAL = [
  /^\.github\//, /^package(-lock)?\.json$/, /^CLAUDE\.md$/, /^public\//, /^data\//, /^config\//,
  /^tools\/lib\//, /^tools\/ci\//, /(^|\/)\.env/, /secret|credential|\.pem$|\.key$/i,
];
const ALLOWED_STATUS = new Set(['A', 'M']);
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/;

/** ref を検証する。shell は使わないが、オプション注入・不正文字は拒否する。 */
export function validateRef(ref) {
  if (typeof ref !== 'string' || !REF_RE.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) {
    throw new Error(`不正なref: ${JSON.stringify(ref)}`);
  }
  return ref;
}

/** `git diff --name-status -z -M` の出力を解析。解析不能なら例外（fail closed）。 */
export function parseNameStatus(out) {
  const parts = out.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  const entries = [];
  for (let i = 0; i < parts.length; ) {
    const st = parts[i++];
    const code = st && st[0];
    if (!code || !/^[A-Z]$/.test(code)) throw new Error(`解析不能なstatus: ${JSON.stringify(st)}`);
    if (code === 'R' || code === 'C') {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      if (!oldPath || !newPath) throw new Error('rename/copy のパスが不足');
      entries.push({ status: code, path: newPath, oldPath });
    } else {
      const p = parts[i++];
      if (!p) throw new Error('パスが不足');
      entries.push({ status: code, path: p });
    }
  }
  return entries;
}

/** 純粋関数: 2つの変更集合を比較。ok / failures / warnings を返す */
export function analyze(a, b) {
  const failures = [];
  const warnings = [
    '同一ファイルの変更が無くても意味上の競合が無いとは限らない（API/テスト/設定の暗黙の依存）。両方をマージした状態でのテストと人手レビューが必要。',
  ];
  for (const [name, set] of [['A', a], ['B', b]]) {
    if (set.length === 0) failures.push(`${name}: 変更が空（取得失敗または想定外）`);
    for (const e of set) {
      if (!ALLOWED_STATUS.has(e.status)) failures.push(`${name}: 追加/変更以外の操作 ${e.status} ${e.oldPath ? e.oldPath + ' -> ' : ''}${e.path}`);
      for (const p of [e.path, e.oldPath].filter(Boolean)) {
        if (CRITICAL.some((re) => re.test(p))) failures.push(`${name}: 重要パスの変更 ${p}`);
      }
    }
  }
  const paths = (s) => new Set(s.flatMap((e) => [e.path, e.oldPath].filter(Boolean)));
  const pb = paths(b);
  for (const p of paths(a)) if (pb.has(p)) failures.push(`同一ファイルを両方が変更: ${p}`);
  return { ok: failures.length === 0, failures: [...new Set(failures)], warnings };
}

const defaultGit = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });

/** git から変更集合を取得して判定。git は注入可能（テスト用）。 */
export function gate(input, git = defaultGit) {
  const { base, refA, refB } = input;
  [base, refA, refB].forEach(validateRef);
  if (refA === refB) throw new Error('A と B が同一ref');
  const rev = (r) => git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${r}^{commit}`]).trim();
  const mb = (r) => git(['merge-base', rev(base), rev(r)]).trim();
  const baseA = mb(refA);
  const baseB = mb(refB);
  const diff = (b, r) => parseNameStatus(git(['diff', '--name-status', '-z', '-M', b, rev(r), '--']));
  const res = analyze(diff(baseA, refA), diff(baseB, refB));
  if (baseA !== baseB) res.failures.push(`共通baseが異なる: A=${baseA} B=${baseB}`);
  res.ok = res.failures.length === 0;
  return res;
}

function main() {
  const argv = process.argv.slice(2);
  const bi = argv.indexOf('--base');
  const base = bi >= 0 ? argv.splice(bi, 2)[1] : 'origin/main';
  try {
    if (argv.length !== 2) throw new Error('使い方: --base <ref> <refA> <refB>');
    const r = gate({ base, refA: argv[0], refB: argv[1] });
    r.warnings.forEach((w) => console.log(`::warning::${w}`));
    r.failures.forEach((f) => console.log(`::error::${f}`));
    console.log(r.ok ? 'PASS（ファイル単位の機械チェックのみ。統合可否の保証ではない）' : 'FAIL');
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.log(`::error::fail closed: ${e.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
