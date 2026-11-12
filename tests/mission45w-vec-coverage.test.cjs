'use strict';
// Mission 45W: the layer counts (roads 969 / water 20 ...) belong to the 住吉 9-tile bundle; the viewer must say where vector data is actually drawn.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');

test('45W: coverage note exists and distinguishes bundle / ward vector / none', () => {
  assert.ok(html.includes("id = 'lc-vec-coverage'"));
  for (const s of ["'sumiyoshi-bundle'", "'ward-vector'", "'ward-layers'", "'none'"]) assert.ok(html.includes(s), s);
  assert.ok(html.includes('描画データ未配信'));
  assert.ok(/camera\.moveEnd\.addEventListener\(updateVecCoverage\)/.test(html));
});
test('45W: styles / heights / projection untouched (centerline polylines, no inferred widths)', () => {
  assert.ok(html.includes('const LAYER_H = { waterways: 0.5, parks: 0.9, roadsCasing: 1.3, roads: 1.4, railways: 2.0 }'));
  assert.ok(html.includes('new Cesium.PolylineCollection()'));
  assert.ok(!/roadWidthM|metersWide|widthMeters/.test(html));
});
test('45W: the 37C bundle bbox is the 住吉 area only (outside it no road/water data)', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37c-layers/osaka-sumiyoshi-9tile/manifest.json'), 'utf8'));
  const w = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards.find((x) => x.wardId === 'chuo');
  const b = m.bboxLocal;
  assert.ok(w.bbox.maxZ < b.minZ - 4000, 'central ward is far outside the bundle');
});
