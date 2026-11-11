'use strict';
// Mission 72: synthetic-only tests for the same-origin auth proxy. Mock in-memory store; only loopback http. No real storage/credentials.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const C = require('../tools/mission70-cloud-contract.cjs');
const P = require('../tools/mission72-auth-proxy.cjs');

const KEY = 'synthetic-manifest-key-not-a-secret';
const TOK_A = 'tokenAAAAAAAAAAAAAAAAAAAA', TOK_B = 'tokenBBBBBBBBBBBBBBBBBBBB', TOK_X = 'tokenXXXXXXXXXXXXXXXXXXXX';
const ORIGIN = 'https://preview.example';
const APPROVAL = { licenceApproved: true, noSecretsReviewed: true, noPersonalDataReviewed: true, costApproved: true, storageProviderApproved: true, ownerApprovedUpload: true, maxMonthlyCostJpy: 1, maxTransferBytes: 1, provider: 'cloudflare-r2', scope: 'buildings-3dtiles-only' };

function ward(wardId, wardCode) {
  const files = {
    'tileset.json': Buffer.from(JSON.stringify({ root: { content: { uri: 'tiles/a.glb' }, children: [{ content: { uri: 'lod/g.glb' } }] } })),
    'tiles/a.glb': Buffer.from('glTF-synthetic-0123456789-' + wardId), 'lod/g.glb': Buffer.from('glTF-lod-' + wardId),
    'ids/a.json': Buffer.from('["x"]'), 'attrs/a.json': Buffer.from('{"byId":{}}'), 'source.json': Buffer.from('{"synthetic":true}'),
    'layers/roads.json': Buffer.from('{"features":[]}')
  };
  return { files, entry: { wardId, wardCode, buildings: 1, bytes: Object.values(files).reduce((s, b) => s + b.length, 0), files: Object.entries(files).map(([p, b]) => ({ path: p, bytes: b.length, sha256: C.sha(b) })) } };
}
function build(over) {
  const a = ward('alpha', '27101'), b = ward('beta', '27102');
  const m = { schema: C.SCHEMA, version: 1, published: true, wards: [a.entry, b.entry] };
  m.signature = C.sign(m, KEY);
  const store = new Map();
  for (const [w, x] of [['27101', a], ['27102', b]]) for (const [p, buf] of Object.entries(x.files)) store.set(w + '/' + p, buf);
  const mock = { get: async (k) => store.get(k) || null };
  const env = { LIVECITY_CLOUD_PROXY: '1', LIVECITY_PROXY_MANIFEST_KEY: KEY, LIVECITY_PROXY_ALLOW: [P.hex(TOK_A), P.hex(TOK_B) + ':beta'].join(',') };
  const proxy = P.createProxy({ env, approval: APPROVAL, manifest: m, store: mock, sameOrigin: ORIGIN, ...over });
  return { proxy, m, store, a, b, env };
}
const rq = (p, o) => ({ method: 'GET', url: '/ext-3dtiles/' + p, headers: { authorization: 'Bearer ' + TOK_A }, ...o });

test('disabled by default: no flag / no approval / bad manifest / no allowlist all -> 404, never 200', async () => {
  const f = build();
  assert.ok(f.proxy.enabled);
  const base = { env: f.env, approval: APPROVAL, manifest: f.m, store: { get: async () => null }, sameOrigin: ORIGIN };
  const cases = [
    { env: { ...f.env, LIVECITY_CLOUD_PROXY: '0' } }, { env: {} }, { approval: { ...APPROVAL, licenceApproved: false } }, { approval: null },
    { manifest: { ...f.m, version: 2 } }, { manifest: { ...f.m, published: false } }, { env: { ...f.env, LIVECITY_PROXY_ALLOW: '' } },
    { env: { ...f.env, LIVECITY_PROXY_MANIFEST_KEY: 'wrong' } }, { store: null }
  ];
  for (const c of cases) {
    const p = P.createProxy({ ...base, ...c });
    assert.ok(!p.enabled, JSON.stringify(Object.keys(c)));
    assert.strictEqual((await p.handle(rq('alpha/tileset.json'))).status, 404);
  }
  // the real repo has no approval file: default config is off
  assert.ok(!P.createProxy({}).enabled);
});

test('authorised 200 for GET/HEAD, content types, nosniff, private cache, no CORS grant', async () => {
  const f = build();
  const g = await f.proxy.handle(rq('alpha/tileset.json'));
  assert.strictEqual(g.status, 200); assert.strictEqual(g.headers['content-type'], 'application/json');
  assert.deepStrictEqual(g.body, f.a.files['tileset.json']);
  assert.strictEqual(g.headers['x-content-type-options'], 'nosniff'); assert.match(g.headers['cache-control'], /^private/);
  assert.ok(!('access-control-allow-origin' in g.headers));
  const glb = await f.proxy.handle(rq('alpha/tiles/a.glb'));
  assert.strictEqual(glb.headers['content-type'], 'model/gltf-binary');
  const h = await f.proxy.handle(rq('alpha/tiles/a.glb', { method: 'HEAD' }));
  assert.strictEqual(h.status, 200); assert.strictEqual(h.body, null); assert.strictEqual(h.headers['content-length'], String(f.a.files['tiles/a.glb'].length));
  assert.strictEqual((await f.proxy.handle(rq('alpha/layers/roads.json'))).status, 200);
  const cookie = await f.proxy.handle({ method: 'GET', url: '/ext-3dtiles/alpha/source.json', headers: { cookie: 'x=1; lc_proxy=' + TOK_A } });
  assert.strictEqual(cookie.status, 200);
  const etag = g.headers.etag;
  assert.strictEqual((await f.proxy.handle(rq('alpha/tileset.json', { headers: { authorization: 'Bearer ' + TOK_A, 'if-none-match': etag } }))).status, 304);
});

