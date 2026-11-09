'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('hardenTileset: empty interior parents get a geometricError above children; leaves/content untouched', async () => {
  const { hardenTileset } = await import('../tools/mission164/harden-tileset.mjs');
  const ts = { geometricError: 160, root: { geometricError: 160, children: [{ geometricError: 40, children: [{ geometricError: 0, content: { uri: 'a.glb' } }] }] } };
  const changed = hardenTileset(ts, 1e5);
  assert.ok(changed >= 1);
  assert.ok(ts.root.geometricError >= 1e5);
  assert.ok(ts.root.geometricError > ts.root.children[0].geometricError);
  assert.strictEqual(ts.root.children[0].children[0].geometricError, 0);
  assert.strictEqual(ts.root.children[0].children[0].content.uri, 'a.glb');
  assert.ok(ts.geometricError >= ts.root.geometricError);
});

test('hardenTileset: a node WITH content is not inflated', async () => {
  const { hardenTileset } = await import('../tools/mission164/harden-tileset.mjs');
  const ts = { geometricError: 10, root: { geometricError: 10, content: { uri: 'r.glb' }, children: [{ geometricError: 0, content: { uri: 'c.glb' } }] } };
  assert.strictEqual(hardenTileset(ts, 1e5), 0);
  assert.strictEqual(ts.root.geometricError, 10);
});

test('strictBrowserOk: requires tile events and a nonzero pixel difference when reported', async () => {
  const { strictBrowserOk } = await import('../tools/mission158/lib.mjs');
  const base = { status: 'ok', gl: true, jsErrors: [], tilesLoaded: true, drawCommands: 28, tilesetCommandsMax: 7, selectedTilesMax: 7, tileLoadEvents: 7, tileVisibleEvents: 300, pixelDiff: 1000 };
  assert.strictEqual(strictBrowserOk(base), true);
  assert.strictEqual(strictBrowserOk({ ...base, tileLoadEvents: 0 }), false);
  assert.strictEqual(strictBrowserOk({ ...base, tileVisibleEvents: 0 }), false);
  assert.strictEqual(strictBrowserOk({ ...base, pixelDiff: 0 }), false);
});
