'use strict';
// Mission 47: 保存済みの実 Chrome E2E 結果(before=?rw=0 / after=既定)の整合を検査する。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const R = JSON.parse(fs.readFileSync('data/reports/mission47-road-width/result.json', 'utf8'));
test('JS 例外 0 / 致命エラーなし', () => {
  for (const r of Object.values(R.runs)) { assert.deepStrictEqual(r.jsErrors, []); assert.ok(!r.fatal); }
});
test('道路は全視点で描画されている(ON/OFF 差分 > 0)', () => {
  for (const s of R.summary) { assert.ok(s.roadPixelsAfter > 10000, s.view); }
});
test('遠景(range 3500)では固定幅より道路の画面占有が減り、近景では変わらない', () => {
  const by = Object.fromEntries(R.summary.map((s) => [s.view, s]));
  for (const v of ['top-far', 'oblique-far']) assert.ok(by[v].roadPixelsAfter < by[v].roadPixelsBefore * 0.9, v);
  assert.ok(by['top-near'].roadPixelsAfter >= by['top-near'].roadPixelsBefore * 0.95);
});
test('区切替後も tileset は 1 本', () => {
  for (const w of R.runs.after.wardSwitch) assert.strictEqual(w.tilesets.n, 1);
});
