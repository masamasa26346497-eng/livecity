const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const crypto = require('crypto');
const r = (p) => fs.readFileSync(__dirname + '/../' + p, 'utf8');
const w = r('tools/mission96/persist-ward.pinned.workflow.yml');
const PIN = 'c4b79150067bba5acd37fbbf05c1e5af8b0af5b0';
test('pinned: full-SHA checkout, no branch refs, no token-bearing event triggers', () => {
  assert.match(w, new RegExp('ref: "' + PIN + '"'));
  assert.match(w, /on:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(w, /pull_request|issue_comment|issues:|pull_request_target/);
  assert.match(w, /github\.actor == github\.repository_owner/); assert.match(w, /default_branch/);
  assert.doesNotMatch(w, /ref: *(main|claude\/|\$\{\{)/);
});
test('pinned: token appears only in connect + persist steps; convert/verify steps have none', () => {
  assert.equal((w.match(/secrets\.LIVECITY_3D_DATA_TOKEN/g) || []).length, 2);
  for (const name of ['Convert ward', 'Strict output check', 'Re-verify code hashes', 'Verify pinned SHA', 'Preflight']) {
    const seg = w.split('- name: ' + name)[1].split('\n      - ')[0];
    assert.doesNotMatch(seg, /TOKEN/, name);
  }
  assert.doesNotMatch(w, /allow-public/); assert.match(w, /--repo "\$DATA_REPO"/);
});
test('pinned: initial scope is nishi only, fixed private data repo', () => {
  assert.match(w, /options:\s*\n\s*- nishi\s*\n/); assert.match(w, /DATA_REPO: masamasa26346497-eng\/livecity-3d-data/);
});
test('pinned: embedded sha256 list equals the working tree and covers the full closure (no missing)', async () => {
  const { hashLines, PIN_SHA } = await import('../tools/mission96/pin-audit.mjs');
  assert.equal(PIN_SHA, PIN);
  const h = hashLines(); assert.deepEqual(h.missing, []);
  for (const l of h.lines) assert.ok(w.includes('          ' + l), 'hash line missing/changed: ' + l);
  for (const f of ['tools/mission80-batch.mjs', 'tools/mission87-persist.mjs', 'tools/mission95-persist-ward.mjs', 'tools/mission95-check-output.mjs', 'tools/mission79-run.mjs']) assert.ok(h.lines.some((x) => x.endsWith('  ' + f)), f);
});
test('pinned: closure code has no outbound hosts beyond PLATEAU sources and no token echo', () => {
  const s = r('tools/mission87-persist.mjs') + r('tools/mission95-persist-ward.mjs');
  assert.doesNotMatch(s, /curl|wget|fetch\(/); assert.match(s, /private is mandatory/);
});
test('claude.yml never sees the data token', () => { assert.doesNotMatch(r('.github/workflows/claude.yml'), /LIVECITY_3D_DATA_TOKEN/); });
