const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const rep = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data/reports/mission55-sumiyoshi-align.json'), 'utf8'));
const src = fs.readFileSync(path.join(__dirname, '..', 'tools/mission55-sumiyoshi-align.cjs'), 'utf8');

test('all sources share one frame and cover the 9 tile area', () => {
  assert.strictEqual(rep.tiles, 9);
  assert.strictEqual(rep.buildings, 10546);
  assert.strictEqual(rep.frame.CLAT, 34.604208);
  assert.strictEqual(rep.frame.CLON, 135.52502);
  assert.strictEqual(rep.frame.MPD, 111320);
});
test('GSI road edge barely enters building footprints at zero shift', () => {
  assert.ok(rep.gsiRoadEdge.pctInside < 2);
  assert.ok(rep.osmCentreline.pctInside < 0.5);
});
test('zero shift is the best of the rigid sweep (no shift justified)', () => {
  assert.strictEqual(rep.gsiShiftSweep.best3[0].dx, 0);
  assert.strictEqual(rep.gsiShiftSweep.best3[0].dz, 0);
});
test('tool is read-only and offline', () => {
  assert.doesNotMatch(src, /https?:\/\/(?!cyber)/);
  assert.doesNotMatch(src, /unlink|rmSync|child_process/);
  assert.doesNotMatch(src, /writeFileSync\([^)]*public/);
});
