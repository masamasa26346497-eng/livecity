'use strict';
// [Mission 64] QA フックが localhost + ?qa=1 限定ブロック内にあり、公開 UI に出ないこと、A/B スクリプトの通信上限が保たれていることの静的確認。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');
const qa = fs.readFileSync('tools/experiments/mission64_ab_qa.mjs', 'utf8');
test('64 hooks live inside the localhost+qa=1 block', () => {
  const gate = html.indexOf("get('qa') === '1'");
  assert.ok(gate > 0);
  for (const name of ['setBuildingSlice', 'setBuildingColor', 'snapshot() {', 'renderErrors() {']) {
    assert.ok(html.lastIndexOf(name) > gate, name);
  }
  assert.ok(!/id="[^"]*(slice|snapshot)/i.test(html));
});
test('slice planes are persistent (no collection swap) and defaults clip nothing', () => {
  assert.match(html, /_qaSlice/);
  assert.match(html, /clippingPlanesOriginMatrix/);
  assert.match(html, /Cartesian3\(0, 0, 1\), 1e6\)/);
});
test('A/B script enforces GET/byte caps, 1s spacing, 429/403 stop, allowlisted hosts', () => {
  assert.match(qa, /MAX_GETS/);
  assert.match(qa, /30 \* 1024 \* 1024/);
  assert.match(qa, /1000 - /);
  assert.match(qa, /429 \|\| r\.status === 403/);
  assert.match(qa, /cdn\\\.jsdelivr\\\.net/);
});
