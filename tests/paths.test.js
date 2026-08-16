// tests/paths.test.js
// パス解決の回帰テスト。C:\C:\のような二重化バグの再発を防ぐ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { PROJECT_ROOT, resolveProjectPath, areaConfigPath, datasetConfigPath } from '../tools/lib/paths.js';

test('PROJECT_ROOTは単一の絶対パスであり、二重化や重複セグメントを含まない', () => {
  assert.ok(path.isAbsolute(PROJECT_ROOT));
  // ドライブ文字やルートの重複がないことを確認（例: "C:" が2回出現しない）
  const driveMatches = PROJECT_ROOT.match(/[A-Za-z]:/g) || [];
  assert.ok(driveMatches.length <= 1, `ドライブ文字が複数回出現している: ${PROJECT_ROOT}`);
});

test('resolveProjectPath: 絶対パス入力はそのまま返す（projectRootを付加しない）', () => {
  const absInput = path.resolve('/some/absolute/path/config.json');
  const result = resolveProjectPath(absInput);
  assert.equal(result, path.normalize(absInput));
  assert.ok(!result.includes(PROJECT_ROOT) || absInput.startsWith(PROJECT_ROOT));
});

test('resolveProjectPath: 相対パス入力はPROJECT_ROOTを基準に解決する', () => {
  const result = resolveProjectPath('config/areas/test.json');
  assert.equal(result, path.resolve(PROJECT_ROOT, 'config/areas/test.json'));
  assert.ok(result.startsWith(PROJECT_ROOT));
});

test('areaConfigPath: area IDから単一の正しいパスを生成する（手動文字列連結ではなくpath.joinベース）', () => {
  const result = areaConfigPath('osaka-sumiyoshi');
  assert.equal(result, path.join(PROJECT_ROOT, 'config', 'areas', 'osaka-sumiyoshi.json'));
});

test('areaConfigPath: 存在しないarea IDでもパス生成自体は成功する（存在チェックは別の責務）', () => {
  const result = areaConfigPath('totally-nonexistent-area');
  assert.ok(path.isAbsolute(result));
  assert.ok(result.endsWith('totally-nonexistent-area.json'));
});

test('datasetConfigPath: dataset IDから単一の正しいパスを生成する', () => {
  const result = datasetConfigPath('osaka-census-2020-population-households');
  assert.equal(result, path.join(PROJECT_ROOT, 'config', 'datasets', 'osaka-census-2020-population-households.json'));
});
