import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const y = fs.readFileSync(path.join(ROOT, 'tools/lod2/cloud-workflow/mission211-restore-once.yml'), 'utf8');
const code = y.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('push on exactly one branch; no other triggers', () => {
  assert.match(code, /^on:\n  push:\n    branches: \[ci\/mission211-restore-once\]\n/m);
  assert.doesNotMatch(code, /^\s{2}(pull_request|pull_request_target|workflow_run|schedule|workflow_dispatch):/m);
  assert.match(code, /if: github\.ref == 'refs\/heads\/ci\/mission211-restore-once'/);
});
test('tools pinned to a full SHA, checkout ref equals it, HEAD re-verified', () => {
  const sha = /TOOLS_SHA: ([0-9a-f]{40})\b/.exec(code)?.[1];
  assert.ok(sha);
  assert.match(code, new RegExp('ref: ' + sha));
  assert.match(code, /git rev-parse HEAD\)" = "\$TOOLS_SHA"/);
  assert.doesNotMatch(code, /ref: \$\{\{/);
  assert.match(code, /persist-credentials: false/);
});
test('read token only in the fetch step; GITHUB_TOKEN not used for the private repo', () => {
  assert.equal((code.match(/secrets\./g) || []).length, 1);
  assert.match(code, /READ_TOKEN: \$\{\{ secrets\.LIVECITY_3D_DATA_READ_TOKEN \}\}/);
  const fetchStep = code.slice(code.indexOf('- name: Fetch ward archives'), code.indexOf('- name: Assemble'));
  assert.match(fetchStep, /READ_TOKEN: /);
  const rest = code.replace(fetchStep, '');
  assert.doesNotMatch(rest, /READ_TOKEN|LIVECITY_3D_DATA/);
  assert.doesNotMatch(code, /GITHUB_TOKEN|github\.token|\bgh \b/);
  assert.match(code, /permissions:\n  contents: read/);
  assert.match(fetchStep, /::add-mask::/);
});
test('Mission210 guards kept: pipefail shell, tar audit before extraction, caps, full24 fail', () => {
  assert.match(code, /defaults:\n  run:\n    shell: bash/);
  const f = code.slice(code.indexOf('- name: Fetch ward archives'), code.indexOf('- name: Assemble'));
  assert.ok(f.indexOf('tar -tvzf') < f.indexOf('tar -xzf'));
  for (const m of [/symlink\/hardlink\/special/, /unsafe member names/, /control characters/, /tar bomb/, /--no-same-owner/, /--proto =https/, /--max-filesize/]) assert.match(f, m);
  assert.match(code, /--allow-missing kita,chuo/);
  assert.match(code, /r\.full24!==true/);
  assert.match(code, /lod2-cloud-verify\.cjs --bundle temp\/cloud-merged/);
});
test('nothing leaves the runner; no deploy; bounded time', () => {
  assert.doesNotMatch(code, /upload-artifact|actions\/cache|vercel|--prod|gh release|set -x|curl[^\n]*(-X|--data|-T )/i);
  assert.match(code, /timeout-minutes: 90/);
  assert.match(code, /GITHUB_STEP_SUMMARY/);
});
