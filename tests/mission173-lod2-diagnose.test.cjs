'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
require('../tools/lod2/lod2-diagnose.js'); const { sanitize } = globalThis.LC152Diag;

test('sanitize removes Windows/UNC/home paths and tokens', () => {
  const o = sanitize({ a: 'C:\\Users\\taro\\AppData\\Local\\LiveCity-3DTiles-Out-24\\x.json', b: ['\\\\srv\\share\\f', '/home/runner/work/x', 'ghp_ABC123def'], c: { d: 'ok text' } });
  assert.strictEqual(o.a, '<path>'); assert.strictEqual(o.b[0], '<path>'); assert.strictEqual(o.b[1], '<path>'); assert.strictEqual(o.b[2], '<secret>'); assert.strictEqual(o.c.d, 'ok text');
  assert.ok(!JSON.stringify(o).includes('taro'));
});

test('overlay loads diagnose.js and server serves it; panel has copy button', () => {
  const ov = fs.readFileSync(path.join(__dirname, '../tools/lod2/lod2-overlay.js'), 'utf8');
  const sv = fs.readFileSync(path.join(__dirname, '../tools/lod2/lod2-preview-serve.cjs'), 'utf8');
  assert.match(ov, /diagnose\.js/); assert.match(sv, /diagnose\.js/);
  assert.match(fs.readFileSync(path.join(__dirname, '../tools/lod2/lod2-diagnose.js'), 'utf8'), /診断をコピー/);
});
