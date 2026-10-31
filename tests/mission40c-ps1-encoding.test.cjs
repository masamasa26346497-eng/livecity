'use strict';
// Static checks for tools/mission40c-run-local.ps1 (PowerShell 5.1 itself is not run in CI).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buf = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission40c-run-local.ps1'));
const src = buf.toString('utf8');

test('ps1 is ASCII-only (PS 5.1 reads BOM-less files as ANSI)', () => {
  for (const b of buf) assert.ok(b < 128, 'non-ASCII byte found');
});

test('ps1 has balanced braces, parens and quotes per line', () => {
  const code = src.replace(/<#[\s\S]*?#>/, '');
  assert.strictEqual((code.match(/\{/g) || []).length, (code.match(/\}/g) || []).length);
  assert.strictEqual((code.match(/\(/g) || []).length, (code.match(/\)/g) || []).length);
  for (const line of code.split('\n')) {
    assert.strictEqual((line.match(/'/g) || []).length % 2, 0, 'odd single quotes: ' + line);
    assert.strictEqual((line.match(/"/g) || []).length % 2, 0, 'odd double quotes: ' + line);
  }
});

test('ps1 checks node exit codes and never deletes/copies source', () => {
  assert.ok(/\$LASTEXITCODE/.test(src));
  assert.ok(!/Remove-Item|Copy-Item|robocopy|Move-Item/i.test(src));
});
