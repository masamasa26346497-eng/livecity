'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../tools/mission130/accept-lib.cjs');
const runner = fs.readFileSync(path.join(__dirname, '../tools/mission130/accept21.mjs'), 'utf8');

test('Mission 140: click failure carries a reason; runner tries several candidates with a wide scan', () => {
  const base = { source: { found: true }, http: { tileset200: 1, glb200: 3, notFound: 0 }, tilesets: 1, state: 'ready', pixels: { pct: 4 }, dupIds: 0 };
  const v = L.verdict({ ...base, click: { target: 'a', selected: null, reason: 'no-screen-point-picks-target', idInSidecar: true, insideWardPolygon: true } });
  assert.ok(!v.accepted);
  assert.strictEqual(v.why[0], 'click-id-mismatch(no-screen-point-picks-target)');
  assert.ok(/ranked\.slice\(0, 8\)/.test(runner));
  assert.ok(/candidatesTried/.test(runner));
  assert.ok(/selected-other-id/.test(runner));
});
test('Mission 140: a correct click is still accepted (acceptance not loosened)', () => {
  const ok = { source: { found: true }, http: { tileset200: 1, glb200: 3, notFound: 0 }, tilesets: 1, state: 'ready', pixels: { pct: 4 }, dupIds: 0,
    click: { target: 'a', selected: 'a', idInSidecar: true, insideWardPolygon: true } };
  assert.deepStrictEqual(L.verdict(ok), { accepted: true, why: [] });
  assert.ok(!L.verdict({ ...ok, click: { ...ok.click, selected: 'b' } }).accepted);
});
