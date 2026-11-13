import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const y = fs.readFileSync(path.join(ROOT, 'tools/lod2/cloud-workflow/lod2-cloud-preview.yml'), 'utf8');
const code = y.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('manual workflow_dispatch only', () => {
  assert.match(code, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(code, /^\s{2}(push|pull_request|pull_request_target|schedule|workflow_run):/m);
});
test('no production deploy, no --token arg, no echo of secrets', () => {
  assert.doesNotMatch(code, /--prod/);
  assert.doesNotMatch(code, /--token/);
  assert.doesNotMatch(code, /echo[^\n]*\$\{?VERCEL_[A-Z_]+\}?[^\n]*/);
  assert.doesNotMatch(code, /set -x/);
});
test('deploy is a separate gated job; build job has no secrets', () => {
  const i = code.indexOf('\n  deploy:');
  const dep = code.slice(i), build = code.slice(code.indexOf('\n  build:'), i);
  assert.match(dep, /needs: build/);
  assert.match(dep, /inputs\.deploy == true/);
  assert.match(dep, /rights_approved == 'CONFIRMED'/);
  assert.match(dep, /environment: lod2-preview-approval/);
  assert.doesNotMatch(build, /secrets\./);
});
test('least privilege and short artifact retention', () => {
  assert.match(code, /permissions:\n  contents: read/);
  assert.doesNotMatch(code, /contents: write|id-token: write/);
  assert.match(code, /retention-days: 3/);
});
test('template is not auto-installed under .github/workflows', () => {
  assert.equal(fs.existsSync(path.join(ROOT, '.github/workflows/lod2-cloud-preview.yml')), false);
});

const audit = (dir, max = '1000000') => spawnSync(process.execPath, [path.join(ROOT, 'tools/lod2/lod2-cloud-audit.mjs'), dir, max], { encoding: 'utf8' });
const mk = (manifest, extra = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc199-'));
  fs.writeFileSync(path.join(d, 'BUNDLE_MANIFEST.json'), JSON.stringify(manifest));
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(d, k), v);
  return d;
};
test('audit passes with confirmedByHuman=false', () => {
  assert.equal(audit(mk({ rights: { status: 'attribution-required', confirmedByHuman: false } })).status, 0);
});
test('audit fails if confirmedByHuman is true, secret-like, or too big', () => {
  assert.equal(audit(mk({ rights: { confirmedByHuman: true } })).status, 1);
  assert.equal(audit(mk({ rights: { confirmedByHuman: false } }, { 'x.js': 'const t="ghp_' + 'a'.repeat(30) + '"' })).status, 1);
  assert.equal(audit(mk({ rights: { confirmedByHuman: false } }), '10').status, 1);
});
