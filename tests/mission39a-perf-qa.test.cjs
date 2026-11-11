'use strict';
// 39A: 保存済みの性能・安定化 QA 結果（実 Chrome / headless）の整合を確認する。
// ブラウザ実行そのものは tools/experiments/mission39a_perf_stability_qa.mjs。headless の FPS は実機値ではない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const qa = JSON.parse(fs.readFileSync('data/reports/mission39a-perf/perf-qa.json', 'utf8'));

test('39A: 4 シナリオ（desktop/mobile × fac=0/1）が揃っている', () => {
  assert.deepStrictEqual(qa.results.map((r) => r.label).sort(), ['desktop-fac0', 'desktop-fac1', 'mobile-fac0', 'mobile-fac1']);
});

test('39A: 全シナリオで 起動 / 建物クリック / 写真表示 が成立し、JS 例外・Google 通信・404 が 0', () => {
  for (const r of qa.results) {
    assert.ok(!r.error, r.label + ' error');
    for (const [k, v] of Object.entries(r.checks)) assert.strictEqual(v, true, `${r.label}.${k}`);
    assert.strictEqual(r.googleRequests.length, 0);
    assert.strictEqual(r.jsErrors.length, 0);
  }
});

test('39A: fac=0 と fac=1 のズーム/回転 p95 が 2 倍以内で差が出ない（headless では施設ロードの影響を分離できない）', () => {
  for (const dev of ['desktop', 'mobile']) {
    const a = qa.results.find((r) => r.label === dev + '-fac0');
    const b = qa.results.find((r) => r.label === dev + '-fac1');
    assert.ok(b.rotate360.p95 <= a.rotate360.p95 * 2);
    assert.ok(b.zoom.p95 <= a.zoom.p95 * 2);
  }
});

test('39A: QA スクリプトは本番ホストに公開されないフック(?qa=1)だけを使い、Google を参照しない', () => {
  const src = fs.readFileSync('tools/experiments/mission39a_perf_stability_qa.mjs', 'utf8');
  assert.ok(/__mission37dQA/.test(src));
  assert.ok(!/maps\.googleapis|places\.googleapis/.test(src));
});
