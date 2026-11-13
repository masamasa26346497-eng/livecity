const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const src = fs.readFileSync('tools/mission61-offline-join-analysis.cjs', 'utf8');
const out = JSON.parse(fs.readFileSync('data/reports/mission61/offline-join.json', 'utf8'));

test('script uses no network APIs', () => {
  assert.ok(!/require\(['"](node:)?(https?|net|tls|dgram|dns)['"]\)/.test(src));
  assert.ok(!/\bfetch\s*\(/.test(src));
  assert.strictEqual(out.network.externalGets, 0);
});
test('parallax theory reproduces Mission 60 values and foot never shifts', () => {
  const r = out.parallaxTheory.find((x) => x.cam === 'persp60-r350' && x.r_m === 144 && x.roofHeight_m === 34.4);
  assert.ok(Math.abs(r.apparentOutwardShift_m - 15.7) < 0.05);
  assert.ok(out.parallaxTheory.every((x) => x.footShift_m === 0));
  const o = out.parallaxTheory.find((x) => x.cam.startsWith('ortho') && x.r_m === 144 && x.roofHeight_m === 34.4);
  assert.ok(o.apparentOutwardShift_m < 0.5);
});
test('layer height shift is zero looking straight down and grows when oblique', () => {
  const t = out.layerHeightApparentShift;
  assert.ok(t.filter((x) => x.elevationDeg === 90).every((x) => x.apparentGroundShift_m === 0));
  const a = t.find((x) => x.layer === 'roads' && x.elevationDeg === 30).apparentGroundShift_m;
  assert.ok(a > 2.3 && a < 2.5);
});
test('independent references show no large uniform shift (<2 m) and inputs are the 9 tiles', () => {
  assert.strictEqual(out.inputs.buildings, 10546);
  const r = out.roadCenterlineVsGsiEdge.meanVectorToNearestEdge_m;
  const w = out.osmWaterAreaVsGsiWater.meanVector_m;
  assert.ok(Math.hypot(r.east, r.south) < 2);
  assert.ok(Math.hypot(w.east, w.south) < 2);
  assert.strictEqual(out.buildingFootVsGsiEdgeSweep.bestByWithin1m.dx, 0);
});
