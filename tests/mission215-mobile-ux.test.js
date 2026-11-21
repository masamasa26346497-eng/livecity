// Mission 215: モバイル/PC の操作性(静的 fixture。実ブラウザ・実描画の検証ではない)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const h = fs.readFileSync(new URL('../public/mission37g-osaka-24ward-mvp.html', import.meta.url), 'utf8');
const mobile = h.slice(h.indexOf('@media (max-width: 720px) {\n    :root'));

test('モバイル: 未選択の右パネルは地図を遮らない(:has で空案内時は非表示)', () => {
  assert.match(mobile, /#lc-right:has\(#lc-bldg-empty:not\(\[style\*="none"\]\)\)\s*\{\s*display:\s*none/);
});
test('モバイル: 区カードは右パネルと重ならないよう上部に置く', () => {
  assert.match(mobile, /#lc-ward-card\s*\{\s*bottom:\s*auto;\s*top:/);
});
test('情報カードに閉じるボタン、btn-panels に aria-controls が対応する id を指す', () => {
  assert.match(h, /id="lc-info-close"[^>]*aria-label/);
  assert.match(h, /id="btn-panels"[^>]*aria-controls="lc-left"/);
  assert.ok(h.includes('id="lc-left"'));
});
test('Escape は検索→左パネル→選択の順に閉じ、パネルの aria-expanded を同期する', () => {
  assert.match(h, /function setLeft\(on\)[\s\S]*?setAttribute\('aria-expanded'/);
  const k = h.slice(h.indexOf("ev.key !== 'Escape'"));
  assert.ok(k.indexOf('closeResults') < k.indexOf('setLeft(false)') && k.indexOf('setLeft(false)') < k.indexOf('clearSelection()'));
});
test('モバイルのタッチターゲットは 44px 以上、focus-visible がある', () => {
  assert.match(mobile, /#btn-panels[^{]*\{\s*min-height:\s*44px;\s*min-width:\s*44px/);
  assert.match(h, /#btn-panels:focus-visible/);
});
test('区ボタン選択でモバイルの左パネルを閉じる(地図が見える)', () => {
  assert.match(h, /clearSelection\(\); select\(w, true\); document\.body\.classList\.remove\('show-left'\)/);
});
