import test from 'node:test';
import assert from 'node:assert/strict';
import { auditGml } from '../tools/lod2/lod2-audit.mjs';

const b = (id, inner) => `<bldg:Building gml:id="${id}">${inner}</bldg:Building>`;
test('auditGml counts lod2 only where present and keeps LOD1 fallback count', () => {
  const xml = '<app:appearanceMember/>' +
    b('a', '<bldg:lod1Solid/>') +
    b('b', '<bldg:lod1Solid/><bldg:lod2Solid/><bldg:RoofSurface/><bldg:WallSurface/>') +
    b('c', '<bldg:lod2MultiSurface/>') + b('a', '<bldg:lod1Solid/>');
  const r = auditGml(xml);
  assert.equal(r.buildings, 4);
  assert.equal(r.lod2Any, 2);
  assert.equal(r.lod1FallbackCount, 2);
  assert.equal(r.dupIds, 1);
  assert.equal(r.roofSurface, 1);
  assert.equal(r.appearance, 1);
  assert.deepEqual(r.lod2Ids, ['b', 'c']);
});
test('LOD1-only data yields zero lod2', () => {
  assert.equal(auditGml(b('x', '<bldg:lod1Solid/>')).lod2Any, 0);
});
