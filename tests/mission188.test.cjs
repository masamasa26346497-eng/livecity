const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mk = (extra) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm188-'));
  fs.mkdirSync(path.join(d, 'tiles')); fs.mkdirSync(path.join(d, 'attrs'));
  fs.writeFileSync(path.join(d, 'tiles', 'a.glb'), 'glb');
  fs.writeFileSync(path.join(d, 'tileset.json'), JSON.stringify({ geometricError: 10, root: { geometricError: 10, children: [{ geometricError: 1, content: { uri: 'tiles/a.glb' } }] } }));
  fs.writeFileSync(path.join(d, 'attrs', 't.json'), JSON.stringify({ byId: { 'bldg_1': {}, 'bldg_2': {} } }));
  fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify(Object.assign({ wardCode: '27128', sourceEtag: 'E', attribution: 'x', counts: { inWard: 2 } }, extra)));
  return d;
};

test('legacy dir and foreign non-empty dir are refused; marker dir and new dir are accepted', async () => {
  const m = await import('../tools/mission188/build-local-2025.mjs');
  assert.throws(() => m.assertSafeOut('C:/Users/x/AppData/Local/LiveCity-3DTiles-Out-24'), /legacy/);
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'm188f-')); fs.writeFileSync(path.join(foreign, 'x'), '1');
  assert.throws(() => m.assertSafeOut(foreign), /not created by this tool/);
  fs.writeFileSync(path.join(foreign, m.MARKER), '{}');
  assert.ok(m.assertSafeOut(foreign));
  assert.ok(m.assertSafeOut(path.join(os.tmpdir(), 'm188-does-not-exist-' + Date.now())));
});

test('verifyWardDir passes a good ward and catches missing tile, bad etag, count mismatch, unhardened parent, duplicate ids', async () => {
  const m = await import('../tools/mission188/build-local-2025.mjs');
  const d = mk();
  const ok = m.verifyWardDir(d, { etag: 'E', wardCode: '27128' });
  assert.ok(ok.ok, ok.problems.join()); assert.equal(ok.buildings, 2);
  assert.ok(m.verifyWardDir(d, { etag: 'OTHER' }).problems.some((p) => /ETag/.test(p)));
  fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify({ wardCode: '27128', sourceEtag: 'E', attribution: 'x', counts: { inWard: 3 } }));
  assert.ok(m.verifyWardDir(d, {}).problems.some((p) => /inWard/.test(p)));
  fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify({ wardCode: '27128', sourceEtag: 'E', counts: { inWard: 2 } }));
  assert.ok(m.verifyWardDir(d, {}).problems.some((p) => /attribution/.test(p)));
  fs.writeFileSync(path.join(d, 'tileset.json'), JSON.stringify({ root: { geometricError: 1, children: [{ geometricError: 5, content: { uri: 'tiles/a.glb' } }] } }));
  assert.ok(m.verifyWardDir(d, {}).problems.some((p) => /hardened/.test(p)));
  fs.rmSync(path.join(d, 'tiles', 'a.glb'));
  assert.ok(m.verifyWardDir(d, {}).problems.some((p) => /missing tile/.test(p)));
  fs.writeFileSync(path.join(d, 'attrs', 'u.json'), JSON.stringify({ byId: { bldg_1: {} } }));
  assert.ok(m.verifyWardDir(d, {}).problems.some((p) => /duplicate/.test(p)));
});

test('treeHash changes when a byte changes (resume must re-verify, not trust)', async () => {
  const m = await import('../tools/mission188/build-local-2025.mjs');
  const d = mk(); const h1 = m.treeHash(d).treeSha256;
  assert.equal(m.treeHash(d).treeSha256, h1);
  fs.writeFileSync(path.join(d, 'tiles', 'a.glb'), 'glB'); assert.notEqual(m.treeHash(d).treeSha256, h1);
});

test('cross-ward duplicate ids are detected', async () => {
  const m = await import('../tools/mission188/build-local-2025.mjs');
  assert.equal(m.crossWardDuplicates({ a: ['1', '2'], b: ['3'] }).length, 0);
  assert.deepEqual(m.crossWardDuplicates({ a: ['1', '2'], b: ['2'] })[0].wards, ['a', 'b']);
});

