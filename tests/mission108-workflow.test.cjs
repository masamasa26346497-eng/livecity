'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const Y = fs.readFileSync(path.join(ROOT, 'tools/mission108/qa-private-2025.workflow.yml'), 'utf8');
const PIN = (Y.match(/PIN_SHA: "([0-9a-f]{40})"/) || [])[1];

test('pin is a real ancestor commit and every listed sha256 equals the git object at the pin', () => {
  assert.ok(PIN);
  execFileSync('git', ['merge-base', '--is-ancestor', PIN, 'HEAD'], { cwd: ROOT });
  const lines = [...Y.matchAll(/^ {10}([0-9a-f]{64}) {2}(\S+)$/gm)];
  assert.ok(lines.length >= 7);
  for (const [, h, f] of lines) {
    const b = execFileSync('git', ['show', PIN + ':' + f], { cwd: ROOT, maxBuffer: 1 << 28 });
    assert.strictEqual(crypto.createHash('sha256').update(b).digest('hex'), h, f);
  }
  assert.strictEqual((Y.match(/ref: "([0-9a-f]{40})"/) || [])[1], PIN);
});

test('owner / default-branch gate, read-only permissions, dispatch only', () => {
  assert.match(Y, /github\.actor == github\.repository_owner && github\.triggering_actor == github\.repository_owner && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(Y, /^permissions:\n {2}contents: read$/m);
  assert.match(Y, /^on:\n {2}workflow_dispatch:/m);
  assert.ok(!/pull_request|push:|schedule:|pull_request_target/.test(Y));
});

test('secret used in exactly one step, never echoed; QA step has no token; ward allow-list', () => {
  assert.strictEqual((Y.match(/secrets\.LIVECITY_3D_DATA_TOKEN/g) || []).length, 1);
  assert.match(Y, /::add-mask::/);
  assert.ok(!/echo[^\n]*\$LIVECITY_3D_DATA_TOKEN(?!\" *\|)/.test(Y.replace(/::add-mask::\$LIVECITY_3D_DATA_TOKEN/, '')));
  assert.match(Y, /nishi\|fukushima\|yodogawa\) ;;/);
  const qaStep = Y.split('- name: Headless Chrome QA')[1].split('- name: Counts-only')[0];
  assert.ok(!/TOKEN/.test(qaStep));
});

test('only counts-only JSON is uploaded; always-cleanup; no publish / release / push', () => {
  assert.match(Y, /path: \$\{\{ runner\.temp \}\}\/m108-out\/\*\.json/);
  assert.match(Y, /Wipe runner temp data[\s\S]*if: always\(\)|if: always\(\)\n {8}run: rm -rf/);
  assert.ok(!/gh release|git push|actions\/deploy|deploy-pages/.test(Y));
  const up = Y.split('uses: actions/upload-artifact@v4')[1].split('- name:')[0];
  assert.ok(!/m108-root/.test(up));
  assert.ok(!/continue-on-error: true/.test(Y));
});

test('new tool files are untouched since the pin (workflow hashes stay valid) and forbidden paths unchanged', () => {
  const diff = execFileSync('git', ['diff', '--name-only', PIN, 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of ['tools/mission108/lib.mjs', 'tools/mission108/fetch-verify.mjs', 'tools/mission108/qa.mjs']) assert.ok(!diff.includes(f), f);
  for (const f of diff) assert.ok(!/^(public\/osaka_3d_buildings|\.github\/workflows\/)/.test(f), 'forbidden: ' + f);
});
