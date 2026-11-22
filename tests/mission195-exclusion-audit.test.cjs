'use strict';
// Mission195: ID-set audit of complement LOD1. Synthetic fixture (NOT real PLATEAU data).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function mk(dir, ids) {
  fs.mkdirSync(path.join(dir, 'ids'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ids', 'g_0_0.json'), JSON.stringify(ids));
}
function run(orig, ex, lod2) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'm195-'));
  mk(path.join(t, 'o'), orig);
  mk(path.join(t, 'e'), ex);
  fs.writeFileSync(path.join(t, 'm.json'), JSON.stringify({ source: 's', assets: [{ ids: lod2 }] }));
  const r = spawnSync(process.execPath, [path.join(__dirname, '../tools/lod2/lod2-exclusion-audit.mjs'), '--orig', path.join(t, 'o'), '--ex', path.join(t, 'e'), '--manifest', path.join(t, 'm.json'), '--ward', 'x'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('exact complement: only LOD2 ids removed, nothing else lost', () => {
  const r = run(['a', 'b', 'c', 'd'], ['c', 'd'], ['a', 'b', 'zzz']);
  assert.strictEqual(r.removedEqualsLod2Intersect, true);
  assert.strictEqual(r.nonLod2LostFromOrig, 0);
  assert.strictEqual(r.remainingContainsLod2, 0);
  assert.strictEqual(r.lod2NotInWardLod1, 1);
});

test('over-deletion is detected', () => {
  const r = run(['a', 'b', 'c', 'd'], ['d'], ['a']);
  assert.strictEqual(r.removedEqualsLod2Intersect, false);
  assert.strictEqual(r.nonLod2LostFromOrig, 2);
});
