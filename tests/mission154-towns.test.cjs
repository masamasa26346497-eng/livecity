'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
const towns = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission145-data/towns-24.json'), 'utf8'));
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
const TW = (() => { const ctx = { self: {} }; require('vm').runInNewContext(fs.readFileSync(path.join(ROOT, 'public/mission145-towns.js'), 'utf8'), ctx); return ctx.self.LiveCityTowns145; })();

test('committed towns-24.json covers all 24 wards with official names', () => {
  assert.ok(towns.towns.length >= 1900);
  const ids = new Set(towns.towns.map((t) => t.w));
  for (const w of wards) if (String(w.wardCode) !== '27999') assert.ok(ids.has(w.wardId), 'no towns for ' + w.wardId);
  assert.ok(/CC BY 4\.0/.test(towns.license));
  assert.strictEqual(new Set(towns.towns.map((t) => t.k)).size, towns.towns.length, 'duplicate keys');
  for (const t of towns.towns) assert.ok(Number.isFinite(t.x) && Number.isFinite(t.z) && t.n);
});
test('chuo and kita have base and chome tiers', () => {
  for (const w of ['chuo', 'kita']) {
    const p = TW.splitForWard(towns.towns.filter((t) => t.w === w));
    assert.ok(p.base.length > 5 && p.full.length > p.base.length, w);
  }
  assert.strictEqual(TW.tierOf(5000), 'base');
  assert.strictEqual(TW.tierOf(1000), 'full');
});
test('page: build id, diagnostics, committed data preferred, independent layers', () => {
  assert.ok(/const BUILD_ID = 'm154-/.test(html));
  assert.ok(html.includes('id="lc-diag154"') && html.includes('diag154Update'));
  assert.ok(html.includes("mission145-data/towns-24.json") && html.includes('towns-24.local.json'));
  assert.ok(/l\.n > \(\(pick && pick\.n\) \|\| 0\)/.test(html), 'local only when larger');
  assert.ok(html.includes("id: 'towns24'") && html.includes("LayerRegistry.get('stations')"));
  assert.ok(!/google/i.test(fs.readFileSync(path.join(ROOT, 'tools/mission154-refresh.mjs'), 'utf8')));
});
test('refresh tool is read-only', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/mission154-refresh.mjs'), 'utf8');
  assert.ok(!/writeFile|rmSync|unlink|rename|execSync|git reset|git clean/.test(s));
});
