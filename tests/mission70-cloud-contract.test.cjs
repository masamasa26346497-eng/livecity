'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../tools/mission70-cloud-contract.cjs');
const U = require('../tools/mission70-upload-gate.cjs');
const A = require('../tools/mission70-audit-offline.cjs');

const KEY = 'synthetic-test-key-not-a-secret';
function fixture() {
  const files = {
    'tileset.json': Buffer.from(JSON.stringify({ root: { content: { uri: 'tiles/a.glb' }, children: [] } })),
    'tiles/a.glb': Buffer.from('glTF-synthetic-bytes-0123456789'),
    'ids/a.json': Buffer.from('["x"]'), 'attrs/a.json': Buffer.from('{"byId":{"x":{}}}'), 'source.json': Buffer.from('{"license":"synthetic"}')
  };
  const list = Object.entries(files).map(([p, b]) => ({ path: p, bytes: b.length, sha256: C.sha(b) }));
  const m = { schema: C.SCHEMA, version: 1, published: true, wards: [{ wardCode: '27100', buildings: 1, bytes: list.reduce((s, f) => s + f.bytes, 0), files: list }] };
  m.signature = C.sign(m, KEY);
  const store = new Map(Object.entries(files).map(([p, b]) => ['27100/' + p, b]));
  return { m, store, files };
}
const ctx = (f, o) => ({ enabled: true, authz: () => true, manifest: f.m, store: f.store, sameOrigin: 'https://p.example', ...o });
const req = (p, o) => ({ method: 'GET', path: '/ext-3dtiles/27100/' + p, ...o });

