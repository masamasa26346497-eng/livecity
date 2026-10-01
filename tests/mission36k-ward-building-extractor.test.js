import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  resolveVariant,
  resolveWard,
  safeDestination,
  selectWardEntries,
} from '../tools/mission36k-fetch-ward-building-source.mjs';

const manifest = {
  wards: {
    sumiyoshi: {
      id: 'sumiyoshi',
      name: '住吉区',
      code: '27120',
      variants: [
        {
          lod: 1,
          noTexture: false,
          root: 'root_sumiyoshi_lod1',
          tilesetPath: 'root_sumiyoshi_lod1/tileset.json',
          fileCount: 3,
          b3dmCount: 2,
        },
        {
          lod: 2,
          noTexture: true,
          root: 'root_sumiyoshi_lod2_no_texture',
          tilesetPath: 'root_sumiyoshi_lod2_no_texture/tileset.json',
          fileCount: 2,
          b3dmCount: 1,
        },
      ],
    },
  },
};

const entries = [
  { name: 'other_root/data/a.b3dm', isDirectory: false, compressedSize: 1 },
  { name: 'root_sumiyoshi_lod1/data/data1.b3dm', isDirectory: false, compressedSize: 20 },
  { name: 'root_sumiyoshi_lod1/tileset.json', isDirectory: false, compressedSize: 5 },
  { name: 'root_sumiyoshi_lod1/data/data0.b3dm', isDirectory: false, compressedSize: 10 },
  { name: 'root_sumiyoshi_lod1/data/', isDirectory: true, compressedSize: 0 },
];

test('resolves ward by id or official code', () => {
  assert.equal(resolveWard(manifest, 'sumiyoshi').code, '27120');
  assert.equal(resolveWard(manifest, '27120').id, 'sumiyoshi');
  assert.throws(() => resolveWard(manifest, '99999'), /Unknown ward/);
});

test('resolves exact requested LOD and texture variant', () => {
  assert.equal(resolveVariant(manifest.wards.sumiyoshi, 1, false).root, 'root_sumiyoshi_lod1');
  assert.equal(resolveVariant(manifest.wards.sumiyoshi, 2, true).root, 'root_sumiyoshi_lod2_no_texture');
  assert.throws(() => resolveVariant(manifest.wards.sumiyoshi, 3, false), /variant unavailable/);
});

test('selects only requested ward root and keeps tileset first', () => {
  const variant = resolveVariant(manifest.wards.sumiyoshi, 1, false);
  const selected = selectWardEntries(entries, variant);
  assert.deepEqual(selected.map((e) => e.name), [
    'root_sumiyoshi_lod1/tileset.json',
    'root_sumiyoshi_lod1/data/data0.b3dm',
    'root_sumiyoshi_lod1/data/data1.b3dm',
  ]);
});

test('supports tileset-only and limited extraction modes', () => {
  const variant = resolveVariant(manifest.wards.sumiyoshi, 1, false);
  assert.deepEqual(
    selectWardEntries(entries, variant, { tilesetOnly: true }).map((e) => e.name),
    ['root_sumiyoshi_lod1/tileset.json'],
  );
  assert.equal(selectWardEntries(entries, variant, { maxFiles: 2 }).length, 2);
});

test('safeDestination strips selected ZIP root and blocks cross-root paths', () => {
  const base = path.resolve('/tmp/livecity-test');
  const dest = safeDestination(base, 'root_sumiyoshi_lod1', 'root_sumiyoshi_lod1/data/data0.b3dm');
  assert.equal(dest, path.join(base, 'data', 'data0.b3dm'));
  assert.throws(
    () => safeDestination(base, 'root_sumiyoshi_lod1', 'other_root/data0.b3dm'),
    /outside selected ward root/,
  );
  assert.throws(
    () => safeDestination(base, 'root_sumiyoshi_lod1', 'root_sumiyoshi_lod1/../escape.b3dm'),
    /Unsafe ZIP path/,
  );
});
