'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const A = require('../tools/mission45d-convert-all.cjs');
const C = require('../tools/mission43f-pc-convert.cjs');
const L = require('../tools/mission40b-legacy-tiles-batch.cjs');
const E = require('../tools/mission45e-preview.cjs');
const ROOT = path.join(__dirname, '..');
const REPO_BLD = path.join(ROOT, 'public/map-data/osaka-city/buildings');
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm45e-'));
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
test.afterEach(() => L.setSource(REPO_BLD));

function fixture() {
  const src = tmp(); const ds = [];
  wards.forEach((w, wi) => {
    const dir = path.join(src, 'osaka-' + w.id); const tiles = [];
    for (let t = 0; t < 2; t++) {
      const bs = [0, 1, 2].map((k) => ({ id: 'bldg_' + String(wi).padStart(2, '0') + t + k + '-fixture', fp: [[t * 600, 0], [t * 600 + 10, 0], [t * 600 + 10, 10], [t * 600, 10]], h: 10, repX: 5 + t * 600, repZ: 5 }));
      wj(path.join(dir, 'tile_' + t + '_0.json'), { buildings: bs });
      tiles.push({ tx: t, tz: 0, count: 3, file: 'tile_' + t + '_0.json' });
    }
    wj(path.join(dir, 'manifest.json'), { wardCode: w.code, coordinateConvention: 'znorth-neg-v1', tiles });
    ds.push({ id: 'osaka-' + w.id, wardId: w.id, buildings: 6, tiles: 2 });
  });
  wj(path.join(src, 'manifest.json'), { datasets: ds });
  return src;
}
const synth = (src) => (dir) => { L.setSource(src); return L.convertWard('sumiyoshi', { out: dir, force: true }); };
function built() {
  const src = fixture(); const out = path.join(tmp(), 'out');
  const r = A.run({ src, outRoot: out, execute: true, approved: true, sumiyoshiRun: synth(src) });
  assert.strictEqual(r.complete, true, JSON.stringify(r.problems));
  return { src, out, opts: { src, outRoot: out, allowSynthetic: true, sumiyoshiRun: synth(src) } };
}
function get(port, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ Host: '127.0.0.1:' + port }, headers) }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}
const snapshot = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).map((e) => path.join(e.parentPath || e.path, e.name) + ':' + (e.isFile() ? fs.statSync(path.join(e.parentPath || e.path, e.name)).size : 'd')).sort().join('\n');

test('plan maps all 24 wards (PC23 under pc23/, Sumiyoshi from its attempt dir) and does not write', () => {
  const { opts, out } = built();
  const before = snapshot(out);
  const p = E.plan(opts);
  assert.strictEqual(p.servable.length, 24);
  assert.ok(p.servable.every((s) => fs.existsSync(path.join(s.dir, 'tileset.json'))));
  assert.ok(p.servable.find((s) => s.ward === 'abeno').dir.includes(path.join('pc23', 'abeno-a')));
  assert.ok(p.servable.find((s) => s.ward === 'sumiyoshi').dir.includes('sumiyoshi-a'));
  assert.strictEqual(p.proof.sourceBuildings, p.proof.convertedBuildings);
  assert.strictEqual(snapshot(out), before);
});

test('synthetic proof is refused unless explicitly allowed (CLI path never allows it)', () => {
  const { opts } = built();
  assert.throws(() => E.plan(Object.assign({}, opts, { allowSynthetic: false })), (e) => e.code === 3);
});

test('refused: incomplete (a ward GLB removed), missing marker, foreign root, inside repo, missing src', () => {
  const { src, out, opts } = built();
  const d = path.join(out, 'pc23', 'abeno-a1', 'tiles');
  fs.rmSync(path.join(d, fs.readdirSync(d).find((f) => f.endsWith('.glb'))));
  assert.throws(() => E.plan(opts), (e) => e.code === 3);
  const foreign = tmp(); fs.writeFileSync(path.join(foreign, 'x.txt'), 'x');
  assert.throws(() => E.plan({ src, outRoot: foreign }), (e) => e.code === 4);
  assert.throws(() => E.plan({ src, outRoot: path.join(ROOT, 'public') }), (e) => e.code === 4);
  assert.throws(() => E.plan({ outRoot: out }), (e) => e.code === 2);
  assert.throws(() => E.plan({ src, outRoot: path.join(tmp(), 'nope') }), (e) => e.code === 4);
});

test('state.json / completion.json are not trusted: a forged completion over a damaged root is refused', () => {
  const { out, opts } = built();
  const d = path.join(out, 'pc23', 'kita-a1', 'ids');
  fs.rmSync(path.join(d, fs.readdirSync(d).find((f) => /^t_.*\.json$/.test(f))));   // g_* are LOD sidecars (not required); damage a leaf tile's ids
  const c = JSON.parse(fs.readFileSync(path.join(out, 'completion.json'), 'utf8'));
  assert.strictEqual(c.complete, true); // the stale file still claims complete
  assert.throws(() => E.plan(opts), (e) => e.code === 3);
});

