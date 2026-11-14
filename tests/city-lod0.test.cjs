'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../tools/lod0/city-lod0.cjs');

const bs = (pts) => pts.map(([x, z, h]) => ({ x, z, h }));
test('aggregate: 決定的・minCount未満除外・異常高さ除外', () => {
  const b = bs([[10, 10, 10], [20, 30, 20], [450, 10, 8], [15, 15, 9999]]);
  const r1 = L.aggregateCells(b), r2 = L.aggregateCells(b.slice().reverse());
  assert.deepStrictEqual(r1, r2);
  assert.strictEqual(r1.cells.length, 1);           // 孤立1棟(450,10)は出さない
  assert.strictEqual(r1.cells[0].n, 3);
  assert.strictEqual(r1.cells[0].meanH, 15);        // 9999 は平均から除外
  assert.strictEqual(r1.stats.badHeight, 1);
});
test('aggregate: セル幅範囲外は拒否', () => assert.throws(() => L.aggregateCells([], { cellM: 50 })));
test('merge: 区境界の同一セルは二重化せず合算', () => {
  const a = { code: '27100', cells: [{ cx: 0, cz: 0, n: 2, meanH: 10, maxH: 12 }] };
  const b = { code: '27102', cells: [{ cx: 0, cz: 0, n: 2, meanH: 20, maxH: 30 }, { cx: 20, cz: 0, n: 3, meanH: 5, maxH: 6 }] };
  const tiles = L.mergeAndPartition([a, b], { tileCells: 16 });
  assert.strictEqual(tiles.length, 2);
  const c = tiles[0].cells[0];
  assert.deepStrictEqual([c.n, c.meanH, c.maxH, c.wards.length], [4, 15, 30, 2]);
});
test('coverage: 0件/欠落/元棟数不一致は失敗', () => {
  const exp = [{ code: 'A', name: 'a' }, { code: 'B', name: 'b' }, { code: 'C', name: 'c' }];
  const ok = { code: 'A', stats: { sourceBuildings: 5, usedBuildings: 5, cellsEmitted: 1, buildingsInEmittedCells: 5 } };
  const empty = { code: 'B', stats: { sourceBuildings: 1, usedBuildings: 1, cellsEmitted: 0, buildingsInEmittedCells: 0 } };
  const r = L.coverageReport(exp, [ok, empty], { lod1FullCounts: { A: 6 } });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.wards.map((w) => w.status), ['count-mismatch', 'empty', 'missing']);
  assert.strictEqual(L.coverageReport([exp[0]], [ok], { lod1FullCounts: { A: 5 } }).ok, true);
});
test('tileset: REPLACE・非クリック明記・巨大単一GLBでない', () => {
  const tiles = L.mergeAndPartition([{ code: 'A', cells: [{ cx: 0, cz: 0, n: 2, meanH: 10, maxH: 12 }, { cx: 40, cz: 0, n: 2, meanH: 10, maxH: 12 }] }]);
  const ts = L.buildTilesetIndex(tiles, { toRegion: (a, b, c, d, h) => [a, b, c, d, 0, h] });
  assert.strictEqual(ts.root.refine, 'REPLACE');
  assert.strictEqual(ts.root.children.length, 2);
  assert.strictEqual(ts.extras.clickable, false);
  assert.strictEqual(ts.extras.notRealBuildings, true);
  assert.ok(ts.root.children.every((c) => /^tiles\/lod0_/.test(c.content.uri)));
  assert.throws(() => L.buildTilesetIndex(tiles, {}));
});
