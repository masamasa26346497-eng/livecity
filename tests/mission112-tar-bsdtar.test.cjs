'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const lib = () => import(path.join(ROOT, 'tools/mission108/lib.mjs'));

test('GNU verbose listing parses (names from plain listing)', async () => {
  const L = await lib();
  const v = 'drwxr-xr-x user/group 0 2025-01-01 12:00 ./\n-rw-r--r-- user/group 1234 2025-01-01 12:00 ./a b.json\n';
  const e = L.parseTarListing(v, './\n./a b.json\n');
  assert.deepStrictEqual(e.map((x) => [x.type, x.size, x.name]), [['d', 0, './'], ['-', 1234, './a b.json']]);
});

test('Windows bsdtar verbose listing parses (owner/size/date layout, CRLF)', async () => {
  const L = await lib();
  const v = 'drwxr-xr-x  0 0      0           0 Jan  1 12:00 ./\r\n-rw-r--r--  0 0      0        6106 Oct 10  2025 ./t_0_0.glb\r\n-rw-r--r--  0 0      0          12 Oct 10 12:34 ./日本 語.json\r\n';
  const p = './\r\n./t_0_0.glb\r\n./日本 語.json\r\n';
  const e = L.parseTarListing(v, p);
  assert.strictEqual(e.length, 3);
  assert.strictEqual(e[1].size, 6106);
  assert.strictEqual(e[2].name, './日本 語.json');
});

test('bsdtar: symlink / hardlink refused; unknown format and mismatches fail closed', async () => {
  const L = await lib();
  assert.throws(() => L.parseTarListing('lrwxr-xr-x  0 0 0 0 Jan  1 12:00 evil -> /etc/passwd', 'evil'), /link/);
  assert.throws(() => L.parseTarListing('hrw-r--r--  0 0 0 0 Jan  1 12:00 x link to y', 'x'), /link/);
  assert.throws(() => L.parseTarListing('garbage line', 'x'), /unparseable/);
  assert.throws(() => L.parseTarListing('-rw-r--r-- u/g 1 2025-01-01 12:00 a\n-rw-r--r-- u/g 1 2025-01-01 12:00 b', 'a'), /mismatch/);
  assert.throws(() => L.parseTarListing('-rw-r--r-- u/g 1 2025-01-01 12:00 a', 'other'), /mismatch/);
  // newline inside a name -> verbose/plain line counts diverge -> refused
  assert.throws(() => L.parseTarListing('-rw-r--r-- u/g 1 2025-01-01 12:00 a\nb', 'a\nb\nc'), /mismatch/);
});

test('traversal / absolute names still refused after parsing', async () => {
  const L = await lib();
  const e = L.parseTarListing('-rw-r--r-- u/g 1 2025-01-01 12:00 ../x', '../x');
  assert.throws(() => L.checkEntries(e), /unsafe/);
});

test('real tar: safeExtract works offline with Japanese + spaced names', async (t) => {
  if (spawnSync('tar', ['--version']).status !== 0) return t.skip('no tar');
  const L = await lib();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm112-日本-'));
  const src = path.join(d, 'src'); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'tileset.json'), '{}');
  fs.writeFileSync(path.join(src, 'a b.json'), '{}');
  assert.strictEqual(spawnSync('tar', ['-czf', path.join(d, 'a.tgz'), '-C', src, '.']).status, 0);
  const info = L.safeExtract(path.join(d, 'a.tgz'), path.join(d, 'dest'));
  assert.ok(info.count >= 3);
  assert.ok(fs.existsSync(path.join(d, 'dest', 'a b.json')));
});

test('fetch-summary is written ASCII-safe (PowerShell 5.1)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/mission108/fetch-verify.mjs'), 'utf8');
  assert.ok(s.includes('ASCII-safe JSON') && s.includes('.replace(/[\\u0080-\\uffff]/g'));
  const out = JSON.stringify({ m: '取得' }, null, 1).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  assert.ok(/^[\x00-\x7f]*$/.test(out));
  assert.strictEqual(JSON.parse(out).m, '取得');
});