test('anonymous 403, unknown token 403, ward-scoped token 403 for other ward, 200 for its own', async () => {
  const f = build();
  assert.strictEqual((await f.proxy.handle(rq('alpha/tileset.json', { headers: {} }))).status, 403);
  assert.strictEqual((await f.proxy.handle(rq('alpha/tileset.json', { headers: { authorization: 'Bearer ' + TOK_X } }))).status, 403);
  assert.strictEqual((await f.proxy.handle(rq('alpha/tileset.json', { headers: { authorization: 'Bearer ' + TOK_B } }))).status, 403);
  assert.strictEqual((await f.proxy.handle(rq('beta/tileset.json', { headers: { authorization: 'Bearer ' + TOK_B } }))).status, 200);
  assert.strictEqual((await f.proxy.handle(rq('alpha/tileset.json', { headers: { authorization: 'Bearer ' + TOK_A, origin: 'https://evil.example' } }))).status, 403);
  assert.strictEqual((await f.proxy.handle(rq('alpha/tileset.json', { headers: { authorization: 'Bearer ' + TOK_A, 'sec-fetch-site': 'cross-site' } }))).status, 403);
  assert.strictEqual((await f.proxy.handle(rq('alpha/tileset.json', { method: 'POST' }))).status, 405);
  // index.json lists only wards the token may see
  const idx = JSON.parse((await f.proxy.handle(rq('index.json', { headers: { authorization: 'Bearer ' + TOK_B } }))).body);
  assert.deepStrictEqual(idx.wards, [{ ward: 'beta' }]);
  assert.strictEqual((await f.proxy.handle(rq('index.json', { headers: {} }))).status, 403);
});

test('404 for unknown ward/object, traversal, encoded, wrong extension, unlisted files', async () => {
  const f = build();
  for (const p of ['gamma/tileset.json', 'alpha/tiles/none.glb', 'alpha/../beta/tileset.json', 'alpha/%2e%2e/beta/tileset.json', 'alpha//tileset.json', 'alpha/tiles/a.glb.exe', 'alpha/secret.txt', 'alpha/layers/other.json', 'alpha\\tileset.json', 'alpha/tiles/a%2Fb.glb', 'alpha/.', '']) {
    const r = await f.proxy.handle(rq(p));
    assert.ok(r.status === 404, p + ' -> ' + r.status);
  }
  assert.strictEqual((await f.proxy.handle({ method: 'GET', url: '/other/alpha/tileset.json', headers: { authorization: 'Bearer ' + TOK_A } })).status, 404);
  assert.strictEqual((await f.proxy.handle(rq('alpha/tileset.json?x=1'))).status, 200); // query ignored, not part of the key
});

test('corrupted / size-mismatched / missing / throwing / hanging / oversized objects are never served', async () => {
  const f = build();
  f.store.set('27101/tiles/a.glb', Buffer.from('tampered-bytes-same-length!!!!!!!'));
  assert.strictEqual((await f.proxy.handle(rq('alpha/tiles/a.glb'))).status, 502);
  f.store.set('27101/lod/g.glb', Buffer.from('x'));
  assert.strictEqual((await f.proxy.handle(rq('alpha/lod/g.glb'))).status, 502);
  f.store.delete('27101/ids/a.json');
  assert.strictEqual((await f.proxy.handle(rq('alpha/ids/a.json'))).status, 502);
  const boom = build({ store: { get: async () => { throw new Error('backend down'); } } });
  assert.strictEqual((await boom.proxy.handle(rq('alpha/tileset.json'))).status, 502);
  const slow = build({ timeoutMs: 20, store: { get: () => new Promise(() => {}) } });
  assert.strictEqual((await slow.proxy.handle(rq('alpha/tileset.json'))).status, 504);
  const big = build({ maxObjectBytes: 5 });
  assert.strictEqual((await big.proxy.handle(rq('alpha/tiles/a.glb'))).status, 413);
});

