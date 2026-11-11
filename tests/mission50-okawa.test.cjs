'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);
const FILE = R('public/mission50-data/gsi-okawa-nakanoshima.json');

test('Okawa/Nakanoshima GSI data: format, credit, small, coordinates inside window, no shift applied', () => {
  const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.strictEqual(d.kind, 'gsi-water-roadedge');
  assert.ok(/国土地理院/.test(d.credit));
  assert.ok(/optimal_bvmap-v1/.test(d.source));
  assert.strictEqual(d.fetchedTiles, 20);
  assert.ok(d.water.length >= 40 && d.lines.length > 1000);
  assert.ok(fs.statSync(FILE).size < 500 * 1024, 'small');
  const b = d.bboxLocal;
  // window is the Nakanoshima/Okawa area of Kita (znorth-neg: z ~ -9960 at lat 34.6937)
  assert.ok(b.minX < -2400 && b.maxX > -2400 && b.minZ < -9960 && b.maxZ > -9960);
  const eps = 100; // MVT tiles carry a clip buffer, so polygons may extend slightly past the tile union
  for (const w of d.water) for (const p of w.outer) assert.ok(p[0] >= b.minX - eps && p[0] <= b.maxX + eps && p[1] >= b.minZ - eps && p[1] <= b.maxZ + eps);
  for (const l of d.lines) for (const p of l) assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
});

test('Okawa audit: GSI buildings vs GSI water consistency control, and QA per-point result', () => {
  const a = JSON.parse(fs.readFileSync(R('data/reports/mission50/okawa-audit.json'), 'utf8'));
  assert.ok(a.waterPolygons >= 40 && a.roadEdgeLines > 1000 && a.gsiBldA > 5000);
  assert.ok(a.gsiBldAVertsInWaterPct < 1, 'buildings are not in the river');
  const q = JSON.parse(fs.readFileSync(R('data/reports/mission50/okawa-qa.json'), 'utf8'));
  assert.strictEqual(q.jsErrors.length, 0);
  assert.strictEqual(q.googleRequests.length, 0);
  assert.ok(q.result.on.waterSamplesUsed >= 50);
  assert.ok(q.result.on.waterHitPct >= 95, 'water interior points render as water');
  assert.ok(q.result.off.waterHitPct < 10, 'baseline (layer OFF) does not show them');
  assert.ok(q.result.on.landFalseWaterPct < 2, 'land samples are not painted as water');
  assert.ok(q.roundTrip.medianM < 1);
});

test('viewer: gsiwater layer is registered default ON, same-origin, coverage window only, no Google', () => {
  const h = fs.readFileSync(R('public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.match(h, /id: 'gsiwater'[\s\S]{0,200}defaultOn: true/);
  assert.match(h, /mission50-data\//);
  const blk = h.slice(h.indexOf('50: GSI 水域面'), h.indexOf('── 未接続レイヤー'));
  assert.ok(blk.length > 500);
  assert.ok(!/google|maps\.googleapis/i.test(blk));
  assert.ok(!/fetch\('https?:/.test(blk));
});

test('production HTML files untouched by Mission 50', () => {
  for (const f of ['public/osaka_3d_buildings.html', 'public/osaka_3d_buildings.fullward-v3.html']) {
    assert.ok(!/gsiwater|mission50/.test(fs.readFileSync(R(f), 'utf8')));
  }
});
