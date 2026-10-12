// tests/ci-select-tests.test.js — tools/ci/select-tests.js のロジック検証（ネットワーク不要）
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTests, parseTestList } from '../tools/ci/select-tests.js';

const list = ['tests/a.test.js', 'tests/b.test.js'];
const src = { 'tests/a.test.js': "read('tools/foo.js')", 'tests/b.test.js': 'nothing' };
const read = (t) => src[t] || '';

test('文書のみの変更はテスト対象なし・全件ではない', () => {
  const r = selectTests(['docs/x.md', 'CLAUDE.md'], list, read);
  assert.equal(r.full, false);
  assert.deepEqual(r.tests, []);
});

test('参照されるツールの変更は関連テストのみ', () => {
  const r = selectTests(['tools/foo.js'], list, read);
  assert.deepEqual(r.tests, ['tests/a.test.js']);
});

test('関連不明・共通基盤は全件に切り替わる', () => {
  assert.equal(selectTests(['tools/unknown.js'], list, read).full, true);
  assert.equal(selectTests(['package.json'], list, read).full, true);
  assert.equal(selectTests(['tools/lib/x.js'], list, read).tests.length, 2);
});

test('未登録の新規テスト・削除された未知ファイル・workflow変更は安全側で全件', () => {
  assert.equal(selectTests(['tests/new-unregistered.test.js'], list, read).full, true);
  assert.equal(selectTests(['tools/deleted-file.js'], list, read).full, true);
  assert.equal(selectTests(['.github/workflows/pr-fast-tests.yml'], list, read).full, true);
});

test('本テスト自身が npm test に登録されている', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(parseTestList(pkg).includes('tests/ci-select-tests.test.js'));
});

test('parseTestList は scripts.test からテストを抽出する', () => {
  assert.deepEqual(parseTestList({ scripts: { test: 'node --test tests/a.test.js tests/b.test.js' } }), list);
});
