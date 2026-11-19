const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs');
const w = fs.readFileSync(__dirname + '/../tools/mission94/private-connect-check.workflow.yml', 'utf8');
test('workflow is dispatch-only, no checkout, read-only, guarded', () => {
  assert.match(w, /on:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(w, /pull_request|issue_comment|issues:|actions\/checkout/);
  assert.match(w, /contents: none/);
  assert.match(w, /github\.actor == github\.repository_owner/);
  assert.match(w, /default_branch/);
  assert.match(w, /add-mask/);
  assert.doesNotMatch(w, /-X (POST|PUT|PATCH|DELETE)|release upload|--data| -d /);
  assert.match(w, /"\$vis" != "private"/);
});
test('token only in the single step env; never echoed', () => {
  assert.equal((w.match(/secrets\.LIVECITY_3D_DATA_TOKEN/g) || []).length, 1);
  assert.doesNotMatch(w, /echo[^\n]*\$DATA_TOKEN(?!")/);
  assert.doesNotMatch(w, /echo "[^"]*\$DATA_TOKEN[^"]*"(?<!add-mask::\$DATA_TOKEN")/);
});
test('claude.yml does not pass the data token', () => {
  assert.doesNotMatch(fs.readFileSync(__dirname + '/../.github/workflows/claude.yml', 'utf8'), /LIVECITY_3D_DATA_TOKEN/);
});
