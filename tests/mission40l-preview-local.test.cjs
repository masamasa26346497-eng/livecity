'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { parseArgs, contentUris } = require('../tools/mission40l-preview-local.cjs');
const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'tools', 'mission40l-preview-local.cjs');

function fixture(opts) {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'p40l-')), w = path.join(ext, 'fukushima');
  for (const d of ['attrs', 'ids', 'layers']) fs.mkdirSync(path.join(w, d), { recursive: true });
  fs.writeFileSync(path.join(w, 'tileset.json'), JSON.stringify({ asset: { version: '1.1' }, root: { children: [{ content: { uri: 't_0_0.glb' } }, { content: { uri: 't_1_0.glb' } }] } }));
  fs.writeFileSync(path.join(w, 'source.json'), JSON.stringify({ wardCode: '27103', source: 'PLATEAU 3D city model Osaka 2024' }));
  fs.writeFileSync(path.join(w, 'build-report.json'), JSON.stringify({ totals: { buildings: 3 } }));
  fs.writeFileSync(path.join(w, 'ids', 't_0_0.json'), JSON.stringify(['bldg_a', 'bldg_b']));
  fs.writeFileSync(path.join(w, 'ids', 't_1_0.json'), JSON.stringify(['bldg_c']));
  fs.writeFileSync(path.join(w, 'attrs', 't_0_0.json'), '{}');
  fs.writeFileSync(path.join(w, 't_0_0.glb'), Buffer.from('glTF-dummy'));
  if (!(opts && opts.missingTile)) fs.writeFileSync(path.join(w, 't_1_0.glb'), Buffer.from('glTF-dummy'));
  for (const f of ['roads.json', 'waterways.json', 'parks.json', 'railways.json', 'layers-report.json']) fs.writeFileSync(path.join(w, 'layers', f), '{}');
  return ext;
}
const run = (args) => cp.spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('parseArgs validates', () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--ext', 'x', '--ward', '../bad']));
  assert.equal(parseArgs(['--ext', 'x', '--check']).open, false);
});
test('contentUris walks nested children', () => {
  assert.deepEqual(contentUris({ root: { content: { uri: 'a' }, children: [{ children: [{ content: { uri: 'b' } }] }] } }), ['a', 'b']);
});
test('--check: real HTTP fetch of page, tileset, every tile and layers succeeds', () => {
  const ext = fixture();
  const before = fs.readdirSync(path.join(ext, 'fukushima')).sort().join();
  const r = run(['--ext', ext, '--check']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rep = JSON.parse(r.stdout.slice(r.stdout.indexOf('{\n')));
  assert.equal(rep.ok, true);
  assert.equal(rep.tiles.total, 2);
  assert.equal(rep.tiles.ok, 2);
  assert.equal(fs.readdirSync(path.join(ext, 'fukushima')).sort().join(), before, 'source untouched');
});
test('--check fails when a tile is missing', () => {
  const r = run(['--ext', fixture({ missingTile: true }), '--check']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /t_1_0\.glb/);
});
test('fails clearly when the ward dir is absent', () => {
  const r = run(['--ext', os.tmpdir() + '/nonexistent-40l', '--check']);
  assert.notEqual(r.status, 0);
});
test('read-only, loopback-only, no network/google, ps1 ASCII', () => {
  const js = fs.readFileSync(SCRIPT, 'utf8'), ps = fs.readFileSync(SCRIPT.replace(/\.cjs$/, '.ps1'));
  assert.ok(!/unlink|rmSync|writeFile|copyFile|googleapis|https:\/\//.test(js));
  assert.ok(/'127\.0\.0\.1'/.test(js));
  for (const b of ps) assert.ok(b < 128, 'non-ASCII byte in ps1');
  assert.ok(!/Remove-Item|Copy-Item|robocopy|Move-Item/i.test(ps.toString()));
});
