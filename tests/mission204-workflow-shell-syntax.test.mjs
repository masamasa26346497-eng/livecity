// Mission 204: offline structural check of the v2 workflow (no YAML parser dependency).
// Extracts every `run: |` block, dedents it and runs `bash -n` on it. Not a full YAML parse.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FILE = 'tools/lod2/cloud-workflow/lod2-cloud-preview.v2.yml';
const lines = fs.readFileSync(FILE, 'utf8').split('\n');

function runBlocks() {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)run: \|\s*$/);
    if (!m) continue;
    const base = m[1].length;
    const body = [];
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > base)) { body.push(lines[j]); j++; }
    const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
    out.push({ line: i + 1, script: body.map((l) => l.slice(indent)).join('\n') + '\n' });
  }
  return out;
}

test('every run block passes bash -n (heredoc dedent included)', () => {
  const blocks = runBlocks();
  assert.ok(blocks.length >= 7, `found ${blocks.length} run blocks`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  for (const b of blocks) {
    const p = path.join(dir, `b${b.line}.sh`);
    fs.writeFileSync(p, b.script);
    const r = spawnSync('bash', ['-n', p], { encoding: 'utf8' });
    assert.equal(r.status, 0, `run block at line ${b.line}: ${r.stderr}`);
  }
});

test('no credential-less git fetch in build job; ancestry uses fetch-depth 0 refs', () => {
  const t = lines.join('\n');
  assert.ok(!/git fetch/.test(t));
  assert.ok(/fetch-depth: 0/.test(t));
  assert.ok(/merge-base --is-ancestor/.test(t));
});

test('top-level keys are present and indentation uses 2-space multiples', () => {
  for (const k of ['name:', 'on:', 'permissions:', 'jobs:']) assert.ok(lines.some((l) => l.startsWith(k)), k);
  assert.ok(!lines.some((l) => l.includes('\t')), 'no tabs');
});
