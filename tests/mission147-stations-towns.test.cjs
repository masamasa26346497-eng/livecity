'use strict';
// Mission 147: operator colour table matches the pipeline's operator ids; towns builder accepts the e-Stat ZIP; launcher wires towns.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');

test('every pipeline operator id has a fixed colour in the page; unknown/other are defined', async () => {
  const SI = await import(path.join(ROOT, 'tools/build-station-index.js'));
  const m = /const OP_COLOR = \{([\s\S]*?)\};/.exec(page);
  assert.ok(m, 'OP_COLOR present');
  const keys = [...m[1].matchAll(/'?([a-z-]+)'?:\s*'#[0-9a-fA-F]{6}'/g)].map((x) => x[1]);
  for (const o of SI.OPERATORS) assert.ok(keys.includes(o.id), 'colour for ' + o.id);
  assert.ok(keys.includes('unknown') && keys.includes('other'));
  const colors = [...m[1].matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((x) => x[1].toLowerCase());
  for (const id of ['metro', 'jr', 'hankyu', 'hanshin', 'keihan', 'kintetsu', 'nankai']) {
    const c = new RegExp("'?" + id + "'?:\\s*'(#[0-9a-fA-F]{6})'").exec(m[1])[1].toLowerCase();
    assert.strictEqual(colors.filter((x) => x === c).length, 1, id + ' colour is unique');
  }
});

test('station layer: ring markers for transfers, legend, operator text under the name, no name-based guessing', () => {
  assert.ok(/stationOpColors\(s\)/.test(page) && /renderStationLegend\(/.test(page) && /lc-st-legend/.test(page));
  assert.ok(/for \(let i = nOp - 1; i >= 0; i--\)/.test(page));
  assert.ok(/text: opText/.test(page));   // 148: operator name is its own label under the (white) station name
  assert.ok(!/OP_COLOR\[s\.name\]/.test(page));
});

test('towns: page prefers towns-24.local.json on localhost; builder reads --zip; launcher builds towns without overwriting', () => {
  assert.ok(/towns-24\.local\.json/.test(page));
  const b = fs.readFileSync(path.join(ROOT, 'tools/mission145-build-towns.cjs'), 'utf8');
  assert.ok(/opt\('zip'\)/.test(b) && /shapefileToFeatureCollection/.test(b));
  const l = fs.readFileSync(path.join(ROOT, 'tools/mission141-local-24.mjs'), 'utf8');
  assert.ok(/--fetch-towns/.test(l) && /--no-towns/.test(l) && /towns-24\.local\.json/.test(l));
  assert.ok(/public\/mission145-data\/\*\.local\.json/.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
});

test('towns builder still builds from the GeoJSON fixture shape (labels inside own polygon)', async () => {
  const T = require(path.join(ROOT, 'tools/mission145-build-towns.cjs'));
  assert.strictEqual(T.splitName('長居東四丁目').chome, 4);
  const poly = { outer: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], holes: [] };
  const p = T.labelPoint(poly);
  assert.ok(T.inRing(p.x, p.z, poly.outer));
});
