// tests/river-building-conflict.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFootprintGrid, pointInAnyFootprint, assessRibbonConflict, resolveMinorConflict, CONFLICT_DEFAULTS,
} from '../tools/lib/river-building-conflict.js';
import { conservativeMinorWidth, MINOR_WIDTH_LIMITS } from '../tools/lib/river-width.js';

// 200m四方の建物を x=[100,300] z=[-50,50] に置く
const BUILDING = [[100, -50], [300, -50], [300, 50], [100, 50]];

test('conservativeMinorWidth: measured は minor 上限(30m)で clamp、無ければ conservative default', () => {
  assert.deepEqual(conservativeMinorWidth('river', 120), { width: MINOR_WIDTH_LIMITS.max, method: 'measured-clamped' });
  assert.deepEqual(conservativeMinorWidth('river', 18), { width: 18, method: 'measured-clamped' });
  assert.equal(conservativeMinorWidth('canal', null).width, 8);
  assert.equal(conservativeMinorWidth('river', null).width, 16);
  assert.equal(conservativeMinorWidth('drain', null).width, 4);
});

test('buildFootprintGrid / pointInAnyFootprint: 建物内/外を正しく判定', () => {
  const idx = buildFootprintGrid([BUILDING], 150);
  assert.equal(pointInAnyFootprint(200, 0, idx), true, '建物中心は内側');
  assert.equal(pointInAnyFootprint(50, 0, idx), false, '建物の外');
  assert.equal(pointInAnyFootprint(400, 0, idx), false, '遠く');
});

test('assessRibbonConflict: centerline が建物を貫く場合 centerInFrac が高い', () => {
  const idx = buildFootprintGrid([BUILDING], 150);
  // z=0 上を x=0→400 へ進む centerline（建物 x=[100,300] を貫通）
  const dense = [];
  for (let x = 0; x <= 400; x += 20) dense.push([x, 0]);
  const half = dense.map(() => 8);
  const a = assessRibbonConflict(dense, half, idx);
  assert.ok(a.centerInFrac > 0.35 && a.centerInFrac < 0.65, `centerInFrac=${a.centerInFrac}`);
});

test('assessRibbonConflict: 建物脇を通り、幅が広いと edge が建物に食い込む', () => {
  const idx = buildFootprintGrid([BUILDING], 150);
  // z=-90 上を進む（建物 z=[-50,50] の外）。halfWidth=50 だと左端 z=-40 が建物内に入る
  const dense = [];
  for (let x = 0; x <= 400; x += 20) dense.push([x, -90]);
  const wide = assessRibbonConflict(dense, dense.map(() => 50), idx);
  const narrow = assessRibbonConflict(dense, dense.map(() => 8), idx);
  assert.ok(wide.edgeInFrac > narrow.edgeInFrac, `wide=${wide.edgeInFrac} narrow=${narrow.edgeInFrac}`);
});

test('resolveMinorConflict: 幅を縮めれば干渉が解消する場合は shrink', () => {
  const idx = buildFootprintGrid([BUILDING], 150);
  const dense = [];
  for (let x = 0; x <= 400; x += 15) dense.push([x, -78]); // 建物のすぐ脇
  const res = resolveMinorConflict(dense, dense.map(() => 40), idx, {});
  assert.ok(['shrink', 'keep'].includes(res.action), `action=${res.action}`);
  if (res.action === 'shrink') assert.ok(res.scale < 1);
});

test('resolveMinorConflict: centerline が大きく建物内なら幅縮小では無理 → suppress', () => {
  const idx = buildFootprintGrid([BUILDING], 150);
  const dense = [];
  for (let x = 120; x <= 280; x += 10) dense.push([x, 0]); // ほぼ全区間が建物内
  const res = resolveMinorConflict(dense, dense.map(() => 8), idx, {});
  assert.equal(res.action, 'suppress');
});

test('resolveMinorConflict: 建物が無ければ keep（scale=1）', () => {
  const idx = buildFootprintGrid([], 150);
  const dense = [[0, 0], [100, 0], [200, 0]];
  const res = resolveMinorConflict(dense, [8, 8, 8], idx, {});
  assert.equal(res.action, 'keep');
  assert.equal(res.scale, 1);
});

test('CONFLICT_DEFAULTS: scales は 100%→55% の段階縮小', () => {
  assert.deepEqual(CONFLICT_DEFAULTS.scales, [1.0, 0.85, 0.70, 0.55]);
});
