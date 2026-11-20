'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const tracked = new Set(execFileSync('git', ['ls-files', '-z', 'public'], { cwd: ROOT, maxBuffer: 1 << 28 }).toString().split('\0').filter(Boolean));

function uris(node, out) {
  if (!node) return out;
  if (node.content && (node.content.uri || node.content.url)) out.push(node.content.uri || node.content.url);
  for (const c of node.children || []) uris(c, out);
  return out;
}

test('site-deps: 必須依存はすべて Git 追跡済み(ローカル依存なし)', () => {
  const out = JSON.parse(execFileSync('node', ['tools/mission42-site-deps.cjs'], { cwd: ROOT }).toString().replace(/\n\s*/g, ' '));
  assert.deepStrictEqual(out.migrationReadiness.missingRequired, []);
  assert.strictEqual(out.migrationReadiness.siteRunsFromGitAlone, true);
  assert.strictEqual(out.migrationReadiness.runtimeVerifiedInBrowser, false);
});

test('site-deps: 公開済み全 tileset の content 参照が Git 追跡ファイルとして実在する', () => {
  const dirs = ['mission37b-3dtiles/osaka-sumiyoshi-9tile', 'mission37h-3dtiles/kita-sample', 'mission37h-3dtiles/chuo-sample',
    'mission37h-3dtiles/tennoji-sample', 'mission37h-3dtiles/nishi-sample', 'mission38e-3dtiles/naniwa-mesh', 'mission38e-3dtiles/naniwa-mesh2'];
  for (const d of dirs) {
    const ts = JSON.parse(fs.readFileSync(path.join(PUB, d, 'tileset.json'), 'utf8'));
    const list = uris(ts.root, []);
    assert.ok(list.length > 0, d + ': content なし');
    for (const u of list) {
      assert.ok(tracked.has('public/' + d + '/' + u), d + ' の参照が未追跡/欠落: ' + u);
    }
  }
});

test('site-deps: レポートに秘密値・ローカル絶対パスが無い', () => {
  const p = path.join(ROOT, 'data/reports/mission42/site-deps.json');
  const s = fs.readFileSync(p, 'utf8');
  assert.ok(!/[A-Za-z]:\\|\/home\/|\/Users\/|AIza[0-9A-Za-z_-]{20}/.test(s));
  const j = JSON.parse(s);
  assert.strictEqual(j.gates.licenseApproved, false);
  assert.strictEqual(j.transferredNow.files, 0);
  for (const r of j.requiredStillLocal) assert.strictEqual(r.classification, 'cannot-transfer-without-access');
});

test('site-deps: published.json は未承認区を含まない', () => {
  const j = JSON.parse(fs.readFileSync(path.join(PUB, 'mission40j-3dtiles/published.json'), 'utf8'));
  for (const w of j.wards || []) assert.strictEqual(w.approved, true);
});
