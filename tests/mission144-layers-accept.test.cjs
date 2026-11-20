'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const L = require('../tools/mission144-lib.cjs');
const W = require('../tools/mission144-water-surface.cjs');
const wr = (d, f, o) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, f), JSON.stringify(o)); };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('144: projection constants are the shared znorth-neg-v1 ones and round-trip', () => {
  assert.deepStrictEqual(L.PROJ, { clat: 34.604208, clon: 135.52502, mpd: 111320 });
  assert.match(read('public/mission37g-osaka-24ward-mvp.html'), /clat: 34\.604208, clon: 135\.525020, mpd: 111320/);
  const p = L.toLocal(L.toLon(-1234.5), L.toLat(678.9));
  assert.ok(Math.abs(p.x + 1234.5) < 1e-6 && Math.abs(p.z - 678.9) < 1e-6);
  assert.ok(L.lonLatDiffM({ lon: L.toLon(100), lat: L.toLat(0) }, { lon: L.toLon(0), lat: L.toLat(0) }) > 99.9);
});

test('144: classification never claims browser rendering and separates sea file from water polygons', () => {
  const c = L.classifyWard({ roads: { parsed: true, features: 5 }, waterways: { parsed: true, features: 4, lines: 3, areas: 1 } });
  assert.strictEqual(c.roads, 'roads ready'); assert.strictEqual(c.waterways, 'waterways ready');
  assert.strictEqual(c.waterSurface, 'water-surface absent'); assert.strictEqual(c.waterAreas, 1);
  assert.strictEqual(c.browser, 'browser rendered unverified');
  assert.match(L.classLine(c), /roads ready \/ waterways ready \/ water-surface absent \/ browser rendered unverified/);
  assert.strictEqual(L.classifyWard({}).roads, 'roads absent');
});

test('144: road/building overlap flags a shifted frame, not an aligned one', () => {
  const roads = [{ p: [[0, 0], [200, 0]] }];
  const aligned = Array.from({ length: 50 }, (_, i) => [i * 4, 15]);   // buildings 15 m beside the road
  const shifted = Array.from({ length: 50 }, (_, i) => [i * 4, 0.5]);  // buildings on the carriageway
  assert.ok(L.roadBuildingOverlap(roads, aligned).onRoadRatio < 0.01);
  assert.ok(L.roadBuildingOverlap(roads, shifted).onRoadRatio > 0.9);
});

test('144: ward sampling is deterministic and keeps first and last', () => {
  const ids = Array.from({ length: 24 }, (_, i) => 'w' + i);
  const s = L.sampleWards(ids, 6);
  assert.strictEqual(s[0], 'w0'); assert.strictEqual(s[s.length - 1], 'w23'); assert.strictEqual(s.length, 6);
  assert.strictEqual(L.sampleWards(ids, 99).length, 24);
});

test('144: water diagnosis explains 0 wards without inventing a surface from centre lines', () => {
  const lr = fs.mkdtempSync(path.join(os.tmpdir(), 'm144a-'));
  const box = { minX: 0, maxX: 100, minZ: 0, maxZ: 100 };
  wr(path.join(lr, 'a', 'layers'), 'waterways.json', { bboxLocal: box, features: [{ id: 'l1', p: [[0, 0], [1, 1]] }] });
  wr(path.join(lr, 'b', 'layers'), 'waterways.json', { bboxLocal: box, features: [{ id: 'p1', kind: 'area', p: [[0, 0], [9, 0], [9, 9]] }] });
  const rows = W.diagnose(lr);
  assert.match(rows.find((r) => r.ward === 'a').cause, /centre lines.*no surface is generated/);
  assert.match(rows.find((r) => r.ward === 'b').cause, /polygons are inside waterways\.json/);
  assert.ok(rows.every((r) => !r.waterSurfaceFile));
});

test('144: sea slicing keeps only whole triangles inside the ward box; apply is new-file-only and dry-run by default', () => {
  const lr = fs.mkdtempSync(path.join(os.tmpdir(), 'm144b-'));
  wr(path.join(lr, 'a', 'layers'), 'waterways.json', { bboxLocal: { minX: 0, maxX: 100, minZ: 0, maxZ: 100 }, features: [] });
  wr(path.join(lr, 'b', 'layers'), 'waterways.json', { bboxLocal: { minX: 500, maxX: 600, minZ: 0, maxZ: 100 }, features: [] });
  const src = path.join(lr, 'sea.json');
  fs.writeFileSync(src, JSON.stringify({ emitted: true, coordinateConvention: 'znorth-neg-v1', positions: [10, 10, 20, 10, 20, 20, /* straddles box a */ 90, 90, 150, 90, 150, 150] }));
  const dry = W.apply(lr, src, null, false);
  assert.strictEqual(dry.find((r) => r.ward === 'a').action, 'would-write'); assert.strictEqual(dry.find((r) => r.ward === 'a').triangles, 1);
  assert.strictEqual(dry.find((r) => r.ward === 'b').action, 'none');
  assert.ok(!fs.existsSync(path.join(lr, 'a', 'layers', 'water-surface.json')));
  W.apply(lr, src, null, true);
  const f = JSON.parse(fs.readFileSync(path.join(lr, 'a', 'layers', 'water-surface.json'), 'utf8'));
  assert.strictEqual(f.count, 1); assert.strictEqual(f.features[0].kind, 'area');
  assert.strictEqual(W.apply(lr, src, null, true).find((r) => r.ward === 'a').action, 'skip-existing');   // never overwrites
  assert.deepStrictEqual(L.sliceWaterSurface({ emitted: false, positions: [] }, { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }).features, []);
});

test('144: launcher counts water polygons separately and prints the 4-way classification; one-command entry kept', () => {
  const s = read('tools/mission141-local-24.mjs');
  assert.match(s, /kind === 'area'/); assert.match(s, /browser rendered unverified/); assert.match(s, /water-surface absent/);
  assert.match(s, /--layers-root/); assert.match(s, /--build-layers/);
});

test('144: acceptance E2E is read-only, loopback, own port, no delete/network/Google; page hook is localhost+qa only', () => {
  const e = read('tools/experiments/mission144_acceptance_e2e.mjs');
  assert.doesNotMatch(e, /rmSync|unlinkSync|Remove-Item|robocopy|https?:\/\/(?!127)/);
  assert.match(e, /'8192'/); assert.match(e, /fixture/); assert.match(e, /rendered/);
  const h = read('public/mission37g-osaka-24ward-mvp.html');
  const i = h.indexOf('probe144('), q = h.lastIndexOf("get('qa') === '1'", i);
  assert.ok(i > 0 && q > 0 && i - q < 6000, 'probe144 sits inside the localhost ?qa=1 block');
  const body = h.slice(i, h.indexOf('setLayer: (id, on)', i));
  assert.doesNotMatch(body, /\.add\(|\.remove\(|setBuildingWard|fetch\(/);
});

test('144: water-surface tool has no network, no overwrite, no delete', () => {
  const s = read('tools/mission144-water-surface.cjs');
  assert.doesNotMatch(s, /require\('(node:)?https?'\)|fetch\(|rmSync|unlinkSync|renameSync/);
  assert.match(s, /flag: 'wx'/);
});
