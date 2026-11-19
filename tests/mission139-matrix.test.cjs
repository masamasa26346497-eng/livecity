'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('../tools/mission139/acceptance-matrix.cjs');

test('matrix covers 24 unique wards and never claims browser rendering', () => {
  const m = build();
  assert.strictEqual(m.wards, 24);
  assert.strictEqual(new Set(m.rows.map((r) => r.wardId)).size, 24);
  assert.strictEqual(m.summary.browserRendered, 0);
  assert.ok(m.rows.every((r) => r.browserRendered === false));
});

test('Sumiyoshi is the only whole-ward real-footprint ward in Git; no real roads/rivers claimed', () => {
  const m = build();
  const whole = m.rows.filter((r) => r.realFootprints.wholeWard).map((r) => r.wardId);
  assert.deepStrictEqual(whole, ['sumiyoshi']);
  assert.strictEqual(m.summary.realRoadsRiversInGit, 0);
  assert.ok(m.summary.mapOnly + m.summary.partial3dTilesOnly + m.summary.wholeWardRealFootprints === 24);
});

test('tool is read-only (no delete/copy/network) and refuses to overwrite --out', () => {
  const src = fs.readFileSync(path.join(__dirname, '../tools/mission139/acceptance-matrix.cjs'), 'utf8');
  assert.ok(!/unlinkSync|rmSync|copyFile|https?\.request|fetch\(/.test(src));
  assert.ok(/refusing to overwrite/.test(src));
});
