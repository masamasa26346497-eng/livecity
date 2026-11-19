'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const Y = fs.readFileSync(path.join(ROOT, 'tools/mission109/qa-private-2025-24ward.workflow.yml'), 'utf8');
const pin = (Y.match(/PIN_SHA: "([0-9a-f]{40})"/) || [])[1];

test('pin is a real ancestor commit and every listed sha256 equals the git object at the pin', () => {
  assert.ok(pin);
  assert.strictEqual(spawnSync('git', ['merge-base', '--is-ancestor', pin, 'HEAD'], { cwd: ROOT }).status, 0);
  const rows = [...Y.matchAll(/^\s+([0-9a-f]{64})  (\S+)$/gm)];
  assert.ok(rows.length >= 9);
  for (const [, h, f] of rows) assert.strictEqual(crypto.createHash('sha256').update(execFileSync('git', ['show', pin + ':' + f], { cwd: ROOT, maxBuffer: 1 << 28 })).digest('hex'), h, f);
  assert.strictEqual((Y.match(/ref: "([0-9a-f]{40})"/) || [])[1], pin);
});

test('workflow gates: owner-only, default branch, read-only, fail-fast false, counts-only artifact, token only in fetch step', () => {
  assert.match(Y, /github\.actor == github\.repository_owner && github\.triggering_actor == github\.repository_owner/);
  assert.match(Y, /permissions:\n  contents: read/);
  assert.match(Y, /fail-fast: false/);
  assert.match(Y, /m109-out\/\*\.json/);
  assert.strictEqual((Y.match(/secrets\.LIVECITY_3D_DATA_TOKEN/g) || []).length, 1);
  assert.ok(!/pull_request|push:|schedule:/.test(Y));
  assert.match(Y, /27999|whitelist/);
});

test('plan step: ALL -> 6 batches of 4; subset ordered; expo/unknown/duplicate/bad batch refused', () => {
  const body = Y.split('run: |\n          set -eu\n          ALL=')[1];
  assert.ok(body);
  const script = 'set -eu\nALL=' + body.split('\n  qa:')[0].replace(/^ {10}/gm, '');
  const run = (wards, batch) => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm109w-')), 'o');
    fs.writeFileSync(out, '');
    const r = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH, IN_WARDS: wards, IN_BATCH: batch, GITHUB_OUTPUT: out }, encoding: 'utf8' });
    return { status: r.status, out: fs.readFileSync(out, 'utf8').trim() };
  };
  const all = run('ALL', '4');
  assert.strictEqual(all.status, 0);
  const b = JSON.parse(all.out.replace('batches=', ''));
  assert.strictEqual(b.length, 6); assert.strictEqual(b.join(',').split(',').length, 24);
  assert.deepStrictEqual(JSON.parse(run('yodogawa,nishi', '4').out.replace('batches=', '')), ['nishi,yodogawa']);
  for (const [w, n] of [['27999', '4'], ['nishi,nishi', '4'], ['sumiyoshii', '4'], ['ALL', '9'], ['', '4']]) assert.notStrictEqual(run(w, n).status, 0, w + '/' + n);
});
