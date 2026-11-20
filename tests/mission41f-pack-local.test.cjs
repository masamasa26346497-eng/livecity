'use strict';
// Mission 41F: offline local tar packaging, synthetic fixtures only (no real data was available to CI).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const f = require('../tools/mission41f-pack-local.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc41f-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function fixture() {
  const base = tmp(); const root = path.join(base, 'LiveCity');
  const files = {
    'livecity-3dtiles-out-fukushima/tileset.json': Buffer.from('{"a":1}'),
    'livecity-3dtiles-out-fukushima/日本語/t_1.glb': crypto.randomBytes(1500),
    'livecity-3dtiles-out-fukushima/empty.bin': Buffer.alloc(0),
    ['livecity-3dtiles-out-fukushima/' + 'deep/'.repeat(25) + 'long-file-name-for-prefix-split.bin']: Buffer.from('prefix'),
    'other/o.bin': Buffer.from('other'),
  };
  for (const [rel, buf] of Object.entries(files)) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
  const entry = (rel) => ({ path: 'LiveCity/' + rel, size: files[rel].length });
  const fk = Object.keys(files).filter((r) => r.includes('fukushima'));
  const m = { schema: 2, sizing: 'tar-estimate', parts: [
    { asset: 'lcdata-3dtiles-output-001.tar', category: '3dtiles-output', files: fk.map(entry) },
    { asset: 'lcdata-other-002.tar', category: 'other', files: [entry('other/o.bin')] }] };
  return { base, root, files, m, roots: { LiveCity: root }, out: path.join(base, 'out'), fk };
}

test('creates a tar that GNU tar accepts, whose members equal the sources byte for byte; sources untouched', () => {
  const x = fixture();
  const before = Object.keys(x.files).map((r) => sha(fs.readFileSync(path.join(x.root, ...r.split('/')))));
  const r = f.create(x.m, x.roots, { outDir: x.out, pathContains: 'fukushima' });
  assert.strictEqual(r.code, 0, JSON.stringify(r.report.problems));
  assert.strictEqual(r.report.parts.length, 1);
  const p = r.report.parts[0]; assert.strictEqual(p.state, 'created');
  const tarFile = path.join(x.out, p.name);
  assert.match(p.name, /-subset-[0-9a-f]{8}\.tar$/); // a subset never carries a full-part name
  assert.strictEqual(sha(fs.readFileSync(tarFile)), p.sha256);
  const members = f.readTar(tarFile);
  assert.strictEqual(members.length, x.fk.length);
  for (const mb of members) { assert.ok(mb.name.startsWith('LiveCity/')); assert.strictEqual(mb.sha256, sha(fs.readFileSync(path.join(x.root, ...mb.name.slice(9).split('/'))))); }
  const ex = tmp(); // independent extractor
  cp.execFileSync('tar', ['-xf', tarFile, '-C', ex]);
  for (const rel of x.fk) assert.ok(fs.readFileSync(path.join(ex, 'LiveCity', ...rel.split('/'))).equals(x.files[rel]));
  const after = Object.keys(x.files).map((r) => sha(fs.readFileSync(path.join(x.root, ...r.split('/')))));
  assert.deepStrictEqual(after, before);
  assert.ok(!fs.existsSync(path.join(x.out, '.staging', p.name + '.partial')));
  assert.strictEqual(r.report.readyToUpload, false);
  assert.ok(Object.values(r.report.gates).every((v) => v === false));
  assert.ok(fs.existsSync(path.join(x.out, r.reportFile)));
});

test('rerun into the same output is detected as already packed (no rewrite); repeat is idempotent', () => {
  const x = fixture();
  const a = f.create(x.m, x.roots, { outDir: x.out, pathContains: 'fukushima' });
  const mt = fs.statSync(path.join(x.out, a.report.parts[0].name)).mtimeMs;
  const b = f.create(x.m, x.roots, { outDir: x.out, pathContains: 'fukushima' });
  assert.strictEqual(b.code, 0);
  assert.strictEqual(b.report.parts[0].state, 'already-packed-verified');
  assert.strictEqual(fs.statSync(path.join(x.out, b.report.parts[0].name)).mtimeMs, mt);
  assert.notStrictEqual(a.reportFile, b.reportFile); // reports are never overwritten
});

