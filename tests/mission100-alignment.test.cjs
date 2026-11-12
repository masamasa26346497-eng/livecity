'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const P = () => import('../tools/mission87-persist.mjs');

function fixture(alignment, extra) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm100-')); const out = path.join(d, 'out', 'w-2025');
  for (const s of ['ids', 'attrs', 'tiles', 'lod']) fs.mkdirSync(path.join(out, s), { recursive: true });
  fs.writeFileSync(path.join(out, 'tileset.json'), '{}'); fs.writeFileSync(path.join(out, 'build-report.json'), '{}');
  fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify({ wardCode: '27106', vintage: '2025' }));
  if (alignment !== undefined) fs.writeFileSync(path.join(out, 'alignment.json'), typeof alignment === 'string' ? alignment : JSON.stringify(alignment));
  if (extra) fs.writeFileSync(path.join(out, extra), '{}');
  return out;
}
const cand = (h) => ({ hits: h, hitRatePct: 1.5 });
const full = { roadPolygons: 10, buildingPoints: 100, candidates: { identity: cand(5), flipX: cand(1), flipZ: cand(1), rot180: cand(0), swapXZ: cand(0) }, bestTransform: 'identity', orientationOk: true, margin: 4 };

test('Mission100: real generator shapes of alignment.json are accepted and counted', async () => {
  const m = await P();
  assert.equal(m.inspectOut(fixture(full)).files, 4);
  assert.equal(m.inspectOut(fixture({ skipped: 'no --tran given' })).files, 4);
  assert.equal(m.inspectOut(fixture({ roadPolygons: 0, buildingPoints: 9, skipped: 'no roads parsed' })).files, 4);
  assert.equal(m.inspectOut(fixture(undefined)).files, 3); // optional
});
test('Mission100: malformed / oversized / extra-key alignment.json is rejected, not dropped', async () => {
  const m = await P();
  assert.throws(() => m.inspectOut(fixture('not json')));
  assert.throws(() => m.inspectOut(fixture([1])), /object/);
  assert.throws(() => m.inspectOut(fixture({ ...full, token: 'x' })), /unexpected key/);
  assert.throws(() => m.inspectOut(fixture({ ...full, bestTransform: 'evil' })), /result invalid/);
  assert.throws(() => m.inspectOut(fixture({ ...full, candidates: { identity: { hits: 'a', hitRatePct: 1 } } })), /candidate invalid/);
  assert.throws(() => m.inspectOut(fixture({ skipped: 'x'.repeat(70000) })), /size/);
});
test('Mission100: no wildcard — other top-level files stay rejected', async () => {
  const m = await P();
  for (const n of ['crosswalk.json', 'crosswalk.jsonl', 'legacy-only-ids.json', 'alignment.json.bak', 'notes.txt']) assert.throws(() => m.inspectOut(fixture(full, n)), /unexpected/, n);
  assert.throws(() => m.inspectOut(fixture(full, 'google-alignment.json')), /denied/);
  assert.deepEqual([...m.VALIDATED_TOP], ['alignment.json']);
});
test('Mission100: generator writes only files the persist allow-list covers', () => {
  const g = fs.readFileSync(path.join(__dirname, '../tools/mission79-build-ward-2025.cjs'), 'utf8');
  const tops = [...g.matchAll(/path\.join\(out, '([^']+)'\)/g)].map((x) => x[1]).filter((x) => !['attrs'].includes(x));
  const legacyOnly = new Set(['crosswalk.json', 'crosswalk.jsonl', 'legacy-only-ids.json']); // only with --legacy, never passed by the workflow
  const run = fs.readFileSync(path.join(__dirname, '../tools/mission79-run.mjs'), 'utf8');
  assert.match(run, /if \(opt\('legacy'\)\)/);
  assert.ok(tops.includes('alignment.json'));
  const ok = new Set(['alignment.json', 'source.json', 'tileset.json', 'build-report.json']);
  for (const t of tops) assert.ok(ok.has(t) || legacyOnly.has(t) || /\.glb$/.test(t), 'unexpected generator output: ' + t);
});
