'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../tools/lib/mission49-glb-footprints.cjs');
const R = (p) => path.join(__dirname, '..', p);

test('footprints recovered from the tracked Kita GLBs match the attrs representative points (frame/sign check)', () => {
  const ts = R('public/mission37h-3dtiles/kita-sample');
  const fps = G.allFootprints(ts);
  assert.strictEqual(fps.length, 2698);
  const rep = {};
  for (const f of fs.readdirSync(ts + '/attrs')) { const j = JSON.parse(fs.readFileSync(ts + '/attrs/' + f)); Object.assign(rep, j.byId); }
  const d = fps.map((b) => {
    const r = rep[b.id]; assert.ok(r, 'attrs has ' + b.id);
    const cx = b.ring.reduce((s, p) => s + p[0], 0) / b.ring.length, cz = b.ring.reduce((s, p) => s + p[1], 0) / b.ring.length;
    return Math.hypot(cx - r[2], cz - r[3]);
  }).sort((a, b) => a - b);
  assert.ok(d[d.length >> 1] < 1, 'median centroid error < 1 m (north = -z, same constants as geoToThree)');
});

test('FIX24 analogue: Cesium leaf GLB footprints equal the tracked source footprints (no outline simplification)', () => {
  const rep = JSON.parse(fs.readFileSync(R('data/reports/mission49/footprint-exact-sumiyoshi.json')));
  assert.strictEqual(rep.glbBuildings, 10546);
  assert.strictEqual(rep.missingInSource, 0);
  assert.strictEqual(rep.over1m, 0);
  assert.ok(rep.maxVertexDeviationM.max < 0.05);
});

test('independent GSI check: no rigid or local shift lowers water overlap + road-edge crossings (minimum at 0,0)', () => {
  for (const n of ['kita', 'sumiyoshi']) {
    const r = JSON.parse(fs.readFileSync(R('data/reports/mission49/' + n + '.json')));
    assert.strictEqual(r.shiftSearch.minAtZero, true, n + ' coarse');
    assert.strictEqual(r.shiftSearch.fine.minAtZero, true, n + ' fine');
    for (const q of r.shiftSearch.quadrants) assert.deepStrictEqual([q.dx, q.dz], [0, 0], n + ' ' + q.quadrant);
    assert.ok(r.plateau.water.wetPct < 0.5, n + ' water overlap is tiny');
    assert.ok(r.counts.gsiRdEdgSegments > 1000 && r.counts.gsiBldA > 1000, 'reference not empty');
  }
});

test('GSI road-edge data files: format, window, coordinates', () => {
  for (const f of ['gsi-roadedge-sumiyoshi-9tile.json', 'gsi-roadedge-kita-sample.json']) {
    const d = JSON.parse(fs.readFileSync(R('public/mission49-data/' + f)));
    assert.strictEqual(d.kind, 'gsi-road-edge');
    assert.ok(/国土地理院/.test(d.credit));
    assert.ok(d.lines.length > 500);
    const b = d.bboxLocal;
    for (const l of d.lines) for (const p of l) assert.ok(p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minZ && p[1] <= b.maxZ);
    assert.ok(fs.statSync(R('public/mission49-data/' + f)).size < 400 * 1024, 'small');
  }
});

test('viewer: GSI road-edge layer is default OFF, lazy, same-origin, and adds no Google reference', () => {
  const h = fs.readFileSync(R('public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.match(h, /id: 'gsiroadedge'[\s\S]{0,200}defaultOn: false/);
  assert.match(h, /mission49-data\//);
  const blk = h.slice(h.indexOf('GSI_EDGE_SETS'), h.indexOf('未接続レイヤー'));
  assert.ok(!/google|maps\.googleapis/i.test(blk));
  assert.ok(!/fetch\('https?:/.test(blk));
});

test('production HTML files untouched', () => {
  for (const f of ['public/osaka_3d_buildings.html', 'public/osaka_3d_buildings.fullward-v3.html']) {
    const s = fs.readFileSync(R(f), 'utf8');
    assert.ok(!/gsiroadedge|mission49/.test(s));
  }
});
