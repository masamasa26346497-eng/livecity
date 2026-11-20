'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const ROOT = path.join(__dirname, '..');
const M = () => import('../tools/mission141-local-24.mjs');
const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ s: r.statusCode, b })); }).on('error', rej));

function mkWard(dataRoot, name, ids, wardCode) {
  const d = path.join(dataRoot, name); fs.mkdirSync(path.join(d, 'ids'), { recursive: true });
  fs.writeFileSync(path.join(d, 'tileset.json'), '{"asset":{"version":"1.1"},"root":{}}');
  fs.writeFileSync(path.join(d, 'ids', 't_0_0.json'), JSON.stringify(ids));
  if (wardCode) fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify({ wardCode }));
  return d;
}

test('24-ward switching (synthetic): resolves valid wards, rejects bad ones, serves each ward separately', async () => {
  const { loadWards, resolveWards } = await M();
  const { makeServer } = await import('../tools/mission81-local-preview.mjs');
  const wards = loadWards();
  assert.strictEqual(wards.length, 24);
  assert.strictEqual(new Set(wards.map((w) => w.wardId)).size, 24);
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm141-'));
  mkWard(dataRoot, 'kita25', ['bldg_a', 'bldg_b'], wards.find((w) => w.wardId === 'kita').wardCode);
  mkWard(dataRoot, 'chuo25', ['bldg_c'], wards.find((w) => w.wardId === 'chuo').wardCode);
  mkWard(dataRoot, 'konohana25', ['bldg_d', 'bldg_d'], null);
  mkWard(dataRoot, 'abeno25', ['bldg_e'], '99999');
  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'm141r-'));
  const { rows, map } = resolveWards({ root: emptyRepo, dataRoot, wards });
  assert.strictEqual(rows.length, 24);
  assert.deepStrictEqual(Object.keys(map).sort(), ['chuo25', 'kita25']);
  assert.strictEqual(rows.find((r) => r.ward === 'konohana').status, 'not-delivered');
  assert.strictEqual(rows.find((r) => r.ward === 'abeno').status, 'not-delivered');
  assert.strictEqual(rows.find((r) => r.ward === 'kita').buildings, 2);
  const srv = makeServer({ publicDir: path.join(ROOT, 'public'), wards: map });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.deepStrictEqual(JSON.parse((await get(port, '/ext-3dtiles/index.json')).b).wards.map((w) => w.ward), ['chuo25', 'kita25']);
    assert.strictEqual((await get(port, '/ext-3dtiles/kita25/tileset.json')).s, 200);
    assert.strictEqual((await get(port, '/ext-3dtiles/abeno25/tileset.json')).s, 404);
    assert.strictEqual((await get(port, '/ext-3dtiles/kita25/..%2f..%2fpackage.json')).s, 404);
  } finally { srv.close(); }
});

test('archive safety and sync-root refusal', async () => {
  const { unsafeEntries, underSync } = await M();
  assert.deepStrictEqual(unsafeEntries(['a/tileset.json', 'a/ids/t.json']), []);
  assert.strictEqual(unsafeEntries(['../x', '/etc/p', 'C:\\x', 'a/../b']).length, 4);
  assert.ok(underSync(path.resolve('/home/u/OneDrive/x'), { OneDrive: path.resolve('/home/u/OneDrive') }));
  assert.ok(!underSync(path.resolve('/home/u/work'), { OneDrive: path.resolve('/home/u/OneDrive') }));
});

test('tool only reads the private release and never publishes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/mission141-local-24.mjs'), 'utf8');
  assert.ok(!/'(upload|create|delete|edit)'/.test(src));
  assert.ok(!/'(push|commit)'|gh\(\['(api|auth|secret)'/.test(src));
  assert.ok(!/GH_TOKEN|READ_TOKEN|0\.0\.0\.0/.test(src));
  assert.ok(/EXPO_CODE/.test(src) && /binding is fixed to 127\.0\.0\.1/.test(src));
});
