'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..');
const P = () => import('../tools/mission87-persist.mjs');

function fixture(code, extra) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm87-')); const out = path.join(d, 'out', 'testward-2025'); fs.mkdirSync(path.join(out, 'ids'), { recursive: true });
  fs.writeFileSync(path.join(out, 'tileset.json'), '{}'); fs.writeFileSync(path.join(out, 'build-report.json'), '{}');
  fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify({ wardCode: code, vintage: '2025' })); fs.writeFileSync(path.join(out, 'a.glb'), 'x'); fs.writeFileSync(path.join(out, 'ids', 't.json'), '[]');
  if (extra) fs.writeFileSync(path.join(out, extra), 'z');
  return { d, out };
}

test('inspectOut accepts 27100-family ward output and counts files', async () => {
  const m = await P(); const f = fixture('27103'); const r = m.inspectOut(f.out);
  assert.strictEqual(r.wardCode, '27103'); assert.strictEqual(r.files, 5);
});
test('expo 27999, photos, secrets and unknown files are rejected, not silently dropped', async () => {
  const m = await P();
  assert.throws(() => m.inspectOut(fixture('27999').out), /expo/);
  assert.throws(() => m.inspectOut(fixture('27103', 'google-photo.jpg').out), /denied/);
  assert.throws(() => m.inspectOut(fixture('27103', '.env').out), /denied/);
  assert.throws(() => m.inspectOut(fixture('27103', 'notes.txt').out), /unexpected/);
});
test('pack refuses invalid ward names and missing output; upload is dry-run by default and needs pack first', async () => {
  const m = await P();
  assert.throws(() => m.pack('../x', 'temp/none'), /invalid ward/);
  assert.throws(() => m.pack('nonexistentward', 'temp/none'), /tileset\.json/);
  assert.throws(() => m.upload('neverpacked'), /pack first/);
});
test('tool stays out of git: archives under temp/, no merge/delete of sources, public repo needs explicit flag', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/mission87-persist.mjs'), 'utf8');
  assert.ok(/temp\/mission87\/archives/.test(s));
  assert.ok(!/rmSync|unlinkSync|git['"]?,\s*\[?['"]?(add|push)/.test(s));
  assert.ok(/allow-public/.test(s) && /execute/.test(s));
  assert.ok(!/googleapis|api[-_]?key\s*=/i.test(s));
});
test('status never reports browser acceptance', async () => {
  const m = await P(); assert.strictEqual(m.status().browserAccepted, 0);
});

test('mission92: explicit private repo targeting, token required, no public bypass', async () => {
  const m = await P();
  const s = fs.readFileSync(path.join(ROOT, 'tools/mission87-persist.mjs'), 'utf8');
  assert.ok(m.validRepo('masamasa26346497-eng/livecity-3d-data'));
  assert.ok(!m.validRepo('bad repo;x') && !m.validRepo('a/b/c'));
  assert.throws(() => m.upload('x', { repo: 'bad repo' }), /invalid --repo/);
  assert.throws(() => m.upload('x', { repo: 'a/b', allowPublic: true }), /private is mandatory/);
  assert.ok(/LIVECITY_3D_DATA_TOKEN/.test(s) && /delete env.GITHUB_TOKEN/.test(s) && /not verified PRIVATE/.test(s));
});
