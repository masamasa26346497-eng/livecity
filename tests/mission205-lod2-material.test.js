// Mission 205: LOD2 GLB の材質/色/法線を GLB バイナリから読み直して監査(合成fixture。実2025のレンダリング検証ではない)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLod2Mesh, meshToGlb, BAKE_SUN } from '../tools/lod2/lod2-to-glb.js';

const poly = (name, c) => `<bldg:boundedBy><bldg:${name}Surface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>${c}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:${name}Surface></bldg:boundedBy>`;
const xml = `<bldg:Building gml:id="a">${poly('Roof', '34.6 135.5 10 34.6001 135.5 10 34.6001 135.5001 10 34.6 135.5001 10 34.6 135.5 10')}${poly('Wall', '34.6 135.5 0 34.6 135.5 10 34.6001 135.5 10 34.6001 135.5 0 34.6 135.5 0')}${poly('Ground', '34.6 135.5 0 34.6001 135.5 0 34.6001 135.5001 0 34.6 135.5001 0 34.6 135.5 0')}</bldg:Building>`;
const mesh = buildLod2Mesh(new Map([['a', xml]]), { lat: 34.6, lon: 135.5, h: 0 });

function parse(glb) {
  const jl = glb.readUInt32LE(12), json = JSON.parse(glb.toString('utf8', 20, 20 + jl));
  const bo = 20 + jl + 8;
  const f = (acc) => { const bv = json.bufferViews[json.accessors[acc].bufferView]; const o = glb.byteOffset + bo + bv.byteOffset; return new Float32Array(glb.buffer.slice(o, o + bv.byteLength)); };
  return { json, P: f(0), N: f(1), C: f(2) };
}

for (const material of ['unlit-baked', 'pbr']) {
  test(`${material}: accessor/offset/長さ/色が正しく非黒`, () => {
    const { json, P, N, C } = parse(meshToGlb(mesh, { material }));
    const n = mesh.positions.length;
    assert.equal(P.length, n * 3); assert.equal(C.length, n * 3);
    json.bufferViews.slice(0, 3).forEach((bv, k) => assert.equal(bv.byteOffset, k * n * 12));
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) - 1) < 1e-4, '法線は単位長');
      const lum = (C[i * 3] + C[i * 3 + 1] + C[i * 3 + 2]) / 3;
      assert.ok(lum > 0.25 && Math.max(C[i * 3], C[i * 3 + 1], C[i * 3 + 2]) <= 1, `色が黒でない lum=${lum}`);
    }
    assert.equal(json.materials[0].doubleSided, true);
    assert.equal(json.materials[0].alphaMode, 'OPAQUE');
  });
}

test('既定は KHR_materials_unlit(時刻/ライトに依存しない)、pbr は拡張なし', () => {
  const u = parse(meshToGlb(mesh)).json;
  assert.ok(u.extensionsUsed.includes('KHR_materials_unlit')); // M208: ID 用拡張が加わるのは可
  assert.ok(u.materials[0].extensions.KHR_materials_unlit);
  assert.ok(!(parse(meshToGlb(mesh, { material: 'pbr' })).json.extensionsUsed || []).includes('KHR_materials_unlit'));
});

test('屋根は上向き法線、壁は水平法線、屋根色と壁色が判別できる', () => {
  const { P, N, C } = parse(meshToGlb(mesh, { material: 'pbr' }));
  const roof = [], wall = [];
  for (let i = 0; i < P.length / 3; i++) {
    if (Math.abs(N[i * 3 + 1]) > 0.99) { if (P[i * 3 + 1] > 5) roof.push(i); } else if (Math.abs(N[i * 3 + 1]) < 0.01) wall.push(i);
  }
  assert.ok(roof.length >= 3 && wall.length >= 3);
  assert.ok(Math.abs(C[roof[0] * 3] - C[wall[0] * 3]) > 0.1, '屋根(赤み)と壁(明灰)が区別できる');
});

