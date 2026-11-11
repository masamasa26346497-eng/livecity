'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const L = () => import('../tools/mission83-local-all.mjs');

test('args: validated, loopback-only, dry-run wiring', async () => {
  const m = await L();
  assert.strictEqual(m.HOST, '127.0.0.1');
  const o = m.parseArgs(['--wards', 'kita,chuo', '--port', '8200', '--max-wards', '2', '--deadline-min', '9']);
  assert.deepStrictEqual(m.batchArgs(o), ['tools/mission80-batch.mjs', '--wards', 'kita,chuo', '--max-wards', '2', '--deadline-min', '9']);
  assert.deepStrictEqual(m.serveArgs(o), ['tools/mission81-local-preview.mjs', '--ward', 'all', '--port', '8200']);
  assert.throws(() => m.parseArgs(['--port', '80']));
  assert.throws(() => m.parseArgs(['--wards', 'a;b']));
});
test('summarize never reports complete below 24 wards', async () => {
  const m = await L();
  const s = m.summarize({ wards: { a: { status: 'ok', buildings: 5 }, b: { status: 'failed' } } });
  assert.deepStrictEqual([s.ok, s.failed, s.buildings, s.complete], [['a'], ['b'], 5, false]);
});
test('source: synchronous only, no detached/background, no host option, no delete/copy', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'mission83-local-all.mjs'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/detached|\.unref\(|nohup|\bspawn\(|exec\(|rmSync|unlink|copyFile|cpSync|fetch\(/.test(src));
  assert.ok(/spawnSync/.test(src));
  assert.ok(!/--host/.test(src));
});
