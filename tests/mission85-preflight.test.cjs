'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const P = () => import('../tools/mission85-preflight.mjs');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const inputs = () => ({ lock: rd('data/reports/mission79/source-lock.json'), polys: rd('data/processed/osaka-city/boundaries/ward-classification-polygons.json'), area: rd('config/areas/osaka-city.json') });

test('24 wards, unique codes, Expo 27999 excluded, per-ward mesh counts from lock only', async () => {
  const m = await P(); const r = m.buildReport({ ...inputs(), man: null, root: '/nonexistent-m85' });
  assert.strictEqual(r.wardsPlanned, 24);
  assert.strictEqual(new Set(r.wards.map((w) => w.wardCode)).size, 24);
  assert.ok(!r.wards.some((w) => w.wardCode === '27999'));
  assert.ok(r.wards.every((w) => w.meshes > 0 && w.inflatedMB > 0));
  assert.strictEqual(r.network, false);
});
test('Konohana/Suminoe 51357341: bldg present, tran absent -> warning, not blocker; no other missing hidden', async () => {
  const m = await P(); const r = m.buildReport({ ...inputs(), man: null, root: '/nonexistent-m85' });
  assert.deepStrictEqual(r.blockers, []);
  const tw = r.noTranWarnings.flatMap((w) => w.meshes);
  assert.ok(tw.length >= 1 && tw.every((x) => x === '51357341'));
  assert.ok(r.noTranWarnings.some((w) => w.ward === 'konohana'));
});
test('a ward with no bldg mesh is a blocker; tran-only meshes are surfaced as warnings', async () => {
  const m = await P(); const i = inputs();
  const lock = { ...i.lock, entries: i.lock.entries.filter((e) => e.kind !== 'bldg') };
  const r = m.buildReport({ ...i, lock, man: null, root: '/nonexistent-m85' });
  assert.strictEqual(r.blockers.length, 24);
  assert.ok(r.tranOnlyWarnings.length >= 1);
  const real = m.buildReport({ ...i, man: null, root: '/nonexistent-m85' });
  assert.deepStrictEqual(real.blockers, []);
});
test('wards without local output are never accepted, even if manifest says ok; complete only when 24 accepted', async () => {
  const m = await P(); const i = inputs();
  const man = { wards: { kita: { status: 'ok', buildings: 5 } } };
  const none = m.buildReport({ ...i, man, root: '/nonexistent-m85' });
  assert.strictEqual(none.wardsArtifactReady, 0); assert.strictEqual(none.artifactsReady, false);
  assert.strictEqual(none.browserAccepted, false);
  assert.ok(none.wards.find((w) => w.wardId === 'kita').reasons.some((x) => /not artifact-ready/.test(x)));
  const fake = { existsSync: () => true };
  const all = Object.fromEntries(i.polys.wards.map((w) => [w.wardId, { status: 'ok', buildings: 1 }]));
  const full = m.buildReport({ ...i, man: { wards: all }, root: 'x', fsx: fake });
  assert.strictEqual(full.artifactsReady, true);
  assert.strictEqual(full.browserAccepted, false); // artifact-ready は受入ではない
  assert.ok(!('complete' in full) && !('wardsAccepted' in full));
  delete all.kita; const part = m.buildReport({ ...i, man: { wards: all }, root: 'x', fsx: fake });
  assert.strictEqual(part.artifactsReady, false);
});
test('wards above the batch default --max-mb are flagged', async () => {
  const m = await P(); const r = m.buildReport({ ...inputs(), man: null, root: '/nonexistent-m85' });
  assert.ok(r.overDefaultCap.every((o) => o.inflatedMB > 1200));
  assert.ok(r.overDefaultCap.length >= 1);
});
test('launcher forwards validated --max-mb only', async () => {
  const m = await import('../tools/mission83-local-all.mjs');
  assert.deepStrictEqual(m.batchArgs(m.parseArgs(['--max-mb', '1400'])), ['tools/mission80-batch.mjs', '--max-mb', '1400']);
  assert.throws(() => m.batchArgs(m.parseArgs(['--max-mb', '1;rm'])));
});
test('source: no network, no child process, no delete/copy/write except --out', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'mission85-preflight.mjs'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/fetch\(|child_process|spawn|exec|rmSync|unlink|copyFile|cpSync|renameSync|https?\.request/.test(src));
  assert.strictEqual((src.match(/writeFileSync/g) || []).length, 1);
});