test('Range: 206 first/open/suffix, 416 invalid/multi/past-end, HEAD ignores range', async () => {
  const f = build(), full = f.a.files['tiles/a.glb'], n = full.length;
  const r = async (range) => f.proxy.handle(rq('alpha/tiles/a.glb', { headers: { authorization: 'Bearer ' + TOK_A, range } }));
  let x = await r('bytes=0-3');
  assert.strictEqual(x.status, 206); assert.deepStrictEqual(x.body, full.subarray(0, 4)); assert.strictEqual(x.headers['content-range'], 'bytes 0-3/' + n);
  x = await r('bytes=5-'); assert.strictEqual(x.status, 206); assert.deepStrictEqual(x.body, full.subarray(5));
  x = await r('bytes=-4'); assert.strictEqual(x.status, 206); assert.deepStrictEqual(x.body, full.subarray(n - 4));
  x = await r('bytes=2-9999'); assert.strictEqual(x.status, 206); assert.strictEqual(x.headers['content-range'], 'bytes 2-' + (n - 1) + '/' + n);
  for (const bad of ['bytes=' + n + '-', 'bytes=9-3', 'bytes=0-1,3-4', 'items=0-1', 'bytes=-', 'bytes=-0']) {
    x = await r(bad); assert.strictEqual(x.status, 416, bad); assert.strictEqual(x.headers['content-range'], 'bytes */' + n);
  }
});

test('manifest validation: layers allowed, bad paths/hash/sig/duplicate wardId rejected', () => {
  const f = build();
  assert.ok(P.validateManifest(f.m, KEY).ok);
  const mut = (fn) => { const m = JSON.parse(JSON.stringify(f.m)); fn(m); m.signature = C.sign(m, KEY); return P.validateManifest(m, KEY); };
  assert.ok(mut((m) => { m.wards[0].files[0].path = '../x.json'; }).errors.includes('path'));
  assert.ok(mut((m) => { m.wards[1].wardId = 'alpha'; }).errors.includes('wardId'));
  assert.ok(mut((m) => { m.wards[0].files[1].sha256 = 'zz'; }).errors.includes('file-hash/bytes'));
  assert.ok(P.validateManifest({ ...f.m, wards: [] }, KEY).errors.includes('signature'));
});

test('tileset relative refs resolve through the proxy per ward (区単位ロード)', async () => {
  const f = build();
  for (const [w, tok] of [['alpha', TOK_A], ['beta', TOK_B]]) {
    const H = { authorization: 'Bearer ' + tok };
    const ts = JSON.parse((await f.proxy.handle(rq(w + '/tileset.json', { headers: H }))).body);
    assert.ok(C.checkTilesetRefs(ts, (w === 'alpha' ? f.a : f.b).entry.files).ok);
    for (const u of [ts.root.content.uri, ts.root.children[0].content.uri]) assert.strictEqual((await f.proxy.handle(rq(w + '/' + u, { headers: H }))).status, 200);
  }
  // loading one ward never reads the other ward's objects
  const seen = [];
  const spy = build({ store: { get: async (k) => { seen.push(k); return null; } } });
  await spy.proxy.handle(rq('alpha/tileset.json'));
  assert.ok(seen.every((k) => k.startsWith('27101/')));
});

test('E2E over loopback http with the node adapter (mock store only)', async () => {
  const f = build();
  const srv = http.createServer(P.toNodeHandler(f.proxy));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const get = (p, headers, method) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET', headers }, (s) => { const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => res({ status: s.statusCode, headers: s.headers, body: Buffer.concat(c) })); }); q.on('error', rej); q.end(); });
  try {
    assert.strictEqual((await get('/ext-3dtiles/alpha/tileset.json')).status, 403);
    const ok = await get('/ext-3dtiles/alpha/tiles/a.glb', { cookie: 'lc_proxy=' + TOK_A, range: 'bytes=0-3' });
    assert.strictEqual(ok.status, 206); assert.strictEqual(ok.body.toString(), 'glTF');
    assert.strictEqual((await get('/ext-3dtiles/alpha/tileset.json', { authorization: 'Bearer ' + TOK_A }, 'HEAD')).body.length, 0);
    assert.strictEqual((await get('/ext-3dtiles/alpha/tileset.json', { authorization: 'Bearer ' + TOK_A }, 'DELETE')).status, 405);
  } finally { srv.close(); }
});

test('guards: no network/credential/write code, no real storage URL, no api/ route or vercel.json change, viewer untouched', () => {
  const root = path.join(__dirname, '..');
  const s = fs.readFileSync(path.join(root, 'tools/mission72-auth-proxy.cjs'), 'utf8');
  assert.ok(!/require\(['"](https?|net|tls|dns|child_process|fs)['"]\)|fetch\(|XMLHttpRequest|WebSocket/.test(s));
  assert.ok(!/process\.env/.test(s), 'env must be injected, never read implicitly');
  assert.ok(!/r2\.cloudflarestorage|blob\.vercel-storage|\.r2\.dev|amazonaws/.test(s));
  assert.ok(!fs.existsSync(path.join(root, 'api')), 'no Vercel function route is added');
  const vj = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.ok(!vj.rewrites && !vj.functions && !JSON.stringify(vj).includes('mission72'));
  const html = fs.readFileSync(path.join(root, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(!html.includes('mission72') && html.includes("'ext-3dtiles/'"));
  const pub = path.join(root, 'public/map-data/osaka-city/derived/published.json');
  if (fs.existsSync(pub)) assert.ok(!/"published"\s*:\s*true/.test(fs.readFileSync(pub, 'utf8')));
});
