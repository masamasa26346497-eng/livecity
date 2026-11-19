'use strict';
// Mission 101: static checks of the multi-ward pinned persist workflow. The workflow is NOT executed here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const cp = require('node:child_process');

const wf = () => fs.readFileSync('tools/mission101/persist-wards.pinned.workflow.yml', 'utf8');

test('render is reproducible and hashes match the current closure', () => {
  const before = wf();
  cp.execFileSync(process.execPath, ['tools/mission101/render.mjs']);
  assert.strictEqual(wf(), before, 'rendered file is stale: run node tools/mission101/render.mjs');
  const lines = before.split('\n').filter((l) => /^ +[0-9a-f]{64}  /.test(l));
  assert.ok(lines.length >= 13);
});

test('pin is a full SHA, no branch tip, and equals the Mission100 pin', () => {
  const s = wf();
  const pins = [...s.matchAll(/ref: "([0-9a-f]{40})"/g)].map((m) => m[1]);
  assert.strictEqual(pins.length, 1);
  assert.strictEqual(pins[0], 'c4b79150067bba5acd37fbbf05c1e5af8b0af5b0');
  assert.match(s, /PIN_SHA: "c4b79150067bba5acd37fbbf05c1e5af8b0af5b0"/);
  assert.ok(!/@@/.test(s));
});

test('batch is bounded, per-ward isolated, owner only, no concurrency', () => {
  const s = wf();
  assert.match(s, /MAX_WARDS: "6"/);
  assert.match(s, /fail-fast: false/);
  assert.match(s, /max-parallel: 1/);
  assert.match(s, /github\.actor == github\.repository_owner/);
  assert.match(s, /default_branch/);
  assert.match(s, /fromJSON\(needs\.plan\.outputs\.matrix\)/);
});

test('24 official wards, expo excluded, source lock + private + no public', () => {
  const s = wf();
  const all = s.match(/ALL="([^"]+)"/)[1].split(' ');
  assert.strictEqual(all.length, 24);
  assert.strictEqual(new Set(all).size, 24);
  const polys = JSON.parse(fs.readFileSync('data/processed/osaka-city/boundaries/ward-classification-polygons.json', 'utf8'));
  assert.deepStrictEqual([...all].sort(), polys.wards.map((w) => w.wardId).sort());
  assert.match(s, /27999/);
  assert.match(s, /plateau-27100-osaka-shi-2025/);
  assert.match(s, /need private \+ push/);
  assert.ok(!/--allow-public/.test(s));
  assert.ok(!/inputs\.wards[^\n]*run:/.test(s));
});

test('inputs are passed via env only (no expression injection into scripts)', () => {
  const s = wf();
  // the only ${{ inputs.* }} uses are env: assignments
  for (const m of s.matchAll(/^.*\$\{\{ inputs\.[^}]+\}\}.*$/gm)) assert.match(m[0], /^\s+(IN_WARDS|IN_OVERWRITE): /);
});

test('token confined to plan, connect check and persist step; convert/strict have none', () => {
  const s = wf();
  const uses = [...s.matchAll(/secrets\.LIVECITY_3D_DATA_TOKEN/g)].length;
  assert.strictEqual(uses, 3);
  const conv = s.split('- name: Convert ward')[1].split('- name: Strict')[0];
  assert.ok(!/secrets\./.test(conv));
  assert.ok(!/GITHUB_TOKEN/.test(s));
});

test('stored wards are re-downloaded and sha256-checked; nishi pinned to recorded sha', () => {
  const s = wf();
  assert.match(s, /EXPECTED_SHA_NISHI: "0232c89f0a5beeb2a03333b6ac8d0ca6366004ac85a0f3b221170dbc91a078c4"/);
  assert.match(s, /sha256sum "chk-/);
  assert.match(s, /!= recorded/);
  assert.match(s, /browserAccepted: 0/);
});

test('no destructive commands on stored data', () => {
  const s = wf();
  assert.ok(!/gh release delete|--clobber|rm -rf|git push/.test(s));
});

test('closure code is unchanged vs pin (workflow-only change)', () => {
  const lines = wf().split('\n').filter((l) => /^ +[0-9a-f]{64}  /.test(l)).map((l) => l.trim().split(/\s+/));
  const crypto = require('node:crypto');
  for (const [h, f] of lines) assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), h, f);
});