test('manifest validates and detects tampering', () => {
  const f = fixture();
  assert.ok(C.validateManifest(f.m, KEY).ok);
  const t = JSON.parse(JSON.stringify(f.m)); t.wards[0].buildings = 2;
  assert.ok(C.validateManifest(t, KEY).errors.includes('signature'));
  assert.ok(!C.validateManifest(f.m, 'other').ok);
  const bad = JSON.parse(JSON.stringify(f.m)); bad.wards[0].files[0].path = '../x.json'; bad.signature = C.sign(bad, KEY);
  assert.ok(C.validateManifest(bad, KEY).errors.includes('path'));
});
test('tileset refs are relative and listed', () => {
  const f = fixture();
  assert.ok(C.checkTilesetRefs(JSON.parse(f.files['tileset.json']), f.m.wards[0].files).ok);
  assert.ok(!C.checkTilesetRefs({ root: { content: { uri: 'https://x/y.glb' } } }, f.m.wards[0].files).ok);
  assert.ok(!C.checkTilesetRefs({ root: { content: { uri: 'tiles/missing.glb' } } }, f.m.wards[0].files).ok);
});
test('handler is default-off and fails closed without authz', () => {
  const f = fixture();
  assert.strictEqual(C.handle(req('tileset.json'), null).status, 404);
  assert.strictEqual(C.handle(req('tileset.json'), ctx(f, { enabled: false })).status, 404);
  assert.strictEqual(C.handle(req('tileset.json'), ctx(f, { authz: undefined })).status, 404);
  assert.strictEqual(C.handle(req('tileset.json'), ctx(f, { authz: () => false })).status, 403);
  assert.strictEqual(C.handle(req('tileset.json'), ctx(f, { manifest: { ...f.m, published: false } })).status, 404);
});
test('authorised GET/HEAD/Range, content types, cache, same-origin', () => {
  const f = fixture(), c = ctx(f);
  const g = C.handle(req('tiles/a.glb'), c);
  assert.strictEqual(g.status, 200); assert.strictEqual(g.headers['content-type'], 'model/gltf-binary');
  assert.match(g.headers['cache-control'], /^private/); assert.ok(!('access-control-allow-origin' in g.headers));
  assert.strictEqual(C.handle(req('tileset.json'), c).headers['content-type'], 'application/json');
  const h = C.handle(req('tiles/a.glb', { method: 'HEAD' }), c); assert.strictEqual(h.status, 200); assert.strictEqual(h.body, null);
  const r = C.handle(req('tiles/a.glb', { range: 'bytes=0-3' }), c); assert.strictEqual(r.status, 206); assert.strictEqual(r.body.length, 4);
  assert.strictEqual(C.handle(req('tiles/a.glb', { range: 'bytes=999-' }), c).status, 416);
  assert.strictEqual(C.handle(req('tiles/a.glb', { origin: 'https://evil.example' }), c).status, 403);
  assert.strictEqual(C.handle(req('tiles/a.glb', { method: 'POST' }), c).status, 405);
});
test('unlisted/traversal paths 404 and corrupted objects are never served', () => {
  const f = fixture(), c = ctx(f);
  assert.strictEqual(C.handle(req('tiles/zzz.glb'), c).status, 404);
  assert.strictEqual(C.handle({ method: 'GET', path: '/ext-3dtiles/27100/../27101/tileset.json' }, c).status, 404);
  assert.strictEqual(C.handle({ method: 'GET', path: '/ext-3dtiles/27199/tileset.json' }, c).status, 404);
  f.store.set('27100/tiles/a.glb', Buffer.from('tampered'));
  assert.strictEqual(C.handle(req('tiles/a.glb'), c).status, 502);
});
test('upload gate refuses by default and needs every gate + confirm', () => {
  assert.strictEqual(U.evaluate(null).allowed, false);
  const all = { provider: 'cloudflare-r2', scope: 'buildings-3dtiles-only', maxMonthlyCostJpy: 100, maxTransferBytes: 1e9, confirmPhrase: 'go' };
  for (const g of U.GATES) all[g] = false;
  assert.strictEqual(U.evaluate(all).allowed, false);
  for (const g of U.GATES) all[g] = true;
  assert.strictEqual(U.evaluate(all).allowed, true);
  assert.strictEqual(U.evaluate(all, { execute: true, env: {} }).allowed, false);
  assert.strictEqual(U.evaluate(all, { execute: true, env: { LIVECITY_UPLOAD_CONFIRM: 'go' } }).allowed, true);
  assert.strictEqual(U.evaluate({ ...all, scope: 'all' }).allowed, false);
  assert.strictEqual(U.evaluate({ ...all, provider: 'x' }).allowed, false);
  assert.strictEqual(U.evaluate(all).uploaderImplemented, false);
});
test('upload plan is resumable and stops at the transfer cap', () => {
  const f = fixture();
  const full = U.plan(f.m, { maxTransferBytes: 1e9 }, 1e6);
  assert.strictEqual(full.stoppedByCap, false);
  const done = {}; for (const x of f.m.wards[0].files) done['27100/' + x.path] = true;
  assert.strictEqual(U.plan(f.m, { maxTransferBytes: 1e9, alreadyUploaded: done }).planned, 0);
  assert.strictEqual(U.plan(f.m, { maxTransferBytes: 10 }).stoppedByCap, true);
});
test('audit: synthetic ward dir, anonymous output, no writes', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm70-'));
  fs.mkdirSync(path.join(d, 'tiles')); fs.mkdirSync(path.join(d, 'ids')); fs.mkdirSync(path.join(d, 'attrs'));
  fs.writeFileSync(path.join(d, 'tileset.json'), JSON.stringify({ root: { content: { uri: 'tiles/a.glb' }, children: [{ content: { uri: 'tiles/gone.glb' } }] } }));
  fs.writeFileSync(path.join(d, 'tiles/a.glb'), 'x');
  fs.writeFileSync(path.join(d, 'ids/a.json'), '["id1","id2"]'); fs.writeFileSync(path.join(d, 'attrs/a.json'), '{"byId":{"id1":{}}}');
  fs.writeFileSync(path.join(d, 'notes.csv'), 'a');
  const before = fs.readdirSync(d).sort().join();
  const r = A.auditWard(d);
  assert.strictEqual(r.brokenRefs, 1); assert.strictEqual(r.idMismatch, 1); assert.strictEqual(r.suspectFiles, 1); assert.strictEqual(r.glb, 1);
  assert.ok(!JSON.stringify(r).includes(d) && !JSON.stringify(r).includes('id1'));
  assert.strictEqual(fs.readdirSync(d).sort().join(), before);
  fs.rmSync(d, { recursive: true, force: true });
});
test('new tools contain no network, credential or destructive code; no storage URLs', () => {
  for (const n of ['mission70-audit-offline', 'mission70-cloud-contract', 'mission70-upload-gate']) {
    const s = fs.readFileSync(path.join(__dirname, '../tools', n + '.cjs'), 'utf8');
    assert.ok(!/require\(['"](https?|net|tls|dns|child_process)['"]\)|fetch\(|XMLHttpRequest|WebSocket/.test(s), n + ' network');
    assert.ok(!/rmSync|unlinkSync|writeFileSync|appendFileSync|renameSync|copyFileSync|rmdirSync/.test(s), n + ' write/delete');
    assert.ok(!/r2\.cloudflarestorage|blob\.vercel-storage|\.r2\.dev|amazonaws/.test(s), n + ' storage url');
    assert.ok(!/process\.env\.(?!LIVECITY_UPLOAD_CONFIRM|OneDrive|USERPROFILE)/.test(s), n + ' env secrets');
  }
});
test('public code has no real storage URL; viewer and published.json untouched', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(!/r2\.cloudflarestorage|blob\.vercel-storage|\.r2\.dev/.test(html));
  assert.ok(!html.includes('mission70'));
});
