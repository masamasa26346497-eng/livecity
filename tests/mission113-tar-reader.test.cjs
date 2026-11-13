'use strict';
// Mission 113: the tar reader parses raw tar headers (no `tar -tv` text). Archives are built in pure JS, so the tests do not
// depend on the host tar; real-tar compatibility is checked additionally when a `tar` binary exists.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const R = () => import(path.join(ROOT, 'tools/mission108/tar-reader.mjs'));
const lib = () => import(path.join(ROOT, 'tools/mission108/lib.mjs'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm113-日本-'));

const oct = (v, n) => Buffer.from(v.toString(8).padStart(n - 1, '0') + '\0', 'latin1');
function header({ name = '', size = 0, type = '0', link = '', prefix = '', magic = 'ustar\0' + '00', badSum = false, rawSize = null }) {
  const h = Buffer.alloc(512);
  Buffer.from(name).copy(h, 0); oct(0o644, 8).copy(h, 100); oct(0, 8).copy(h, 108); oct(0, 8).copy(h, 116);
  (rawSize || oct(size, 12)).copy(h, 124); oct(0, 12).copy(h, 136);
  h[156] = type === '\0' ? 0 : type.charCodeAt(0);
  Buffer.from(link).copy(h, 157); Buffer.from(magic, 'latin1').copy(h, 257); Buffer.from(prefix).copy(h, 345);
  h.fill(0x20, 148, 156);
  let s = 0; for (const b of h) s += b;
  Buffer.from(((badSum ? s + 1 : s).toString(8).padStart(6, '0')) + '\0 ', 'latin1').copy(h, 148);
  return h;
}
const padTo = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
const file = (name, data, o = {}) => Buffer.concat([header({ name, size: data.length, ...o }), padTo(Buffer.from(data))]);
const dir = (name) => header({ name, type: '5' });
const pax = (kv) => { let body = ''; for (const [k, v] of Object.entries(kv)) { const rec = ' ' + k + '=' + v + '\n'; let len = Buffer.byteLength(rec) + 1; len = Buffer.byteLength(rec) + String(len).length; len = Buffer.byteLength(rec) + String(len).length; body += len + rec; } return Buffer.concat([header({ name: 'PaxHeader', size: Buffer.byteLength(body), type: 'x' }), padTo(Buffer.from(body))]); };
const end = () => Buffer.alloc(1024);
const mk = (parts, { gz = true } = {}) => { const t = Buffer.concat(parts); return gz ? zlib.gzipSync(t) : t; };
function write(buf) { const d = tmp(); const f = path.join(d, 'a.tgz'); fs.writeFileSync(f, buf); return { d, f, dest: path.join(d, 'dest') }; }
const rejectsCode = async (buf, code) => { const { f, dest } = write(buf); const { extractTarGz } = await R(); await assert.rejects(() => extractTarGz(f, dest), (e) => e.code === code && !fs.existsSync(path.join(dest, 'evil'))); return dest; };

test('plain USTAR: dirs, files, Japanese + spaced names, exact bytes', async () => {
  const { extractTarGz } = await R();
  const { f, dest } = write(mk([dir('./'), dir('./日本語/'), file('./日本語/a b.json', '{"x":1}'), file('tileset.json', '{}'), end()]));
  const info = await extractTarGz(f, dest);
  assert.strictEqual(info.files, 2); assert.strictEqual(info.endMarker, true);
  assert.strictEqual(fs.readFileSync(path.join(dest, '日本語', 'a b.json'), 'utf8'), '{"x":1}');
});

test('USTAR prefix field joins with name; PAX path overrides; GNU long name works', async () => {
  const { extractTarGz } = await R();
  const longp = 'deep/' + 'd'.repeat(120);
  let w = write(mk([file('f.json', '1', { prefix: 'pre/dir' }), end()]));
  await extractTarGz(w.f, w.dest); assert.ok(fs.existsSync(path.join(w.dest, 'pre', 'dir', 'f.json')));
  w = write(mk([pax({ path: longp + '/p.json' }), file('short', 'x'), end()]));
  await extractTarGz(w.f, w.dest); assert.ok(fs.existsSync(path.join(w.dest, ...(longp + '/p.json').split('/'))));
  const ln = longp + '/g.json\0';
  w = write(mk([Buffer.concat([header({ name: '././@LongLink', size: ln.length, type: 'L', magic: 'ustar  \0' }), padTo(Buffer.from(ln))]), file('trunc', 'y', { magic: 'ustar  \0' }), end()]));
  await extractTarGz(w.f, w.dest); assert.ok(fs.existsSync(path.join(w.dest, ...(longp + '/g.json').split('/'))));
});

test('GNU base-256 size field and PAX global header are accepted; PAX size is honoured', async () => {
  const { extractTarGz } = await R();
  const b256 = Buffer.alloc(12); b256[0] = 0x80; b256[11] = 5;
  const g = pax({ comment: 'hi' }); g[156] = 'g'.charCodeAt(0);
  // re-checksum after type edit
  g.fill(0x20, 148, 156); let s = 0; for (const x of g.subarray(0, 512)) s += x; Buffer.from(s.toString(8).padStart(6, '0') + '\0 ', 'latin1').copy(g, 148);
  const w = write(mk([g, Buffer.concat([header({ name: 'n.bin', rawSize: b256, magic: 'ustar  \0' }), padTo(Buffer.from('12345'))]), end()]));
  const info = await extractTarGz(w.f, w.dest);
  assert.strictEqual(fs.readFileSync(path.join(w.dest, 'n.bin'), 'utf8'), '12345'); assert.ok(info.formats.pax);
});

test('malicious: traversal, absolute, UNC/drive, backslash, NUL, ADS colon, reserved names', async () => {
  for (const n of ['../evil', 'a/../../evil', '/etc/evil', 'C:/evil', 'C:evil', 'a\\evil', 'a:stream', 'CON', 'a/nul.txt', 'trail.', 'sp ']) await rejectsCode(mk([file(n, 'x'), end()]), 'unsafe-entry-name');
  await rejectsCode(mk([pax({ path: '../evil' }), file('ok', 'x'), end()]), 'unsafe-entry-name');
  await rejectsCode(mk([pax({ path: 'a\0b' }), file('ok', 'x'), end()]), 'unsafe-entry-name');
});

test('malicious: symlink, hardlink, device, fifo, link name on a regular file', async () => {
  for (const t of ['2', '1', '3', '4', '6', '7']) await rejectsCode(mk([header({ name: 'evil', type: t, link: 'x' }), end()]), 'unsupported-entry-type');
  await rejectsCode(mk([header({ name: 'evil', link: '/etc/passwd', size: 0 }), end()]), 'link-name-on-regular-entry');
  await rejectsCode(mk([pax({ linkpath: '/etc/passwd' }), file('evil', 'x'), end()]), 'link-name-on-regular-entry');
});

test('malicious: duplicates, case collisions, file/dir conflicts, bad checksum, bad numbers, truncation, trailing data', async () => {
  await rejectsCode(mk([file('a', '1'), file('a', '2'), end()]), 'path-collision');
  await rejectsCode(mk([file('A.json', '1'), file('a.json', '2'), end()]), 'path-collision');
  await rejectsCode(mk([file('a', '1'), file('a/b', '2'), end()]), 'path-collision');
  await rejectsCode(mk([file('d/x', '1'), file('d', '2'), end()]), 'path-collision');
  await rejectsCode(mk([file('a', '1', { badSum: true }), end()]), 'bad-checksum');
  await rejectsCode(mk([header({ name: 'a', rawSize: Buffer.from('99999999999\0', 'latin1') }), end()]), 'bad-number');
  const good = Buffer.concat([file('a', 'x'.repeat(2000)), end()]);
  await rejectsCode(zlib.gzipSync(good.subarray(0, 700)), 'truncated');
  await rejectsCode(mk([file('a', '1'), end(), Buffer.from('JUNK')]), 'data-after-end-marker');
  await rejectsCode(mk([Buffer.alloc(512), file('a', '1'), end()]), 'data-after-zero-block');
  await rejectsCode(mk([pax({ comment: 'x' }), end()]), 'dangling-meta-header');
  await rejectsCode(mk([Buffer.from('not a tar at all, not even close ........')]), 'truncated');
});

test('limits: too many entries and unpacked size are enforced (fail closed, nothing leaks names)', async () => {
  const { extractTarGz } = await R();
  const w = write(mk([file('a', '1'), file('b', '2'), end()]));
  await assert.rejects(() => extractTarGz(w.f, w.dest, { maxEntries: 1, maxUnpackedBytes: 1e6, maxMetaBytes: 1e6, maxPathChars: 1024, maxComponentChars: 255 }), (e) => e.code === 'too-many-entries');
  const w2 = write(mk([file('a', '1234'), end()]));
  await assert.rejects(() => extractTarGz(w2.f, w2.dest, { maxEntries: 10, maxUnpackedBytes: 3, maxMetaBytes: 1e6, maxPathChars: 1024, maxComponentChars: 255 }), (e) => e.code === 'unpacked-size-too-large');
  const w3 = write(zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024)));
  await assert.rejects(() => extractTarGz(w3.f, w3.dest, { maxEntries: 2, maxUnpackedBytes: 10, maxMetaBytes: 10, maxPathChars: 1024, maxComponentChars: 255 }), (e) => e.code === 'decompressed-too-large');
});

