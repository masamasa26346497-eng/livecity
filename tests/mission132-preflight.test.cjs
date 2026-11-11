'use strict';
// Mission 132: regression guards for the pre-run quality gate (synthetic only; says nothing about real 21-ward data).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('LOD-group id sidecars (ids/g_*.json) are not counted as duplicate ids (data check + loader)', () => {
  assert.match(src('tools/mission129/wards21.cjs'), /\^g_\/\.test\(f\)/);
  assert.match(src('tools/mission130/accept-lib.cjs'), /\^g_\/\.test\(f\)/);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm132-'));
  fs.mkdirSync(path.join(d, 'ids'));
  fs.writeFileSync(path.join(d, 'ids', 't_0_0.json'), JSON.stringify(['bldg_a', 'bldg_b']));
  fs.writeFileSync(path.join(d, 'ids', 'g_0_0.json'), JSON.stringify(['bldg_a', 'bldg_b']));
  const L = require('../tools/mission130/accept-lib.cjs').loadWardData(d);
  assert.strictEqual(L.dup, 0);
  assert.strictEqual(L.ids.size, 2);
});

test('browser runner reads the selection from window.__mission37g (not .stats) and the viewer exposes it there', () => {
  const r = src('tools/mission130/accept21.mjs');
  assert.doesNotMatch(r, /__mission37g\.stats\./);
  assert.match(r, /__mission37g\.selectedCanonicalId/);
  assert.match(src('public/mission37g-osaka-24ward-mvp.html'), /window\.__mission37g = stats;/);
});
