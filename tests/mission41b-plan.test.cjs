'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const b = require('../tools/mission41b-plan.cjs');
const a41 = require('../tools/mission41a-inventory.cjs');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const mk = (rel, size, category, extra) => ({ root: 'src', rel, size, ext: path.extname(rel), category, decision: 'private-data-repo', secrets: [], secretByName: false, ...extra });

test('41A plan exposes parts over target instead of hiding them', () => {
  const files = [mk('buildings/osaka-a/t1.json', 2 * GB, 'building-tiles')];
  const p = a41.plan(files);
  assert.strictEqual(p.partsOverTarget, 1);
  assert.ok(p.maxPartBytes > 900 * MB);
});

test('41B splits an oversized group so every part is under the limit', () => {
  const files = [];
  for (let i = 0; i < 40; i++) files.push(mk('buildings/osaka-a/tile_' + i + '.json', 100 * MB, 'building-tiles'));
  const plan = b.buildPlan({ files }, { maxPartGiB: 1.5 });
  assert.ok(plan.validation.ok);
  assert.ok(plan.parts.length >= 3);
  assert.ok(plan.parts.every((p) => p.bytes <= 1.5 * GB));
  assert.strictEqual(plan.validation.allFilesPlacedOnce, true);
  assert.strictEqual(plan.validation.bytesMatch, true);
});

test('41B flags a single file larger than the limit as unsplittable and rejects >=2GiB limit', () => {
  const plan = b.buildPlan({ files: [mk('x/huge.bin', 3 * GB, 'building-tiles'), mk('x/s.json', MB, 'building-tiles')] }, {});
  assert.strictEqual(plan.unsplittable.length, 1);
  assert.strictEqual(plan.validation.unsplittableFiles, 1);
  assert.throws(() => b.buildPlan({ files: [] }, { maxPartGiB: 2 }), /2 GiB/);
});

test('41B holds secrets, photos, raw PLATEAU, cache; never mixes categories in a part', () => {
  const files = [
    mk('.env', 10, 'secrets-candidate', { decision: 'exclude', secretByName: true }),
    mk('p/a.jpg', 5 * MB, 'photos-unverified-rights', { decision: 'exclude-until-license-ledger' }),
    mk('raw/plateau.zip', 5 * MB, 'plateau-raw'),
    mk('roads/t.json', MB, 'osm-layers'),
    mk('boundaries/n03.json', MB, 'boundaries'),
  ];
  const plan = b.buildPlan({ files }, {});
  assert.deepStrictEqual(plan.parts.map((p) => p.category).sort(), ['boundaries', 'osm-layers']);
  for (const k of ['secrets-candidate', 'photos-unverified-rights', 'plateau-raw']) assert.ok(plan.held[k]);
  assert.ok(plan.parts.every((p) => p.approved === false));
  assert.ok(b.buildPlan({ files }, { approved: ['osm-layers'] }).parts.find((p) => p.category === 'osm-layers').approved);
});

test('41B drops only sha256-confirmed duplicates', () => {
  const f1 = mk('a/1.json', 2 * MB, 'osm-layers'); const f2 = mk('b/1.json', 2 * MB, 'osm-layers');
  const unconfirmed = b.buildPlan({ files: [f1, f2], duplicates: [{ confirmed: false, files: ['src:a/1.json', 'src:b/1.json'] }] }, {});
  assert.strictEqual(unconfirmed.droppedDup.files, 0);
  const confirmed = b.buildPlan({ files: [f1, f2], duplicates: [{ confirmed: true, files: ['src:a/1.json', 'src:b/1.json'] }] }, {});
  assert.strictEqual(confirmed.droppedDup.files, 1);
});

test('summary is anonymous: no paths, no secret values', () => {
  const inv = { files: [mk('secret-place/key.pem', 100, 'secrets-candidate', { decision: 'exclude', secretByName: true }), mk('buildings/osaka-kita/t.json', 3 * MB, 'building-tiles', { secrets: [{ line: 1, type: 'google-api-key' }] })] };
  const s = JSON.stringify(b.summarize(inv, 5));
  assert.ok(!s.includes('secret-place') && !s.includes('osaka-kita') && !s.includes('key.pem') && !s.includes('src'));
  assert.ok(!/[A-Za-z]:\\|\/home\//.test(s));
  assert.ok(s.includes('google-api-key'));
});

test('emit writes new files only, refuses non-empty out, no network/upload code', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc41b-')), 'o');
  const plan = b.buildPlan({ files: [mk('roads/t.json', MB, 'osm-layers')] }, {});
  b.emit(plan, out);
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['deferred-ledger.json', 'manifest.json', 'plan.md', 'provenance-ledger.json', 'state.json']);
  assert.throws(() => b.emit(plan, out), /not empty/);
  const src = fs.readFileSync(path.join(__dirname, '../tools/mission41b-plan.cjs'), 'utf8');
  assert.ok(!/require\(['"]node:(https?|net|child_process)['"]\)|fetch\(|unlinkSync|rmSync|copyFile/.test(src));
});

test('resume helpers: failed parts retry, done parts skipped, verify needs size+sha', () => {
  const st = { parts: { a: { status: 'pending', attempts: 0 }, b: { status: 'pending', attempts: 0 } } };
  b.markResult(st, 'a', true, 'h', 5);
  assert.strictEqual(b.nextPending(st)[0], 'b');
  for (let i = 0; i < 5; i++) b.markResult(st, 'b', false);
  assert.strictEqual(b.nextPending(st, 5), undefined);
  assert.ok(b.verifyPart({ bytes: 5, sha256: 'h' }, { size: 5, sha256: 'h' }));
  assert.ok(!b.verifyPart({ bytes: 5, sha256: 'h' }, { size: 4, sha256: 'h' }));
  assert.ok(!b.verifyPart({ bytes: 5, sha256: null }, { size: 5, sha256: null }));
});
