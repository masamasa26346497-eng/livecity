'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { build } = require('../tools/mission158-ward2025-inventory.cjs');

test('23 wards listed, nishi excluded, no duplicates', () => {
  const r = build({});
  assert.strictEqual(r.rows.length, 23);
  assert.ok(!r.rows.some((x) => x.wardId === 'nishi'));
  assert.strictEqual(new Set(r.rows.map((x) => x.wardId)).size, 23);
});

test('never claims 24/24 acceptance or ward alignment', () => {
  const r = build({});
  assert.strictEqual(r.summary.wardAlignmentProven, 0);
  assert.ok(/NOT established/.test(r.summary.note));
  assert.ok(r.rows.every((x) => x.wardAlignment.state === 'unverified'));
});

test('konohana failed on runner and not accepted; owner-PC data is unverified without --local', () => {
  const r = build({});
  const k = r.rows.find((x) => x.wardId === 'konohana');
  assert.ok(/FAILED/.test(k.converted.state));
  assert.strictEqual(k.browserVerdict, 'NOT ACCEPTED');
  assert.ok(r.rows.every((x) => /unverified/.test(x.ownerPc.state)));
});

test('plan is non-destructive and not executed; tool has no write/network calls beyond --out', () => {
  const r = build({});
  assert.strictEqual(r.plan.executed, false);
  const src = fs.readFileSync(require.resolve('../tools/mission158-ward2025-inventory.cjs'), 'utf8');
  assert.ok(!/rmSync|unlinkSync|rmdirSync|https?\.request|fetch\(|execFile|spawn/.test(src));
});
