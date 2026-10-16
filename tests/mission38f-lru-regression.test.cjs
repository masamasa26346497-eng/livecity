'use strict';
// 37G+38F LRU 回帰 QA の整合テスト（静的 + 保存済み QA 結果）。ブラウザ実行そのものは tools/experiments/mission38f_lru_regression_qa.mjs。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');
const qa = fs.readFileSync('tools/experiments/mission38f_lru_regression_qa.mjs', 'utf8');
const rep = JSON.parse(fs.readFileSync('data/reports/mission38f-lru/lru-qa.json', 'utf8'));

test('QA は 4 区以上を訪れ、再訪を含む', () => {
  assert.ok(new Set(rep.steps.map((s) => s.ward)).size >= 4);
  assert.strictEqual(rep.steps[0].ward, rep.steps[rep.steps.length - 1].ward);
});
test('保存済み結果: LRU は常に 3 区以内、evictions が増加', () => {
  for (const s of rep.steps) assert.ok(s.cached.length <= 3);
  assert.ok(rep.steps[rep.steps.length - 1].evictionsAfter > rep.steps[0].evictionsAfter);
  assert.ok(rep.checks.evictedSearchGone && rep.checks.selectedKept && rep.checks.kitaRefetched);
});
test('保存済み結果: JS 例外 0 / Google 通信 0 / 404 は favicon のみ', () => {
  assert.strictEqual(rep.jsErrorCount, 0);
  assert.strictEqual(rep.googleRequestCount, 0);
  assert.ok(rep.failedRequests.every((x) => /favicon\.ico/.test(x)));
});
test('ページ側の診断フィールドと選択中施設の保護が存在する', () => {
  assert.match(html, /facilityEvictions/);
  assert.match(html, /facilityCachedWards/);
  assert.match(html, /r !== poiFly/);
  assert.match(qa, /facilityCachedWards/);
});