test('焼き込みは幾何(POSITION)を変えず、最暗でも下限以上', () => {
  const a = parse(meshToGlb(mesh)), b = parse(meshToGlb(mesh, { material: 'pbr' }));
  assert.deepEqual([...a.P], [...b.P]);
  assert.ok(Math.hypot(...BAKE_SUN) > 0.999 && BAKE_SUN[1] > 0);
  assert.ok(Math.min(...a.C) >= 0.28 * 0.62 - 1e-6); // 最小チャンネル(屋根の青0.28) × 環境光下限0.62
  for (let i = 0; i < a.C.length; i += 3) assert.ok((a.C[i] + a.C[i + 1] + a.C[i + 2]) / 3 > 0.3);
});

// Mission 207: LOD2 色を LOD1(colorFor: 青灰, 壁=屋根×0.78)へ統一。既定は無陰影(LOD1 も unlit 無陰影)。
test('LOD2 既定色は LOD1 の青灰(colorFor高さ式)と一致し、茶橙でない', () => {
  const { P, N, C } = parse(meshToGlb(mesh));
  const t = 10 / 60, roof = [190 - 70 * t, 200 - 50 * t, 215 - 20 * t].map((v) => Math.round(v) / 255);
  let seenRoof = false, seenWall = false;
  for (let i = 0; i < P.length / 3; i++) {
    if (Math.abs(N[i * 3 + 1]) > 0.99 && P[i * 3 + 1] > 5) { seenRoof = true; roof.forEach((v, c) => assert.ok(Math.abs(C[i * 3 + c] - v) < 1e-4)); assert.ok(C[i * 3 + 2] > C[i * 3], '青>赤'); }
    if (Math.abs(N[i * 3 + 1]) < 0.01) { seenWall = true; roof.forEach((v, c) => assert.ok(Math.abs(C[i * 3 + c] - Math.round(v * 255 * 0.78) / 255) < 1e-4)); }
  }
  assert.ok(seenRoof && seenWall);
});

// Mission 208: クリック用。LOD2 GLB に建物ごとの canonicalId(gml:id) を載せる(形状/色は不変)。
test('Mission208: LOD2 GLB が EXT_mesh_features + EXT_structural_metadata で canonicalId を持つ', async () => {
  const { buildLod2Mesh, meshToGlb } = await import('../tools/lod2/lod2-to-glb.js');
  const mk = (id, h) => `<bldg:Building gml:id="${id}"><bldg:lod2Solid><gml:Solid><gml:exterior><gml:CompositeSurface>` +
    `<gml:surfaceMember><bldg:RoofSurface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>34.70 135.50 ${h} 34.70 135.5001 ${h} 34.7001 135.5001 ${h} 34.7001 135.50 ${h} 34.70 135.50 ${h}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:RoofSurface></gml:surfaceMember>` +
    `</gml:CompositeSurface></gml:exterior></gml:Solid></bldg:lod2Solid></bldg:Building>`;
  const m = buildLod2Mesh(new Map([['bldg_aaa', xml.replace('gml:id="a"', 'gml:id="bldg_aaa"')], ['bldg_bbb', xml.replace('gml:id="a"', 'gml:id="bldg_bbb"')]]), { lat: 34.6, lon: 135.5, h: 0 });
  assert.equal(m.ok.length, 2);
  assert.equal(m.featureIds.length, m.positions.length);
  const glb = meshToGlb(m);
  const jl = glb.readUInt32LE(12), json = JSON.parse(glb.subarray(20, 20 + jl).toString());
  assert.ok(json.extensionsUsed.includes('EXT_mesh_features') && json.extensionsUsed.includes('EXT_structural_metadata') && json.extensionsUsed.includes('KHR_materials_unlit'));
  const pt = json.extensions.EXT_structural_metadata.propertyTables[0];
  assert.equal(pt.count, m.ok.length);
  const binStart = 20 + jl + 8, bv = json.bufferViews[pt.properties.canonicalId.values], ov = json.bufferViews[pt.properties.canonicalId.stringOffsets];
  assert.equal(ov.byteOffset % 4, 0);
  const offs = new Uint32Array(m.ok.length + 1).map((_, i) => glb.readUInt32LE(binStart + ov.byteOffset + i * 4));
  const ids = m.ok.map((_, i) => glb.subarray(binStart + bv.byteOffset + offs[i], binStart + bv.byteOffset + offs[i + 1]).toString());
  assert.deepEqual(ids, m.ok.map((o) => o.id));
  assert.equal(json.meshes[0].primitives[0].attributes._FEATURE_ID_0, 3);
});
