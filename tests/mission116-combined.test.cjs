'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const S = require('../tools/mission116/combined-server.cjs');
const R = require('../tools/mission115/layers-run.cjs');

const w = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm116-'));
  const b = path.join(tmp, 'bld'), l = path.join(tmp, 'lay');
  for (const ward of ['nishi', 'fukushima']) {
    w(path.join(b, ward + '25', 'tileset.json'), '{"asset":{"version":"1.1"}}');
    w(path.join(b, ward + '25', 'tiles', 't.glb'), 'GLB');
    w(path.join(b, ward + '25', 'secret.txt'), 'x');
  }
  w(path.join(b, 'abc', 'tileset.json'), '{}');   // no "25" suffix: ignored
  w(path.join(l, '.livecity-45i-layers.json'), JSON.stringify({ schema: 'livecity.mission45i.layers/1' }));
  w(path.join(l, 'nishi', 'layers', 'layers-report.json'), '{}');
  w(path.join(l, 'nishi', 'layers', 'roads.json'), '{"count":1}');
  w(path.join(l, 'nishi', 'layers', 'evil.json'), '{}');
  w(path.join(l, 'kita', 'layers', 'layers-report.json'), '{}');   // layers without 2025 building
  return { tmp, b, l };
}
const get = (port, p, headers) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: Object.assign({ Host: '127.0.0.1:' + port }, headers || {}) }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ s: r.statusCode, body: d }));
  }).on('error', rej);
});

