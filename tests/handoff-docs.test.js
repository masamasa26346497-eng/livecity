import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../tools/validate/handoff-docs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('handoff docs pass validation', () => {
  assert.deepEqual(validate(root), []);
});
test('validation fails on a directory without docs', () => {
  assert.ok(validate(path.join(root, 'tests')).length > 0);
});