test('index lists only verified wards, never over-claims, 24 needed for complete24', async () => {
  const m = await import('../tools/mission188/build-local-2025.mjs');
  const lock = { package: { name: 'plateau-27100-osaka-shi-2025' }, http: { etag: 'E' }, license: { id: 'plateau' }, attribution: 'attr' };
  const man = { chuo: { verified: true, wardCode: '27128', buildings: 5, tiles: 1, bytes: 9, treeSha256: 'h' }, kita: { verified: false, wardCode: '27127' }, nishi: null };
  const i = m.buildIndex(man, lock);
  assert.deepEqual(i.wards.map((w) => w.ward), ['chuo']);
  assert.equal(i.complete24, false); assert.equal(i.verified, false); assert.equal(i.ui37gVerified, false);
  assert.equal(i.published, false); assert.equal(i.attribution, 'attr'); assert.equal(i.wards[0].idScheme, 'gml:id');
  const all = {}; for (let k = 0; k < 24; k++) all['w' + k] = { verified: true, wardCode: String(k), buildings: 1, tiles: 1, bytes: 1, treeSha256: 'h' };
  assert.equal(m.buildIndex(all, lock).complete24, true);
});

test('disk check fails when free space is below need', async () => {
  const m = await import('../tools/mission188/build-local-2025.mjs');
  const fake = () => ({ bavail: 10, bsize: 1048576 });
  assert.equal(m.diskCheck(os.tmpdir(), 100, fake).ok, false);
  assert.equal(m.diskCheck(os.tmpdir(), 5, fake).ok, true);
});

test('loopback server: HTTP200 crawl, 404 for traversal/_manifest, 405 POST, 403 foreign Host', async () => {
  const s = await import('../tools/mission188/serve-check.mjs');
  const http = require('node:http');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'm188s-')); const ext = path.join(out, 'ext-3dtiles');
  fs.mkdirSync(path.join(ext, '_manifest'), { recursive: true }); fs.cpSync(mk(), path.join(ext, 'chuo'), { recursive: true });
  fs.writeFileSync(path.join(ext, '_manifest', 'chuo.json'), '{}');
  fs.writeFileSync(path.join(ext, 'index.json'), JSON.stringify({ wards: [{ ward: 'chuo' }] }));
  const { srv, port } = await s.startServer(out);
  try {
    const rep = await s.crawl(port); assert.equal(rep.index, 200); assert.deepEqual(rep.non200, []); assert.equal(rep.wards.chuo.urls, 3);
    const req = (p, o = {}) => new Promise((r) => http.request({ host: '127.0.0.1', port, path: p, method: o.method || 'GET', headers: o.headers }, (x) => { x.resume(); r(x.statusCode); }).end());
    assert.equal(await req('/ext-3dtiles/_manifest/chuo.json'), 404);
    assert.equal(await req('/ext-3dtiles/chuo/%2e%2e/index.json'), 404);
    assert.equal(await req('/ext-3dtiles/index.json', { method: 'POST' }), 405);
    assert.equal(await req('/ext-3dtiles/index.json', { headers: { Host: 'evil.example' } }), 403);
  } finally { srv.close(); }
});

// Real-data check: runs only when LC188_OUT points at a folder produced by the CLI (never in plain `npm test`).
test('REAL built folder: index entries verify against disk and manifests', { skip: !process.env.LC188_OUT }, async () => {
  const m = await import('../tools/mission188/build-local-2025.mjs');
  const s = await import('../tools/mission188/serve-check.mjs');
  const out = process.env.LC188_OUT, ext = path.join(out, 'ext-3dtiles');
  const idx = JSON.parse(fs.readFileSync(path.join(ext, 'index.json'), 'utf8')); assert.ok(idx.wards.length >= 1);
  for (const w of idx.wards) {
    const v = m.verifyWardDir(path.join(ext, w.ward), { wardCode: w.wardCode }); assert.ok(v.ok, w.ward + v.problems.join());
    assert.equal(v.buildings, w.buildings); assert.equal(m.treeHash(path.join(ext, w.ward)).treeSha256, w.treeSha256);
  }
  const { srv, port } = await s.startServer(out);
  try { const rep = await s.crawl(port); assert.deepEqual(rep.non200, []); } finally { srv.close(); }
});
