// tests/ci-parallel-merge-gate.test.js — tools/ci/parallel-merge-gate.js の検証（ネットワーク不要・一時gitリポジトリ使用）
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyze, parseNameStatus, validateRef, gate } from '../tools/ci/parallel-merge-gate.js';

const M = (p) => ({ status: 'M', path: p });
const A = (p) => ({ status: 'A', path: p });
const SCRIPT = new URL('../tools/ci/parallel-merge-gate.js', import.meta.url).pathname;

test('PASS: 独立したファイルのみ。ただし常に意味上の競合の警告を返す', () => {
  const r = analyze([A('docs/a.md')], [A('docs/b.md')]);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('意味上の競合')));
});

test('FAIL: 同一ファイル', () => {
  const r = analyze([M('docs/x.md')], [A('docs/x.md')]);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('docs/x.md')));
});

test('FAIL: 重要パス（workflow/package.json/public/data/secrets 等）', () => {
  const paths = ['.github/workflows/x.yml', 'package.json', 'public/osaka_3d_buildings.html', 'data/raw/a.json', 'docs/my-secret.txt', 'tools/lib/a.js', '.env'];
  for (const p of paths) assert.equal(analyze([M(p)], [A('docs/b.md')]).ok, false, p);
});

test('FAIL: 削除・リネーム・不明status・空の変更', () => {
  assert.equal(analyze([{ status: 'D', path: 'docs/a.md' }], [A('docs/b.md')]).ok, false);
  assert.equal(analyze([{ status: 'R', path: 'docs/n.md', oldPath: 'docs/o.md' }], [A('docs/b.md')]).ok, false);
  assert.equal(analyze([{ status: 'T', path: 'docs/a.md' }], [A('docs/b.md')]).ok, false);
  assert.equal(analyze([], [A('docs/b.md')]).ok, false);
});

test('リネーム元と相手の変更が衝突すれば検出する', () => {
  const r = analyze([{ status: 'R', path: 'docs/n.md', oldPath: 'docs/o.md' }], [M('docs/o.md')]);
  assert.ok(r.failures.some((f) => f.includes('同一ファイル')));
});

test('安全な引数処理: 不正refを拒否（オプション注入・空白・..・shell記号）', () => {
  for (const bad of ['--output=/tmp/x', '-h', 'a b', 'a;rm -rf /', '$(id)', 'a..b', '', null, 'x/', 'a`id`']) {
    assert.throws(() => validateRef(bad), /不正なref/, String(bad));
  }
  assert.equal(validateRef('claude/issue-33-20261013-1652'), 'claude/issue-33-20261013-1652');
  assert.equal(validateRef('origin/main'), 'origin/main');
});

test('parseNameStatus: -z 出力を解析し、壊れた入力は例外', () => {
  const e = parseNameStatus('A\0a.md\0R100\0old.md\0new.md\0');
  assert.deepEqual(e, [{ status: 'A', path: 'a.md' }, { status: 'R', path: 'new.md', oldPath: 'old.md' }]);
  assert.throws(() => parseNameStatus('A\0'));
  assert.throws(() => parseNameStatus('??\0a\0'));
});

test('gate: 未知refは fail closed（例外）', () => {
  const git = (args) => {
    if (args[0] === 'rev-parse') throw new Error('unknown revision');
    return '';
  };
  assert.throws(() => gate({ base: 'origin/main', refA: 'nope-a', refB: 'nope-b' }, git));
  assert.throws(() => gate({ base: 'origin/main', refA: 'same', refB: 'same' }, git), /同一ref/);
});

// ---- 実gitによる統合テスト（一時リポジトリ） ----
function makeRepo() {
  const d = mkdtempSync(path.join(tmpdir(), 'pmg-'));
  const g = (...a) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  mkdirSync(path.join(d, 'docs'));
  writeFileSync(path.join(d, 'docs/base.md'), 'base\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  const branch = (name, files, extra) => {
    g('checkout', '-q', '-b', name, 'main');
    for (const [f, c] of Object.entries(files)) writeFileSync(path.join(d, f), c);
    if (extra) extra();
    g('add', '-A');
    g('commit', '-q', '-m', name);
  };
  return { d, g, branch };
}

test('実git: 独立=PASS / 同一ファイル・削除・リネーム・base相違=FAIL', () => {
  const { d, g, branch } = makeRepo();
  try {
    const git = (args) => execFileSync('git', ['-C', d, ...args], { encoding: 'utf8' });
    branch('a', { 'docs/a.md': 'a' });
    branch('b', { 'docs/b.md': 'b' });
    assert.equal(gate({ base: 'main', refA: 'a', refB: 'b' }, git).ok, true);
    branch('c', { 'docs/a.md': 'conflict' });
    assert.equal(gate({ base: 'main', refA: 'a', refB: 'c' }, git).ok, false);
    branch('d', {}, () => g('rm', '-q', 'docs/base.md'));
    assert.equal(gate({ base: 'main', refA: 'a', refB: 'd' }, git).ok, false);
    branch('e', {}, () => g('mv', 'docs/base.md', 'docs/moved.md'));
    assert.equal(gate({ base: 'main', refA: 'a', refB: 'e' }, git).ok, false);
    g('checkout', '-q', 'main');
    writeFileSync(path.join(d, 'docs/m2.md'), 'x');
    g('add', '.');
    g('commit', '-q', '-m', 'main2');
    branch('f', { 'docs/f.md': 'f' });
    const rb = gate({ base: 'main', refA: 'a', refB: 'f' }, git);
    assert.ok(rb.failures.some((x) => x.includes('共通base')), 'base相違は失敗');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('CLI: 不正な引数・未知refは非0（fail closed）', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--base', 'origin/main', '--evil', 'x'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, 'only-one'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--base', 'origin/main', 'no-such-ref-1', 'no-such-ref-2'], { encoding: 'utf8' }).status, 2);
});

test('CI v2 提案の ci-tools ジョブが本テストを実際に実行する', () => {
  const yml = readFileSync(new URL('../docs/development/proposed-workflows/pr-fast-tests.v2.yml.txt', import.meta.url), 'utf8');
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^  ci-tools:\s*$/.test(l));
  assert.ok(start >= 0, 'ci-tools ジョブが存在する');
  // 次のジョブ（インデント2のキー）までを ci-tools ジョブ本体とみなす
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) { end = i; break; }
  }
  const job = lines.slice(start, end).filter((l) => !/^\s*#/.test(l));
  const runLines = job.filter((l) => /^\s*-\s*run:\s*node --test\b/.test(l));
  assert.ok(runLines.length >= 1, 'ci-tools に node --test の run ステップがある');
  assert.ok(
    runLines.some((l) => l.split(/\s+/).includes('tests/ci-parallel-merge-gate.test.js')),
    'ci-tools の node --test 引数に tests/ci-parallel-merge-gate.test.js が含まれる',
  );
  assert.ok(!job.some((l) => /continue-on-error:\s*true/.test(l)), 'ci-tools は continue-on-error で赤を許さない');
  assert.ok(!job.some((l) => /\|\|\s*true/.test(l)), 'ci-tools は || true で失敗を握りつぶさない');
});
