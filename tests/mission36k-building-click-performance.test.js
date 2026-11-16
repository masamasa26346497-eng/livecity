import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const clickGatePath = new URL('../public/livecity-building-click-performance.js', import.meta.url);
const reliabilityPath = new URL('../public/livecity-building-pick-reliability.js', import.meta.url);
const renderPerfPath = new URL('../public/livecity-render-performance.js', import.meta.url);
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

test('Mission 36L building pick reliability refreshes canonical cache before canvas click', async () => {
  const source = await readFile(reliabilityPath, 'utf8');
  assert.match(source, /invalidatePickCache/);
  assert.match(source, /document\.addEventListener\('click', onClickCapture, true\)/);
  assert.match(source, /event\.target !== canvas/);
  assert.match(source, /MAX_CLICK_HOLD_MS = 1600/);
  assert.match(source, /WHEEL_BLOCK_MS = 120/);
  assert.match(source, /lastGesture\?\.isClick/);
  assert.match(source, /__MISSION36L_BUILDING_PICK_RELIABILITY__/);
});

test('Mission 36L building pick reliability loads after the existing click performance gate', async () => {
  const source = await readFile(previewPath, 'utf8');
  const clickGate = source.indexOf('/livecity-building-click-performance.js');
  const reliability = source.indexOf('/livecity-building-pick-reliability.js');
  assert.ok(clickGate >= 0, 'existing click performance gate must be injected');
  assert.ok(reliability > clickGate, 'pick reliability guard must load after click performance gate');
});

test('Mission 36L runtime guard throttles continuous work but keeps exact clicks unthrottled', async () => {
  const source = await readFile(renderPerfPath, 'utf8');
  assert.match(source, /MAX_PIXEL_RATIO = 1\.0/);
  assert.match(source, /MIN_RENDER_FRAME_MS = 33/);
  assert.match(source, /LAYER_UPDATE_INTERVAL_MS = 125/);
  assert.match(source, /HOVER_PICK_INTERVAL_MS = 100/);
  assert.match(source, /TILE_UPDATE_INTERVAL_MS = 150/);
  assert.match(source, /MID_RING_TILES = 3/);
  assert.match(source, /PREFETCH_RING_TILES = 0/);
  assert.match(source, /MAX_HIDDEN_TILE_CACHE = 96/);
  assert.match(source, /SHADOW_UPDATE_EVERY_FRAMES = 8/);
  assert.match(source, /event\.type !== 'mousemove'\) return original\(event\)/);
  assert.match(source, /BUILDING_TILE_CONFIG\.midRing = Math\.min/);
  assert.match(source, /BUILDING_TILE_CONFIG\.enableTileCulling = true/);
  assert.match(source, /BUILDING_TILE_CONFIG\.enableFrustumCulling = true/);
  assert.match(source, /__mission36lRenderBudgetPatched/);
  assert.match(source, /__MISSION36L_RENDER_PERF__/);
});

test('Mission 36L runtime guard is injected before click reliability logic', async () => {
  const source = await readFile(previewPath, 'utf8');
  const renderPerf = source.indexOf('/livecity-render-performance.js');
  const clickGate = source.indexOf('/livecity-building-click-performance.js');
  assert.ok(renderPerf >= 0, 'runtime performance guard must be injected');
  assert.ok(clickGate > renderPerf, 'runtime guard must load before click-specific patches');
});
