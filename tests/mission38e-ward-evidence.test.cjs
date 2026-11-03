'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

test('building.ward ラベルは全テスト用データセット共通の定数スタンプで、区の根拠にならない', () => {
  const { labelCensus } = require('../tools/mission38e-audit-ward.cjs');
  const c = labelCensus();
  for (const d of Object.keys(c)) assert.deepStrictEqual(Object.keys(c[d].labels), ['東住吉区'], d);
  assert.strictEqual(Object.values(c).reduce((s, x) => s + x.n, 0), 115703);
  const cls = read('data/reports/building-ward-classification.json');
  assert.strictEqual(cls.attr.hasWardAttr, cls.total);
  assert.strictEqual(cls.attr.attrMatch, cls.counts.higashisumiyoshi);
  assert.ok(cls.attr.mismatchSamples.every((m) => m.attrWard === '東住吉区'));
  const conv = fs.readFileSync(path.join(ROOT, 'tools/mission36k-convert-citygml-runtime.mjs'), 'utf8');
  assert.ok(conv.includes("ward: meta.wardHint || ''"));
});

test('N03 判定は旧 TOWN_POLYGONS 由来の分類と平野区で 99% 以上一致する（独立2系統）', () => {
  const h = read('data/reports/ward-classification-vs-poc.json').perWard.hirano;
  assert.strictEqual(h.count, 43843);
  assert.ok(h.agree / h.count > 0.99, 'agree=' + h.agree);
});
