#!/usr/bin/env node
// tools/ci/select-tests.js
// 実行: node tools/ci/select-tests.js [--base origin/main] [--files a,b] [--run] [--full]
//
// 目的（Mission 38 / A3）: PR向け軽量テスト。変更ファイルから関連テストを選び、必要なら実行する。
// 方針:
//   - 追加依存なし（Node.js組み込みのみ）。ネットワーク不使用。
//   - 選択対象は `npm test`（package.json の scripts.test）に列挙されたテストのみ。
//   - 関連が特定できない変更（package.json・tools/lib・未知のパス等）は安全側で全件に切り替える。
//   - ドキュメントのみの変更は「テスト対象なし」。これは全件が成功したという意味ではない。
//   - 全件検証は `npm test` として常に残る。
import { readFileSync, existsSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_ONLY = [/^docs\//, /^[^/]+\.md$/, /^\.github\/(ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)/];
const ALWAYS_FULL = [/^package(-lock)?\.json$/, /^tools\/lib\//, /^\.github\/workflows\//, /^tests\/_/];

export function parseTestList(pkg) {
  return pkg.scripts.test.match(/tests\/[\w.-]+\.test\.js/g) || [];
}

export function selectTests(changed, testList, readText) {
  const selected = new Set();
  let full = false;
  const reasons = [];
  for (const f of changed) {
    if (DOC_ONLY.some((re) => re.test(f))) continue;
    if (ALWAYS_FULL.some((re) => re.test(f))) {
      full = true;
      reasons.push(`${f}: 共通基盤のため全件`);
      continue;
    }
    if (testList.includes(f)) {
      selected.add(f);
      continue;
    }
    const base = path.basename(f);
    const hits = testList.filter((t) => {
      const src = readText(t);
      return src.includes(f) || src.includes(base);
    });
    if (hits.length === 0) {
      full = true;
      reasons.push(`${f}: 関連テストを特定できないため全件`);
      continue;
    }
    hits.forEach((h) => selected.add(h));
  }
  return { full, reasons, tests: full ? testList : [...selected].sort() };
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : null;
  };
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const testList = parseTestList(pkg);
  let changed;
  if (opt('--files')) changed = opt('--files').split(',').filter(Boolean);
  else {
    const base = opt('--base') || 'origin/main';
    changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  }
  const readText = (t) => (existsSync(path.join(ROOT, t)) ? readFileSync(path.join(ROOT, t), 'utf8') : '');
  const r = argv.includes('--full')
    ? { full: true, reasons: ['--full 指定'], tests: testList }
    : selectTests(changed, testList, readText);
  console.log(`changed files: ${changed.length}`);
  console.log(`mode: ${r.full ? 'FULL' : 'SELECTED'} (${r.tests.length}/${testList.length} tests)`);
  r.reasons.forEach((x) => console.log(`  - ${x}`));
  if (!r.tests.length) console.log('テスト対象なし（文書のみの変更）。全件成功を意味しない。');
  r.tests.forEach((t) => console.log(`  ${t}`));
  if (argv.includes('--run') && r.tests.length) {
    const res = spawnSync(process.execPath, ['--test', ...r.tests], { cwd: ROOT, stdio: 'inherit' });
    process.exit(res.status ?? 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
