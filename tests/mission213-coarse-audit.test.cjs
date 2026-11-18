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
