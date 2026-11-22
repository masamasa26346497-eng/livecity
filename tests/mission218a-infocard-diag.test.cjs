const test = require('node:test'), assert = require('node:assert'), fs = require('node:fs');
// 静的テスト: 実画面PASSの証拠ではない。E2E が診断フィールドを保持し続けることだけ保護する。
test('e2e infoCard diag fields remain (tc/cid/rendered/hiddenBy)', () => {
  const s = fs.readFileSync('tools/cloud/e2e-city-lod0.mjs', 'utf8');
  for (const k of ['tc', 'cid', 'rendered', 'hiddenBy', 'cardOpensThenCloses']) assert.ok(s.includes(k), k);
});
test('lblidle stays opt-in (default OFF)', () => {
  const h = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');
  assert.ok(h.includes("q.get('lblidle') === '1'"));
});
