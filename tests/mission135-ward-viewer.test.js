// Mission 135: Cesium 24区ビューア統合（アダプター・ローカル専用サーバー・投影定数・fixture・状態表示）。ブラウザ不要。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { liveCityProjection } from '../tools/lib/livecity-coordinate-system.js';
import { buildWardLayers, collectCityLayer, collectWaterSurface, tilesFor, loadWards } from '../tools/lib/ward-layer-adapter.js';
import { createServer, hostOk, originOk, wardIndex } from '../tools/mission135/server.js';
import { writeFixture, geodeticToEcef, fixtureGeometry } from '../tools/mission135/make-fixtures.js';
import { wardStates, verifiedLayersFromReport } from '../tools/mission135/ward-status.js';
import { DEFAULT_POLYGONS } from '../tools/mission135/build-ward-layers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm135t-'));
const wj = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const BBOX = { minX: 0, maxX: 1000, minZ: -3000, maxZ: -2000 };
const WARD = { wardId: 'testward', bbox: BBOX };

test('viewer projection constants equal the official Live City projection (no ad-hoc offsets)', () => {
  const js = fs.readFileSync('public/mission135-ward-viewer.js', 'utf8');
  const m = js.match(/const PROJ = \{ clat: ([\d.]+), clon: ([\d.]+), mpd: (\d+) \}/);
  assert.ok(m, 'PROJ literal present');
  const p = liveCityProjection();
  assert.equal(Number(m[1]), p.centerLat); assert.equal(Number(m[2]), p.centerLon); assert.equal(Number(m[3]), p.metersPerDegree);
  assert.match(js, /toLon = \(x\) => PROJ\.clon \+ x \/ \(COS_CLAT \* PROJ\.mpd\)/);
  assert.match(js, /toLat = \(z\) => PROJ\.clat - z \/ PROJ\.mpd/);
  // 位置を合わせるための場当たり補正を持たない
  assert.doesNotMatch(js, /OFFSET_|rotateBy|addDeg/);
  assert.match(js, /LAYER_H = \{ waterways: 0\.5, roads: 1\.4 \}/);
});

test('viewer: cancellation, release and 404 handling are implemented', () => {
  const js = fs.readFileSync('public/mission135-ward-viewer.js', 'utf8');
  assert.match(js, /new AbortController\(\)/); assert.match(js, /ctrl\.abort\(\)/); assert.match(js, /scene\.primitives\.remove/);
  assert.match(js, /status === 404/); assert.match(js, /未取得（/); assert.match(js, /my !== S\.gen/);
  assert.doesNotMatch(js, /index\.html/);
});

test('adapter: collects only ward-overlapping features, de-duplicates by id, does not move coordinates', () => {
  const root = tmp();
  wj(path.join(root, 'roads', 'manifest.json'), { coordinateConvention: 'znorth-neg-v1' });
  const inside = { id: 'r1', kind: 'line', tier: 'major', p: [[100, -2500], [200, -2500]] };
  const outside = { id: 'r2', kind: 'line', p: [[9000, 9000], [9100, 9000]] };
  for (const t of tilesFor(BBOX)) wj(path.join(root, 'roads', `tile_${t.tx}_${t.tz}.json`), { features: [inside, outside] });
  const r = collectCityLayer(root, 'roads', BBOX);
  assert.equal(r.state, 'generated'); assert.equal(r.features.length, 1);
  assert.deepEqual(r.features[0].p, inside.p);
});

test('adapter: missing input => not-acquired with no features (nothing fabricated); wrong convention rejected', () => {
  const root = tmp();
  assert.equal(collectCityLayer(root, 'roads', BBOX).state, 'not-acquired');
  wj(path.join(root, 'roads', 'manifest.json'), { coordinateConvention: 'other' });
  const r = collectCityLayer(root, 'roads', BBOX);
  assert.equal(r.state, 'rejected'); assert.equal(r.features.length, 0);
  assert.equal(collectWaterSurface(root, BBOX).state, 'not-acquired');
  wj(path.join(root, 'water-surface', 'water-surface.json'), { coordinateConvention: 'znorth-neg-v1', emitted: true, positions: [1, 2, 3] });
  assert.equal(collectWaterSurface(root, BBOX).state, 'rejected');
});

