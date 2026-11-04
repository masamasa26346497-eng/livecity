'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const lib = () => import(path.join(ROOT, 'tools/mission108/lib.mjs'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm108-'));

function glb() {
  const b = Buffer.alloc(24); b.write('glTF', 0, 'latin1'); b.writeUInt32LE(2, 4); b.writeUInt32LE(24, 8); return b;
}
function makeWard(dir, { badGlb = false, missing = false } = {}) {
  fs.mkdirSync(path.join(dir, 'attrs'), { recursive: true }); fs.mkdirSync(path.join(dir, 'ids'));
  fs.writeFileSync(path.join(dir, 'tileset.json'), JSON.stringify({ asset: { version: '1.0' }, root: { children: [{ content: { uri: 't_0_0.glb' } }, ...(missing ? [{ content: { uri: 'nope.glb' } }] : [])] } }));
  fs.writeFileSync(path.join(dir, 't_0_0.glb'), badGlb ? Buffer.from('not a glb at all, sorry!!') : glb());
  fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ vintage: 2025, wardCode: '27106' }));
}
function pack(srcDir, out, extra = []) {
  const r = spawnSync('tar', ['-czf', out, '-C', srcDir, ...extra, '.']); assert.strictEqual(r.status, 0);
}

test('ward allow-list: only nishi/fukushima/yodogawa, no duplicates, no tokens', async () => {
  const L = await lib();
  assert.deepStrictEqual(L.validateWards(['nishi', 'fukushima', 'yodogawa']), ['nishi', 'fukushima', 'yodogawa']);
  for (const bad of [['sumiyoshi'], ['nishi', 'nishi'], ['../x'], ['Nishi'], []]) assert.throws(() => L.validateWards(bad));
});

test('entry names: traversal / absolute / backslash refused', async () => {
  const L = await lib();
  assert.ok(L.unsafeName('../a')); assert.ok(L.unsafeName('/etc/x')); assert.ok(L.unsafeName('a\\b')); assert.ok(L.unsafeName('C:/x'));
  assert.strictEqual(L.unsafeName('attrs/t_0_0.json'), null);
});

test('tar listing: symlink and hardlink entries are refused', async () => {
  const L = await lib();
  assert.throws(() => L.parseTarListing('lrwxrwxrwx root/root 0 2025-01-01 00:00 evil -> /etc/passwd', 'evil'), /link/);
  assert.throws(() => L.checkEntries([{ type: 'c', size: 0, name: 'dev' }]), /special/);
  assert.throws(() => L.checkEntries([{ type: '-', size: 1, name: '../../x' }]), /unsafe/);
});

test('safeExtract: a real archive containing a symlink is refused before extraction', async () => {
  const L = await lib(); const t = tmp(); const src = path.join(t, 'src'); makeWard(src);
  fs.symlinkSync('/etc/passwd', path.join(src, 'evil'));
  pack(src, path.join(t, 'a.tgz'));
  assert.throws(() => L.safeExtract(path.join(t, 'a.tgz'), path.join(t, 'dest')), /link/);
  assert.ok(!fs.existsSync(path.join(t, 'dest', 'tileset.json')));
});

test('safeExtract: non-empty destination refused (no overwrite)', async () => {
  const L = await lib(); const t = tmp(); const src = path.join(t, 'src'); makeWard(src); pack(src, path.join(t, 'a.tgz'));
  fs.mkdirSync(path.join(t, 'dest')); fs.writeFileSync(path.join(t, 'dest', 'keep'), 'x');
  assert.throws(() => L.safeExtract(path.join(t, 'a.tgz'), path.join(t, 'dest')), /not empty/);
  assert.strictEqual(fs.readFileSync(path.join(t, 'dest', 'keep'), 'utf8'), 'x');
});

test('verifyTilesetDir: good ward passes; bad GLB and missing content fail', async () => {
  const L = await lib(); const t = tmp();
  makeWard(path.join(t, 'ok')); assert.strictEqual(L.verifyTilesetDir(path.join(t, 'ok')).ok, true);
  makeWard(path.join(t, 'bad'), { badGlb: true }); assert.strictEqual(L.verifyTilesetDir(path.join(t, 'bad')).ok, false);
  makeWard(path.join(t, 'miss'), { missing: true }); assert.strictEqual(L.verifyTilesetDir(path.join(t, 'miss')).ok, false);
});

test('fetch-verify offline: verifies a fixture archive, summary has no data/paths/token', () => {
  const t = tmp(); const src = path.join(t, 'src'); makeWard(src);
  fs.mkdirSync(path.join(t, 'arch')); pack(src, path.join(t, 'arch', 'plateau2025-nishi.tar.gz'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/mission108/fetch-verify.mjs'), '--wards', 'nishi', '--from-archive-dir', path.join(t, 'arch'), '--dest', path.join(t, 'out'), '--summary', path.join(t, 's.json')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const s = JSON.parse(fs.readFileSync(path.join(t, 's.json'), 'utf8'));
  assert.strictEqual(s.wards.nishi.status, 'verified'); assert.strictEqual(s.containsData, false);
  assert.match(s.wards.nishi.archiveSha256, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(t, 'out', 'nishi25', 'tileset.json')));
  assert.ok(!fs.existsSync(path.join(t, 'out', '.archives')));
  assert.ok(!JSON.stringify(s).includes(t));
  // second run into the now non-empty dest must refuse
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'tools/mission108/fetch-verify.mjs'), '--wards', 'nishi', '--from-archive-dir', path.join(t, 'arch'), '--dest', path.join(t, 'out'), '--summary', path.join(t, 's2.json')], { encoding: 'utf8' });
  assert.strictEqual(r2.status, 2);
});

test('fetch-verify without token and without local dir fails closed', () => {
  const t = tmp();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/mission108/fetch-verify.mjs'), '--wards', 'nishi', '--dest', path.join(t, 'o'), '--summary', path.join(t, 's.json')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.strictEqual(r.status, 3);
});

test('static: token never logged, no destructive/network-publish commands, qa is 127.0.0.1 + GET-only', () => {
  for (const f of ['lib.mjs', 'fetch-verify.mjs', 'qa.mjs', 'local-run.mjs']) {
    const s = fs.readFileSync(path.join(ROOT, 'tools/mission108', f), 'utf8');
    assert.ok(!/console\.(log|error)\([^)]*token/i.test(s.replace(/LIVECITY_3D_DATA_TOKEN (missing|\w+)/g, '')), f + ' logs token');
    assert.ok(!/(gh release (upload|create)|git push|method:\s*'(PUT|POST|DELETE|PATCH)')/.test(s), f + ' has write/publish op');
  }
  const qa = fs.readFileSync(path.join(ROOT, 'tools/mission108/qa.mjs'), 'utf8');
  assert.match(qa, /listen\(port, '127\.0\.0\.1'/); assert.match(qa, /req\.method !== 'GET'/);
  const lr = fs.readFileSync(path.join(ROOT, 'tools/mission108/local-run.mjs'), 'utf8');
  assert.match(lr, /delete cleanEnv\.LIVECITY_3D_DATA_TOKEN/);
});

test('qa.mjs imports without side effects and exposes Phase B views with no shift', async () => {
  const q = await import(path.join(ROOT, 'tools/mission108/qa.mjs'));
  assert.strictEqual(q.PHASE_B_VIEWS.length, 2);
  assert.ok(!/shiftApplied:\s*true/.test(fs.readFileSync(path.join(ROOT, 'tools/mission108/qa.mjs'), 'utf8')));
});
