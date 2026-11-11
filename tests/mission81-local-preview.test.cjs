'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const L = () => import('../tools/mission81-local-preview.mjs');
const SRC = fs.readFileSync(path.join(ROOT, 'tools', 'mission81-local-preview.mjs'), 'utf8');
const lock = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/mission79/source-lock.json'), 'utf8'));

test('real source lock passes; wrong host / license / etag / expo are rejected', async () => {
  const { checkLock } = await L();
  assert.deepStrictEqual(checkLock(lock()), []);
  const b1 = lock(); b1.resource.url = 'https://evil.example/x.zip'; assert.ok(checkLock(b1).length);
  const b2 = lock(); b2.license = { id: 'unknown' }; assert.ok(checkLock(b2).length);
  const b3 = lock(); delete b3.http.etag; assert.ok(checkLock(b3).length);
  const b4 = lock(); b4.package.name = 'plateau-27999-expo-2025'; assert.ok(checkLock(b4).length);
});

test('validateOutput: accepts consistent 2025 ward; rejects 2024 / expo / wrong ward / duplicate ids / foreign host', async () => {
  const { validateOutput } = await L();
  const mk = (over = {}) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm81-'));
    fs.mkdirSync(path.join(d, 'ids')); fs.mkdirSync(path.join(d, 'attrs'));
    fs.writeFileSync(path.join(d, 'tileset.json'), '{}');
    fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify(Object.assign({ wardCode: '27106', vintage: 2025, attribution: 'Project PLATEAU', source: 'https://assets.cms.plateau.reearth.io/a.zip' }, over.src)));
    fs.writeFileSync(path.join(d, 'build-report.json'), JSON.stringify({ totals: { buildings: 2 } }));
    fs.writeFileSync(path.join(d, 'ids', 't_0_0.json'), JSON.stringify(over.ids || ['bldg_a', 'bldg_b']));
    return d;
  };
  const w = { wardCode: '27106' };
  assert.ok(validateOutput(mk(), w).ok);
  assert.ok(!validateOutput(mk({ src: { vintage: 2024 } }), w).ok);
  assert.ok(!validateOutput(mk({ src: { wardCode: '27999' } }), w).ok);
  assert.ok(!validateOutput(mk({ src: { wardCode: '27103' } }), w).ok);
  assert.ok(!validateOutput(mk({ ids: ['bldg_a', 'bldg_a'] }), w).ok);
  assert.ok(!validateOutput(mk({ src: { source: 'https://evil.example/a.zip' } }), w).ok);
});

test('server: serves only the one ward under /ext-3dtiles/, read-only, traversal rejected, loopback', async () => {
  const { makeServer } = await L();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'm81o-')); fs.writeFileSync(path.join(out, 'tileset.json'), '{"a":1}');
  fs.writeFileSync(path.join(path.dirname(out), 'm81-secret.txt'), 'x');
  const srv = makeServer({ publicDir: path.join(ROOT, 'public'), outDir: out, name: 'nishi25' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const get = (p, m) => new Promise((r) => http.request({ host: '127.0.0.1', port, path: p, method: m || 'GET' }, (res) => { res.resume(); res.on('end', () => r(res.statusCode)); }).end());
  assert.strictEqual(await get('/ext-3dtiles/nishi25/tileset.json'), 200);
  assert.strictEqual(await get('/ext-3dtiles/other/tileset.json'), 404);
  assert.notStrictEqual(await get('/ext-3dtiles/nishi25/../m81-secret.txt'), 200);
  assert.notStrictEqual(await get('/ext-3dtiles/nishi25/%2e%2e/m81-secret.txt'), 200);
  assert.strictEqual(await get('/mission37g-osaka-24ward-mvp.html'), 200);
  assert.strictEqual(await get('/ext-3dtiles/nishi25/tileset.json', 'POST'), 405);
  assert.strictEqual(srv.address().address, '127.0.0.1');
  srv.close();
});

test('launcher source: loopback only, deletes only its own temp paths, no tunnel, URL uses nobuiltin', async () => {
  const { previewUrl, HOST, candidateDirs } = await L();
  assert.strictEqual(HOST, '127.0.0.1');
  assert.ok(!/0\.0\.0\.0|ngrok|tunnel/i.test(SRC.replace(/no tunnel/gi, '')));
  assert.match(SRC, /\.listen\(port, HOST/);
  assert.match(previewUrl(8137, 'nishi25'), /^http:\/\/127\.0\.0\.1:8137\/.*\?nobuiltin=1&ext=nishi25$/);
  for (const m of SRC.matchAll(/rmSync\(([^)]*)\)/g)) assert.match(m[1], /ROOT, (final|work)/);
  assert.ok(candidateDirs('nishi').every((d) => d.includes(path.sep + 'temp' + path.sep)));
});

test('CLI refuses oversize plan and non-loopback bind options (no download happens)', () => {
  const run = (args) => execFileSync(process.execPath, ['tools/mission81-local-preview.mjs'].concat(args), { cwd: ROOT, stdio: 'pipe' });
  assert.throws(() => run(['--host', '0.0.0.0']));
  assert.throws(() => run(['--ward', 'expo']));
});
