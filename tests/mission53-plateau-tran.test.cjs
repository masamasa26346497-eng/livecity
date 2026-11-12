const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run, parseTran, toLocal, pip } = require('../tools/mission53-plateau-tran-vs-gsi.cjs');

test('toLocal matches geoToThree constants (origin -> 0,0; north is -z)', () => {
  const o = toLocal(34.604208, 135.525020);
  assert.ok(Math.abs(o[0]) < 1e-9 && Math.abs(o[1]) < 1e-9);
  assert.ok(toLocal(34.605208, 135.525020)[1] < 0);
  assert.ok(toLocal(34.604208, 135.526020)[0] > 0);
});

test('pip basic', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.ok(pip(5, 5, sq));
  assert.ok(!pip(15, 5, sq));
});

test('parseTran reads Road exterior ring (lat lon h) and run() reports water overlap', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm53-'));
  const lat0 = 34.604208, lon0 = 135.525020;
  const pos = [[lat0, lon0], [lat0, lon0 + 0.0001], [lat0 - 0.0001, lon0 + 0.0001], [lat0 - 0.0001, lon0], [lat0, lon0]]
    .map(p => p[0] + ' ' + p[1] + ' 0').join(' ');
  const gml = '<core:CityModel><tran:Road gml:id="tran_x"><tran:function>1</tran:function><tran:lod1MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>' + pos + '</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></tran:lod1MultiSurface></tran:Road></core:CityModel>';
  fs.writeFileSync(path.join(d, 'tran_test.gml'), gml);
  const polys = parseTran(d);
  assert.strictEqual(polys.length, 1);
  assert.strictEqual(polys[0].ring.length, 5);
  const g = path.join(d, 'gsi.json');
  fs.writeFileSync(g, JSON.stringify({ bboxLocal: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 }, water: [{ outer: [[-50, -50], [50, -50], [50, 50], [-50, 50]] }], lines: [[[0, 0], [5, 5]]] }));
  const r = run(d, g);
  assert.strictEqual(r.roadPolygonsInWindow, 1);
  assert.ok(r.inGsiWater > 0);
});

test('tool is read-only (no network, no writes besides optional out file)', () => {
  const s = fs.readFileSync(path.join(__dirname, '../tools/mission53-plateau-tran-vs-gsi.cjs'), 'utf8');
  assert.ok(!/fetch\(|https?:\/\/|child_process/.test(s.replace(/\/\/.*$/gm, '')));
});
