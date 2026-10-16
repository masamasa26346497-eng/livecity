import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('public/mission37-livecity-hybrid-3d-poc.html', 'utf8');

test('[Mission37] POC is isolated from production HTML', () => {
  assert.ok(html.includes('Hybrid 3D Engine POC'));
  assert.ok(html.includes('tile.googleapis.com/v1/3dtiles/root.json'));
  assert.ok(html.includes('showCreditsOnScreen: true'));
  assert.ok(html.includes('__MISSION37_HYBRID_3D_POC__'));
});

test('[Mission37] API key is not hard-coded', () => {
  assert.ok(html.includes('googleMapTilesApiKey'));
  assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(html));
});

test('[Mission37] initial camera targets Umeda', () => {
  assert.ok(html.includes('135.49595'));
  assert.ok(html.includes('34.70385'));
});
