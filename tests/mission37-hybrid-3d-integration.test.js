import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const preview = fs.readFileSync('tools/preview.js', 'utf8');
const toggle = fs.readFileSync('public/livecity-hybrid-3d-toggle.js', 'utf8');
const compare = fs.readFileSync('public/mission37-livecity-hybrid-3d-compare.html', 'utf8');

test('[Mission37] dev preview injects the hybrid launcher', () => {
  assert.ok(preview.includes('/livecity-hybrid-3d-toggle.js'));
  assert.ok(toggle.includes('Cesium POC'));
  assert.ok(toggle.includes('mission37-livecity-hybrid-3d-poc.html'));
});

test('[Mission37] side-by-side comparison page exists', () => {
  assert.ok(compare.includes('osaka_3d_buildings.ward-ux-v1.html'));
  assert.ok(compare.includes('mission37-livecity-hybrid-3d-poc.html'));
});

test('[Mission37] production pages are not patched by launcher source', () => {
  assert.ok(!toggle.includes('osaka_3d_buildings.html'));
  assert.ok(!toggle.includes('osaka_3d_buildings.fullward-v3.html'));
});
