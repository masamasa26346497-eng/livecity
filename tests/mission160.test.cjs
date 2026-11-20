'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('mission160 safeWardPath blocks traversal and bad ward names', async () => {
  const { safeWardPath, localOrigin } = await import('../tools/mission160-local-serve.mjs');
  const root = path.resolve('temp/x');
  assert.ok(safeWardPath(root, 'kita', 'tileset.json').endsWith(path.join('kita', 'tiles', 'tileset.json')));
  assert.strictEqual(safeWardPath(root, 'kita', '../../chuo/tiles/tileset.json'), null);
  assert.strictEqual(safeWardPath(root, '../kita', 'tileset.json'), null);
  assert.ok(localOrigin('http://127.0.0.1:3000'));
  assert.ok(!localOrigin('https://evil.example'));
});

test('mission160 auth-test never claims success without LIVECITY_3D_DATA_TOKEN', () => {
  const { execFileSync } = require('node:child_process');
  const env = { ...process.env }; delete env.LIVECITY_3D_DATA_TOKEN; env.GITHUB_TOKEN = '';
  let out = '';
  try { execFileSync(process.execPath, ['tools/mission158-private-release.mjs', 'setup'], { env }); } catch (e) { assert.fail('setup failed'); }
  try { out = execFileSync(process.execPath, ['tools/mission158-private-release.mjs', 'auth-test'], { env, timeout: 20000 }).toString(); }
  catch (e) { out = String(e.stdout || ''); assert.notStrictEqual(e.status, 0); }
  assert.ok(!/READ-OK/.test(out));
});
