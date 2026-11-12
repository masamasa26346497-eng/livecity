// Mission 201: static policy checks on the v2 workflow template (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const y = fs.readFileSync(new URL('../tools/lod2/cloud-workflow/lod2-cloud-preview.v2.yml', import.meta.url), 'utf8');
const lines = y.split('\n');
const deployIdx = lines.findIndex(l => /^  deploy:/.test(l));
const build = lines.slice(0, deployIdx).join('\n');
const deploy = lines.slice(deployIdx).join('\n');

test('only workflow_dispatch trigger', () => {
  assert.match(y, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(y, /^\s+(push|pull_request|pull_request_target|schedule):/m);
});
test('all uses: are pinned to 40-hex SHAs', () => {
  const uses = [...y.matchAll(/uses:\s*(\S+)/g)].map(m => m[1]);
  assert.ok(uses.length >= 5);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
});
test('source_sha validated and ancestry-checked', () => {
  assert.match(y, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(y, /merge-base --is-ancestor/);
  assert.match(y, /persist-credentials: false/);
});
test('build job references no secrets', () => {
  assert.doesNotMatch(build, /secrets\./);
});
test('deploy gated: main, CONFIRMED, environment', () => {
  assert.match(deploy, /github\.ref == 'refs\/heads\/main'/);
  assert.match(deploy, /rights_approved == 'CONFIRMED'/);
  assert.match(deploy, /environment: lod2-preview-approval/);
});
test('secrets only in the final deploy step env', () => {
  const secretLines = lines.map((l, i) => [l, i]).filter(([l]) => /secrets\./.test(l));
  assert.equal(secretLines.length, 3);
  const stepStart = lines.findIndex(l => /name: Deploy PREVIEW/.test(l));
  for (const [, i] of secretLines) assert.ok(i > stepStart);
  assert.doesNotMatch(y.split('\njobs:')[0], /secrets\./);
});
test('re-audit before deploy and no --prod / @latest', () => {
  assert.ok(deploy.indexOf('lod2-cloud-audit.mjs') < deploy.indexOf('Deploy PREVIEW'));
  assert.doesNotMatch(y, /--prod\b|--target=production|@latest/);
  assert.match(y, /--target=preview/);
});
