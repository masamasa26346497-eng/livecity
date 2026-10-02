import test from 'node:test';
import assert from 'node:assert/strict';
import { parseB3dmHeader, selectWardB3dmEntry } from '../tools/mission36k-smoke-b3dm.mjs';

function fakeB3dm({ glbVersion = 2, glbLength = 24 } = {}) {
  const bytes = Buffer.alloc(28 + glbLength);
  bytes.write('b3dm', 0, 'ascii');
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(0, 12);
  bytes.writeUInt32LE(0, 16);
  bytes.writeUInt32LE(0, 20);
  bytes.writeUInt32LE(0, 24);
  bytes.write('glTF', 28, 'ascii');
  bytes.writeUInt32LE(glbVersion, 32);
  bytes.writeUInt32LE(glbLength, 36);
  return bytes;
}

test('parses valid B3DM and embedded GLB header', () => {
  const h = parseB3dmHeader(fakeB3dm());
  assert.equal(h.magic, 'b3dm');
  assert.equal(h.version, 1);
  assert.equal(h.glbMagic, 'glTF');
  assert.equal(h.glbVersion, 2);
  assert.equal(h.glbOffset, 28);
  assert.equal(h.glbByteLength, 24);
});

test('rejects invalid magic and byte length mismatch', () => {
  const badMagic = fakeB3dm();
  badMagic.write('xxxx', 0, 'ascii');
  assert.throws(() => parseB3dmHeader(badMagic), /Invalid B3DM magic/);

  const badLength = fakeB3dm();
  badLength.writeUInt32LE(badLength.length + 1, 8);
  assert.throws(() => parseB3dmHeader(badLength), /byteLength mismatch/);
});

test('selects the smallest LOD1 B3DM within the requested ward root', () => {
  const ward = {
    preferredLod1: { root: 'root_sumiyoshi_lod1' },
  };
  const entries = [
    { name: 'root_other_lod1/data/a.b3dm', compressedSize: 1, isDirectory: false },
    { name: 'root_sumiyoshi_lod1/tileset.json', compressedSize: 2, isDirectory: false },
    { name: 'root_sumiyoshi_lod1/data/b.b3dm', compressedSize: 200, isDirectory: false },
    { name: 'root_sumiyoshi_lod1/data/a.b3dm', compressedSize: 100, isDirectory: false },
  ];
  const selected = selectWardB3dmEntry(entries, ward);
  assert.equal(selected.name, 'root_sumiyoshi_lod1/data/a.b3dm');
});
