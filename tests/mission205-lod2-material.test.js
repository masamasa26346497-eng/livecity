// Mission 205/207: LOD2 GLB の材質/色/法線を GLB バイナリから読み直して監査し、LOD1 と同一配色であることを固定する。
// 入力はすべて合成 fixture。公式 PLATEAU 2025 の実データ・実 Cesium レンダリングの検証ではない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildLod2Mesh, meshToGlb } from '../tools/lod2/lod2-to-glb.js';

const require = createRequire(import.meta.url);
const { colorFor, buildingColors } = require('../tools/lib/building-color.cjs');
const B = require('../tools/mission37b-build-3dtiles.cjs');

const poly = (name, c) => `<bldg:boundedBy><bldg:${name}Surface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>${c}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:${name}Surface></bldg:boundedBy>`;
// 高さ hgt(m) の箱。標高は gml 上の ellipsoid 高としてそのまま使う(最低点=0)
const box = (id, lon0, hgt) => {
  const a = lon0, b = lon0 + 0.0001, z = hgt;
  return `<bldg:Building gml:id="${id}">${poly('Roof', `34.6 ${a} ${z} 34.6001 ${a} ${z} 34.6001 ${b} ${z} 34.6 ${b} ${z} 34.6 ${a} ${z}`)}${poly('Wall', `34.6 ${a} 0 34.6 ${a} ${z} 34.6001 ${a} ${z} 34.6001 ${a} 0 34.6 ${a} 0`)}${poly('Ground', `34.6 ${a} 0 34.6001 ${a} 0 34.6001 ${b} 0 34.6 ${b} 0 34.6 ${a} 0`)}</bldg:Building>`;
};
const ORG = { lat: 34.6, lon: 135.5, h: 0 };
const mesh = buildLod2Mesh(new Map([['a', box('a', 135.5, 10)]]), ORG);
// 高さの異なる 2 棟を 1 メッシュに入れて、棟ごとに別の高さで塗られることを確認する
const mesh2 = buildLod2Mesh(new Map([['lo', box('lo', 135.5, 10)], ['hi', box('hi', 135.502, 90)]]), ORG);

function parse(glb) {
  const jl = glb.readUInt32LE(12), json = JSON.parse(glb.toString('utf8', 20, 20 + jl));
  const bo = 20 + jl + 8;
  const view = (acc, Type) => { const a = json.accessors[acc], bv = json.bufferViews[a.bufferView]; const o = glb.byteOffset + bo + bv.byteOffset; return new Type(glb.buffer.slice(o, o + bv.byteLength)); };
  return { json, P: view(0, Float32Array), N: view(1, Float32Array), C: view(2, Uint8Array) };
}
const rgbAt = (C, i) => [C[i * 4], C[i * 4 + 1], C[i * 4 + 2]];

test('共通配色: LOD1 式と一致(0/15/30/60/90m)・LOD1 の既知値が不変', () => {
  assert.deepEqual(colorFor(0), [190, 200, 215]);
  assert.deepEqual(colorFor(60), [120, 150, 195]);
  assert.deepEqual(colorFor(90), [120, 150, 195]);
  assert.deepEqual(colorFor(30), [155, 175, 205]);
  assert.deepEqual(buildingColors(0).wall, [148, 156, 168]); // round(190*.78,200*.78,215*.78)
  for (const h of [0, 15, 30, 60, 90]) {
    const t = Math.min(h / 60, 1);
    assert.deepEqual(colorFor(h), [Math.round(190 - 70 * t), Math.round(200 - 50 * t), Math.round(215 - 20 * t)]);
  }
});

