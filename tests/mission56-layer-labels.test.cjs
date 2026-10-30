// Mission 56: 37G の道路・水路・公園レイヤーが、出典と線/面の別をラベルで示すこと。QA の保存結果と整合すること。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');

test('layer labels state source and line/area kind', () => {
  for (const l of ['道路中心線（OSM・線）', '道路縁（GSI実測・線）', '河川・水路（OSM・線/面）', '水域面（GSI実測・面／大川・中之島のみ）', '公園・緑地（OSM・面）']) {
    assert.ok(html.includes("label: '" + l + "'"), l);
  }
});

test('no buffered/synthetic road surface was introduced', () => {
  assert.ok(!/bufferRoad|roadSurface|offsetCentre/i.test(html));
});

test('saved QA: all layers ready, centreline/edge/building produce pixels, click ok, no JS errors', () => {
  const p = 'data/reports/mission56-sumiyoshi/after-result.json';
  if (!fs.existsSync(p)) return;
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepStrictEqual(r.jsErrors, []);
  for (const id of ['buildings', 'roads', 'waterways', 'parks', 'gsiroadedge']) assert.strictEqual(r.layersInitial[id].state, 'ready', id);
  assert.strictEqual(r.layersInitial.roads.count, 969);
  assert.strictEqual(r.layersInitial.waterways.count, 20);
  assert.strictEqual(r.stats.tilesetBuildings, 10546);
  for (const v of r.views) { assert.ok(v.diffPx.bldOnlyVsNone > 0 && v.diffPx.edgeVsNone > 0 && v.diffPx.centreVsNone > 0, v.view); }
  assert.ok(r.clicks.some((c) => c.ok));
});
