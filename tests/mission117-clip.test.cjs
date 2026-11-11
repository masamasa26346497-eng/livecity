'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../tools/lib/mission117-clip.cjs');
const R = require('../tools/mission115/layers-run.cjs');

const box = { minX: 0, maxX: 100, minZ: 0, maxZ: 100 };
const inBoxFn = (x, z) => x >= 0 && x <= 100 && z >= 0 && z <= 100;
const allIn = (pts) => pts.every((p) => p[0] >= 0 && p[0] <= 100 && p[1] >= 0 && p[1] <= 100);

test('clipLineExact ends exactly at the boundary (no far outside neighbour)', () => {
  const runs = C.clipLineExact([[50, 50], [5000, 50]], inBoxFn);
  assert.strictEqual(runs.length, 1);
  assert.ok(allIn(runs[0]));
  assert.ok(Math.abs(runs[0][runs[0].length - 1][0] - 100) < 0.2);
});
test('clipLineExact splits a line that leaves and re-enters', () => {
  const runs = C.clipLineExact([[10, 10], [10, 500], [90, 500], [90, 10]], inBoxFn);
  assert.strictEqual(runs.length, 2);
  runs.forEach((r) => assert.ok(allIn(r)));
});
test('clipLineExact keeps fully-inside lines unchanged and drops fully-outside ones', () => {
  assert.deepStrictEqual(C.clipLineExact([[1, 1], [2, 2], [3, 3]], inBoxFn), [[[1, 1], [2, 2], [3, 3]]]);
  assert.deepStrictEqual(C.clipLineExact([[200, 200], [300, 300]], inBoxFn), []);
});
test('clipRingToBox clips a large river polygon to the box; fully outside -> null', () => {
  const ring = [[-1000, 40], [2000, 40], [2000, 60], [-1000, 60], [-1000, 40]];
  const out = C.clipRingToBox(ring, box);
  assert.ok(out && allIn(out));
  const xs = out.map((p) => p[0]);
  assert.strictEqual(Math.min(...xs), 0); assert.strictEqual(Math.max(...xs), 100);
  assert.strictEqual(C.clipRingToBox([[500, 500], [600, 500], [600, 600]], box), null);
});

function mkRoot(w, mutate, clipVersion) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm117-日本語-'));   // Japanese path segment (Windows Node 24 style)
  const d = path.join(tmp, w.wardId, 'layers');
  fs.mkdirSync(d, { recursive: true });
  const b = w.bbox, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const base = { roads: [{ id: 'r', p: [[cx - 100, cz], [cx + 100, cz]] }], waterways: [], parks: [], railways: [] };
  const data = mutate(base, b);
  for (const l of Object.keys(data)) fs.writeFileSync(path.join(d, l + '.json'), JSON.stringify({ coordinateConvention: R.CONVENTION, clipVersion, count: data[l].length, features: data[l] }));
  return tmp;
}
const chuo = () => R.wardList('ALL').find((w) => w.wardId === 'chuo');

test('legacy output: threshold stays 5% (just under passes, just over fails) and is not relaxed', () => {
  const w = chuo();
  const mk = (nOut) => mkRoot(w, (d, b) => {
    // 100 inside vertices + nOut vertices 500 m outside the east edge
    d.roads = [{ id: 'in', p: Array.from({ length: 100 }, (_, i) => [b.minX + 10 + i, b.minZ + 10]) }, { id: 'out', p: Array.from({ length: nOut }, (_, i) => [b.maxX + 500, b.minZ + i]) }];
    return d;
  }, undefined);
  assert.strictEqual(R.verifyWard(w, mk(5), 100).state, 'generated-unverified-visually');   // 4.76%
  const r = R.verifyWard(w, mk(6), 100);                                                      // 5.66%
  assert.strictEqual(r.state, 'check-failed');
  assert.strictEqual(r.checks.allowedOutsidePct, 5);
});
test('clipVersion 2 output must have zero outside vertices', () => {
  const w = chuo();
  const mk = (n) => mkRoot(w, (d, b) => { d.roads = [{ id: 'in', p: Array.from({ length: 5000 }, (_, i) => [b.minX + 10 + (i % 100), b.minZ + 10]) }].concat(n ? [{ id: 'o', p: [[b.maxX + 40, b.minZ + 5]] }] : []); return d; }, 2);
  assert.strictEqual(R.verifyWard(w, mk(0), 100).state, 'generated-unverified-visually');
  assert.strictEqual(R.verifyWard(w, mk(1), 100).state, 'check-failed');   // 1 of 5001 (0.02%) is still rejected
});
test('tens-of-metres shifted layers are detected (coordinate transform error)', () => {
  const w = chuo();
  const tmp = mkRoot(w, (d, b) => { d.roads = [{ id: 'edge', p: Array.from({ length: 100 }, (_, i) => [b.maxX - 5 + 30, b.minZ + 10 + i]) }]; return d; }, 2);
  const r = R.verifyWard(w, tmp, 100);
  assert.strictEqual(r.state, 'check-failed');
  assert.ok(r.diagnostics.maxOffsetM >= 20 && r.diagnostics.sides.east === 100);
});
test('diagnostics split area rings from kept-neighbour line vertices and name the neighbouring ward', () => {
  const w = chuo(), all = R.wardList('ALL');
  const tmp = mkRoot(w, (d, b) => {
    d.roads = [{ id: 'l', p: [[b.minX + 10, b.minZ + 10], [b.minX - 50, b.minZ + 10]] }];
    d.waterways = [{ id: 'a', kind: 'area', p: [[b.minX - 10, b.minZ], [b.minX - 20, b.minZ + 5], [b.minX - 20, b.minZ + 10]] }];
    return d;
  }, 1);
  const r = R.verifyWard(w, tmp, 100, { allWards: all });
  assert.strictEqual(r.diagnostics.adjacentKeepVertex, 1);
  assert.strictEqual(r.diagnostics.byLayerKind['waterways:area'].outside, 3);
  assert.ok(Object.keys(r.diagnostics.crossWard).length >= 1);
  assert.ok(!JSON.stringify(r.diagnostics).includes('"id"'), 'diagnostics are anonymous aggregates');
});
test('ward without layers stays missing (no layers is not faked)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm117-'));
  assert.strictEqual(R.verifyWard(chuo(), tmp, 100).state, 'missing');
});
test('real chuo N03 polygon: exact clipping of long synthetic lines yields vertices inside bbox', () => {
  const w = chuo(), VEC = require('../public/mission45i-vec.js');
  const mod = VEC && VEC.makeInsideTester ? VEC : globalThis.LC45I;
  const inside = mod.makeInsideTester(w.polygons, 64), b = w.bbox, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const runs = C.clipLineExact([[cx, cz], [cx + 20000, cz + 3000], [cx - 20000, cz - 3000]], inside);
  assert.ok(runs.length >= 1);
  for (const r of runs) for (const p of r) assert.ok(p[0] >= b.minX - 1 && p[0] <= b.maxX + 1 && p[1] >= b.minZ - 1 && p[1] <= b.maxZ + 1);
});
test('tools stay offline and do not delete/copy', () => {
  const src = ['tools/lib/mission117-clip.cjs', 'tools/mission115/layers-run.cjs', 'tools/mission116/combined-run.ps1'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  assert.ok(!/Remove-Item|rmSync|unlinkSync|Copy-Item|robocopy|fetch\(|https\.request/.test(src));
  assert.ok(!/[^\x00-\x7F]/.test(fs.readFileSync(path.join(__dirname, '../tools/mission116/combined-run.ps1'), 'utf8')));
});
