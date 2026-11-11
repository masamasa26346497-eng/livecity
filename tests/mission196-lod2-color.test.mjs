import test from 'node:test';
import assert from 'node:assert/strict';
import { lod1Color, colorForType, meshToGlb } from '../tools/lod2/lod2-to-glb.js';

test('LOD2 の色は LOD1 colorFor(h) と同一(屋根)・×0.78(壁)', () => {
  const lo = lod1Color(0).map((v) => Math.round(v * 255));
  const hi = lod1Color(60).map((v) => Math.round(v * 255));
  assert.deepEqual(lo, [190, 200, 215]);
  assert.deepEqual(hi, [120, 150, 195]);
  assert.deepEqual(colorForType('wall', 0).map((v) => Math.round(v * 255)), [148, 156, 168]);
});

test('GLB は KHR_materials_unlit(照明で黒くならない)', () => {
  const m = { positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], colors: [lod1Color(10), lod1Color(10), lod1Color(10)] };
  const glb = meshToGlb(m);
  const len = glb.readUInt32LE(12);
  const j = JSON.parse(glb.subarray(20, 20 + len).toString());
  assert.deepEqual(j.extensionsUsed, ['KHR_materials_unlit']);
  assert.ok(j.materials[0].extensions.KHR_materials_unlit);
});
