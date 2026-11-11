const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(require('os').tmpdir(), 'mission48-overlap-test.json');

test('road/river vs building footprints: no global offset (minimum at 0,0)', () => {
  execFileSync('node', [path.join(root, 'tools/mission48-road-building-overlap.cjs'), out], { stdio: 'pipe' });
  const r = JSON.parse(fs.readFileSync(out));
  assert.ok(r.buildings > 30000);
  // Roads: overlap is small and a 0 m shift is the global minimum of the +-12 m search.
  assert.ok(r.roads.insidePct < 1, 'roads inside footprints ' + r.roads.insidePct);
  assert.deepStrictEqual([r.roads.bestShift.dx, r.roads.bestShift.dz], [0, 0]);
  // Shifting by 2 m in any direction must worsen overlap (sensitivity: a real offset would be detectable).
  for (const [dx, dz, pct] of r.roads.shiftGridPct) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) === 2) assert.ok(pct > r.roads.insidePct, `shift ${dx},${dz}`);
  }
  // Rivers: tiny sample (20 features); only require low overlap.
  assert.ok(r.waterways.insidePct < 2);
});

test('viewer and 3D Tiles builder share the same projection constants', () => {
  const html = fs.readFileSync(path.join(root, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  const b = fs.readFileSync(path.join(root, 'tools/mission37b-build-3dtiles.cjs'), 'utf8');
  assert.ok(/clat: 34\.604208, clon: 135\.525020, mpd: 111320/.test(html));
  assert.ok(/CLAT = 34\.604208, CLON = 135\.525020, MPD = 111320/.test(b));
});
