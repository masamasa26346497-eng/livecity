import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assertSafeZipPath,
  buildWardManifest,
  classifyBuildingEntry,
  findEocd,
  parseCentralDirectory,
} from '../tools/mission36k-build-ward-building-manifest.mjs';

const registry = JSON.parse(fs.readFileSync(new URL('../config/wards/registry.json', import.meta.url), 'utf8'));

function fakeEntry(name, compressedSize = 100, uncompressedSize = 200) {
  return {
    name,
    flags: 0,
    method: 8,
    crc32: 0,
    compressedSize,
    uncompressedSize,
    localHeaderOffset: 0,
    isDirectory: name.endsWith('/'),
  };
}

function wardRoot(ward, lod = 1, noTexture = false) {
  return `27100_osaka-shi_city_2024_citygml_1_op_bldg_3dtiles_${ward.code}_${ward.id}-ku_lod${lod}${noTexture ? '_no_texture' : ''}`;
}

test('classifies PLATEAU ward building paths and texture variants', () => {
  const p = '27100_osaka-shi_city_2024_citygml_1_op_bldg_3dtiles_27120_sumiyoshi-ku_lod1/data/data0.b3dm';
  assert.deepEqual(classifyBuildingEntry(p), {
    root: '27100_osaka-shi_city_2024_citygml_1_op_bldg_3dtiles_27120_sumiyoshi-ku_lod1',
    wardCode: '27120',
    slug: 'sumiyoshi-ku',
    lod: 1,
    noTexture: false,
    relativePath: 'data/data0.b3dm',
  });

  const nt = classifyBuildingEntry('27100_osaka-shi_city_2024_citygml_1_op_bldg_3dtiles_27127_kita-ku_lod3_no_texture/tileset.json');
  assert.equal(nt.wardCode, '27127');
  assert.equal(nt.lod, 3);
  assert.equal(nt.noTexture, true);
});

test('builds a complete 24-ward LOD1 manifest and reports higher LOD coverage', () => {
  const entries = [];
  for (const ward of registry.wards) {
    const root = wardRoot(ward, 1);
    entries.push(fakeEntry(`${root}/tileset.json`, 80, 120));
    entries.push(fakeEntry(`${root}/data/data0.b3dm`, 1000, 2000));
  }
  for (const ward of registry.wards.slice(0, 11)) {
    const root = wardRoot(ward, 2);
    entries.push(fakeEntry(`${root}/tileset.json`));
    entries.push(fakeEntry(`${root}/data/data0.b3dm`));
  }
  for (const ward of registry.wards.slice(0, 2)) {
    const root = wardRoot(ward, 3);
    entries.push(fakeEntry(`${root}/tileset.json`));
    entries.push(fakeEntry(`${root}/data/data0.b3dm`));
  }

  const manifest = buildWardManifest({
    source: { packageId: 'plateau-test', name: 'runtime', format: 'ZIP', url: 'https://example.invalid/osaka.zip' },
    zip: { size: 1234, etag: 'x', lastModified: null, entries },
    registry,
  });

  assert.equal(manifest.wardCount, 24);
  assert.equal(manifest.coverage.lod1Wards, 24);
  assert.equal(manifest.coverage.lod2Wards, 11);
  assert.equal(manifest.coverage.lod3Wards, 2);
  assert.equal(Object.keys(manifest.wards).length, 24);
  assert.equal(manifest.wards.sumiyoshi.code, '27120');
  assert.equal(manifest.wards.sumiyoshi.preferredLod1.b3dmCount, 1);
});

test('fails closed when any ward lacks LOD1', () => {
  const entries = [];
  for (const ward of registry.wards.slice(0, 23)) {
    const root = wardRoot(ward, 1);
    entries.push(fakeEntry(`${root}/tileset.json`));
  }
  assert.throws(() => buildWardManifest({
    source: { packageId: 'x', name: 'x', format: 'ZIP', url: 'https://example.invalid/x.zip' },
    zip: { size: 1, etag: null, lastModified: null, entries },
    registry,
  }), /LOD1 missing/);
});

test('rejects ZIP path traversal and absolute paths', () => {
  assert.equal(assertSafeZipPath('safe/root/tileset.json'), 'safe/root/tileset.json');
  assert.throws(() => assertSafeZipPath('../escape.txt'), /Unsafe ZIP path/);
  assert.throws(() => assertSafeZipPath('/absolute.txt'), /Unsafe ZIP path/);
  assert.throws(() => assertSafeZipPath('C:/windows.txt'), /Unsafe ZIP path/);
  assert.throws(() => assertSafeZipPath('bad\\path.txt'), /Unsafe ZIP path/);
});

test('parses central-directory metadata required for range extraction', () => {
  const name = Buffer.from('root/tileset.json');
  const b = Buffer.alloc(46 + name.length);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(0, 8);
  b.writeUInt16LE(8, 10);
  b.writeUInt32LE(0x12345678, 16);
  b.writeUInt32LE(321, 20);
  b.writeUInt32LE(654, 24);
  b.writeUInt16LE(name.length, 28);
  b.writeUInt32LE(98765, 42);
  name.copy(b, 46);
  const [entry] = parseCentralDirectory(b);
  assert.equal(entry.method, 8);
  assert.equal(entry.compressedSize, 321);
  assert.equal(entry.uncompressedSize, 654);
  assert.equal(entry.localHeaderOffset, 98765);
  assert.equal(entry.name, 'root/tileset.json');
});

test('finds classic ZIP EOCD metadata', () => {
  const b = Buffer.alloc(40);
  const p = 18;
  b.writeUInt32LE(0x06054b50, p);
  b.writeUInt16LE(24, p + 10);
  b.writeUInt32LE(3000, p + 12);
  b.writeUInt32LE(9000, p + 16);
  assert.deepEqual(findEocd(b), {
    offset: p,
    entries: 24,
    centralDirectorySize: 3000,
    centralDirectoryOffset: 9000,
  });
});
