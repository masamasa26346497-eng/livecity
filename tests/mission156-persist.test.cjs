'use strict';
// Mission 157: retry / delivery manifest / restore integrity / viewer adapter. Fixture only, no network.
const test = require('node:test');
const assert = require('node:assert');
let L;
test.before(async () => { L = await import('../tools/mission156/lib.mjs'); });

test('withRetry retries transient failures then succeeds; gives up after attempts', async () => {
  let n = 0;
  const ok = await L.withRetry(async () => { if (++n < 3) throw new Error('net'); return 'ok'; }, { sleep: async () => {} });
  assert.strictEqual(ok, 'ok'); assert.strictEqual(n, 3);
  let m = 0;
  await assert.rejects(L.withRetry(async () => { m++; throw new Error('down'); }, { attempts: 2, sleep: async () => {} }), /down/);
  assert.strictEqual(m, 2);
});

test('delivery manifest lists only HTTP200-verified wards and is unpublished', () => {
  const base = { wardCode: '1', meshesPlanned: 2, meshesFetched: 2, convertedBuildings: 5, sourceBuildings: 9, orientationOk: true, tiles: 3, outputBytes: 10 };
  const m = L.buildDeliveryManifest({
    a: Object.assign({}, base),
    b: Object.assign({}, base, { http200Verified: true }),
    c: Object.assign({}, base, { http200Verified: true, browserVerified: true }),
    d: { error: 'x' },
  }, 'etag');
  assert.deepStrictEqual(m.wards.map((w) => w.ward), ['b', 'c']);
  assert.strictEqual(m.published, false);
});

test('missingTilesetFiles detects absent tile content (partial restore)', () => {
  const ts = { root: { children: [{ content: { uri: 'tiles/a.glb' } }, { content: { uri: 'tiles/b.glb' } }] } };
  assert.deepStrictEqual(L.missingTilesetFiles(['tiles/a.glb'], ts), ['tiles/b.glb']);
});

test('viewer adapter resolves tileset URLs and rejects bad schema', async () => {
  const A = await import('../tools/mission156/viewer-adapter.mjs');
  const man = { schema: 'livecity-mission156-delivery/1', wards: [{ ward: 'chuo', tileset: 'chuo/tiles/tileset.json' }] };
  const a = await A.loadMission156Manifest('http://x/m/delivery-manifest.json', async () => ({ ok: true, json: async () => man }));
  assert.strictEqual(a.tilesetUrlFor('chuo'), 'http://x/m/chuo/tiles/tileset.json');
  assert.strictEqual(a.tilesetUrlFor('kita'), null);
  await assert.rejects(A.loadMission156Manifest('http://x/m.json', async () => ({ ok: true, json: async () => ({ schema: 'bad' }) })), /schema/);
});
