// tests/lod2-pipeline.test.js
// LOD2自動取得・監査パイプラインのオフライン単体テスト。
// ネットワーク・大容量ZIPに依存せず、合成CityGMLフィクスチャで解析ロジックを検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitBuildings, extractBuildingId, auditCityGml, extractAllBuildingIds,
  extractSurfacePosLists, summarizeBuildingGeometry, detectCoordinateSystem,
} from '../tools/lib/citygml.js';
import { readCentralDirectory, extractEntryBuffer, extractEntryText } from '../tools/lib/zip-reader.js';
import { convertBuildingGeometry } from '../tools/convert/buildings-lod2.js';
import { geoToLocal, localToGeo } from '../tools/lib/projection.js';
import zlib from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- 合成フィクスチャ: LOD2(Roof/Wall/Ground)を持つ建物2件 + LOD1のみ1件 + テクスチャ ---
// 座標は大阪市住吉区付近(緯度34.60x, 経度135.52x)。posListは "lat lon height" の並び。
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0"
  xmlns:bldg="http://www.opengis.net/citygml/building/2.0"
  xmlns:gml="http://www.opengis.net/gml"
  xmlns:app="http://www.opengis.net/citygml/appearance/2.0">
  <core:cityObjectMember>
    <bldg:Building gml:id="bldg_00000000-0000-0000-0000-000000000001">
      <bldg:lod1Solid><gml:Solid/></bldg:lod1Solid>
      <bldg:lod2Solid><gml:Solid/></bldg:lod2Solid>
      <bldg:boundedBy>
        <bldg:RoofSurface>
          <bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing>
            <gml:posList>34.6040 135.5200 20 34.6041 135.5201 20 34.6041 135.5200 20 34.6040 135.5200 20</gml:posList>
          </gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface>
        </bldg:RoofSurface>
      </bldg:boundedBy>
      <bldg:boundedBy>
        <bldg:WallSurface>
          <bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing>
            <gml:posList>34.6040 135.5200 0 34.6040 135.5200 20 34.6041 135.5200 20 34.6041 135.5200 0 34.6040 135.5200 0</gml:posList>
          </gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface>
        </bldg:WallSurface>
      </bldg:boundedBy>
      <bldg:boundedBy>
        <bldg:GroundSurface>
          <bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing>
            <gml:posList>34.6040 135.5200 0 34.6041 135.5201 0 34.6041 135.5200 0 34.6040 135.5200 0</gml:posList>
          </gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface>
        </bldg:GroundSurface>
      </bldg:boundedBy>
    </bldg:Building>
  </core:cityObjectMember>
  <core:cityObjectMember>
    <bldg:Building gml:id="bldg_00000000-0000-0000-0000-000000000002">
      <bldg:lod1Solid><gml:Solid/></bldg:lod1Solid>
      <bldg:lod2Solid><gml:Solid/></bldg:lod2Solid>
      <bldg:boundedBy><bldg:RoofSurface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing>
        <gml:posList>34.6050 135.5210 15 34.6051 135.5211 15 34.6051 135.5210 15 34.6050 135.5210 15</gml:posList>
      </gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:RoofSurface></bldg:boundedBy>
      <bldg:boundedBy><bldg:WallSurface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing>
        <gml:posList>34.6050 135.5210 0 34.6050 135.5210 15 34.6051 135.5210 15 34.6051 135.5210 0 34.6050 135.5210 0</gml:posList>
      </gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:WallSurface></bldg:boundedBy>
      <bldg:boundedBy><bldg:GroundSurface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing>
        <gml:posList>34.6050 135.5210 0 34.6051 135.5211 0 34.6051 135.5210 0 34.6050 135.5210 0</gml:posList>
      </gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:GroundSurface></bldg:boundedBy>
    </bldg:Building>
  </core:cityObjectMember>
  <core:cityObjectMember>
    <bldg:Building gml:id="bldg_ffffffff-0000-0000-0000-000000000003">
      <bldg:lod1Solid><gml:Solid/></bldg:lod1Solid>
    </bldg:Building>
  </core:cityObjectMember>
  <app:appearanceMember><app:Appearance><app:surfaceDataMember>
    <app:ParameterizedTexture><app:imageURI>textures/roof01.jpg</app:imageURI></app:ParameterizedTexture>
  </app:surfaceDataMember></app:Appearance></app:appearanceMember>
