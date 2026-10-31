'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../tools/lib/mission46d-mvt.cjs');
const F = require('../tools/mission46d-fetch-gsi-tiles.cjs');

const wards = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
const sumi = wards.find((w) => w.wardId === 'sumiyoshi');
const goodTile = () => M.encodeMvt('BldA', 4096, [{ type: 3, rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]], props: {} }]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm46dfetch-'));
const opts = (out, extra = {}) => ({ out, zoom: 16, maxTilesPerWard: 100, maxRequests: 50, margin: 100, retries: 2, backoffMs: 1, timeoutMs: 100, delayMs: 0, ...extra });

test('local <-> tile mapping: ward bbox tiles cover the Live City origin tile', () => {
  const g = F.localToLonLat(0, 0);
  assert.ok(Math.abs(g.lon - M.CONST.clon) < 1e-9 && Math.abs(g.lat - M.CONST.clat) < 1e-9);
  const tiles = F.tilesForBbox({ minX: -100, maxX: 100, minZ: -100, maxZ: 100 }, 16);
  const o = F.lonLatToTile(M.CONST.clon, M.CONST.clat, 16);
  assert.ok(tiles.some((t) => t.x === o.x && t.y === o.y));
  assert.strictEqual(F.tileName({ z: 16, x: 1, y: 2 }), '16_1_2.pbf');
});

test('sampling keeps only tiles with centre inside the ward polygon, at most N', () => {
  const all = F.tilesForBbox(sumi.bbox, 16, 100);
  const s = F.sampleWardTiles(sumi, all, 5);
  assert.ok(s.length > 0 && s.length <= 5 && s.length <= all.length);
  const full = F.sampleWardTiles(sumi, all, 0);
  assert.ok(full.length < all.length, 'bbox corners outside polygon are dropped');
});

test('response validation rejects html/json/garbage/empty and accepts a real MVT', () => {
  assert.strictEqual(F.validateTileBuffer(goodTile()).ok, true);
  assert.strictEqual(F.validateTileBuffer(Buffer.alloc(0)).ok, false);
  assert.strictEqual(F.validateTileBuffer(Buffer.from('<html>404</html>')).ok, false);
  assert.strictEqual(F.validateTileBuffer(Buffer.from('{"error":1}')).ok, false);
  assert.strictEqual(F.validateTileBuffer(Buffer.alloc(3 * 1024 * 1024, 1)).ok, false);
});

test('retries on 503 then succeeds; 404 is absent (no retry); other 4xx is error', async () => {
  let n = 0;
  const r1 = await F.fetchTile({ z: 16, x: 1, y: 1 }, opts('x'), async () => (++n < 3 ? { status: 503, body: Buffer.alloc(0) } : { status: 200, body: goodTile() }));
  assert.strictEqual(r1.state, 'ok'); assert.strictEqual(n, 3);
  let m = 0;
  assert.strictEqual((await F.fetchTile({ z: 16, x: 1, y: 1 }, opts('x'), async () => { m++; return { status: 404, body: Buffer.alloc(0) }; })).state, 'absent');
  assert.strictEqual(m, 1);
  assert.strictEqual((await F.fetchTile({ z: 16, x: 1, y: 1 }, opts('x'), async () => ({ status: 403, body: Buffer.alloc(0) }))).state, 'error');
  let k = 0;
  const bad = await F.fetchTile({ z: 16, x: 1, y: 1 }, opts('x'), async () => { k++; throw new Error('timeout'); });
  assert.strictEqual(bad.state, 'error'); assert.strictEqual(k, 3, 'bounded retries (1 + 2)');
});

test('run: writes z_x_y.pbf under ward dir, dedups cached tiles, honours request cap, writes manifest', async () => {
  const out = tmp(); let calls = 0;
  const get = async () => { calls++; return { status: 200, body: goodTile() }; };
  const r = await F.run(opts(out, { insideOnly: true, sample: 4, maxRequests: 3 }), [sumi], get);
  assert.strictEqual(calls, 3); assert.strictEqual(r.manifest.stoppedByRequestCap, true);
  const files = fs.readdirSync(path.join(out, 'sumiyoshi'));
  assert.strictEqual(files.length, 3);
  assert.ok(files.every((f) => /^16_\d+_\d+\.pbf$/.test(f)));
  assert.ok(fs.existsSync(path.join(out, 'fetch-manifest.json')));
  calls = 0;
  await F.run(opts(out, { insideOnly: true, sample: 4, maxRequests: 10 }), [sumi], get);
  assert.strictEqual(calls, 1, 'only the missing 4th tile is requested');
});

test('wards over the tile cap are skipped and reported, plan mode makes no requests', async () => {
  const out = tmp(); let calls = 0;
  const r = await F.run(opts(out, { maxTilesPerWard: 3 }), [sumi], async () => { calls++; return { status: 200, body: goodTile() }; });
  assert.strictEqual(calls, 0); assert.strictEqual(r.manifest.skippedWards.length, 1);
  const p = await F.run(opts(out, { plan: true }), [sumi], async () => { calls++; });
  assert.strictEqual(calls, 0); assert.ok(p.manifest.plannedTiles > 0);
});

test('write safety: refuses unsafe ward ids and tracked repo locations; only GSI host is contacted', async () => {
  assert.throws(() => F.assertOutDirSafe(path.join(__dirname, '..', 'public', 'x')), /refusing/);
  assert.doesNotThrow(() => F.assertOutDirSafe(path.join(__dirname, '..', 'temp', 'gsi46d')));
  await assert.rejects(F.run(opts(tmp()), [{ wardId: '../evil', bbox: sumi.bbox }], async () => ({ status: 404, body: Buffer.alloc(0) })), /unsafe/);
  const src = fs.readFileSync(path.join(__dirname, '../tools/mission46d-fetch-gsi-tiles.cjs'), 'utf8');
  assert.deepStrictEqual([...new Set(src.match(/https?:\/\/[a-z0-9.\-]+/g))].filter((u) => !/cyberjapandata\.gsi\.go\.jp|maps\.gsi\.go\.jp|github\.com/.test(u)), []);
  assert.ok(!/unlinkSync|rmSync|rmdirSync/.test(src));
});
