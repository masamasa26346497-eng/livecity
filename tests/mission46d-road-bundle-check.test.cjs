'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../tools/mission46d-independent-accuracy.cjs');
const R = require('../tools/mission46d-road-bundle-check.cjs');

const idx = (lines) => { const e = new A.SegIndex(); lines.forEach((l) => e.addLine(l)); return e; };
const TB = [{ x0: -1000, x1: 1000, z0: -1000, z1: 1000 }];
const ward = { wardId: 't', bbox: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 }, polygons: [{ outer: [[-1000, -1000], [1000, -1000], [1000, 1000], [-1000, 1000]], holes: [] }] };
const road = [{ pts: [[-100, 0], [100, 0]], tier: 'local' }];

test('feature classes: bridge/tunnel/layer excluded from ground', () => {
  assert.equal(R.classifyFeature({ bridge: true }), 'bridge');
  assert.equal(R.classifyFeature({ tunnel: true }), 'tunnel');
  assert.equal(R.classifyFeature({ layer: '-1' }), 'underground-layer');
  assert.equal(R.classifyFeature({ layer: '1' }), 'elevated-layer');
  assert.equal(R.classifyFeature({ highway: 'residential' }), 'ground');
});
test('both-side parallel edges 4 m each side => bracketed', () => {
  const e = idx([[[-200, 4], [200, 4]], [[-200, -4], [200, -4]]]);
  const m = R.measure(road, e, TB, ward);
  assert.equal(m.bracketed, m.samples); assert.ok(m.samples > 10);
});
test('counterexample: one-sided edge only is not bracketed', () => {
  const m = R.measure(road, idx([[[-200, 4], [200, 4]]]), TB, ward);
  assert.equal(m.bracketed, 0); assert.ok(m.oneSided > 0);
});
test('counterexample: perpendicular edges ahead/behind (junction/cross road) do not bracket', () => {
  const e = idx([[[150, -30], [150, 30]], [[-150, -30], [-150, 30]]]);
  const m = R.measure([{ pts: [[-100, 0], [100, 0]], tier: 'local' }], e, TB, ward);
  assert.equal(m.bracketed, 0);
});
test('counterexample: implausibly wide corridor (60 m) is rejected', () => {
  const e = idx([[[-200, 20], [200, 20]], [[-200, -20], [200, -20]]]);
  const m = R.measure(road, e, TB, ward);
  assert.equal(m.bracketed, m.samples); // 40 m edge-to-edge is still within the cap
  const wide = R.measure(road, idx([[[-200, 24], [200, 24]], [[-200, -24], [200, -24]]]), TB, ward);
  assert.equal(wide.bracketed, 0);
});
test('displaced road (15 m off) next to one edge is not bracketed', () => {
  const e = idx([[[-200, 4], [200, 4]], [[-200, -4], [200, -4]]]);
  const m = R.measure([{ pts: [[-100, 40], [100, 40]], tier: 'local' }], e, TB, ward);
  assert.equal(m.bracketed, 0);
});
test('samples outside ward polygon / outside reference coverage are counted separately', () => {
  const small = { ...ward, polygons: [{ outer: [[-50, -50], [50, -50], [50, 50], [-50, 50]], holes: [] }] };
  const m = R.measure(road, idx([]), TB, small);
  assert.ok(m.outsideWard > 0 && m.samples > 0);
  const m2 = R.measure(road, idx([]), [{ x0: -20, x1: 20, z0: -20, z1: 20 }], ward);
  assert.ok(m2.outsideRefCoverage > 0);
});
test('partial area coverage never yields ward-level PASS', () => {
  const ref = { tiles: 1, errors: 0, tileBounds: TB, roadEdges: [[[-1000, 4], [1000, 4]], [[-1000, -4], [1000, -4]]] };
  const bundle = { source: 's', sourceGeneratedAt: 'x', count: 1, bboxLocal: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 }, features: [{ id: 'a', p: [[-990, 0], [990, 0]], tier: 'local' }] };
  const rep = R.buildReport(bundle, ref, ward);
  assert.equal(rep.areaVerdict, 'PASS'); assert.equal(rep.wardStatus, 'INSUFFICIENT_DATA');
  assert.ok(rep.areaCoverage.coveragePct < 95);
});
test('report is aggregate-only (no ids or coordinates arrays)', () => {
  const ref = { tiles: 1, errors: 0, tileBounds: TB, roadEdges: [] };
  const rep = R.buildReport({ count: 1, bboxLocal: ward.bbox, features: [{ id: 'road_secret', p: [[0, 0], [10, 0]], tier: 'local' }] }, ref, ward);
  assert.ok(!JSON.stringify(rep).includes('road_secret'));
  assert.equal(rep.areaVerdict, 'INSUFFICIENT_DATA');
});
test('saved real report: both bundle and GSI were used', () => {
  const p = path.join(__dirname, '..', 'data/reports/mission46d-r3/road-bundle-sumiyoshi.json');
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(r.inputs.bundleFeatureCount, 969);
  assert.ok(r.inputs.referenceTiles >= 30 && r.inputs.referenceRoadEdgeLines > 1000);
  assert.ok(r.samples.evaluated > 10000);
  assert.notEqual(r.wardStatus, 'PASS'); // 9-tile bundle only
  assert.ok(r.displacementControl.shift20m.bracketedPct < r.result.bracketedPct - 20);
});
test('tool is read-only and offline', () => {
  const s = fs.readFileSync(path.join(__dirname, '../tools/mission46d-road-bundle-check.cjs'), 'utf8');
  assert.ok(!/require\('https?'\)|writeFileSync\(\s*bundle|unlinkSync|rmSync/.test(s));
});
