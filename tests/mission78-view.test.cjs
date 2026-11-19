const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const sb = {}; sb.window = sb;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/mission78-view.js'), 'utf8'), sb);
const V = sb.LC78;
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');

test('M78: parallax math (45deg => roof shift equals height; 90deg => 0)', () => {
  assert.ok(Math.abs(V.parallaxM(30, -45) - 30) < 1e-9);
  assert.ok(Math.abs(V.parallaxM(30, -90)) < 1e-9);
  assert.ok(V.parallaxRatio(-68) < V.parallaxRatio(-62) && V.parallaxRatio(-62) < V.parallaxRatio(-55) && V.parallaxRatio(-55) < V.parallaxRatio(-45));
});
test('M78: default ward/city view keeps parallax under the stated ratio', () => {
  assert.ok(V.parallaxRatio(V.DEFAULT_PITCH_DEG) <= V.MAX_PARALLAX_RATIO);
  assert.ok(V.parallaxRatio(V.SELECT_PITCH_DEG) <= V.MAX_PARALLAX_RATIO);
});
test('M78: viewer loads the policy and uses it for ward fit / city home / ward select; no old hard-coded ward pitches', () => {
  assert.match(html, /<script src="mission78-view\.js"><\/script>/);
  assert.equal((html.match(/LC78\.(DEFAULT|SELECT)_PITCH_DEG/g) || []).length >= 4, true);
  assert.doesNotMatch(html, /const pitch = Cesium\.Math\.toRadians\(-55\)/);
  assert.doesNotMatch(html, /pitch: Cesium\.Math\.toRadians\(-62\) \}/);
});
test('M78: no coordinate/projection change and roads still drawn (no hiding)', () => {
  assert.match(html, /roads: 1\.4/);
  assert.match(html, /makeLineLayer\('roads\.json'|roads\.json/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'public/mission78-view.js'), 'utf8'), /CLAT|CLON|MPD/);
});
test('M78: saved E2E shows measured shift decreasing with steeper pitch, with no JS errors / Google traffic', () => {
  const p = path.join(ROOT, 'data/reports/mission78-view/e2e.json');
  if (!fs.existsSync(p)) return;
  const e = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(e.jsErrors.length, 0); assert.equal(e.googleRequests.length, 0);
  for (const view of ['mid', 'near']) {
    const r = e.rows.filter((x) => x.view === view);
    const old = r.find((x) => x.variant === 'before-45'), neu = r.find((x) => x.variant === 'after-68');
    assert.ok(neu.shiftP50M < old.shiftP50M, view);
    assert.equal(neu.visibleBuildings > 0, true);
  }
});