test('plan: wards present in buildings / layers / both are reported separately', () => {
  const f = fixture();
  const p = S.plan({ buildingsRoot: f.b, layersRoot: f.l });
  assert.deepStrictEqual(p.buildingWards, ['fukushima', 'nishi']);
  assert.deepStrictEqual(p.both, ['nishi']);
  assert.deepStrictEqual(p.buildingsOnly, ['fukushima']);
  assert.deepStrictEqual(p.layersOnly, ['kita']);
});
test('server: buildings and layers come from one origin; whitelist and traversal enforced', async () => {
  const f = fixture();
  const p = S.plan({ buildingsRoot: f.b, layersRoot: f.l });
  const { server, port } = await S.listen(p, 0);
  try {
    assert.strictEqual((await get(port, '/ext-3dtiles/nishi25/tileset.json')).s, 200);
    assert.strictEqual((await get(port, '/ext-3dtiles/nishi25/tiles/t.glb')).s, 200);
    assert.strictEqual((await get(port, '/ext-3dtiles/nishi25/layers/roads.json')).body, '{"count":1}');
    assert.strictEqual((await get(port, '/ext-3dtiles/nishi25/layers/layers-report.json')).s, 200);
    assert.strictEqual((await get(port, '/ext-3dtiles/nishi25/layers/evil.json')).s, 404);
    assert.strictEqual((await get(port, '/ext-3dtiles/nishi25/secret.txt')).s, 404);
    assert.strictEqual((await get(port, '/ext-3dtiles/fukushima25/layers/roads.json')).s, 404);   // buildings only, no layers
    assert.strictEqual((await get(port, '/ext-3dtiles/kita25/tileset.json')).s, 404);              // layers-only ward has no buildings
    assert.strictEqual((await get(port, '/ext-3dtiles/nishi25/../fukushima25/tileset.json')).s, 404);
    assert.strictEqual((await get(port, '/ext-3dtiles/nishi25/%2e%2e/x')).s, 404);
    const idx = JSON.parse((await get(port, '/ext-3dtiles/index.json')).body);
    assert.deepStrictEqual(idx.layersWards, [{ ward: 'nishi25' }]);
    assert.strictEqual(idx.wards.length, 2);
    assert.strictEqual(idx.verified, false);
    assert.strictEqual((await get(port, '/mission37g-osaka-24ward-mvp.html')).s, 200);
    assert.strictEqual((await get(port, '/', { Host: 'evil.example' })).s, 403);
    assert.strictEqual((await get(port, '/ext-3dtiles/index.json', { Origin: 'http://evil.example' })).s, 403);
    const post = await new Promise((res) => { const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { Host: '127.0.0.1:' + port } }, (x) => res(x.statusCode)); r.end(); });
    assert.strictEqual(post, 405);
  } finally { server.close(); }
});
test('server: busy port falls forward to the next free port', async () => {
  const f = fixture();
  const p = S.plan({ buildingsRoot: f.b, layersRoot: f.l });
  const a = await S.listen(p, 0);
  try {
    const busy = await new Promise((res, rej) => { const s = http.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => res(s)); });
    const bp = busy.address().port;
    const c = await S.listen(p, bp, 5);
    assert.ok(c.port > bp && c.port <= bp + 5, 'port ' + c.port + ' vs busy ' + bp);
    c.server.close(); busy.close();
  } finally { a.server.close(); }
});
test('roots: layers inside the repo or without marker refused; buildings under public/ refused', () => {
  const f = fixture();
  assert.throws(() => S.plan({ buildingsRoot: f.b, layersRoot: path.join(__dirname, '..', 'tools') }), /outside the repository/);
  assert.throws(() => S.plan({ buildingsRoot: path.join(__dirname, '..', 'public', 'mission37h-3dtiles') }), /public/);
  assert.throws(() => S.plan({ buildingsRoot: path.join(__dirname, '..', 'tools') }), /temp/);
  const noMarker = fs.mkdtempSync(path.join(os.tmpdir(), 'm116n-'));
  assert.throws(() => S.plan({ buildingsRoot: f.b, layersRoot: noMarker }), /marker/);
  assert.throws(() => S.plan({ buildingsRoot: f.b, layersRoot: f.b }), /separate/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'm116e-'));
  assert.throws(() => S.plan({ buildingsRoot: empty }), /nothing to serve/);
});
test('server source writes/deletes nothing and has no network client', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools/mission116/combined-server.cjs'), 'utf8');
  assert.ok(!/writeFile|unlink|rmSync|rmdir|rename|copyFile|mkdir|appendFile|https?\.request|fetch\(/.test(src));
});
test('-Wards ALL enumerates the 24 wards, unique, codes 27102..27128 in Osaka', () => {
  const all = R.wardList('ALL');
  assert.strictEqual(all.length, 24);
  assert.strictEqual(new Set(all.map((x) => x.wardId)).size, 24);
  assert.strictEqual(new Set(all.map((x) => x.wardCode)).size, 24);
  for (const x of all) {
    const ll = R.localToLonLat((x.bbox.minX + x.bbox.maxX) / 2, (x.bbox.minZ + x.bbox.maxZ) / 2);
    assert.ok(ll.lon > 135.3 && ll.lon < 135.7 && ll.lat > 34.4 && ll.lat < 34.9, x.wardId);
  }
});
test('audit: without source tiles every ward is noSource (never "ready")', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm116a-'));
  const r = R.audit(tmp, R.wardList('ALL'));
  assert.strictEqual(r.summary.requested, 24);
  assert.strictEqual(r.summary.ready.length, 0);
  assert.strictEqual(r.summary.noSource.length, 24);
});
test('ps1: ASCII only, no destructive commands, balanced braces/quotes, serves via combined server', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'tools/mission116/combined-run.ps1'));
  assert.ok(![...s].some((b) => b > 127), 'non-ASCII byte');
  const t = s.toString('utf8');
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|\bdel\b|\brm\b/i.test(t));
  const strip = t.replace(/^\s*#.*$/gm, '');
  assert.strictEqual((strip.match(/\{/g) || []).length, (strip.match(/\}/g) || []).length);
  assert.strictEqual((strip.match(/\(/g) || []).length, (strip.match(/\)/g) || []).length);
  for (const line of strip.split('\n')) assert.strictEqual((line.match(/'/g) || []).length % 2, 0, line);
  assert.ok(/combined-server\.cjs/.test(t) && /LASTEXITCODE/.test(t) && /LOCALAPPDATA/.test(t));
});
test('viewer maps ?ext=<ward>25 to layers under the same base (no page change needed)', () => {
  const h = fs.readFileSync(path.join(__dirname, '..', 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(h.includes("base: 'ext-3dtiles/' + n + '/', external: true"));
  assert.ok(h.includes("m.base + 'layers/'"));
});