test('LOD1 GLB と LOD2 GLB の COLOR_0 を読み戻し、同一高さの roof/wall の RGB が同一', () => {
  for (const h of [15, 30, 60, 90]) {
    const frame = B.makeFrame(135.5, 34.6);
    const { glb } = B.buildGlb([{ id: 'x', fp: [[0, 0], [40, 0], [40, 30], [0, 30]], z0: 0, top: h, h }], frame);
    const jl = glb.readUInt32LE(12), j1 = JSON.parse(glb.toString('utf8', 20, 20 + jl));
    const colAcc = j1.accessors[j1.meshes[0].primitives[0].attributes.COLOR_0];
    assert.equal(colAcc.componentType, 5121); assert.equal(colAcc.normalized, true); assert.equal(colAcc.type, 'VEC4');
    const bv = j1.bufferViews[colAcc.bufferView], o = glb.byteOffset + 20 + jl + 8 + (bv.byteOffset || 0);
    const c1 = new Uint8Array(glb.buffer.slice(o, o + colAcc.count * 4));
    const set1 = new Set(); for (let i = 0; i < colAcc.count; i++) set1.add(rgbAt(c1, i).join(','));
    const m = buildLod2Mesh(new Map([['x', box('x', 135.5, h)]]), ORG);
    const { C } = parse(meshToGlb(m));
    const set2 = new Set(); for (let i = 0; i < C.length / 4; i++) set2.add(rgbAt(C, i).join(','));
    const cc = buildingColors(h);
    assert.ok(set1.has(cc.roof.join(',')) && set1.has(cc.wall.join(',')));
    assert.deepEqual([...set2].sort(), [cc.roof.join(','), cc.wall.join(',')].sort(), `LOD2 は roof/wall のみ h=${h}`);
    assert.deepEqual([...set1].sort(), [...set2].sort(), `LOD1 と LOD2 の色集合が一致 h=${h}`);
  }
});

test('建物単位で高さを取る: 同一メッシュ内の低い棟/高い棟が別の色になる', () => {
  const { C } = parse(meshToGlb(mesh2));
  const seen = new Set(); for (let i = 0; i < C.length / 4; i++) seen.add(rgbAt(C, i).join(','));
  const lo = buildingColors(10), hi = buildingColors(90);
  for (const c of [lo.roof, lo.wall, hi.roof, hi.wall]) assert.ok(seen.has(c.join(',')), `色 ${c} が存在`);
  assert.equal(seen.size, 4);
});

for (const material of ['unlit', 'pbr']) {
  test(`${material}: accessor/offset/長さ/色が正しく非黒`, () => {
    const { json, P, N, C } = parse(meshToGlb(mesh, { material }));
    const n = mesh.positions.length;
    assert.equal(P.length, n * 3); assert.equal(C.length, n * 4);
    assert.deepEqual(json.bufferViews.map((bv) => bv.byteOffset), [0, n * 12, n * 24]);
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) - 1) < 1e-4, '法線は単位長');
      assert.ok(Math.min(...rgbAt(C, i)) >= 100 && C[i * 4 + 3] === 255, '黒でない');
    }
    assert.deepEqual(json.materials[0].pbrMetallicRoughness.baseColorFactor, [1, 1, 1, 1]);
    assert.equal(json.materials[0].doubleSided, true);
    assert.equal(json.materials[0].alphaMode, 'OPAQUE');
  });
}

test('既定は KHR_materials_unlit(LOD1 と同じ・夜も黒くならない)、pbr は拡張なし', () => {
  const u = parse(meshToGlb(mesh)).json;
  assert.deepEqual(u.extensionsUsed, ['KHR_materials_unlit']);
  assert.ok(u.materials[0].extensions.KHR_materials_unlit);
  assert.equal(parse(meshToGlb(mesh, { material: 'pbr' })).json.extensionsUsed, undefined);
});

test('屋根は上向き法線・壁は水平法線で、屋根色と壁色は焼き込み無しの共通配色そのもの', () => {
  const { P, N, C } = parse(meshToGlb(mesh));
  const cc = buildingColors(10); let roofN = 0, wallN = 0;
  for (let i = 0; i < P.length / 3; i++) {
    if (Math.abs(N[i * 3 + 1]) > 0.99 && P[i * 3 + 1] > 5) { roofN++; assert.deepEqual(rgbAt(C, i), cc.roof); }
    else if (Math.abs(N[i * 3 + 1]) < 0.01) { wallN++; assert.deepEqual(rgbAt(C, i), cc.wall); }
  }
  assert.ok(roofN >= 3 && wallN >= 3);
});

test('色の変更は幾何(POSITION)を変えない(unlit と pbr で完全一致)', () => {
  assert.deepEqual([...parse(meshToGlb(mesh)).P], [...parse(meshToGlb(mesh, { material: 'pbr' })).P]);
});
