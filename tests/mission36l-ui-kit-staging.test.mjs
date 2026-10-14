import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const ui = fs.readFileSync(new URL('../public/livecity-places-ui-kit.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../public/livecity-building-photo-bridge.js', import.meta.url), 'utf8');
const preview = fs.readFileSync(new URL('../tools/preview.js', import.meta.url), 'utf8');
test('UI Kit is staged without any billable Google request', () => {
  assert.match(ui, /const ENABLED = false/);
  assert.doesNotMatch(ui, /\b(?:fetch|importLibrary)\s*\(/);
  assert.match(ui, /throw new Error\('UI Kit activation requires/);
});
test('only verified exact building Place IDs are passed to UI Kit', () => {
  assert.match(bridge, /placeMatchConfidence !== 'VERIFIED'/);
  assert.match(bridge, /livecity:verified-google-place/);
  assert.match(bridge, /PAID_GOOGLE_PHOTOS_ENABLED = false/);
});
test('UI Kit is injected in dev preview only', () => {
  assert.match(preview, /scripts\.push\('\/livecity-places-ui-kit\.js'/);
  assert.match(preview, /path\.basename\(abs\) !== DEV_UI_HTML/);
});
