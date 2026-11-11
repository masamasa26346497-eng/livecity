'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
test('vercel.json is valid, has no build/env/secret settings', () => {
  const j = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  for (const k of ['buildCommand', 'env', 'build', 'rewrites', 'functions']) assert.ok(!(k in j), k);
  assert.ok(j.redirects.every((r) => fs.existsSync(path.join(root, 'public', r.destination.slice(1)))));
});
