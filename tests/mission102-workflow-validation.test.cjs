'use strict';
// Mission 102: free static validation of the Mission101 pinned workflow. No YAML library is installed, so this
// checks the YAML subset structurally (not a full parser) plus security properties. The workflow is NOT executed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const cp = require('node:child_process');

const FILE = 'tools/mission101/persist-wards.pinned.workflow.yml';
const wf = () => fs.readFileSync(FILE, 'utf8');

test('rendered file has no placeholders after render', () => {
  cp.execFileSync(process.execPath, ['tools/mission101/render.mjs']);
  assert.ok(!/@@/.test(wf()));
});

test('YAML subset: spaces only, no tabs/CR, even indent outside block scalars', () => {
  const s = wf();
  assert.ok(!/\t/.test(s) && !/\r/.test(s));
  let block = -1;
  for (const [i, line] of s.split('\n').entries()) {
    if (!line.trim()) continue;
    const ind = line.match(/^ */)[0].length;
    if (block >= 0) { if (ind > block) continue; block = -1; }
    if (line.trim().startsWith('#')) continue;
    assert.strictEqual(ind % 2, 0, 'odd indent at line ' + (i + 1));
    if (/:\s*\|[-+]?\s*$/.test(line)) block = ind;
  }
});

test('top-level keys and trigger: only workflow_dispatch, read-only permissions', () => {
  const s = wf();
  const top = [...s.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
  assert.deepStrictEqual(top, ['name', 'on', 'permissions', 'env', 'jobs']);
  const on = s.split(/^on:\n/m)[1].split(/^permissions:/m)[0];
  assert.match(on, /^  workflow_dispatch:/m);
  assert.ok(!/^  (push|pull_request|pull_request_target|schedule|issue_comment|workflow_run):/m.test(on));
  assert.match(s, /^permissions:\n  contents: read\n/m);
  const jobs = [...s.split(/^jobs:\n/m)[1].matchAll(/^  ([a-z]+):\n/gm)].map((m) => m[1]);
  assert.deepStrictEqual(jobs, ['plan', 'persist']);
});

test('owner-only gate checks actor and triggering_actor, default branch only', () => {
  const s = wf();
  assert.match(s, /github\.actor == github\.repository_owner && github\.triggering_actor == github\.repository_owner/);
  assert.match(s, /github\.ref == format\(/);
  assert.match(s, /default_branch/);
  assert.match(s, /needs: plan/);
  assert.ok(!/always\(\)|!cancelled\(\)|failure\(\)/.test(s));
});

test('overwrite is not offered: stored wards are always skipped after sha256 re-check', () => {
  const s = wf();
  assert.ok(!/overwrite/i.test(s));
  assert.match(s, /if \[ -n "\$id" \]; then/);
  assert.deepStrictEqual([...s.matchAll(/^ {6}([a-z_]+):\n {8}description/gm)].map((m) => m[1]), ['wards']);
});

test('only known actions, pinned checkout, no persisted credentials', () => {
  const s = wf();
  const uses = [...s.matchAll(/uses: (\S+)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(uses, ['actions/checkout@v4', 'actions/setup-node@v4']);
  assert.match(s, /persist-credentials: false/);
  assert.match(s, /ref: "[0-9a-f]{40}"/);
});

test('fail-closed limits: bounded timeouts, ward cap 6, one ward per runner', () => {
  const s = wf();
  assert.match(s, /timeout-minutes: 45/);
  assert.match(s, /timeout-minutes: 90/);
  assert.match(s, /--max-wards 1 --ward-timeout-min 60/);
  assert.match(s, /MAX_WARDS: "6"/);
  assert.ok(6 * 90 + 45 <= 600);
});

test('no secrets at workflow env level; inputs only reach scripts via env', () => {
  const s = wf();
  const envBlock = s.split(/^env:\n/m)[1].split(/^jobs:/m)[0];
  assert.ok(!/secrets\./.test(envBlock));
  for (const m of s.matchAll(/^.*\$\{\{[^}]*inputs[^}]*\}\}.*$/gm)) assert.match(m[0], /^\s+IN_WARDS: /);
});

test('heredoc hash list: one terminator, exactly 13 closure hashes', () => {
  const s = wf();
  assert.strictEqual((s.match(/<<'HASHES'/g) || []).length, 1);
  assert.strictEqual((s.match(/^ +HASHES$/gm) || []).length, 1);
  assert.strictEqual((s.match(/^ +[0-9a-f]{64} {2}\S+$/gm) || []).length, 13);
});
