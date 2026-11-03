'use strict';
// Mission 38E: 浪速区 2 tileset の統合準備（37G の EXTRA_SET_DEFS 互換性）と結合プレビューの静的検証。外部通信なし。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const T = path.join(ROOT, 'public/mission38e-3dtiles');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const SETS = ['naniwa-mesh', 'naniwa-mesh2'];

test('各 set の source.json / build-report.json が 37G の extra-meta 読込形式を満たす', () => {
  for (const s of SETS) {
    const src = readJson(path.join(T, s, 'source.json'));
    const rep = readJson(path.join(T, s, 'build-report.json'));
    assert.equal(src.wardCode, '27111');
    assert.ok(Array.isArray(src.sourceMeshes) && src.sourceMeshes.length === 1);
    assert.ok(rep.totals.buildings > 0 && rep.selectedTiles > 0);
  }
});

test('2 set の合計は 4,267 棟で、tile 名が衝突する（set ごとの配信ベースで sidecar を引く必要がある）', () => {
  const names = SETS.map((s) => new Set(fs.readdirSync(path.join(T, s, 'tiles'))));
  const total = SETS.reduce((n, s) => n + readJson(path.join(T, s, 'build-report.json')).totals.buildings, 0);
  assert.equal(total, 4267);
  const shared = [...names[0]].filter((n) => names[1].has(n));
  assert.ok(shared.length > 0, '衝突前提の設計確認');
});

test('結合プレビュー ?set=naniwa-all は両 set を mount し、sidecar を tileset ごとの _lcBase で引く', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/mission38e-3d-preview.html'), 'utf8');
  assert.match(html, /'naniwa-all':\s*\['naniwa-mesh',\s*'naniwa-mesh2'\]/);
  assert.match(html, /_lcBase/);
  assert.doesNotMatch(html, /fetch\(BASE\b/);
  assert.doesNotMatch(html, /googleapis|ion\.cesium|places|photorealistic/i);
});

test('37G 本体は本ブランチで 38E の set を参照していない（未統合）', () => {
  const g = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.doesNotMatch(g, /mission38e/);
});
