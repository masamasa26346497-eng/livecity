'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { makeServer, resolveUnder } = require('../tools/mission40f-serve-local.cjs');
const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');

function get(port, p, method) {
  return new Promise((ok, ng) => {
    http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET' }, (r) => {
      r.resume(); r.on('end', () => ok(r.statusCode));
    }).on('error', ng).end();
  });
}
test('resolveUnder rejects traversal', () => {
  const r = path.resolve('/tmp/x');
  assert.equal(resolveUnder(r, '/../etc/passwd'), null);
  assert.equal(resolveUnder(r, '/%2e%2e/etc'), null);
  assert.ok(resolveUnder(r, '/a/b.json').startsWith(r));
});
test('server serves ext read-only and blocks writes/traversal', async () => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'ext40f-'));
  fs.mkdirSync(path.join(ext, 'w'));
  fs.writeFileSync(path.join(ext, 'w', 'tileset.json'), '{"ok":1}');
  const srv = makeServer({ publicDir: path.join(ROOT, 'public'), extDir: ext });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.equal(await get(port, '/ext-3dtiles/w/tileset.json'), 200);
    assert.equal(await get(port, '/ext-3dtiles/w/none.json'), 404);
    assert.notEqual(await get(port, '/ext-3dtiles/..%2f..%2fetc/passwd'), 200);
    assert.equal(await get(port, '/ext-3dtiles/w/tileset.json', 'POST'), 405);
    assert.equal(await get(port, '/mission37g-osaka-24ward-mvp.html'), 200);
  } finally { srv.close(); fs.rmSync(ext, { recursive: true }); }
});
test('page: ext sets are localhost-only; per-ward mount path unchanged', () => {
  assert.match(page, /\^\(localhost\|127\\\.0\\\.0\\\.1\)\$\/\.test\(location\.hostname\)\) \{\s*for \(const n of/);
  assert.match(page, /ext-3dtiles\//);
  assert.match(page, /\(e\.source\.sourceMeshes \|\| \[\]\)\.length/);
  assert.match(page, /extraMeta\.filter\(\(m\) => m\.source\.wardCode === wardCode\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'tools/mission40f-serve-local.cjs'), 'utf8'), /googleapis|maps\.google/);
});
test('ps1 is ASCII only and has no delete/copy commands', () => {
  const b = fs.readFileSync(path.join(ROOT, 'tools/mission40f-serve-local.ps1'));
  assert.ok(![...b].some((x) => x > 127));
  assert.doesNotMatch(b.toString(), /Remove-Item|Copy-Item|robocopy|Move-Item/i);
});
