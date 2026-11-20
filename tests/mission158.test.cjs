const test = require('node:test');
const assert = require('node:assert');

test('mission158 lib', async () => {
  const L = await import('../tools/mission158/lib.mjs');
  // protected / public-repo write guards
  assert.throws(() => L.assertWritableTag('plateau2025-converted'), /protected/);
  assert.throws(() => L.assertWritableTag('latest'), /m158-/);
  assert.ok(L.assertWritableTag('m158-run42'));
  assert.throws(() => L.assertWritableRepo(L.PUBLIC_REPO), /public/);
  assert.throws(() => L.assertWritableRepo('someone/else'), /refused/);
  assert.ok(L.assertWritableRepo(L.PRIVATE_REPO));
  // auth classification never carries a token and distinguishes failure modes
  assert.deepStrictEqual(L.classifyAuth(200, { private: true, permissions: { pull: true } }), { ok: true, read: true, write: false, private: true });
  assert.strictEqual(L.classifyAuth(200, { private: true, permissions: { push: true } }).write, true);
  assert.match(L.classifyAuth(404).reason, /404/);
  assert.match(L.classifyAuth(401).reason, /401/);
  // asset summary
  const s = L.summarizeAssets([{ name: 'plateau2025-abeno.tar.gz', size: 5, state: 'uploaded' }, { name: 'x.txt', size: 1 }], ['abeno', 'kita']);
  assert.deepStrictEqual(s.missingWards, ['kita']);
  assert.deepStrictEqual(s.unrecognised, ['x.txt']);
  assert.strictEqual(L.wardFromAsset('plateau2025-higashi-sumiyoshi.tar.gz'), 'higashi-sumiyoshi');
  // missing tile detection in archive listing
  const ins = L.inspectEntries(['./tileset.json', './t/a.glb'], { root: { children: [{ content: { uri: 't/a.glb' } }, { content: { uri: 't/b.glb' } }] } });
  assert.deepStrictEqual(ins.missing, ['t/b.glb']);
  // strict browser verdict: Kita regression (drawCommands 0) must fail
  const ok = { status: 'ok', gl: true, jsErrors: [], tilesLoaded: true, drawCommands: 3 };
  assert.ok(L.strictBrowserOk(ok));
  assert.ok(!L.strictBrowserOk({ ...ok, drawCommands: 0 }));
  assert.ok(!L.strictBrowserOk({ ...ok, drawCommands: null }));
  assert.ok(!L.strictBrowserOk({ ...ok, jsErrors: ['x'] }));
  assert.ok(!L.strictBrowserOk({ ...ok, tilesetCommandsMax: 0, selectedTilesMax: 0 })); // Mission 160: globe-only commands
  assert.ok(L.strictBrowserOk({ ...ok, tilesetCommandsMax: 20, selectedTilesMax: 4 }));
  // round trip
  const m = L.buildStoreManifest({ ward: 'kita', sourceVersion: 'p', sourceEtag: 'e', buildings: 1, tiles: 1, ids: 1, files: [{ name: 'f', size: 3, sha256: L.sha256(Buffer.from('abc')) }] });
  assert.strictEqual(m.published, false);
  assert.strictEqual(m.license.id, 'plateau');
  assert.deepStrictEqual(L.verifyRoundTrip(m.files, { f: { size: 3, sha256: L.sha256(Buffer.from('abc')) } }), []);
  assert.strictEqual(L.verifyRoundTrip(m.files, { f: { size: 3, sha256: 'bad' } })[0].why, 'sha256');
  assert.strictEqual(L.verifyRoundTrip(m.files, {})[0].why, 'missing');
});

test('mission158 CLI put is dry-run by default and refuses protected tag', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['tools/mission158-private-release.mjs', 'put', '--ward', 'x', '--dir', '.', '--tag', 'plateau2025-converted'], { encoding: 'utf8', env: { ...process.env, LIVECITY_3D_DATA_TOKEN: '', GITHUB_TOKEN: '' } });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /protected/);
});
