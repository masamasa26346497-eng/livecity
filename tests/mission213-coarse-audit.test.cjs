'use strict';
const test = require('node:test'), assert = require('node:assert');
const { audit } = require('../tools/cloud/audit-coarse-overlap.cjs');
test('audit: 箱の半分が道路ポリゴン、水域なし', () => {
  const box = { id: 'lod1c_a', x0: 0, z0: 0, x1: 10, z1: 10, n: 2, memberArea: 50 };
  const road = { id: 'r', kind: 'area', p: [[0, 0], [5, 0], [5, 10], [0, 10]] };
  const r = audit([box], [road], [], 0.5);
  assert.strictEqual(r.boxes, 1); assert.ok(Math.abs(r.roadFracOfBox - 0.5) < 0.01); assert.strictEqual(r.waterUnderBoxM2, 0); assert.strictEqual(r.gapUpperBoundM2, 50);
});
test('audit: 水域の穴(h)は除外', () => {
  const box = { id: 'lod1c_b', x0: 0, z0: 0, x1: 10, z1: 10, n: 2, memberArea: 100 };
  const w = { id: 'w', kind: 'area', p: [[0, 0], [10, 0], [10, 10], [0, 10]], h: [[[0, 0], [10, 0], [10, 10], [0, 10]]] };
  assert.strictEqual(audit([box], [], [w]).waterUnderBoxM2, 0);
});
test('separate: 道路が建物 bbox 内だけなら gap 道路は 0(既存重複)', () => {
  const box = { id: 'lod1c_c', x0: 0, z0: 0, x1: 20, z1: 10, m: [[0, 0, 10, 10], [10, 0, 20, 10]] };  // 隙間なし
  const road = { id: 'r', p: [[0, 0], [20, 0], [20, 10], [0, 10]] };
  const r = require('../tools/cloud/audit-coarse-overlap.cjs').separate([box], [road], [], 1);
  assert.strictEqual(r.gapM2, 0); assert.strictEqual(r.gapRoadM2, 0); assert.strictEqual(r.memberRoadM2, 200);
});
test('separate: 隙間側だけ道路なら gap 道路が新規被覆として数えられる', () => {
  const box = { id: 'lod1c_d', x0: 0, z0: 0, x1: 20, z1: 10, m: [[0, 0, 5, 10], [15, 0, 20, 10]] };  // 中央 10x10 が隙間
  const road = { id: 'r', p: [[5, 0], [15, 0], [15, 10], [5, 10]] };
  const r = require('../tools/cloud/audit-coarse-overlap.cjs').separate([box], [road], [], 1);
  assert.strictEqual(r.gapM2, 100); assert.strictEqual(r.gapRoadM2, 100); assert.strictEqual(r.memberRoadM2, 0); assert.strictEqual(r.boxesGapRoad, 1);
  assert.strictEqual(require('../tools/cloud/audit-coarse-overlap.cjs').separate([{ ...box, m: undefined }], [road], [], 1).skipped, 1);
});
