'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const L = require('../tools/mission130/accept-lib.cjs');
const tmpl = fs.readFileSync(path.join(__dirname, '../tools/mission130/accept21.workflow.yml.template'), 'utf8');
const runner = fs.readFileSync(path.join(__dirname, '../tools/mission130/accept21.mjs'), 'utf8');
const mk = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o)); };

test('discoverWard: expected, wrapped and nested layouts; sumiyoshi vs higashisumiyoshi never collide', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'm130-'));
  mk(path.join(r, 'kita25', 'tileset.json'), {});
  mk(path.join(r, '_x_sumiyoshi', 'sumiyoshi25', 'tileset.json'), {});
  mk(path.join(r, '_x_higashisumiyoshi', 'tileset.json'), {});
  mk(path.join(r, '_x_abeno', 'deep', 'abeno25', 'tileset.json'), {});
  assert.strictEqual(L.discoverWard(r, 'kita').layout, 'expected(<ward>25)');
  const s = L.discoverWard(r, 'sumiyoshi'), h = L.discoverWard(r, 'higashisumiyoshi');
  assert.ok(s.dir.endsWith(path.join('_x_sumiyoshi', 'sumiyoshi25')));
  assert.ok(h.dir.endsWith('_x_higashisumiyoshi'));
  assert.ok(L.discoverWard(r, 'abeno').dir.endsWith('abeno25'));
  assert.strictEqual(L.discoverWard(r, 'chuo'), null);
});
test('insideWard uses the N03 polygon, not only the bbox; target is 21 wards', () => {
  const w = L.target21().find((x) => x.wardId === 'kita');
  assert.strictEqual(L.insideWard(w, w.bbox.minX - 5, w.bbox.minZ - 5), false);
  assert.strictEqual(L.target21().length, 21);
});
test('verdict: every acceptance item is required; missing evidence is NOT accepted', () => {
  const ok = { source: { found: true }, http: { tileset200: 1, glb200: 3, notFound: 0 }, tilesets: 1, state: 'ready', pixels: { pct: 4 }, click: { target: 'bldg_a', selected: 'bldg_a', idInSidecar: true, insideWardPolygon: true }, dupIds: 0 };
  assert.deepStrictEqual(L.verdict(ok), { accepted: true, why: [] });
  assert.ok(!L.verdict({ source: { found: false } }).accepted);
  const bad = [['http', { tileset200: 0, glb200: 3, notFound: 0 }], ['http', { tileset200: 1, glb200: 0, notFound: 0 }], ['http', { tileset200: 1, glb200: 1, notFound: 1 }],
    ['state', 'loading'], ['pixels', { pct: 0.2 }], ['click', { target: 'a', selected: null, idInSidecar: true, insideWardPolygon: true }],
    ['click', { target: 'a', selected: 'a', idInSidecar: false, insideWardPolygon: true }], ['click', { target: 'a', selected: 'a', idInSidecar: true, insideWardPolygon: false }], ['dupIds', 2]];
  for (const [k, v] of bad) assert.ok(!L.verdict({ ...ok, [k]: v }).accepted, k + ' must block acceptance');
  assert.ok(!L.verdict({}).accepted);
});
test('summarize never claims 24/24 and does not infer the existing three wards', () => {
  const s = L.summarize([{ ward: 'kita', verdict: { accepted: true, why: [] } }, { ward: 'chuo', verdict: null }]);
  assert.strictEqual(s.acceptedWards, 1);
  assert.strictEqual(s.twentyFourOfTwentyFourProven, false);
  assert.match(s.existingThreeWards, /not-evaluated/);
  assert.deepStrictEqual(s.notAccepted, ['chuo:not-run']);
});
test('coverage never reports a proof of completeness', () => {
  assert.strictEqual(L.coverage(0, 100).class, 'unknown');
  assert.strictEqual(L.coverage(100, 100).class, 'full-candidate');
  assert.strictEqual(L.coverage(40, 100).class, 'partial');
  assert.match(L.coverage(100, 100).note, /not a proof/);
});
test('server: loopback only, read-only, whitelisted files from the discovered dir, logs 200/404', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'm130s-'));
  mk(path.join(r, 'w', 'tileset.json'), '{}'); mk(path.join(r, 'w', 'secret.txt'), 'x'); mk(path.join(r, 'w', 'tiles', 'a.glb'), 'glTF');
  const hits = []; let port = 0;
  const srv = L.makeServer({ kita: path.join(r, 'w') }, hits, () => port);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok)); port = srv.address().port;
  const get = (p, method) => new Promise((ok) => http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET' }, (res) => { res.resume(); ok(res.statusCode); }).end());
  assert.strictEqual(await get('/ext-3dtiles/kita25/tileset.json'), 200);
  assert.strictEqual(await get('/ext-3dtiles/kita25/tiles/a.glb'), 200);
  assert.strictEqual(await get('/ext-3dtiles/kita25/tiles/missing.glb'), 404);
  assert.strictEqual(await get('/ext-3dtiles/kita25/secret.txt'), 404);
  assert.strictEqual(await get('/ext-3dtiles/kita25/../w/tileset.json'), 404);
  assert.strictEqual(await get('/ext-3dtiles/chuo25/tileset.json'), 404);
  assert.strictEqual(await get('/ext-3dtiles/kita25/tileset.json', 'POST'), 405);
  srv.close();
  assert.deepStrictEqual(hits.map((h) => h.s), [200, 200, 404, 404, 404]);
});
test('safety: template uploads nothing and guards rm; runner is loopback and writes only a new --out', () => {
  assert.ok(!/upload-artifact|actions\/cache|gh release (create|upload)|vercel|-X (PUT|POST|DELETE)/i.test(tmpl));
  for (const line of tmpl.split('\n').filter((l) => /\brm\b/.test(l))) assert.match(line, /RUNNER_TEMP:\?/);
  assert.match(tmpl, /permissions:\s*\n\s*contents: read/);
  assert.ok(!/writeFileSync\([^)]*(png|jpg|shot)/i.test(runner));
  assert.match(runner, /flag: 'wx'/);
  assert.match(runner, /127\.0\.0\.1/);
});
