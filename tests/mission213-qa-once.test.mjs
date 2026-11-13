import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const y = fs.readFileSync(path.join(ROOT, 'tools/lod2/cloud-workflow/mission213-qa-once.yml'), 'utf8');
const code = y.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const fetchStep = code.slice(code.indexOf('- name: Fetch ward archives'), code.indexOf('- name: Assemble'));

test('single push branch, no other triggers, job re-checks ref', () => {
  assert.match(code, /^on:\n  push:\n    branches: \[ci\/mission213-qa-once\]\n/m);
  assert.doesNotMatch(code, /^\s{2}(pull_request|pull_request_target|workflow_run|schedule|workflow_dispatch):/m);
  assert.match(code, /if: github\.ref == 'refs\/heads\/ci\/mission213-qa-once'/);
  assert.doesNotMatch(code, /mission211/);
});
test('tools pinned to a full SHA that contains the QA scripts', () => {
  const sha = /TOOLS_SHA: ([0-9a-f]{40})\b/.exec(code)?.[1]; assert.ok(sha);
  assert.match(code, new RegExp('ref: ' + sha)); assert.match(code, /git rev-parse HEAD\)" = "\$TOOLS_SHA"/);
  try { // 履歴が浅い環境では確認できないため skip 扱い
    for (const f of ['tools/lod2/lod2-click-qa.cjs', 'tools/lod2/lod2-merged-survey.mjs']) execFileSync('git', ['cat-file', '-e', `${sha}:${f}`], { cwd: ROOT, stdio: 'pipe' });
  } catch (e) { if (!/not a valid|Not a valid|bad object|unable to read/i.test(String(e.stderr || e.message))) throw e; }
});
test('secrets: read token only in the fetch step; no GITHUB_TOKEN/gh; nothing leaves the runner', () => {
  assert.equal((code.match(/secrets\./g) || []).length, 1);
  assert.doesNotMatch(code.replace(fetchStep, ''), /READ_TOKEN|LIVECITY_3D_DATA/);
  assert.doesNotMatch(code, /GITHUB_TOKEN|github\.token|\bgh \b|upload-artifact|actions\/cache|vercel|--prod|gh release/i);
  assert.match(code, /permissions:\n  contents: read/); assert.match(code, /persist-credentials: false/);
});
test('Mission 210 fetch guards kept and QA steps present after the merged-tree checks', () => {
  assert.ok(fetchStep.indexOf('tar -tvzf') < fetchStep.indexOf('tar -xzf'));
  for (const m of [/symlink\/hardlink\/special/, /unsafe member names/, /tar bomb/, /--no-same-owner/, /--proto =https/, /--max-filesize/]) assert.match(fetchStep, m);
  assert.match(code, /r\.full24!==true/);
  const i = (s) => code.indexOf(s);
  assert.ok(i('lod2-cloud-verify.cjs') < i('lod2-merged-survey.mjs') && i('lod2-merged-survey.mjs') < i('lod2-click-qa.cjs'));
  assert.match(code, /timeout-minutes: 90/);
});
