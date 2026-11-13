// Mission 209: 37G HTML のインラインスクリプトが構文的に有効であること（M208 で引用符欠落により全JSが停止し建物が消えた回帰の防止）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('mission37g inline scripts parse without SyntaxError', () => {
  const h = fs.readFileSync(new URL('../public/mission37g-osaka-24ward-mvp.html', import.meta.url), 'utf8');
  const re = /<script(?![^>]*\ssrc)[^>]*>([\s\S]*?)<\/script>/g; let m, n = 0;
  while ((m = re.exec(h))) { n++; assert.doesNotThrow(() => new Function(m[1]), `script #${n}`); }
  assert.ok(n >= 1);
});
