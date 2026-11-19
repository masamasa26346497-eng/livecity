'use strict';
// Mission 41G: 41B packing must respect the 41D tar estimate (headers + padding + end marker).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const plan = require('../tools/mission41b-plan.cjs');
const d = require('../tools/mission41d-pack.cjs');

const MB = 1024 * 1024;
function mk(n, size, cat) {
  return Array.from({ length: n }, (_, i) => ({ root: 'r', rel: 'd' + (i % 50) + '/f' + i + '.json', size, category: cat || 'osm-layers', decision: 'include' }));
}

test('many tiny files: raw-bytes packing would exceed the limit, tar-sized packing does not', () => {
  const limit = 50 * MB; // scaled-down model of 1.5 GiB
  const files = mk(200000, 100); // 100 B data -> 1024 B in tar (10x overhead)
  const raw = files.reduce((a, f) => a + f.size, 0);
  assert.ok(raw < limit, 'raw total fits in a single part by bytes alone (the old behaviour)');
  const { parts } = plan.pack(files, limit);
  assert.ok(parts.length > 1, 'split into several parts');
  for (const p of parts) {
    const est = d.tarEstimate(p.files);
    assert.ok(est < limit, 'tar estimate under limit: ' + est);
    assert.strictEqual(est, p.tarBytes, 'planner estimate equals 41D tarEstimate');
  }
});

test('mixed sizes near the limit stay strictly under it, with margin', () => {
  const limit = 20 * MB;
  const files = [...mk(3000, 1000), ...mk(500, 30000).map((f, i) => ({ ...f, rel: 'big/' + i })), ...mk(30, 600000).map((f, i) => ({ ...f, rel: 'huge/' + i }))];
  const { parts, unsplittable } = plan.pack(files, limit);
  assert.strictEqual(unsplittable.length, 0);
  assert.strictEqual(parts.reduce((a, p) => a + p.files.length, 0), files.length, 'every file placed once');
  for (const p of parts) assert.ok(d.tarEstimate(p.files) <= limit - 4 * MB, 'margin kept');
});

test('a file whose tar size exceeds the budget is flagged unsplittable', () => {
  const limit = 10 * MB;
  const { parts, unsplittable } = plan.pack([{ root: 'r', rel: 'a.bin', size: limit - 1000, category: 'x' }], limit);
  assert.strictEqual(unsplittable.length, 1);
  assert.strictEqual(parts.length, 0);
});

test('buildPlan validation and manifest use tar sizing (schema 2)', () => {
  const inv = { files: mk(3000, 100), duplicates: [] };
  const pl = plan.buildPlan(inv, { maxPartGiB: 0.01 });
  assert.ok(pl.validation.ok);
  assert.ok(pl.validation.maxPartTarBytes < pl.limitBytes);
  const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lc41g-'));
  const dir = path.join(out, 'plan');
  plan.emit(pl, dir);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.strictEqual(m.schema, 2);
  assert.strictEqual(m.sizing, 'tar-estimate');
  assert.ok(m.parts.every((p) => p.tarEstimate < m.partLimitBytes));
  fs.rmSync(out, { recursive: true, force: true });
});

test('anonymous problem summary has kinds and counts only, no paths or ids', () => {
  const rep = { results: [
    { problems: [{ id: 'abcd1234', kind: 'missing' }, { id: 'ffff0000', kind: 'missing' }, { id: 'x', kind: 'hardlink-warning' }] },
    { problems: [{ id: 'SECRET_asset.tar', kind: 'tar-estimate-over-limit', estimate: 5 }] },
    { problems: [] },
  ] };
  const a = d.anonSummary(rep);
  assert.deepStrictEqual(a.byKind, { missing: 2, 'tar-estimate-over-limit': 1 });
  assert.deepStrictEqual(a.parts.map((p) => p.part), ['part-001', 'part-002']);
  const s = JSON.stringify(a);
  assert.ok(!/abcd1234|ffff0000|SECRET|\.tar/.test(s));
});

test('41D/41F print and enforce the legacy-manifest diagnosis; 41D prints the anonymous summary', () => {
  const src = fs.readFileSync(path.join(__dirname, '../tools/mission41d-pack.cjs'), 'utf8');
  assert.ok(/legacySizing/.test(src) && /problem kind /.test(src) && /Regenerate the plan/.test(src));
  const f = fs.readFileSync(path.join(__dirname, '../tools/mission41f-pack-local.cjs'), 'utf8');
  assert.ok(/legacy-manifest-regenerate-plan/.test(f));
});
