import test from 'node:test';
import assert from 'node:assert/strict';
import { meshToGlb, lod1Color } from '../tools/lod2/lod2-to-glb.js';

test('LOD2 GLB は建物ごとの feature id と canonicalId(gml:id)を持つ(37G クリック選択の前提)', () => {
  const c = lod1Color(10), v = (x) => [x, 0, 0];
  const mesh = {
    positions: [v(0), v(1), [0, 1, 0], v(5), v(6), [5, 1, 0], v(9), v(10), [9, 1, 0]],
    colors: Array(9).fill(c),
    ok: [{ id: 'bldg_aaa', triangles: 1 }, { id: 'bldg_bbb', triangles: 2 }],
  };
  mesh.positions = mesh.positions.slice(0, 9);
  const glb = meshToGlb(mesh);
  const jl = glb.readUInt32LE(12), j = JSON.parse(glb.subarray(20, 20 + jl).toString());
  assert.deepEqual(j.extensionsUsed.sort(), ['EXT_mesh_features', 'EXT_structural_metadata', 'KHR_materials_unlit']);
  assert.equal(j.extensions.EXT_structural_metadata.propertyTables[0].count, 2);
  const bin = glb.subarray(20 + jl + 8);
  const fv = j.bufferViews[3], F = new Float32Array(bin.buffer.slice(bin.byteOffset + fv.byteOffset, bin.byteOffset + fv.byteOffset + fv.byteLength));
  assert.deepEqual([...F], [0, 0, 0, 1, 1, 1, 1, 1, 1]);
  const sv = j.bufferViews[4], ov = j.bufferViews[5];
  const O = new Uint32Array(bin.buffer.slice(bin.byteOffset + ov.byteOffset, bin.byteOffset + ov.byteOffset + ov.byteLength));
  const str = bin.subarray(sv.byteOffset, sv.byteOffset + sv.byteLength).toString();
  assert.equal(str.slice(O[0], O[1]), 'bldg_aaa'); assert.equal(str.slice(O[1], O[2]), 'bldg_bbb');
  assert.ok(/^bldg_/.test(str.slice(O[0], O[1])));
});
