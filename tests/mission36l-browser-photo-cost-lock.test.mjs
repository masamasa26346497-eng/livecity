import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'public/livecity-building-photo-bridge.js'), 'utf8');
test('paid browser photo API is hard-disabled until server-side per-run approval exists', () => {
  assert.match(source, /const PAID_GOOGLE_PHOTOS_ENABLED = false;/);
  assert.match(source, /if \(!PAID_GOOGLE_PHOTOS_ENABLED\) return;/);
});
test('unverified name-only fallback is not used by default', () => {
  assert.match(source, /\(await tryExactIndex\(\)\) \|\| new Map\(\)/);
});
