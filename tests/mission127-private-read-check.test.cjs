const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const y = fs.readFileSync(__dirname + '/../tools/mission127/private-read-check.workflow.yml.template', 'utf8');

test('workflow template is read-only and does not leak', () => {
  assert.match(y, /workflow_dispatch:/);
  assert.doesNotMatch(y, /pull_request|issue_comment|issues:/);
  assert.match(y, /permissions:\s*\n\s*contents: none/);
  assert.doesNotMatch(y, /actions\/checkout/);
  assert.doesNotMatch(y, /-X (POST|PUT|PATCH|DELETE)|--data|--upload-file|-T /);
  assert.match(y, /add-mask::\$T/);
  assert.match(y, /default_branch/);
  assert.match(y, /repository_owner/);
  assert.ok(/LIVECITY_3D_DATA_READ_TOKEN/.test(y) && /LIVECITY_3D_DATA_TOKEN/.test(y));
});

test('no secret-like literal values', () => {
  assert.doesNotMatch(y, /gh[pous]_[A-Za-z0-9]{20,}|github_pat_/);
});
