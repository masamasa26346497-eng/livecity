// Mission 153: LOD2 → GLB/3D Tiles 変換のfixtureテスト(合成CityGML。実データではない)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triangulate, buildLod2Mesh, meshToGlb, buildTileset, extractLod2Surfaces, geodeticToEcef } from '../tools/lod2/lod2-to-glb.js';

const poly = (name, coords) => `<bldg:boundedBy><bldg:${name}Surface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>${coords}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:${name}Surface></bldg:boundedBy>`;
const bldg = (id, roof) => `<bldg:Building gml:id="${id}">${poly('Roof', roof)}${poly('Wall', '34.6 135.5 0 34.6 135.5 10 34.6001 135.5 10 34.6001 135.5 0 34.6 135.5 0')}${poly('Ground', '34.6 135.5 0 34.6001 135.5 0 34.6001 135.5001 0 34.6 135.5 0')}</bldg:Building>`;
const ORG = { lat: 34.6, lon: 135.5, h: 0 };
const area = (pts, tris) => tris.reduce((s, [a, b, c]) => {
  const u = pts[b].map((v, i) => v - pts[a][i]), w = pts[c].map((v, i) => v - pts[a][i]);
  return s + Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
}, 0);

test('凹多角形(L字)の三角形化で面積が保存される', () => {
  const L = [[0, 0, 0], [4, 0, 0], [4, 2, 0], [2, 2, 0], [2, 4, 0], [0, 4, 0]];
  const t = triangulate(L);
  assert.equal(t.length, 4);
  assert.ok(Math.abs(area(L, t) - 12) < 1e-9);
});

test('傾斜した屋根面(3D)も三角形化でき、退化面は空', () => {
  assert.equal(triangulate([[0, 0, 0], [1, 0, 1], [1, 1, 1], [0, 1, 0]]).length, 2);
  assert.equal(triangulate([[0, 0, 0], [1, 1, 1], [2, 2, 2]]).length, 0);
});

test('変換成功棟はメッシュ化、面が壊れた棟はfailed(=LOD1フォールバック対象)', () => {
  const m = new Map([
    ['ok1', bldg('ok1', '34.6 135.5 10 34.6001 135.5 12 34.6001 135.5001 10 34.6 135.5 10')],
    ['bad', bldg('bad', '34.6 135.5 10 34.6 135.5 10 34.6 135.5 10 34.6 135.5 10')],
  ]);
  const mesh = buildLod2Mesh(m, ORG);
  assert.deepEqual(mesh.ok.map((o) => o.id), ['ok1']);
  assert.deepEqual(mesh.failed, ['bad']);
  assert.ok(mesh.extentEnu.z[1] > 11.9 && mesh.extentEnu.z[1] < 12.1); // 屋根頂≈12m(標高を維持、一律shiftなし)
  assert.equal(mesh.positions.length % 3, 0);
});

test('lod1しかない面は拾わない(推定屋根を作らない)', () => {
  const xml = '<bldg:Building gml:id="x"><bldg:boundedBy><bldg:RoofSurface><bldg:lod1MultiSurface><gml:Polygon><gml:exterior><gml:posList>1 2 3 4 5 6 7 8 9</gml:posList></gml:exterior></gml:Polygon></bldg:lod1MultiSurface></bldg:RoofSurface></bldg:boundedBy></bldg:Building>';
  assert.equal(extractLod2Surfaces(xml).length, 0);
  assert.deepEqual(buildLod2Mesh(new Map([['x', xml]]), ORG).failed, ['x']);
});

test('GLBヘッダ/長さ整合、tilesetはECEF原点transformと箱を持つ', () => {
  const mesh = buildLod2Mesh(new Map([['ok1', bldg('ok1', '34.6 135.5 10 34.6001 135.5 12 34.6001 135.5001 10 34.6 135.5 10')]]), ORG);
  const glb = meshToGlb(mesh);
  assert.equal(glb.toString('latin1', 0, 4), 'glTF');
  assert.equal(glb.readUInt32LE(8), glb.length);
  assert.equal(glb.length % 4, 0);
  const ts = buildTileset(mesh, ORG);
  const o = geodeticToEcef(34.6, 135.5, 0);
  assert.ok(Math.abs(ts.root.transform[12] - o[0]) < 1e-6);
  assert.equal(ts.root.content.uri, 'lod2.glb');
});
