import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const y = fs.readFileSync('tools/lod2/cloud-workflow/mission217-qa-once.yml', 'utf8');
test('mission217 template: single ci branch, SHA pinned, no deploy/artifact', () => {
  const sha = /TOOLS_SHA: ([0-9a-f]{40})\b/.exec(y)?.[1]; assert.ok(sha);
  assert.match(y, new RegExp('ref: ' + sha));
  assert.match(y, /branches: \[ci\/mission217-qa-once\]/);
  assert.doesNotMatch(y, /upload-artifact|actions\/cache|vercel|pull_request|workflow_dispatch/i);
});
