'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');
const repo = path.resolve(__dirname, '..');
const run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8' });

test('no .pathname path derivation in mission108/109 scripts', () => {
  for (const d of ['tools/mission108', 'tools/mission109']) {
    for (const f of fs.readdirSync(path.join(repo, d)).filter((x) => x.endsWith('.mjs'))) {
      const t = fs.readFileSync(path.join(repo, d, f), 'utf8');
      assert.ok(!/new URL\(import\.meta\.url\)\.pathname/.test(t), f);
    }
  }
  assert.match(fs.readFileSync(path.join(repo, 'tools/mission108/local-run.mjs'), 'utf8'), /fileURLToPath\(import\.meta\.url\)/);
});

test('fileURLToPath decodes japanese / space / % / drive / UNC', () => {
  for (const p of ['/tmp/ドキュメント/Live City/100%/x.mjs', '/tmp/a b/%E3/x.mjs']) {
    assert.strictEqual(fileURLToPath(pathToFileURL(p)), p);
  }
  assert.strictEqual(
    fileURLToPath('file:///C:/Users/user/OneDrive/%E3%83%89%E3%82%AD%E3%83%A5%E3%83%A1%E3%83%B3%E3%83%88/x.mjs', { windows: true }),
    'C:\\Users\\user\\OneDrive\\ドキュメント\\x.mjs');
  assert.strictEqual(fileURLToPath('file://server/share/a%20b/x.mjs', { windows: true }), '\\\\server\\share\\a b\\x.mjs');
});

test('local-run works from a non-ASCII/space/% dir, propagates child exit code', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lc110-'));
  const dir = path.join(base, 'ドキュメント 100%', 'tools', 'mission108');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['local-run.mjs', 'lib.mjs']) fs.copyFileSync(path.join(repo, 'tools/mission108', f), path.join(dir, f));
  const serve = path.join(dir, '..', 'mission40f-serve-local.cjs');
  fs.writeFileSync(serve, 'process.exit(7)');
  const root = path.join(base, 'r');
  const script = path.join(dir, 'local-run.mjs');
  const r = run([script, '--dry-run', '--reuse', '--root', root]);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /tileset\.json is missing/);
  for (const w of ['nishi', 'fukushima', 'yodogawa']) {
    fs.mkdirSync(path.join(root, w + '25'), { recursive: true });
    fs.writeFileSync(path.join(root, w + '25', 'tileset.json'), '{}');
  }
  const before = fs.readdirSync(root);
  const r2 = run([script, '--dry-run', '--reuse', '--root', root]);
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(JSON.parse(r2.stdout).serve, serve);
  assert.deepStrictEqual(fs.readdirSync(root), before);
  assert.strictEqual(run([script, '--reuse', '--root', root]).status, 7);
  fs.rmSync(base, { recursive: true, force: true });
});

test('--reuse names missing wards and never deletes existing data', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lc110b-'));
  const keep = path.join(base, 'nishi25');
  fs.mkdirSync(keep);
  fs.writeFileSync(path.join(keep, 'keep.txt'), 'x');
  const r = run([path.join(repo, 'tools/mission108/local-run.mjs'), '--reuse', '--root', base]);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /nishi25, fukushima25, yodogawa25/);
  assert.ok(fs.existsSync(path.join(keep, 'keep.txt')));
  fs.rmSync(base, { recursive: true, force: true });
});