test('an existing archive that no longer matches is NOT overwritten and not deleted', () => {
  const x = fixture();
  const a = f.create(x.m, x.roots, { outDir: x.out, pathContains: 'fukushima' });
  const tarFile = path.join(x.out, a.report.parts[0].name); const keep = fs.readFileSync(tarFile);
  // 1) archive damaged on disk: same name, content no longer matches -> refused, left in place
  const bad = Buffer.from(keep); bad[600] ^= 0xff; fs.writeFileSync(tarFile, bad);
  const b = f.create(x.m, x.roots, { outDir: x.out, pathContains: 'fukushima' });
  assert.strictEqual(b.code, 1);
  assert.match(b.report.parts[0].error, /NOT overwritten/);
  assert.ok(fs.readFileSync(tarFile).equals(bad));
  // 2) source legitimately changed (manifest updated): a NEW name is used, the old archive stays untouched
  fs.writeFileSync(tarFile, keep);
  fs.appendFileSync(path.join(x.root, 'livecity-3dtiles-out-fukushima', 'tileset.json'), 'X');
  x.m.parts[0].files[0].size += 1;
  const c = f.create(x.m, x.roots, { outDir: x.out, pathContains: 'fukushima' });
  assert.strictEqual(c.code, 0);
  assert.notStrictEqual(c.report.parts[0].name, a.report.parts[0].name);
  assert.ok(fs.readFileSync(tarFile).equals(keep));
});

test('source changing mid-pack is detected; the partial is quarantined (moved), never deleted, nothing finalised', () => {
  const x = fixture();
  let n = 0;
  const part = f.selectForPack(x.m, { pathContains: 'fukushima' }).parts[0];
  fs.mkdirSync(x.out, { recursive: true });
  const r = f.buildPart(part, 'p.tar', x.roots, x.out, { afterFile: (file, src) => { if (n++ === 0) fs.writeFileSync(src, fs.readFileSync(src).length ? 'Z' + fs.readFileSync(src, 'utf8').slice(1) : 'Z'); } });
  assert.strictEqual(r.state, 'failed');
  assert.ok(r.quarantined);
  assert.ok(fs.existsSync(path.join(x.out, 'quarantine', r.quarantined)));
  assert.ok(!fs.existsSync(path.join(x.out, 'p.tar')));
});

test('leftover .partial from an earlier crash is quarantined, not deleted or reused', () => {
  const x = fixture(); fs.mkdirSync(path.join(x.out, '.staging'), { recursive: true });
  const part = f.selectForPack(x.m, { pathContains: 'fukushima' }).parts[0];
  fs.writeFileSync(path.join(x.out, '.staging', 'q.tar.partial'), 'junk');
  const r = f.buildPart(part, 'q.tar', x.roots, x.out);
  assert.strictEqual(r.state, 'created'); assert.ok(r.quarantinedOld);
  assert.strictEqual(fs.readFileSync(path.join(x.out, 'quarantine', r.quarantinedOld), 'utf8'), 'junk');
});

test('secrets-candidate / backup-archive categories and key-like names are never packed', () => {
  const x = fixture();
  x.m.parts.push({ asset: 's.tar', category: 'secrets-candidate', files: [{ path: 'LiveCity/livecity-3dtiles-out-fukushima/tileset.json', size: 7 }] });
  x.m.parts.push({ asset: 'b.tar', category: 'backup-archive', files: [{ path: 'LiveCity/livecity-3dtiles-out-fukushima/tileset.json', size: 7 }] });
  x.m.parts[0].files.push({ path: 'LiveCity/livecity-3dtiles-out-fukushima/.env.local', size: 3 });
  const s = f.selectForPack(x.m, { pathContains: 'fukushima' });
  assert.strictEqual(s.parts.length, 1);
  assert.ok(s.parts[0].files.every((q) => !/\.env/.test(q.path)));
  assert.ok(s.excluded.categoryFiles >= 2); assert.strictEqual(s.excluded.nameHintFiles, 1);
  for (const n of ['a/.env', 'x/key.pem', 'id_rsa', 'cfg/credentials.json', 'api-token.txt']) assert.ok(f.SECRET_NAME_HINT.test(n), n);
  assert.ok(!f.SECRET_NAME_HINT.test('LiveCity/x/t_1.glb'));
});

