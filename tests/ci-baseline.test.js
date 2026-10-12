// tests/ci-baseline.test.js — tools/ci/baseline.js と classify-tap-failures.js の検証（ネットワーク不要）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verdict } from '../tools/ci/baseline.js';
import { parseFailures, classify } from '../tools/ci/classify-tap-failures.js';

test('新規失敗があれば ok=false、既知の赤だけなら ok=true だが known に残る', () => {
  const v1 = verdict(1, [{ name: 'a' }, { name: 'new' }], ['a', 'b']);
  assert.equal(v1.ok, false);
  assert.deepEqual(v1.newFailures, ['new']);
  const v2 = verdict(1, [{ name: 'a' }], ['a', 'b']);
  assert.equal(v2.ok, true);
  assert.deepEqual(v2.knownFailures, ['a']);
  assert.deepEqual(v2.nowPassing, ['b']);
});

test('非0終了なのに失敗を解析できない場合は異常終了として失敗', () => {
  assert.equal(verdict(1, [], ['a']).ok, false);
  assert.equal(verdict(0, [], ['a']).ok, true);
});

test('TAPから失敗を抽出し分類する（手がかりが無ければ unknown）', () => {
  const log = [
    '2026-10-12T00:00:00.0Z ok 1 - fine',
    '2026-10-12T00:00:00.0Z not ok 2 - needs data',
    '2026-10-12T00:00:00.0Z   error: "ENOENT: no such file"',
    '2026-10-12T00:00:00.0Z not ok 3 - odd',
    '2026-10-12T00:00:00.0Z   error: "boom"',
  ].join('\n');
  const f = parseFailures(log);
  assert.deepEqual(f.map((x) => x.category), ['data-missing', 'unknown']);
  assert.equal(classify('ReferenceError: x is not defined'), 'not-defined');
});

test('同梱 baseline は 104 件・名前重複なし', () => {
  const b = JSON.parse(readFileSync(new URL('../tools/ci/baseline/pr29-run38190403528.json', import.meta.url), 'utf8'));
  assert.equal(b.failures.length, 104);
  assert.equal(new Set(b.failures.map((f) => f.name)).size, 104);
});

test('本テストが npm test に登録されている', () => {
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.ok(pkg.includes('tests/ci-baseline.test.js'));
});
