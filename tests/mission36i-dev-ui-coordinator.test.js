import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const coordinator = read('../public/livecity-dev-ui-coordinator.js');
const preview = read('../tools/preview.js');
const prod = read('../public/osaka_3d_buildings.html');
const protectedHtml = read('../public/osaka_3d_buildings.fullward-v3.html');

test('Mission 36I dev UI coordinator is syntactically valid and dev-preview only', () => {
  assert.doesNotThrow(() => new Function(coordinator));
  assert.match(preview, /osaka_3d_buildings\.ward-ux-v1\.html/);
  assert.match(preview, /livecity-dev-ui-coordinator\.js/);
  assert.match(preview, /path\.basename\(abs\) !== DEV_UI_HTML/);
  assert.doesNotMatch(prod, /livecity-dev-ui-coordinator\.js/);
  assert.doesNotMatch(protectedHtml, /livecity-dev-ui-coordinator\.js/);
});

test('Mission 36I keeps facility/building cards mutually exclusive and prioritizes a photo', () => {
  assert.match(coordinator, /FACILITY_CARD_ID = 'facility-card'/);
  assert.match(coordinator, /BUILDING_CARD_ID = 'prop-card'/);
  assert.match(coordinator, /function cardHasPhoto/);
  assert.match(coordinator, /buildingHasPhoto && !facilityHasPhoto/);
  assert.match(coordinator, /hideCard\(facility\)/);
  assert.match(coordinator, /hideCard\(building\)/);
  assert.match(coordinator, /MutationObserver/);
  assert.match(coordinator, /HTMLImageElement/);
});

test('Mission 36I tuning panel can be collapsed and remembers the choice', () => {
  assert.match(coordinator, /TUNING_PANEL_ID = 'canonical-runtime-status'/);
  assert.match(coordinator, /livecity\.dev\.tuning-collapsed\.v1/);
  assert.match(coordinator, /調整を表示/);
  assert.match(coordinator, /調整を隠す/);
  assert.match(coordinator, /localStorage\.getItem/);
  assert.match(coordinator, /localStorage\.setItem/);
  assert.match(coordinator, /aria-expanded/);
});
