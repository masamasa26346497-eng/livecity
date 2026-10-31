const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const rep = JSON.parse(fs.readFileSync(path.join(root, 'data/reports/mission54-bldg-vs-gsi.json'), 'utf8'));
const fetchSrc = fs.readFileSync(path.join(root, 'tools/mission54-fetch-bldg-ranges.cjs'), 'utf8');
const cmpSrc = fs.readFileSync(path.join(root, 'tools/mission54-bldg-vs-gsi.cjs'), 'utf8');

test('real PLATEAU footprints were analysed, ids unique', () => {
  assert.ok(rep.completeBuildingsParsed > 500);
  assert.strictEqual(rep.uniqueIds, rep.completeBuildingsParsed);
  assert.ok(rep.inWindow > 300);
});
test('old 31G ~29% overlap is not reproduced with real building footprints', () => {
  assert.ok(rep.baseline.pctVertsInWater < 2);
  assert.ok(rep.baseline.centroidInWater / rep.inWindow < 0.02);
});
test('no rigid shift gives a material improvement (no justification for a shift)', () => {
  const best = rep.shiftSweepBest5[0].vertsInWater;
  assert.ok(rep.shiftSweepAtZero.vertsInWater - best <= 5);
});
test('fetch tool enforces the budget and does not touch the viewer', () => {
  assert.match(fetchSrc, /MAXGET = 60/);
  assert.match(fetchSrc, /MAXB = 50e6/);
  assert.match(fetchSrc, /MAXONE = 15e6/);
  assert.match(fetchSrc, /403 \|\| res\.status === 429/);
  assert.doesNotMatch(cmpSrc + fetchSrc, /writeFileSync\([^)]*(public|\.html)/);
});
