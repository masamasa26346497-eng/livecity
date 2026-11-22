import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const y = fs.readFileSync('tools/lod2/cloud-workflow/mission218-qa-once.yml', 'utf8');
test('mission218 template: single ci branch, SHA pinned, no deploy/artifact', () => {
  const sha = /TOOLS_SHA: ([0-9a-f]{40})\b/.exec(y)?.[1]; assert.ok(sha);
  assert.match(y, new RegExp('ref: ' + sha));
  assert.match(y, /branches: \[ci\/mission218-qa-once\]/);
  assert.doesNotMatch(y.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'), /upload-artifact|actions\/cache|vercel|pull_request|workflow_dispatch/i);
});
