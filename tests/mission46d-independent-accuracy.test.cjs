'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../tools/lib/mission46d-mvt.cjs');
const A = require('../tools/mission46d-independent-accuracy.cjs');

const Z = 16, N = 2 ** Z;
const TX = Math.floor(((M.CONST.clon + 180) / 360) * N);
const TY = Math.floor(((1 - Math.asinh(Math.tan((M.CONST.clat * Math.PI) / 180)) / Math.PI) / 2) * N);

function fixtureTile() {
  const feats = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    const x = 300 + i * 500, y = 300 + j * 500;
    feats.push({ type: 3, rings: [[[x, y], [x + 200, y], [x + 200, y + 200], [x, y + 200]]], props: { ftCode: '3101' } });
  }
  const roads = [
    { type: 2, rings: [[[0, 1000], [4096, 1000]]], props: {} },
    { type: 2, rings: [[[0, 1100], [4096, 1100]]], props: {} }
  ];
  return Buffer.concat([M.encodeMvt('BldA', 4096, feats), M.encodeMvt('RdEdg', 4096, roads)]);
}
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm46d-'));
  fs.mkdirSync(path.join(dir, 'w'));
  fs.writeFileSync(path.join(dir, 'w', Z + '_' + TX + '_' + TY + '.pbf'), fixtureTile());
  return path.join(dir, 'w');
}
const shift = (polys, dx, dz) => polys.map((p) => p.map(([x, z]) => [x + dx, z + dz]));

test('MVT round trip decodes polygons and lines', () => {
  const L = M.decodeMvt(fixtureTile());
  assert.strictEqual(L.BldA.features.length, 36);
  assert.strictEqual(L.BldA.features[0].type, 3);
  assert.strictEqual(L.BldA.features[0].rings[0].length, 4);
  assert.strictEqual(L.RdEdg.features.length, 2);
  assert.strictEqual(L.BldA.features[0].props.ftCode, '3101');
});

test('tile -> local conversion is near the Live City origin', () => {
  const g = M.tilePointToLonLat(Z, TX, TY, 4096, 0, 0), l = M.lonLatToLocal(g.lon, g.lat);
  assert.ok(Math.abs(l.x) < 1000 && Math.abs(l.z) < 1000);
});

test('good alignment passes; 40 m shift fails; no reference is INSUFFICIENT_DATA', () => {
  const ref = A.loadReference(setup());
  assert.strictEqual(ref.buildings.length, 36);
  const good = A.buildingAccuracy(shift(ref.buildings, 1, 1), ref);
  assert.strictEqual(good.matchedPct, 100);
  assert.ok(good.vertexDistM.median <= 3);
  const okRoad = { samples: 500, refEdgeLines: 2, bracketedSamples: 500, bracketedPct: 100 };
  assert.strictEqual(A.classify(good, okRoad).status, 'PASS');
  const bad = A.buildingAccuracy(shift(ref.buildings, 40, 40), ref);
  assert.strictEqual(A.classify(bad, okRoad).status, 'FAIL');
  const none = A.buildingAccuracy(ref.buildings, { buildings: [], roadEdges: [], tileBounds: [] });
  assert.strictEqual(A.classify(none, null).status, 'INSUFFICIENT_DATA');
});

test('roads: centerline between two edges is bracketed', () => {
  const ref = A.loadReference(setup());
  const e = ref.roadEdges.map((l) => l[0][1]).sort((a, b) => a - b);
  const mid = (e[0] + e[1]) / 2, x0 = ref.tileBounds[0].x0 + 20, x1 = ref.tileBounds[0].x1 - 20;
  const r = A.roadAccuracy([[[x0, mid], [x1, mid]]], ref, 30);
  assert.ok(r.samples > 40, 'samples ' + r.samples);
  assert.strictEqual(r.bracketedPct, 100);
  const far = A.roadAccuracy([[[x0, mid + 200], [x1, mid + 200]]], ref, 30);
  assert.ok(far.bracketedPct < 50);
});

