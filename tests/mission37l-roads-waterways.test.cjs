'use strict';
// [Mission 37L] 住吉 9 tile 範囲の道路・河川データと、37G ページの描画設定の整合（静的・データ検証）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'public', 'mission37c-layers', 'osaka-sumiyoshi-9tile');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'mission37g-osaka-24ward-mvp.html'), 'utf8');
const load = (n) => JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'));
const manifest = load('manifest.json');

function within(features) {
  const b = manifest.bboxLocal, m = manifest.marginM;
  let bad = 0;
  for (const f of features) for (const p of f.p || []) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) bad++;
    else if (p[0] < b.minX - m || p[0] > b.maxX + m || p[1] < b.minZ - m || p[1] > b.maxZ + m) bad++;
  }
  return bad;
}

test('roads.json: 969 件・座標は有限で配信 bbox 内', () => {
  const d = load('roads.json');
  assert.strictEqual(d.features.length, 969);
  assert.strictEqual(within(d.features), 0);
  assert.ok(d.features.every((f) => f.p && f.p.length >= 2));
});

test('waterways.json: 線 12・面 8、面は 3 点以上、座標は bbox 内', () => {
  const d = load('waterways.json');
  const lines = d.features.filter((f) => f.kind === 'line'), areas = d.features.filter((f) => f.kind === 'area');
  assert.strictEqual(lines.length, 12);
  assert.strictEqual(areas.length, 8);
  assert.ok(areas.every((f) => f.p.length >= 3));
  assert.strictEqual(within(d.features), 0);
});

test('37G ページ: roads/waterways は defaultOn、投影定数は不変', () => {
  assert.match(HTML, /id: 'roads'[^\n]*defaultOn: true/);
  assert.match(HTML, /id: 'waterways'[^\n]*defaultOn: true/);
  assert.match(HTML, /clat: 34\.604208, clon: 135\.525020, mpd: 111320/);
});

test('37L: 水域の色は旧値（淡すぎて地図に溶ける）に戻っていない、配信範囲を注記している', () => {
  assert.doesNotMatch(HTML, /waterLine: '#9ec6e0'/);
  assert.match(HTML, /waterLine: '#4f9fd6'/);
  assert.match(HTML, /配信範囲は住吉区の一部（約2\.1km四方）のみ/);
});

test('37L: QA フックは localhost かつ ?qa=1 のときだけ', () => {
  const i = HTML.indexOf('setLayer: (id, on)');
  assert.ok(i > 0);
  assert.ok(HTML.lastIndexOf("get('qa') === '1'", i) > HTML.lastIndexOf('</style>'));
});
