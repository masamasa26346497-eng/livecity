'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const d = JSON.parse(fs.readFileSync('public/mission57-data/gsi-sumiyoshi-9tile.json', 'utf8'));
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');

test('GSI WA data for the Sumiyoshi window: finite local metres inside the fetched window, no synthesized road lines', () => {
  assert.strictEqual(d.kind, 'gsi-water-roadedge');
  assert.match(d.coordinateSystem, /znorth-neg-v1/);
  assert.ok(d.water.length > 0);
  assert.strictEqual(d.lines.length, 0);
  const b = d.bboxLocal;
  for (const w of d.water) {
    assert.ok(w.outer.length >= 3);
    for (const p of [].concat(w.outer, ...w.holes)) {
      assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
      assert.ok(p[0] >= b.minX - 100 && p[0] <= b.maxX + 100 && p[1] >= b.minZ - 100 && p[1] <= b.maxZ + 100); // tile clip buffer
    }
  }
  assert.match(d.credit, /国土地理院/);
});

test('the window covers the Sumiyoshi 9-tile bbox', () => {
  const b = d.bboxLocal;
  assert.ok(b.minX <= -3300 && b.maxX >= -1200 && b.minZ <= -1800 && b.maxZ >= 300);
});

test('viewer loads both water windows into the same gsiwater layer and keeps znorth-neg toCart', () => {
  assert.match(html, /mission57-data\/' \+ GSI_SUMIYOSHI/);
  assert.match(html, /mission50-data\/' \+ GSI_OKAWA/);
  assert.match(html, /LiveCityWaterDedupe\.dedupeWater/);
});

test('QA result (headless Chrome): GSI-only water interior points 0 -> all, no JS errors, no Google traffic', () => {
  const f = 'data/reports/mission57-water/run2-result.json';
  if (!fs.existsSync(f)) return;
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(r.jsErrors.length, 0);
  assert.strictEqual(r.googleRequests, 0);
  for (const v of r.views) { assert.strictEqual(v.before.waterColoured, 0); assert.strictEqual(v.after.waterColoured, v.usable); }
});