test('not gzip / corrupt gzip -> coded error; non-empty destination refused and untouched', async () => {
  const { extractTarGz } = await R();
  const w = write(Buffer.from('plain text, not gzip'));
  await assert.rejects(() => extractTarGz(w.f, w.dest), (e) => e.code === 'gunzip-failed');
  const w2 = write(mk([file('a', '1'), end()])); fs.mkdirSync(w2.dest); fs.writeFileSync(path.join(w2.dest, 'keep'), 'k');
  await assert.rejects(() => extractTarGz(w2.f, w2.dest), /not empty/);
  assert.strictEqual(fs.readFileSync(path.join(w2.dest, 'keep'), 'utf8'), 'k');
});

test('error messages carry codes/numbers but never entry names', async () => {
  const { extractTarGz } = await R();
  const w = write(mk([file('SECRET-NAME-日本/../x', 'x'), end()]));
  await assert.rejects(() => extractTarGz(w.f, w.dest), (e) => !/SECRET|日本/.test(e.message) && e.code === 'unsafe-entry-name');
});

test('audit is name-free and writes nothing', async () => {
  const { auditTarGz } = await R();
  const w = write(mk([dir('./'), file('./SECRET/a.glb', 'xx'), file('./SECRET/b.json', 'y'), end()]));
  const a = await auditTarGz(w.f);
  assert.strictEqual(a.files, 2); assert.deepStrictEqual(a.ext, { glb: 1, json: 1 }); assert.ok(!JSON.stringify(a).includes('SECRET'));
  assert.ok(!fs.existsSync(w.dest));
});

