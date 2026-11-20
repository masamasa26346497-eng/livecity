'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const A = require('../tools/mission46a-align-audit.cjs');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'public/map-data/osaka-city');
const hasSrc = fs.existsSync(path.join(SRC, 'buildings/osaka-sumiyoshi/manifest.json'));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'm46a-'));
test.after(() => fs.rmSync(T, { recursive: true, force: true }));

// synthetic src: tracked Sumiyoshi footprints (read-only copy of the manifest dir is NOT made; we point at the repo) + synthetic roads
let cached = null;
function makeRoadsSrc() {
  if (cached) return cached;
  const dst = path.join(T, 'src');
  fs.mkdirSync(path.join(dst, 'roads'), { recursive: true });
  fs.symlinkSync(path.join(SRC, 'buildings'), path.join(dst, 'buildings'));
  const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json'), 'utf8'));
  fs.writeFileSync(path.join(dst, 'roads/manifest.json'), JSON.stringify({ tileSize: 2000, coordinateConvention: 'znorth-neg-v1' }));
  for (let tx = -2; tx <= 0; tx++) for (let tz = -2; tz <= 1; tz++) fs.writeFileSync(path.join(dst, 'roads', `tile_${tx}_${tz}.json`), JSON.stringify({ features: r.features }));
  cached = { dst, roads: r };
  return cached;
}

test('46A: ECEF->geodetic->local inversion round-trips the viewer projection', () => {
  const D2R = Math.PI / 180, WA = 6378137, E2 = 0.00669437999014;
  const lon = 135.51, lat = 34.59, s = Math.sin(lat * D2R), N = WA / Math.sqrt(1 - E2 * s * s);
  const g = A.ecefToGeodetic(N * Math.cos(lat * D2R) * Math.cos(lon * D2R), N * Math.cos(lat * D2R) * Math.sin(lon * D2R), N * (1 - E2) * s);
  assert.ok(Math.abs(g.lon - lon) < 1e-9 && Math.abs(g.lat - lat) < 1e-9 && Math.abs(g.h) < 1e-3);
  const l = A.toLocal(CLON(), CLAT());
  assert.ok(Math.abs(l.x) < 1e-6 && Math.abs(l.z) < 1e-6);
});
function CLAT() { return 34.604208; }
function CLON() { return 135.525020; }

test('46A: refuses missing src, does not crash with a path in the message', () => {
  assert.throws(() => A.run({ src: path.join(T, 'nope') }), /--src missing/);
});

