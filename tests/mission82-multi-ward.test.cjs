'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const ROOT = path.join(__dirname, '..');
const L = () => import('../tools/mission81-local-preview.mjs');
const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ s: r.statusCode, b })); }).on('error', rej));

test('multi-ward server: index.json lists wards, serves each ward dir only, rejects unknown / traversal', async () => {
  const { makeServer } = await L();
  const mk = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm82-')); fs.writeFileSync(path.join(d, 'tileset.json'), t); return d; };
  const a = mk('{"a":1}'), b = mk('{"b":2}');
  const srv = makeServer({ publicDir: path.join(ROOT, 'public'), wards: { nishi25: a, kita25: b } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.strictEqual(srv.address().address, '127.0.0.1');
    const idx = JSON.parse((await get(port, '/ext-3dtiles/index.json')).b);
    assert.deepStrictEqual(idx.wards.map((w) => w.ward), ['kita25', 'nishi25']);
    assert.strictEqual((await get(port, '/ext-3dtiles/nishi25/tileset.json')).b, '{"a":1}');
    assert.strictEqual((await get(port, '/ext-3dtiles/kita25/tileset.json')).b, '{"b":2}');
    assert.strictEqual((await get(port, '/ext-3dtiles/chuo25/tileset.json')).s, 404);
    assert.strictEqual((await get(port, '/ext-3dtiles/nishi25/..%2f..%2fpackage.json')).s, 404);
    assert.strictEqual((await get(port, '/ext-3dtiles/__proto__/tileset.json')).s, 404);
  } finally { srv.close(); }
});

test('--ward all never downloads and refuses Expo 27999', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'mission81-local-preview.mjs'), 'utf8');
  const m = src.slice(src.indexOf('async function mainAll'), src.indexOf('async function main()'));
  assert.ok(!/mission79-run|fetch\(|execFileSync/.test(m));
  assert.ok(/EXPO_CODE/.test(m));
});
