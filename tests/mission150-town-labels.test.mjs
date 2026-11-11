import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');
const LOCAL = 'public/mission145-data/towns-24.local.json';
test('150: viewer exposes shown town label texts for E2E', () => {
  assert.match(html, /shownTexts/);
  assert.match(html, /towns-24\.local\.json/);
});
test('150: E2E script reads Cesium label text, not only Node values', () => {
  const s = fs.readFileSync('tools/experiments/mission150_town_labels_e2e.mjs', 'utf8');
  assert.match(s, /shownTexts/);
  assert.match(s, /nobuiltin=1&ext45=1/);
});
test('150: a locally generated towns file covers 24 wards with unique keys', { skip: !fs.existsSync(LOCAL) }, () => {
  const j = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
  assert.equal(new Set(j.towns.map((t) => t.w)).size, 24);
  assert.equal(new Set(j.towns.map((t) => t.k)).size, j.towns.length);
  assert.equal(j.towns.filter((t) => t.w === 'sumiyoshi').length, 104);
  assert.ok(j.towns.every((t) => Number.isFinite(t.x) && Number.isFinite(t.z) && t.n));
});
