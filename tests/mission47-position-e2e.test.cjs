'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const res = JSON.parse(fs.readFileSync(path.join(root, 'data/reports/mission47-position/result.json'), 'utf8'));

test('47 位置 E2E: 保存済み実 Chrome 結果 — 建物の描画位置が元座標と一致（補正なし）', () => {
  assert.ok(res.summary.measured >= 10);
  assert.strictEqual(res.summary.idMatch, res.summary.measured);
  assert.ok(res.summary.horizontalErrMax < 0.5, 'horizontal ' + res.summary.horizontalErrMax);
  assert.ok(res.summary.heightErrAbsMax < 0.5);
  assert.strictEqual(res.summary.jsErrors, 0);
  assert.ok(!res.fatal);
});

test('47 位置 E2E: 建物を画面端に置いた測定を含む（中心画素では横方向誤差が構造上 0 になるため）', () => {
  const src = fs.readFileSync(path.join(root, 'tools/experiments/mission47_position_e2e.mjs'), 'utf8');
  assert.match(src, /c\.x \+ 110, c\.z - 70/);
  assert.ok(res.buildings.every((b) => !b.screen || Math.abs(b.screen.x - 700) > 20 || Math.abs(b.screen.y - 476) > 20));
});

test('47 位置 E2E: QA フック pickLocal は localhost かつ ?qa=1 のブロック内にあり、補正コードを含まない', () => {
  const html = fs.readFileSync(path.join(root, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  const i = html.indexOf('window.__mission37dQA = {');
  assert.ok(i > 0 && html.indexOf('pickLocal(px, py)') > i);
  assert.ok(!/shift|rotateAll|globalOffset/i.test(html.slice(html.indexOf('pickLocal(px, py)'), html.indexOf('pickLocal(px, py)') + 400)));
});
