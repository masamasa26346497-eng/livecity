import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const clickGatePath = new URL('../public/livecity-building-click-performance.js', import.meta.url);
const previewPath = new URL('../tools/preview.js', import.meta.url);

test('Mission 36K facility pick gate preserves exact pick fallback and exposes diagnostics', async () => {
  const source = await readFile(clickGatePath, 'utf8');
  assert.match(source, /queryNearbySpatial/);
  assert.match(source, /const originalPickHit = layer\.pickHit\.bind\(layer\)/);
  assert.match(source, /if \(exactNeeded === false\)[\s\S]*return null/);
  assert.match(source, /return originalPickHit\(mouseX, mouseY, camera\)/);
  assert.match(source, /__MISSION36K_BUILDING_CLICK_PERF__/);
});

test('Mission 36K click gate is injected after the facility spatial coordinator', async () => {
  const source = await readFile(previewPath, 'utf8');
  const coordinator = source.indexOf('/livecity-dev-ui-coordinator.js');
  const clickGate = source.indexOf('/livecity-building-click-performance.js');
  assert.ok(coordinator >= 0, 'facility spatial coordinator must be injected');
  assert.ok(clickGate > coordinator, 'click gate must load after spatial coordinator');
});

test('Mission 36K does not replace the facility dataset with a reduced source', async () => {
  const source = await readFile(clickGatePath, 'utf8');
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /40,585[^\n]*(delete|remove|truncate)/i);
  assert.match(source, /Keep the full 40,585-facility source/);
});
