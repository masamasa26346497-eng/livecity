'use strict';
// Mission 45X: ward road/water layers must be mounted AND drawn in single-ward mode, coverage must follow the mounts,
// and the read-only diagnose CLI must report anonymous coverage. Synthetic fixtures only (no private 45I data).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { diagnose } = require('../tools/mission45x-diagnose-layers.cjs');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };

test('45X: viewer syncs view-culled ward vectors in single-ward mode (not only in allTick)', () => {
  assert.ok(html.includes('function singleCullSync()'));
  assert.ok(/moveEnd\.addEventListener\(\(\) => \{ if \(allMode\) scheduleAll\(\); else scheduleSingleCull\(\); \}\)/.test(html));
  assert.ok(/mountWardVec[\s\S]*?scheduleSingleCull\(\)/.test(html), 'a freshly mounted ward layer is synced to the current view');
  assert.ok(/vecViewSync\(ctr \? cartToLocal\(ctr\) : pos, pos\.h\)/.test(html));
});
test('45X: coverage note is refreshed on every vec mount/drop and never reuses the Sumiyoshi counts for another ward', () => {
  assert.ok(/function vecSync\(\)[\s\S]*?vecCovHook\(\)/.test(html));
  assert.ok(html.includes('vecCovHook = () => setTimeout(updateVecCoverage, 0)'));
  assert.ok(html.includes('描画データ未配信。上の件数は住吉区の束のものです'));
});
test('45X: wards absent from index.json layersWards are reported as not delivered without probing', () => {
  assert.ok(html.includes('vecWards.size && !vecWards.has(wid)'));
});
test('45X: no geometry inference was added (centerline polylines, same heights)', () => {
  assert.ok(html.includes('const LAYER_H = { waterways: 0.5, parks: 0.9, roadsCasing: 1.3, roads: 1.4, railways: 2.0 }'));
  assert.ok(!/roadWidthM|metersWide|widthMeters/.test(html));
});

function fixtureRoot(opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm45x-diag-'));
  wj(path.join(root, '.livecity-45i-layers.json'), { schema: 'livecity.mission45i.layers/1' });
  const w = reg.find((x) => x.id === 'chuo');
  const ld = path.join(root, 'chuo', 'layers');
  wj(path.join(ld, 'roads.json'), { layer: 'roads', coordinateConvention: 'znorth-neg-v1', count: 2, features: [{ id: 'a', p: [[0, 0], [1, 1]] }, { id: 'b', p: [[0, 0], [2, 2]] }] });
  wj(path.join(ld, 'waterways.json'), { layer: 'waterways', coordinateConvention: 'znorth-neg-v1', count: 0, features: [] });
  if (!opts.noReport) wj(path.join(ld, 'layers-report.json'), { wardCode: w.code, layers: { roads: { status: 'ok', features: opts.reportRoads === undefined ? 2 : opts.reportRoads }, waterways: { status: 'ok', features: 0 } } });
  return root;
}
test('45X diagnose: 24 wards, delivered ward ok, others "not-delivered", output has no paths/ids', () => {
  const root = fixtureRoot({});
  const R = diagnose(root, reg);
  assert.strictEqual(R.wards.length, 24);
  assert.strictEqual(R.markerOk, true);
  assert.strictEqual(R.summary.ok, 1);
  assert.strictEqual(R.summary.notDelivered, 23);
  assert.strictEqual(R.summary.indexLayersWards, 1);
  const s = JSON.stringify(R);
  assert.ok(!s.includes(root) && !/"id":"a"|"p":/.test(s));
  fs.rmSync(root, { recursive: true, force: true });
});
test('45X diagnose: missing report / count mismatch are flagged; the source folder is not modified', () => {
  const r1 = fixtureRoot({ noReport: true }), r2 = fixtureRoot({ reportRoads: 5 });
  assert.strictEqual(diagnose(r1, reg).summary.incompleteNoReport, 1);
  const before = fs.readdirSync(path.join(r2, 'chuo', 'layers')).sort().join();
  const D = diagnose(r2, reg);
  assert.strictEqual(D.summary.withProblems, 1);
  assert.ok(D.wards.find((x) => x.ward === 'chuo').problems.some((p) => /report count != file/.test(p)));
  assert.strictEqual(fs.readdirSync(path.join(r2, 'chuo', 'layers')).sort().join(), before);
  assert.ok(diagnose(path.join(r1, 'nope'), reg).error);
  for (const r of [r1, r2]) fs.rmSync(r, { recursive: true, force: true });
});
test('45X diagnose: source is read-only and offline', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/mission45x-diagnose-layers.cjs'), 'utf8');
  assert.ok(!/unlink|rmSync|rename|copyFile|http|fetch\(|mkdirSync|writeFileSync\(path\.join\(d/.test(src.replace(/fs\.writeFileSync\(out,/, '')));
});
