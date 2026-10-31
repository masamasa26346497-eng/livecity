'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);
const vm = require('vm');
// package.json is "type":"module" so a public/*.js UMD file cannot be require()d; evaluate it as a browser script
const sb = { self: {} }; sb.self = sb; vm.runInNewContext(fs.readFileSync(R('public/mission51-seg-dedupe.js'), 'utf8'), sb);
const { dedupeLines } = sb.LiveCitySegDedupe;
const J = (p) => JSON.parse(fs.readFileSync(R(p), 'utf8'));

test('dedupeLines: reversed/duplicate segments dropped, remaining runs rebuilt, coordinates untouched', () => {
  const seen = new Set();
  const a = dedupeLines([[[0, 0], [1, 0], [2, 0]]], seen);
  assert.strictEqual(JSON.stringify(a.lines), JSON.stringify([[[0, 0], [1, 0], [2, 0]]]));
  const b = dedupeLines([[[2, 0], [1, 0], [1, 5], [1, 6]], [[0, 0], [1, 0], [2, 0]]], seen);
  assert.strictEqual(JSON.stringify(b.lines), JSON.stringify([[[1, 0], [1, 5], [1, 6]]]));
  assert.strictEqual(b.droppedSegs, 3);
  assert.strictEqual(b.keptSegs, 2);
});

test('real data: Kita-sample window and Okawa window overlap; shared segments are drawn once', () => {
  const sets = ['public/mission49-data/gsi-roadedge-sumiyoshi-9tile.json', 'public/mission49-data/gsi-roadedge-kita-sample.json', 'public/mission50-data/gsi-okawa-nakanoshima.json'];
  const seen = new Set(); let inS = 0, kept = 0; const allIn = new Set();
  for (const f of sets) {
    const d = J(f); const r = dedupeLines(d.lines, seen); inS += r.inSegs; kept += r.keptSegs;
    for (const ln of d.lines) for (const p of ln) allIn.add(p[0] + ',' + p[1]);
    for (const ln of r.lines) for (const p of ln) assert.ok(allIn.has(p[0] + ',' + p[1]), 'no new/shifted vertex');
  }
  assert.ok(inS - kept >= 1700, 'dropped ' + (inS - kept));
  assert.ok(kept > 0.8 * inS, 'only duplicates dropped');
});

test('viewer wires the dedupe into both road-edge sources and keeps counts diagnosable', () => {
  const h = fs.readFileSync(R('public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(h.includes('mission51-seg-dedupe.js'));
  assert.strictEqual((h.match(/of dd\(d\.lines\)/g) || []).length, 2);
  assert.ok(h.includes('stats.gsiRoadEdge.dedupe'));
  assert.ok(!/google|places\.googleapis/i.test(fs.readFileSync(R('public/mission51-seg-dedupe.js'), 'utf8')));
});

test('PLATEAU vs GSI at Okawa (tracked data): report is present and shows no building in the river', () => {
  const r = J('data/reports/mission51/okawa-plateau-vs-gsi.json').summary;
  assert.ok(r.buildings >= 200);
  assert.strictEqual(r.verticesInWater, 0);
  assert.strictEqual(r.buildingsWithAnyWaterSample, 0);
  assert.ok(r.within10mOfShore >= 1);
});