test('report: 24 wards present, missing data never PASS, schema stable', () => {
  const wards = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
  const rep = A.buildReport(wards, null, null, null);
  assert.strictEqual(rep.schema, 'livecity.mission46d.independent-accuracy/1');
  assert.strictEqual(rep.wards.length, 24);
  assert.strictEqual(rep.summary.INSUFFICIENT_DATA, 24);
  assert.strictEqual(rep.summary.allWardsPass, false);
  assert.ok(rep.wards.every((w) => w.status === 'INSUFFICIENT_DATA' && w.reasons.length));
  assert.strictEqual(new Set(rep.wards.map((w) => w.wardId)).size, 24);
});

test('tool never deletes/copies inputs and uses no network', () => {
  const s = fs.readFileSync(path.join(__dirname, '../tools/mission46d-independent-accuracy.cjs'), 'utf8') + fs.readFileSync(path.join(__dirname, '../tools/lib/mission46d-mvt.cjs'), 'utf8');
  assert.ok(!/https?\.request|fetch\(|require\('https?'\)|unlinkSync|rmSync|copyFileSync/.test(s));
  assert.strictEqual((s.match(/writeFileSync/g) || []).length, 1);
});

test('roads: one-sided proximity is never bracketed and never PASS', () => {
  const ref = A.loadReference(setup());
  const e = ref.roadEdges.map((l) => l[0][1]).sort((a, b) => a - b);
  const x0 = ref.tileBounds[0].x0 + 20, x1 = ref.tileBounds[0].x1 - 20;
  const outside = e[0] - 8; // 8 m beyond the first edge, only one edge within 30 m of the far side
  const r = A.roadAccuracy([[[x0, outside - 40], [x1, outside - 40]]], ref, 30);
  assert.strictEqual(r.bracketedSamples, 0);
  const good = A.buildingAccuracy(ref.buildings, ref);
  const c = A.classify(good, { samples: 500, refEdgeLines: 2, bracketedSamples: 10, bracketedPct: 2 });
  assert.strictEqual(c.status, 'INSUFFICIENT_DATA');
  assert.ok(c.reasons.some((x) => /bracketed/.test(x)));
});

test('interior MVT rings are holes, malformed rings are excluded', () => {
  const ref = { buildings: [], invalidRings: 0 };
  const sq = (x, z, s, rev) => { const r = [[x, z], [x + s, z], [x + s, z + s], [x, z + s]]; return rev ? r.reverse() : r; };
  A.addPolygonFeature(ref, [sq(0, 0, 100), sq(30, 30, 20, true), [[0, 0], [1, 1]], [[0, 0], [NaN, 1], [2, 2]], sq(500, 500, 0.1)]);
  assert.strictEqual(ref.buildings.length, 1);
  assert.strictEqual(ref.buildings[0].holes.length, 1);
  assert.strictEqual(ref.invalidRings, 3);
  const idx = new A.PolyIndex(); idx.add(ref.buildings[0]);
  assert.ok(idx.containing(10, 10));
  assert.strictEqual(idx.containing(40, 40), null, 'point in the courtyard hole is not inside the building');
});

test('low reference coverage is INSUFFICIENT_DATA even with perfect match', () => {
  const ref = A.loadReference(setup());
  const few = ref.buildings.slice(0, 5);
  const b = A.buildingAccuracy(few, ref);
  assert.strictEqual(A.classify(b, { samples: 500, refEdgeLines: 2, bracketedSamples: 500, bracketedPct: 100 }).status, 'INSUFFICIENT_DATA');
});

test('centimetre-identical geometry is flagged as shared lineage, not PASS', () => {
  const ref = A.loadReference(setup());
  const b = A.buildingAccuracy(ref.buildings, ref); // identical copy
  assert.strictEqual(b.suspectedSharedLineage, false, 'fixture has only a few vertices (below min n)');
  const big = { ...b, evaluated: 100, refBuildings: 100, matchedPct: 100, suspectedSharedLineage: true, vertexDistM: { median: 0.03, p95: 0.09, n: 5000 } };
  const c = A.classify(big, { samples: 500, refEdgeLines: 2, bracketedSamples: 500, bracketedPct: 100 });
  assert.strictEqual(c.status, 'INSUFFICIENT_DATA');
  assert.ok(c.reasons.some((x) => /NOT an independent/.test(x)));
});
