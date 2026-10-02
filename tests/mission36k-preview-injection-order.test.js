import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preview = fs.readFileSync(path.join(ROOT, 'tools', 'preview.js'), 'utf8');

test('[36K CLICK] preview injects spatial coordinator before click gate', () => {
  const coordinator = preview.indexOf("'/livecity-dev-ui-coordinator.js'");
  const gate = preview.indexOf("'/livecity-building-click-performance.js'");
  assert.ok(coordinator >= 0, 'spatial coordinator injection is missing');
  assert.ok(gate > coordinator, 'click gate must be injected after spatial coordinator');
});
