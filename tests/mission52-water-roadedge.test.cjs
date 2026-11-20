'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = (p) => path.join(__dirname, '..', p);
const sb = { self: {} }; sb.self = sb;
vm.runInNewContext(fs.readFileSync(R('public/mission52-water-dedupe.js'), 'utf8'), sb);
const W = sb.LiveCityWaterDedupe;
const html = fs.readFileSync(R('public/mission37g-osaka-24ward-mvp.html'), 'utf8');
const d = JSON.parse(fs.readFileSync(R('public/mission50-data/gsi-okawa-nakanoshima.json'), 'utf8'));
const sq = (x, z, s) => ({ outer: [[x, z], [x + s, z], [x + s, z + s], [x, z + s]], holes: [] });

test('synthetic: fully covered polygon dropped, partial overlap and hole kept', () => {
  const big = sq(0, 0, 100), inner = sq(10, 10, 20), partial = sq(90, 10, 30);
  const r = W.dedupeWater([inner, big, partial]);
  assert.deepStrictEqual(Array.from(r.droppedIndexes), [0]);
  assert.strictEqual(r.polys.length, 2);
  const holed = { outer: big.outer, holes: [sq(40, 40, 20).outer] };
  const r2 = W.dedupeWater([holed, sq(45, 45, 5)]); // 穴の中の小片は覆われていない
  assert.strictEqual(r2.polys.length, 2);
});

test('real Okawa data: only covered polygons dropped, no water cell lost, coordinates untouched', () => {
  const r = W.dedupeWater(d.water);
  assert.ok(r.droppedIndexes.length >= 1 && r.droppedIndexes.length <= 10, 'dropped ' + r.droppedIndexes.length);
  for (const p of r.polys) assert.ok(d.water.includes(p), 'same object, no new geometry');
  let tot = 0, lost = 0; const b = d.bboxLocal;
  for (let x = b.minX; x < b.maxX; x += 3) for (let z = b.minZ; z < b.maxZ; z += 3) {
    if (!d.water.some((p) => W.inPoly(x, z, p))) continue;
    tot++; if (!r.polys.some((p) => W.inPoly(x, z, p))) lost++;
  }
  assert.ok(tot > 10000);
  assert.ok(lost / tot < 0.0005, 'lost ' + lost + '/' + tot);
});

test('viewer wiring: water dedupe loaded and used; GSI road edge default ON; centreline kept', () => {
  assert.ok(html.includes('mission52-water-dedupe.js'));
  assert.ok(/LiveCityWaterDedupe\.dedupeWater/.test(html));
  assert.ok(/id: 'gsiroadedge'[^]*?defaultOn: true/.test(html));
  assert.ok(/id: 'roads'/.test(html), 'OSM centreline layer still registered');
  assert.ok(!/google|places\.googleapis/i.test(fs.readFileSync(R('public/mission52-water-dedupe.js'), 'utf8')));
});
