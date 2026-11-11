import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyWard } from '../tools/lod2/lod2-all-wards.mjs';

// 合成 fixture(実データではない): verifyWard の検証ロジックのみを確認する。
function mk(opts = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm193-'));
  fs.mkdirSync(path.join(d, 'tiles'));
  fs.writeFileSync(path.join(d, 'tiles', 'a.glb'), 'glTF');
  fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify({ wardCode: opts.code || '27128' }));
  fs.writeFileSync(path.join(d, 'build-report.json'), JSON.stringify({ totals: { buildings: opts.b ?? 5, uniqueCanonicalIds: 5 } }));
  fs.writeFileSync(path.join(d, 'tileset.json'), JSON.stringify({ root: { children: [{ content: { uri: opts.uri || 'tiles/a.glb' } }] } }));
  return d;
}

test('healthy ward verifies', () => {
  const v = verifyWard(mk(), '27128');
  assert.equal(v.ok, true); assert.equal(v.buildings, 5); assert.equal(v.contentTiles, 1); assert.equal(v.glbBytes, 4);
});
test('wrong wardCode / missing GLB / zero buildings fail', () => {
  assert.equal(verifyWard(mk({ code: '27100' }), '27128').ok, false);
  assert.equal(verifyWard(mk({ uri: 'tiles/none.glb' }), '27128').ok, false);
  assert.equal(verifyWard(mk({ b: 0 }), '27128').ok, false);
});
test('missing files reported, not guessed', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm193-'));
  const v = verifyWard(d, '27128');
  assert.equal(v.ok, false); assert.ok(v.problems.length >= 3);
});