</core:CityModel>`;

const PROJECTION = { centerLat: 34.604208, centerLon: 135.52502, metersPerDegree: 111320 };

test('splitBuildings: 建物を正しく分割する', () => {
  const bs = splitBuildings(FIXTURE);
  assert.equal(bs.length, 3);
});

test('extractBuildingId: gml:idを接頭辞非依存で取得する', () => {
  const bs = splitBuildings(FIXTURE);
  assert.equal(extractBuildingId(bs[0]), 'bldg_00000000-0000-0000-0000-000000000001');
  assert.equal(extractBuildingId(bs[2]), 'bldg_ffffffff-0000-0000-0000-000000000003');
});

test('auditCityGml: LOD1/LOD2件数・境界面・テクスチャを集計する', () => {
  const a = auditCityGml(FIXTURE);
  assert.equal(a.buildingCount, 3);
  assert.equal(a.lod1SolidCount, 3);
  assert.equal(a.lod2SolidCount, 2);
  assert.equal(a.lod2AnyCount, 2, 'LOD2を持つのは2件');
  assert.equal(a.lod3AnyCount, 0);
  assert.equal(a.roofSurfaceTotal, 2);
  assert.equal(a.wallSurfaceTotal, 2);
  assert.equal(a.groundSurfaceTotal, 2);
  assert.equal(a.appearancePresent, true);
  assert.equal(a.parameterizedTextureCount, 1);
  assert.equal(a.imageUriCount, 1);
  assert.equal(a.buildingsWithNullId, 0);
});

test('auditCityGml: LOD2が0件のGMLを検出できる', () => {
  const lod1Only = FIXTURE.replace(/<bldg:lod2Solid>[\s\S]*?<\/bldg:lod2Solid>/g, '')
    .replace(/<bldg:boundedBy>[\s\S]*?<\/bldg:boundedBy>/g, '');
  const a = auditCityGml(lod1Only);
  assert.equal(a.lod2AnyCount, 0);
});

test('extractAllBuildingIds: 配列順でなくSet照合できるidを返す', () => {
  const ids = extractAllBuildingIds(FIXTURE);
  assert.equal(ids.length, 3);
  assert.ok(ids.includes('bldg_00000000-0000-0000-0000-000000000002'));
});

test('extractSurfacePosLists: Roof/Wall/GroundのposListを面単位で取り出す', () => {
  const b = splitBuildings(FIXTURE)[0];
  const roofs = extractSurfacePosLists(b, 'Roof');
  assert.equal(roofs.length, 1);
  assert.equal(roofs[0].length, 4); // 4点(閉ポリゴン)
  assert.deepEqual(roofs[0][0], [34.6040, 135.5200, 20]);
  const walls = extractSurfacePosLists(b, 'Wall');
  assert.equal(walls.length, 1);
  assert.equal(walls[0].length, 5);
});

test('summarizeBuildingGeometry: 三角形数を概算する(閉ポリゴンを考慮)', () => {
  const b = splitBuildings(FIXTURE)[0];
  const s = summarizeBuildingGeometry(b);
  // Roof:4点閉→3実頂点→1三角形, Wall:5点閉→4実頂点→2三角形, Ground:4点閉→1三角形 = 4
  assert.equal(s.triangleCountApprox, 4);
  assert.equal(s.surfaceCount, 3);
  assert.ok(s.bounds);
});

test('convertBuildingGeometry: EPSG:6697→ローカル座標へ変換しbboxを返す', () => {
  const b = splitBuildings(FIXTURE)[0];
  const conv = convertBuildingGeometry(b, PROJECTION);
  assert.equal(conv.id, 'bldg_00000000-0000-0000-0000-000000000001');
  assert.ok(conv.localBounds);
  // 変換の整合性: ローカル→緯度経度へ戻すとおおよそ元の緯度経度域に入る
  const g = localToGeo(conv.localBounds.minX, conv.localBounds.minZ, PROJECTION);
  assert.ok(g.lat > 34.60 && g.lat < 34.61);
  assert.ok(g.lon > 135.51 && g.lon < 135.53);
});

test('convertBuildingGeometry: 座標系が想定外なら明確にthrowする', () => {
  const bad = `<bldg:Building gml:id="bldg_x"><bldg:boundedBy><bldg:RoofSurface>
    <gml:posList>0 0 0 1 1 0 1 0 0 0 0 0</gml:posList></bldg:RoofSurface></bldg:boundedBy></bldg:Building>`;
  assert.throws(() => convertBuildingGeometry(bad, PROJECTION), /座標系が想定外/);
});

test('ID照合: 現行id集合との一致/不一致が集計できる', () => {
  const lod2Ids = extractAllBuildingIds(FIXTURE);
  const currentIdSet = new Set([
    'bldg_00000000-0000-0000-0000-000000000001', // 一致
    'bldg_00000000-0000-0000-0000-000000000002', // 一致
    'bldg_99999999-0000-0000-0000-000000000099', // 現行のみ(LOD2に無い)
  ]);
  const exact = lod2Ids.filter((id) => currentIdSet.has(id));
  const unmatchedLod2 = lod2Ids.filter((id) => !currentIdSet.has(id));
  assert.equal(exact.length, 2);
  assert.equal(unmatchedLod2.length, 1);
  assert.equal(unmatchedLod2[0], 'bldg_ffffffff-0000-0000-0000-000000000003');
});

// ===== pure-Node ZIPリーダ（Windows互換・全展開しない） =====

/** テスト用に、指定エントリからなる最小ZIP(stored/deflate)をNodeだけで生成する。 */
function buildZip(entries) {
  // entries: [{name, data:Buffer, method:0|8}]
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const comp = e.method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32 ? zlib.crc32(raw) : crc32(raw);
    // local file header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0, 6);           // flags
    lh.writeUInt16LE(e.method, 8);    // method
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); // time/date
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);          // extra len
    chunks.push(lh, nameBuf, comp);
    const localOffset = offset;
    offset += lh.length + nameBuf.length + comp.length;
    // central header
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
  }
  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// zlib.crc32 が無い旧Node向けの簡易CRC32
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

test('zip-reader: 中央ディレクトリを解析しエントリを列挙できる（全展開しない）', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'zt-'));
  try {
    const zipPath = path.join(tmp, 'test.zip');
    const gml = Buffer.from('<gml>hello 大阪</gml>', 'utf8');
    writeFileSync(zipPath, buildZip([
      { name: 'udx/bldg/51357422_bldg_6697_op.gml', data: gml, method: 8 },   // deflate
      { name: 'udx/bldg/51357499_bldg_6697_op.gml', data: Buffer.from('<gml/>'), method: 0 }, // stored
    ]));
    const entries = readCentralDirectory(zipPath);
    assert.equal(entries.length, 2);
    const target = entries.find((e) => e.fileName.includes('51357422'));
    assert.ok(target);
    assert.equal(target.compressionMethod, 8);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('zip-reader: deflate/storedエントリを個別に解凍できる', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'zt-'));
  try {
    const zipPath = path.join(tmp, 'test.zip');
    const gml = Buffer.from('<gml>deflate content 日本語</gml>', 'utf8');
    const stored = Buffer.from('<gml>stored</gml>', 'utf8');
    writeFileSync(zipPath, buildZip([
      { name: 'a/deflated.gml', data: gml, method: 8 },
      { name: 'a/stored.gml', data: stored, method: 0 },
    ]));
    const entries = readCentralDirectory(zipPath);
    const d = entries.find((e) => e.fileName.endsWith('deflated.gml'));
    const s = entries.find((e) => e.fileName.endsWith('stored.gml'));
    assert.equal(extractEntryText(zipPath, d), gml.toString('utf8'));
    assert.equal(extractEntryBuffer(zipPath, s).toString('utf8'), stored.toString('utf8'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===== 座標系・軸順序の検出（固定値で決めつけない） =====

test('detectCoordinateSystem: EPSG:6697(緯度経度)を検出し軸順序lat-lonと判定', () => {
  const xml = `<gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/6697" srsDimension="3">
    <gml:lowerCorner>34.60 135.51 0</gml:lowerCorner>
    <gml:upperCorner>34.61 135.55 30</gml:upperCorner>
  </gml:Envelope>
  <gml:posList>34.6040 135.5200 20 34.6041 135.5201 20</gml:posList>`;
  const c = detectCoordinateSystem(xml);
  assert.equal(c.epsgCode, 6697);
  assert.equal(c.epsgKind, 'geographic');
  assert.equal(c.srsDimension, 3);
  assert.equal(c.detectedAxisOrder, 'lat-lon');
  assert.equal(c.isProjectedPlaneRectangular, false);
  assert.deepEqual(c.firstCoordSample.slice(0, 3), [34.6040, 135.5200, 20]);
  assert.deepEqual(c.lowerCorner, [34.60, 135.51, 0]);
});

test('detectCoordinateSystem: 平面直角座標系(EPSG:6674等)を検出できる', () => {
  const xml = `<gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/6674" srsDimension="3">
    <gml:lowerCorner>-150000.0 -20000.0 0</gml:lowerCorner></gml:Envelope>
    <gml:posList>-150000.0 -20000.0 20 -150001.0 -20001.0 20</gml:posList>`;
  const c = detectCoordinateSystem(xml);
  assert.equal(c.epsgCode, 6674);
  assert.equal(c.epsgKind, 'projected-plane-rectangular');
  assert.equal(c.detectedCrsKind, 'projected');
  assert.equal(c.isProjectedPlaneRectangular, true);
});

test('detectCoordinateSystem: 経度緯度順(lon-lat)を実座標から見抜く', () => {
  const xml = `<gml:posList>135.5200 34.6040 20 135.5201 34.6041 20</gml:posList>`;
  const c = detectCoordinateSystem(xml);
  assert.equal(c.detectedCrsKind, 'geographic');
  assert.equal(c.detectedAxisOrder, 'lon-lat');
});
