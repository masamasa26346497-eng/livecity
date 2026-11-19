'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const d = path.join(__dirname, '..', 'data', 'reports', 'mission140');
const s = JSON.parse(fs.readFileSync(path.join(d, 'run42438843605-acceptance.json'), 'utf8'));
const e = JSON.parse(fs.readFileSync(path.join(d, 'nishi-2025-e2e-rerun.json'), 'utf8'));

test('run summary: counts are self-consistent and never claim 24/24', () => {
  assert.strictEqual(s.wards.length, 21);
  assert.strictEqual(new Set(s.wards.map((w) => w[0])).size, 21);
  const acc = s.wards.filter((w) => w[5] === 'ACCEPTED').length;
  assert.strictEqual(acc, s.browser.accepted);
  assert.strictEqual(21 - acc, s.browser.notAccepted);
  assert.deepStrictEqual(s.notAccepted.map((w) => w.ward).sort(), ['konohana', 'nishinari']);
  assert.ok(s.notProvenByLog.some((t) => /24\/24 is NOT shown/.test(t)));
  assert.strictEqual(s.steps.strictDataCheck.browserAcceptedWards, 0);
});

test('nishi 2025 re-run evidence: 12,603 buildings, 3/3 real clicks, no JS/Google', () => {
  assert.strictEqual(e.coverage.buildings, 12603);
  assert.strictEqual(e.clicks.length, 3);
  assert.ok(e.clicks.every((c) => c.realMouseClick === true && c.selected === true && /^bldg_/.test(c.id)));
  assert.deepStrictEqual(e.googleRequests, []);
  assert.deepStrictEqual(e.jsErrors, []);
  assert.strictEqual(e.pass, true);
  assert.ok(e.topDown.diffPx > 0 && e.oblique.diffPx > 0);
  assert.strictEqual(e.coverage.insideWardBboxPct, 100);
});