test('adapter: buildWardLayers writes only layers with data and removes stale outputs', () => {
  const root = tmp(), out = tmp();
  wj(path.join(root, 'roads', 'manifest.json'), { coordinateConvention: 'znorth-neg-v1' });
  for (const t of tilesFor(BBOX)) wj(path.join(root, 'roads', `tile_${t.tx}_${t.tz}.json`), { features: [{ id: 'r1', kind: 'line', p: [[100, -2500], [200, -2500]] }] });
  wj(path.join(out, 'testward', 'layers', 'waterways.json'), { stale: true });
  const r = buildWardLayers({ mapRoot: root, outRoot: out, ward: WARD });
  assert.equal(r.layers.roads.state, 'generated'); assert.equal(r.layers.waterways.state, 'not-acquired'); assert.equal(r.layers.waterSurface.state, 'not-acquired');
  assert.ok(fs.existsSync(path.join(out, 'testward', 'layers', 'roads.json')));
  assert.ok(!fs.existsSync(path.join(out, 'testward', 'layers', 'waterways.json')), 'stale waterways removed');
  assert.throws(() => buildWardLayers({ mapRoot: root, outRoot: out, ward: { wardId: '../x', bbox: BBOX } }));
});

async function withServer(opts, fn) {
  let port = 0; const srv = createServer({ ...opts, getPort: () => port });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); port = srv.address().port;
  const get = (p, headers = {}, method = 'GET') => new Promise((res, rej) => { const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (rsp) => { const c = []; rsp.on('data', (d) => c.push(d)); rsp.on('end', () => res({ status: rsp.statusCode, body: Buffer.concat(c).toString('latin1') })); }); rq.on('error', rej); rq.end(); });
  try { await fn({ get, port, srv }); } finally { srv.close(); }
}

test('server: loopback only, 404 for missing, no traversal, no non-allowlisted files, read-only', async () => {
  const b = tmp(), l = tmp();
  const wards = loadWards(DEFAULT_POLYGONS);
  const ids = wards.slice(0, 2).map((w) => w);
  writeFixture({ buildingsRoot: b, layersRoot: l, wards: ids, skipLayers: { [ids[1].wardId]: ['roads'] } });
  fs.writeFileSync(path.join(b, `${ids[0].wardId}25`, 'secret.txt'), 'x');
  await withServer({ buildingsRoot: b, layersRoot: l }, async ({ get, srv, port }) => {
    assert.equal(srv.address().address, '127.0.0.1');
    const A = ids[0].wardId, B = ids[1].wardId;
    assert.equal((await get(`/ext-3dtiles/${A}25/tileset.json`)).status, 200);
    assert.equal((await get(`/ext-3dtiles/${A}25/b.glb`)).status, 200);
    assert.equal((await get(`/ext-3dtiles/${A}/layers/roads.json`)).status, 200);
    assert.equal((await get(`/ext-3dtiles/${B}/layers/roads.json`)).status, 404, 'missing layer is 404, never an empty 200');
    assert.equal((await get(`/ext-3dtiles/${A}25/secret.txt`)).status, 404);
    assert.equal((await get(`/ext-3dtiles/${A}25/..%2F..%2Fx.json`)).status, 404);
    assert.equal((await get(`/ext-3dtiles/..%2Ftmp/layers/roads.json`)).status, 404);
    assert.equal((await get(`/ext-3dtiles/${A}/layers/roads.json`, { Host: 'evil.example' })).status, 403);
    assert.equal((await get(`/ext-3dtiles/${A}/layers/roads.json`, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await get('/index.json', {}, 'POST')).status, 405);
    const idx = JSON.parse((await get('/index.json')).body);
    assert.equal(idx.wards.length, 24);
    assert.equal(idx.wards.find((w) => w.wardId === A).available.buildings, true);
    assert.equal(idx.wards.find((w) => w.wardId === B).available.roads, false);
    assert.equal(idx.wards.filter((w) => w.available.buildings).length, 2);
    assert.ok(hostOk(`127.0.0.1:${port}`, port) && !hostOk('example.com', port) && originOk(undefined, port) && !originOk('http://x', port));
  });
});

test('fixture: valid GLB + tileset anchored by the official projection (ENU basis orthonormal, ward center on the ellipsoid)', () => {
  const b = tmp(), l = tmp(), w = loadWards(DEFAULT_POLYGONS).slice(0, 2);
  const geos = writeFixture({ buildingsRoot: b, layersRoot: l, wards: w });
  for (const ward of w) {
    const dir = path.join(b, `${ward.wardId}25`), glb = fs.readFileSync(path.join(dir, 'b.glb'));
    assert.equal(glb.toString('latin1', 0, 4), 'glTF'); assert.equal(glb.readUInt32LE(8), glb.length);
    const ts = JSON.parse(fs.readFileSync(path.join(dir, 'tileset.json'), 'utf8')), T = ts.root.transform;
    const o = T.slice(12, 15), g = geodeticToEcef;
    const r = Math.hypot(...o); assert.ok(r > 6.35e6 && r < 6.38e6);
    const col = (i) => T.slice(i * 4, i * 4 + 3);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(Math.hypot(...col(i)) - 1) < 1e-9);
    assert.equal(geos[ward.wardId].buildings.length, 6);
    { const e = g(34.6, 135.5, 0); assert.ok(e[0] < 0 && e[1] > 0 && e[2] > 0 && Math.abs(Math.hypot(...e) - 6.37e6) < 3e4); }
    assert.equal(JSON.parse(fs.readFileSync(path.join(l, ward.wardId, 'layers', 'waterways.json'), 'utf8')).coordinateConvention, 'znorth-neg-v1');
  }
  assert.equal(fixtureGeometry(w[0].bbox).roads.length, 2);
});

