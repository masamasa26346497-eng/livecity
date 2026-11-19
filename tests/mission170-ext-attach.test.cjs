'use strict';
// Mission 170: 既存 24区 LOD1 出力の読み取り専用検出・互換判定・配信(合成 fixture。実データではない)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../tools/lod2/lod2-ext-attach.cjs');

// Mission 171: 以前の fixture は tileset.json='{}'・source.json なしの「37G が読めない形」で、検出テストだけ通っていた。実出力に忠実な形へ共通化。
const F = require('./helpers/lc-45d-fixture.cjs');
const mk45d = (wards) => F.mk45d(wards, Object.fromEntries(wards.map((w) => [w, { buildings: 10 }])));

test('45D ルート: 検出できた区だけ接続し、欠落区と「未検証」を明示する', () => {
  const root = mk45d(['kita', 'sumiyoshi']);
  const r = A.inspect(root);
  assert.strictEqual(r.kind, '45d-root'); assert.strictEqual(r.verified, false);
  assert.deepStrictEqual(r.wards.map((w) => w.ward).sort(), ['kita', 'sumiyoshi']);
  assert.ok(r.missingWards.length >= 20);
  assert.ok(r.reasons.some((x) => /未検証/.test(x)));
  assert.strictEqual(r.wards.find((w) => w.ward === 'kita').buildings, 10);
  const idx = JSON.parse(A.indexJsonFor(r));
  assert.strictEqual(idx.verified, false); assert.strictEqual(idx.provenance, 'unverified-45d-root'); assert.strictEqual(idx.wards.length, 2);
});

test('配信は許可リストのみ。traversal・非許可ファイル・他区は拒否', () => {
  const r = A.inspect(mk45d(['kita']));
  assert.ok(A.resolveFromServable(r.servable, 'kita/tileset.json'));
  assert.ok(A.resolveFromServable(r.servable, 'kita/tiles/t_0_0.glb'));
  assert.strictEqual(A.resolveFromServable(r.servable, 'kita/secret.txt'), null);
  assert.strictEqual(A.resolveFromServable(r.servable, 'kita/../x/tileset.json'), null);
  assert.strictEqual(A.resolveFromServable(r.servable, 'naniwa/tileset.json'), null);
});

test('互換性が不明なフォルダは 0 件と推測せず理由を返す。discover は書き込まない', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lc170e-'));
  const r = A.inspect(empty);
  assert.strictEqual(r.kind, 'unknown'); assert.match(r.reasons.join(' '), /判断できません/);
  const d = A.discover(empty);
  assert.strictEqual(d.chosen, null); assert.strictEqual(d.inspected.length, 1);
  assert.deepStrictEqual(fs.readdirSync(empty), []);
  assert.strictEqual(A.inspect(path.join(empty, 'nope')).kind, 'unknown');
});

test('index.json 付き(45E 形式)は ext-index として接続', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc170i-'));
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ verified: true, wards: [{ ward: 'kita', wardCode: '27127', buildings: 5 }] }));
  const r = A.inspect(root); assert.strictEqual(r.kind, 'ext-index'); assert.strictEqual(r.verified, true); assert.strictEqual(r.wards.length, 1);
});

test('overlay.js は構文有効で、LOD2 実数と LOD1 出典の表示を持つ', () => {
  const src = fs.readFileSync(path.join(__dirname, '../tools/lod2/lod2-overlay.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(src));
  for (const k of ['このプレビューの実数', '37G旧タイル専用', 'LOD1(24区)', '高度が高すぎて']) assert.ok(src.includes(k), k);
});