test('HTTP: serves the viewer, index and every ward; 24 wards mount-able; denies bad host/origin/method/traversal/non-whitelisted', async () => {
  const { opts, out } = built();
  const before = snapshot(out);
  const s = await E.serve(Object.assign({}, opts, { port: 0 }));
  try {
    const port = s.port;
    const page = await get(port, '/');
    assert.strictEqual(page.status, 200); assert.ok(/ext45/.test(page.body.toString()));
    const idx = JSON.parse((await get(port, '/ext-3dtiles/index.json')).body.toString());
    assert.strictEqual(idx.wards.length, 24);
    assert.ok(!JSON.stringify(idx).includes(out), 'index has no paths');
    for (const w of idx.wards) {
      const src = await get(port, '/ext-3dtiles/' + w.ward + '/source.json');
      assert.strictEqual(src.status, 200, w.ward);
      assert.strictEqual(String(JSON.parse(src.body.toString()).wardCode), w.wardCode);
      const ts = await get(port, '/ext-3dtiles/' + w.ward + '/tileset.json');
      assert.strictEqual(ts.status, 200, w.ward);
      const glb = fs.readdirSync(path.join(s.plan.servable.find((x) => x.ward === w.ward).dir, 'tiles'))[0];
      const g = await get(port, '/ext-3dtiles/' + w.ward + '/tiles/' + glb);
      assert.strictEqual(g.status, 200); assert.strictEqual(g.headers['access-control-allow-origin'], undefined);
    }
    assert.strictEqual((await get(port, '/ext-3dtiles/abeno/source.json', { method: 'HEAD' })).status, 200);
    assert.strictEqual((await get(port, '/ext-3dtiles/abeno/source.json', { method: 'POST' })).status, 405);
    assert.strictEqual((await get(port, '/ext-3dtiles/abeno/source.json', { headers: { Host: 'evil.example' } })).status, 403);
    assert.strictEqual((await get(port, '/ext-3dtiles/abeno/source.json', { headers: { Origin: 'http://evil.example' } })).status, 403);
    for (const p of ['/ext-3dtiles/abeno/../../state.json', '/ext-3dtiles/abeno/%2e%2e/state.json', '/ext-3dtiles/abeno/verify-report.json', '/ext-3dtiles/pc23/abeno-a1/tileset.json',
      '/ext-3dtiles/unknown/tileset.json', '/ext-3dtiles/abeno/', '/ext-3dtiles/', '/.livecity-45d-root.json', '/../tools/mission45e-preview.cjs', '/ext-3dtiles/abeno/tiles/..%5c..%5cstate.json']) {
      assert.strictEqual((await get(port, p)).status, 404, p);
    }
  } finally { await new Promise((r) => s.server.close(r)); }
  assert.strictEqual(snapshot(out), before, 'serving wrote nothing');
});

test('HTTP: a symlink inside a ward dir is not followed', { skip: process.platform === 'win32' }, async () => {
  const { opts, out } = built();
  const secret = path.join(tmp(), 'secret.json'); fs.writeFileSync(secret, '{"s":1}');
  const p0 = E.plan(opts); const dir = p0.servable.find((s) => s.ward === 'kita').dir;
  fs.symlinkSync(secret, path.join(dir, 'ids', 'zz.json'));
  assert.throws(() => E.plan(opts), (e) => e.code === 3); // link-in-output => ward not verified => nothing served
  fs.rmSync(path.join(dir, 'ids', 'zz.json'));
  const s = await E.serve(Object.assign({}, opts, { port: 0 }));
  try {
    fs.symlinkSync(secret, path.join(dir, 'ids', 'late.json')); // appears after verification: resolveExt must still refuse it
    assert.strictEqual((await get(s.port, '/ext-3dtiles/kita/ids/late.json')).status, 404);
  } finally { await new Promise((r) => s.server.close(r)); }
});

test('server binds loopback only; OneDrive roots refused; viewer wiring is localhost-gated, prefers external full sets', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/mission45e-preview.cjs'), 'utf8');
  assert.ok(/listen\(port, '127\.0\.0\.1'/.test(src));
  const old = process.env.OneDrive; process.env.OneDrive = path.join(os.tmpdir(), 'FakeOneDrive');
  try { assert.strictEqual(E.underSync(path.join(process.env.OneDrive, 'x', 'out')), true); assert.strictEqual(E.underSync(path.join(os.tmpdir(), 'other')), false); }
  finally { if (old === undefined) delete process.env.OneDrive; else process.env.OneDrive = old; }
  const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(/loadExt45Defs/.test(html) && /get\('ext45'\) !== '1'/.test(html) && /127\\\.0\\\.0\\\.1/.test(html));
  assert.ok(/metas\.some\(\(m\) => m\.external\)\) metas = metas\.filter\(\(m\) => m\.external\)/.test(html));
  assert.ok(!/published\.json/.test(src), 'does not touch published.json');
  for (const bad of ['writeFile', 'rmSync', 'unlink', 'copyFile', 'rename', 'mkdir', 'https.', 'fetch(', 'child_process']) assert.ok(!src.includes(bad), bad);
});

test('static: ps1 is ASCII, one command, no delete/copy/network commands', () => {
  const b = fs.readFileSync(path.join(ROOT, 'tools/mission45e-preview.ps1'));
  assert.ok(b.every((x) => x < 128));
  const t = b.toString('utf8');
  assert.ok(/\$LASTEXITCODE/.test(t) && /mission45e-preview\.cjs/.test(t) && /LiveCity-3DTiles-Out-24/.test(t));
  for (const bad of ['Remove-Item', 'Copy-Item', 'Move-Item', 'robocopy', 'Invoke-WebRequest', 'Invoke-RestMethod', 'curl', 'git push', 'git add']) assert.ok(!t.includes(bad), bad);
});
