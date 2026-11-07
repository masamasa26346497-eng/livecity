const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs');
const r = (p) => fs.readFileSync(__dirname + '/../' + p, 'utf8');
const w = r('tools/mission95/persist-ward.workflow.yml');
test('workflow: dispatch-only, owner + default-branch guard, no PR triggers', () => {
  assert.match(w, /on:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(w, /pull_request|issue_comment|issues:|pull_request_target/);
  assert.match(w, /github\.actor == github\.repository_owner/); assert.match(w, /default_branch/);
});
test('workflow: token only in connect and persist steps, never in convert', () => {
  assert.equal((w.match(/secrets\.LIVECITY_3D_DATA_TOKEN/g) || []).length, 2);
  const conv = w.split('- name: Convert ward')[1].split('- name:')[0];
  assert.doesNotMatch(conv, /TOKEN/);
  assert.doesNotMatch(r('.github/workflows/claude.yml'), /LIVECITY_3D_DATA_TOKEN/);
});
test('workflow: private repo mandatory, no public flag', () => {
  assert.doesNotMatch(w, /allow-public/); assert.match(w, /--repo "\$DATA_REPO"/); assert.match(w, /"\$vis" = "private"/);
});
test('mission87 resume requires sha256, not size', () => {
  const s = r('tools/mission87-persist.mjs');
  assert.doesNotMatch(s, /a\.size === e\.archiveBytes/); assert.match(s, /sha256File\(path\.join\(rd, e\.asset\)\) === e\.sha256/);
});
test('mission95 script refuses public and requires --repo', () => {
  const s = r('tools/mission95-persist-ward.mjs');
  assert.match(s, /--allow-public is not accepted/); assert.match(s, /--repo owner\/name is mandatory/);
});
test('strict output check rejects expo, wrong vintage, dup ids', async () => {
  const { strictOk } = await import('../tools/mission95-check-output.mjs');
  const ok = { status: 'ok', vintage: 2025, wardCode: '27106', idsUnique: true, skipped: 0, buildings: 5 };
  assert.equal(strictOk(ok), true);
  assert.equal(strictOk({ ...ok, wardCode: '27999' }), false);
  assert.equal(strictOk({ ...ok, vintage: 2022 }), false);
  assert.equal(strictOk({ ...ok, idsUnique: false }), false);
  assert.equal(strictOk({ ...ok, skipped: 1 }), false);
  assert.equal(strictOk(null), false);
});