test('status: only real (non-synthetic) WebGL reports count as WebGL検証済', () => {
  const b = tmp(), l = tmp(), w = loadWards(DEFAULT_POLYGONS);
  writeFixture({ buildingsRoot: b, layersRoot: l, wards: w.slice(0, 1) });
  const px = (n) => ({ diff: n });
  const wardRep = { layers: { buildings: { cls: 'ready' }, roads: { cls: 'ready' }, waterLine: { cls: 'ready' }, waterArea: { cls: 'ready' } }, pixels: { buildings: px(5000), roads: px(5000), waterLine: px(5000), waterArea: px(5000) } };
  const id = w[0].wardId;
  const synthetic = { dataKind: 'synthetic-fixture', wards: { [id]: wardRep } };
  assert.equal(verifiedLayersFromReport(synthetic).size, 0);
  const s1 = wardStates({ buildingsRoot: b, layersRoot: l, realReport: synthetic });
  assert.equal(s1.filter((r) => r.allWebglVerified).length, 0);
  assert.equal(s1[0].layers.buildings, 'generated'); assert.equal(s1[1].layers.buildings, 'not-acquired');
  const real = wardStates({ buildingsRoot: b, layersRoot: l, realReport: { dataKind: 'real', wards: { [id]: wardRep } } });
  assert.equal(real.filter((r) => r.allWebglVerified).length, 1);
  const weak = { ...wardRep, pixels: { ...wardRep.pixels, roads: px(3) } };
  assert.equal(wardStates({ buildingsRoot: b, layersRoot: l, realReport: { dataKind: 'real', wards: { [id]: weak } } })[0].allWebglVerified, false);
  assert.equal(wardIndex({ buildingsRoot: b, layersRoot: l }).length, 24);
});

test('committed synthetic e2e report is labelled synthetic and never claims real 24-ward proof', () => {
  const f = 'data/reports/mission135/synthetic-e2e.json';
  if (!fs.existsSync(f)) return;
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(r.dataKind, 'synthetic-fixture'); assert.equal(r.realData24WardsProven, false);
});