test('real tar (POSIX gnu / bsdtar) archives with Japanese + spaced names extract identically', async (t) => {
  if (spawnSync('tar', ['--version']).status !== 0) return t.skip('no tar');
  const L = await lib();
  const d = tmp(); const src = path.join(d, 'src日本'); fs.mkdirSync(path.join(src, 'ids'), { recursive: true });
  fs.writeFileSync(path.join(src, 'tileset.json'), '{}'); fs.writeFileSync(path.join(src, 'ids', 'a b.json'), '[]');
  fs.writeFileSync(path.join(src, 'x'.repeat(130) + '.json'), '1'); // forces PAX or GNU long name depending on tar
  for (const fmt of [[], ['--format=pax'], ['--format=gnu'], ['--format=ustar']]) {
    const out = path.join(d, 'a' + fmt.length + (fmt[0] || '') .replace(/\W/g, '') + '.tgz');
    const r = spawnSync('tar', ['-czf', out, ...fmt, '-C', src, '.']);
    if (r.status !== 0) continue; // this tar does not support the format flag
    const dest = path.join(d, 'dest' + path.basename(out));
    const info = await L.safeExtract(out, dest);
    assert.ok(info.count >= 4); assert.ok(fs.existsSync(path.join(dest, 'ids', 'a b.json')));
    assert.ok(fs.existsSync(path.join(dest, 'x'.repeat(130) + '.json')));
  }
});

test('local-run/fetch scripts no longer shell out to tar and keep failed archives for offline audit', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'tools/mission108/lib.mjs'), 'utf8');
  const rd = fs.readFileSync(path.join(ROOT, 'tools/mission108/tar-reader.mjs'), 'utf8');
  assert.ok(!/spawnSync|child_process|parseTarListing/.test(lib + rd));
  const fv = fs.readFileSync(path.join(ROOT, 'tools/mission108/fetch-verify.mjs'), 'utf8');
  assert.ok(fv.includes('if (exit === 0) fs.rmSync(arch') && fv.includes('ASCII-safe JSON') && fv.includes('.replace(/[\\u0080-\\uffff]/g'));
  assert.ok(fs.existsSync(path.join(ROOT, 'tools/mission108/tar-audit.mjs')));
});
