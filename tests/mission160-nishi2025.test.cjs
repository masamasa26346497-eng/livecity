'use strict';
// Mission 160: fixture-based tests. These prove the audit/launch tooling logic only.
// They are NOT owner-PC browser acceptance and say nothing about the real Mission 79 output.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const A = require('../tools/mission160/nishi2025-audit.cjs');
const { insideWard } = require('../tools/mission130/accept-lib.cjs');

const polys = require('../data/processed/osaka-city/boundaries/ward-classification-polygons.json').wards;
const nishi = polys.find((w) => w.wardId === 'nishi');

function glb(len) { const b = Buffer.alloc(len); b.write('glTF', 0, 'latin1'); b.writeUInt32LE(2, 4); b.writeUInt32LE(len, 8); return b; }
function pointsInside(n) {
  const out = []; const b = nishi.bbox;
  for (let i = 0; i < 200000 && out.length < n; i++) {
    const x = b.minX + Math.random() * (b.maxX - b.minX), z = b.minZ + Math.random() * (b.maxZ - b.minZ);
    if (insideWard(nishi, x, z)) out.push([x, z]);
  }
  return out;
}
function mkFixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm160-'));
  const d = path.join(root, 'nishi-2025');
  for (const s of ['tiles', 'lod', 'attrs', 'ids']) fs.mkdirSync(path.join(d, s), { recursive: true });
  fs.writeFileSync(path.join(d, 'tiles', 't_0_0.glb'), glb(64));
  fs.writeFileSync(path.join(d, 'lod', 'g_0_0.glb'), opts.badLod ? Buffer.from('nope') : glb(64));
  fs.writeFileSync(path.join(d, 'tileset.json'), JSON.stringify({ asset: { version: '1.1' }, root: { content: { uri: 'lod/g_0_0.glb' }, children: [{ content: { uri: 'tiles/t_0_0.glb' } }] } }));
  const pts = pointsInside(5), byId = {}, ids = [];
  pts.forEach(([x, z], i) => { const id = 'bldg_' + i; byId[id] = [opts.sentinel && i === 0 ? 29997 : 20 + i, 0, opts.outside && i < 3 ? 9e5 : x, z, 0]; ids.push(id); });
  fs.writeFileSync(path.join(d, 'attrs', 't_0_0.json'), JSON.stringify({ byId }));
  fs.writeFileSync(path.join(d, 'ids', 't_0_0.json'), JSON.stringify(ids));
  fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify({ vintage: opts.vintage || 2025, wardCode: opts.wardCode || '27106', license: 'PLATEAU site policy', attribution: 'MLIT Project PLATEAU', sourceMeshes: ['52350318'], coordinateConvention: 'znorth-neg-v1' }));
  return { root, d };
}

test('fixture: audit passes file-level checks, is labelled static-files and never owner-PC accepted', () => {
  const { d } = mkFixture();
  const r = A.audit(d, { fixture: true });
  assert.strictEqual(r.scope, 'static-files');
  assert.strictEqual(r.ownerPcBrowserAccepted, false);
  assert.strictEqual(r.fixture, true);
  const hard = r.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.deepStrictEqual(hard, ['building count equals Mission 79 reported 12603 (informational)']);
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.tiles.detail, 1);
  assert.strictEqual(r.tiles.coarse, 1);
});

test('audit fails on: bad GLB, wrong vintage, wrong ward (Expo 27999), out-of-ward points, height sentinel', () => {
  assert.ok(A.audit(mkFixture({ badLod: true }).d).failed.some((x) => /GLB/.test(x)));
  assert.ok(A.audit(mkFixture({ vintage: 2024 }).d).failed.some((x) => /2025/.test(x)));
  assert.ok(A.audit(mkFixture({ wardCode: '27999' }).d).failed.some((x) => /27106/.test(x)));
  assert.ok(A.audit(mkFixture({ outside: true }).d).failed.some((x) => /99%/.test(x)));
  assert.ok(A.audit(mkFixture({ sentinel: true }).d).failed.some((x) => /sentinel/.test(x)));
});

test('audit is read-only: tileset dir bytes unchanged', () => {
  const { d } = mkFixture();
  const snap = () => fs.readdirSync(d, { recursive: true }).sort().map((f) => { const p = path.join(d, f); return fs.statSync(p).isFile() ? f + ':' + fs.readFileSync(p).toString('hex') : f; }).join('|');
  const before = snap();
  A.audit(d);
  assert.strictEqual(snap(), before);
});

test('start script: missing tileset exits 2 with build hint and does not serve', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '../tools/mission160-nishi2025-start.cjs'), '--root', path.join(os.tmpdir(), 'm160-does-not-exist')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /mission79-run\.mjs --ward nishi/);
});

test('start script: audits a fixture then binds loopback only and serves tileset.json 200 (no 404 for GLB)', async () => {
  const { root } = mkFixture();
  const { makeServer } = require('../tools/mission40f-serve-local.cjs');
  const http = require('http');
  const srv = makeServer({ publicDir: path.join(__dirname, '../public'), extDir: root });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  assert.strictEqual(srv.address().address, '127.0.0.1');
  const get = (u, method = 'GET') => new Promise((res) => http.request({ host: '127.0.0.1', port: srv.address().port, path: u, method }, (x) => { x.resume(); res(x.statusCode); }).end());
  assert.strictEqual(await get('/ext-3dtiles/nishi-2025/tileset.json'), 200);
  assert.strictEqual(await get('/ext-3dtiles/nishi-2025/tiles/t_0_0.glb'), 200);
  assert.strictEqual(await get('/ext-3dtiles/nishi-2025/lod/g_0_0.glb'), 200);
  assert.strictEqual(await get('/ext-3dtiles/nishi-2025/tileset.json', 'DELETE'), 405);
  assert.strictEqual(await get('/ext-3dtiles/..%2f..%2fetc/passwd'), 400);
  srv.close();
});

test('wiring: no write/delete/copy/network in the new tools; ps1 is ASCII; viewer accepts ?ext=nishi-2025', () => {
  const files = ['tools/mission160/nishi2025-audit.cjs', 'tools/mission160-nishi2025-start.cjs', 'tools/mission160-nishi2025-start.ps1', 'tools/experiments/mission160_nishi2025_browser.mjs'];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/rmSync|unlinkSync|rename|copyFile|Remove-Item|Copy-Item|robocopy|Move-Item|https?\.get|fetch\('https|new WebSocket\('wss/.test(s), f);
    assert.ok(!/0\.0\.0\.0/.test(s), f);
  }
  const ps = fs.readFileSync(path.join(__dirname, '../tools/mission160-nishi2025-start.ps1'));
  assert.ok(![...ps].some((b) => b > 127), 'ps1 must be ASCII');
  const html = fs.readFileSync(path.join(__dirname, '../public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.match(html, /\/\^\[a-z0-9-\]\+\$\/\.test\(n\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '../tools/experiments/mission160_nishi2025_browser.mjs'), 'utf8'), /ownerPcAcceptance: false/);
});

test('browser acceptance script has valid syntax (not executed here: needs a built tileset and a browser)', () => {
  execFileSync(process.execPath, ['--check', path.join(__dirname, '../tools/experiments/mission160_nishi2025_browser.mjs')]);
});
