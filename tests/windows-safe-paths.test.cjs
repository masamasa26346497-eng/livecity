'use strict';
// Windows checkout safety: every git-tracked path must be valid on Windows (NTFS).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
  .toString('utf8').split('\0').filter(Boolean);
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function problems(p) {
  const out = [];
  if (/[<>:"|?*\u0000-\u001f]/.test(p)) out.push('forbidden char');
  for (const seg of p.split('/')) {
    if (/[. ]$/.test(seg)) out.push('trailing dot/space: ' + seg);
    if (RESERVED.test(seg.split('.')[0])) out.push('reserved name: ' + seg);
  }
  return out;
}

test('no tracked path is invalid on Windows', () => {
  const bad = files.map((f) => [f, problems(f)]).filter(([, p]) => p.length);
  assert.deepStrictEqual(bad, []);
});

test('no case-insensitive path collisions', () => {
  const seen = new Map();
  const dup = [];
  for (const f of files) {
    const k = f.toLowerCase();
    if (seen.has(k)) dup.push([seen.get(k), f]); else seen.set(k, f);
  }
  assert.deepStrictEqual(dup, []);
});

test('mission64 renamed images exist and references are consistent', () => {
  for (const j of ['data/reports/mission64/ab.json', 'data/reports/mission64/nobg/ab.json']) {
    const s = fs.readFileSync(path.join(root, j), 'utf8');
    assert.ok(!s.includes('roof(>='), j);
  }
  assert.strictEqual(files.filter((f) => f.endsWith('roof(ge12m).png')).length, 8);
});