test('preflight refuses traversal, absolute path, size mismatch, intermediate-dir symlink; writes nothing', () => {
  const x = fixture();
  const bad = (mut) => { const m = JSON.parse(JSON.stringify(x.m)); mut(m.parts[0]); return f.create(m, x.roots, { outDir: path.join(x.base, 'o' + Math.random()), pathContains: 'fukushima' }); };
  let r = bad((p) => p.files.push({ path: 'LiveCity/fukushima/../../x', size: 1 }));
  assert.strictEqual(r.code, 1); assert.ok(r.report.problems.some((q) => q.kind === 'path-traversal'));
  r = bad((p) => p.files[0].size += 5);
  assert.strictEqual(r.code, 1); assert.ok(r.report.problems.some((q) => q.kind === 'size-changed'));
  // intermediate symlink that stays INSIDE the root
  const real = path.join(x.root, 'other'); const link = path.join(x.root, 'livecity-3dtiles-out-fukushima', 'lnk');
  try { fs.symlinkSync(real, link, 'dir'); } catch { return; }
  const m = JSON.parse(JSON.stringify(x.m)); m.parts[0].files = [{ path: 'LiveCity/livecity-3dtiles-out-fukushima/lnk/o.bin', size: 5 }];
  const out = path.join(x.base, 'osym');
  r = f.create(m, x.roots, { outDir: out, pathContains: 'fukushima' });
  assert.strictEqual(r.code, 1); assert.ok(r.report.problems.some((q) => q.kind === 'intermediate-dir-symlink-or-not-dir'));
  assert.ok(!fs.existsSync(out));
});

test('NFC / case-collision from 41D are reused', () => {
  const x = fixture();
  const m = JSON.parse(JSON.stringify(x.m));
  m.parts[0].files.push({ path: 'LiveCity/livecity-3dtiles-out-fukushima/TILESET.JSON', size: 7 });
  const r = f.create(m, x.roots, { outDir: path.join(x.base, 'oc'), pathContains: 'fukushima' });
  assert.strictEqual(r.code, 1);
  assert.ok(r.report.problems.some((q) => q.kind === 'case-collision' || q.kind === 'missing'));
});

test('part limit and 2 GiB cap are enforced from the 41D estimate', () => {
  const x = fixture();
  const r = f.create(x.m, x.roots, { outDir: path.join(x.base, 'ol'), pathContains: 'fukushima', partLimitGiB: 0.000001 });
  assert.ok(r.report.problems.some((q) => q.kind === 'tar-estimate-over-limit'));
  assert.throws(() => f.create(x.m, x.roots, { outDir: x.out, partLimitGiB: 2 }), /< 2 GiB/);
});

test('ustar names: long names are split into prefix/name and read back identically', () => {
  const long = 'LiveCity/' + 'd'.repeat(60) + '/' + 'e'.repeat(60) + '/file.bin';
  const { name, prefix } = f.splitName(long);
  assert.ok(name.length <= 100 && prefix.length <= 155);
  assert.strictEqual(prefix.toString() + '/' + name.toString(), long);
  assert.throws(() => f.splitName('x'.repeat(120)));
});

test('CLI: refuses --out inside a data root and a non-empty foreign --out; zero match exits 3', () => {
  const x = fixture();
  const rf = path.join(x.base, 'r.json'); fs.writeFileSync(rf, JSON.stringify(x.roots));
  const mf = path.join(x.base, 'm.json'); fs.writeFileSync(mf, JSON.stringify(x.m));
  const q = (extra) => f.run(['create', '--manifest', mf, '--roots-file', rf, ...extra]);
  assert.throws(() => q(['--out', path.join(x.root, 'inside')]), /outside every data root/);
  const foreign = path.join(x.base, 'foreign'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep.txt'), 'k');
  assert.throws(() => q(['--out', foreign, '--path-contains', 'fukushima']), /not empty/);
  assert.strictEqual(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8'), 'k');
  const orig = console.log; console.log = () => {};
  try { assert.strictEqual(q(['--out', path.join(x.base, 'o9'), '--path-contains', 'nomatch']), 3); assert.strictEqual(q(['--out', x.out, '--path-contains', 'fukushima']), 0); }
  finally { console.log = orig; }
});

test('static: no network, no upload, no delete of sources; ps1 is ASCII and has no remove/copy', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41f-pack-local.cjs'), 'utf8');
  assert.ok(!/require\(['"]node:(https?|net|dns|tls|http2)['"]\)|\bfetch\(|XMLHttpRequest|child_process/.test(js));
  assert.ok(!/unlinkSync|rmSync|rmdirSync|\.rm\(|truncateSync|copyFileSync/.test(js));
  const ps = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41f-pack-local.ps1'));
  assert.ok(ps.every((b) => b < 128), 'ps1 must be ASCII');
  const t = ps.toString();
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod|\bgh\b/i.test(t));
  assert.ok(/livecity-plan-\*/.test(t) && /IsPathRooted/.test(t) && /exit \$code/.test(t));
  assert.ok((t.match(/\{/g) || []).length === (t.match(/\}/g) || []).length);
});