test('46A: tool is read-only (no write/delete APIs except the explicit --out wx) and offline', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/mission46a-align-audit.cjs'), 'utf8');
  assert.ok(!/unlinkSync|rmSync|renameSync|copyFileSync|appendFileSync|\bfetch\(|https?\.request|require\('https?'\)\.(get|request)/.test(s));
  assert.ok((s.match(/writeFileSync/g) || []).length === 1 && /flag: 'wx'/.test(s));
  assert.match(s, /listen\(port, '127\.0\.0\.1'/);
  assert.ok(!/applied: 1|applyShift|translate\(/.test(s));
});

test('46A: tracked Sumiyoshi footprints: centroids inside own ward, no tile/height anomalies, roads reported with limits', { skip: !hasSrc }, () => {
  const { dst } = makeRoadsSrc();
  const r = A.run({ src: dst, wards: ['sumiyoshi', 'kita'] });
  const s = r.wards.find((w) => w.wardId === 'sumiyoshi');
  assert.strictEqual(s.footprints.buildings, 35031);
  assert.ok(s.footprints.repInsideOwnPct >= 99);
  assert.strictEqual(s.footprints.tileCellMismatch, 0);
  assert.strictEqual(s.footprints.heightSentinel, 0);
  assert.strictEqual(s.roads.translationProbe.applied, false);
  assert.ok(s.roads.throughFraction.surfaceOnly <= s.roads.throughFraction.allRoads);
  assert.strictEqual(s.verdict.status, 'no-inconsistency-found');
  // a ward without source is never reported as verified
  assert.strictEqual(r.wards.find((w) => w.wardId === 'kita').verdict.status, 'unverified-no-source');
  assert.strictEqual(r.applied, 0);
  assert.ok(r.limits.length >= 4 && /NOT a proof/.test(r.limits[0]));
  // anonymity: no building id / path in the report
  const txt = JSON.stringify(r);
  assert.ok(!/bldg_[0-9a-f]{8}/.test(txt) && !txt.includes(T));
});

test('46A: real converter output (45D-style tiles) + synthetic 45I layers pass; tampered copies are caught', { skip: !hasSrc }, () => {
  const { dst, roads } = makeRoadsSrc();
  const tiles = path.join(T, 'tiles');
  execFileSync(process.execPath, [path.join(ROOT, 'tools/mission40b-legacy-tiles-batch.cjs'), '--ward', 'sumiyoshi', '--force', '--out', path.join(tiles, 'sumiyoshi')], { stdio: 'pipe' });
  const layers = path.join(T, 'layers');
  const ld = path.join(layers, 'sumiyoshi', 'layers');
  fs.mkdirSync(ld, { recursive: true });
  fs.writeFileSync(path.join(ld, 'layers-report.json'), JSON.stringify({ wardCode: '27120' }));
  fs.writeFileSync(path.join(ld, 'roads.json'), JSON.stringify({ coordinateConvention: 'znorth-neg-v1', features: roads.features }));
  const ok = A.run({ src: dst, tilesRoot: tiles, layersRoot: layers, wards: ['sumiyoshi'] }).wards[0];
  assert.strictEqual(ok.tiles.status, 'ok');
  assert.ok(ok.tiles.attrs.matchedToSourceById > 35000);
  assert.ok(ok.tiles.attrs.repVsSourceRepM.max <= 0.5, 'attrs rep == source rep');
  assert.ok(ok.tiles.tileFrame.leafTiles > 40 && ok.tiles.tileFrame.originOffsetFromCellCentreM.max < 0.5, JSON.stringify(ok.tiles.tileFrame));
  assert.ok(Math.abs(ok.tiles.tileFrame.ellipsoidHeightM.max) < 1);
  assert.ok(ok.layers.files.roads.vertexMatchesSourceRoadsPct >= 99);
  assert.strictEqual(ok.verdict.status, 'no-inconsistency-found', JSON.stringify(ok.verdict));

  // tamper 1: shift the tileset root transform by 25 m east (copy only) -> origin mismatch
  const ts = JSON.parse(fs.readFileSync(path.join(tiles, 'sumiyoshi/tileset.json'), 'utf8'));
  const first = (n) => (n.transform ? n : (n.children || []).map(first).find(Boolean));
  const gnode = first(ts.root);
  gnode.transform[12] += 25;
  fs.writeFileSync(path.join(tiles, 'sumiyoshi/tileset.json'), JSON.stringify(ts));
  const bad1 = A.run({ src: dst, tilesRoot: tiles, wards: ['sumiyoshi'] }).wards[0];
  assert.strictEqual(bad1.verdict.status, 'issues');
  assert.ok(bad1.verdict.issues.some((i) => /frame origin/.test(i)));

  // tamper 2: 45I roads shifted 5 m -> vertices no longer coincide with the source
  const shifted = roads.features.map((f) => Object.assign({}, f, { p: f.p.map((q) => [q[0] + 5, q[1]]) }));
  fs.writeFileSync(path.join(ld, 'roads.json'), JSON.stringify({ coordinateConvention: 'znorth-neg-v1', features: shifted }));
  const bad2 = A.run({ src: dst, layersRoot: layers, wards: ['sumiyoshi'] }).wards[0];
  assert.ok(bad2.verdict.issues.some((i) => /45I roads vertices/.test(i)), JSON.stringify(bad2.verdict));
});

test('46A: --out must be new and outside inputs; serve exposes aggregate JSON only on loopback', { skip: !hasSrc }, async () => {
  const { dst } = makeRoadsSrc();
  assert.throws(() => A.run({ src: dst, out: path.join(dst, 'x.json') }), /inside an input/);
  const rep = A.run({ src: dst, wards: ['sumiyoshi'] });
  const http = require('http');
  const srv = await A.serveSummary(rep, 0 || 18146);
  try {
    const get = (p, host) => new Promise((res) => http.get({ host: '127.0.0.1', port: 18146, path: p, headers: { Host: host || '127.0.0.1:18146' } }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ code: r.statusCode, b })); }));
    const ok = await get('/align46a/summary.json');
    assert.strictEqual(ok.code, 200);
    assert.strictEqual(JSON.parse(ok.b).schema, A.SCHEMA);
    assert.strictEqual((await get('/')).code, 404);
    assert.strictEqual((await get('/align46a/summary.json', 'evil.example:18146')).code, 403);
    assert.strictEqual(srv.address().address, '127.0.0.1');
  } finally { srv.close(); }
});
