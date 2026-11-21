// Mission 214: LOD1/LOD2 色の品質ゲート(fixture・ネットワーク不要)。実描画のスクリーンショット比較ではない。
//  - LOD1 の colorFor(ソースから抽出)と LOD2 の lod1Color/GLB 頂点色が全高さで一致(式の二重実装のドリフト検出)
//  - 全高さで黒化しない(輝度下限)・青>赤(青灰系)
//  - LOD2 tileset にスタイル(色上書き/アルファ)を overlay が付けていない(頂点色=LOD1と同色のまま)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLod2Mesh, meshToGlb } from '../tools/lod2/lod2-to-glb.js';

const lod1Src = fs.readFileSync(new URL('../tools/mission37b-build-3dtiles.cjs', import.meta.url), 'utf8');
const m = lod1Src.match(/function colorFor\(h\) \{[\s\S]*?\n\}/);
const colorFor = new Function(`${m[0]}; return colorFor;`)();

const poly = (n, c) => `<bldg:boundedBy><bldg:${n}Surface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>${c}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:${n}Surface></bldg:boundedBy>`;
const bld = (h) => `<bldg:Building gml:id="a">${poly('Roof', `34.6 135.5 ${h} 34.6001 135.5 ${h} 34.6001 135.5001 ${h} 34.6 135.5001 ${h} 34.6 135.5 ${h}`)}${poly('Wall', `34.6 135.5 0 34.6 135.5 ${h} 34.6001 135.5 ${h} 34.6001 135.5 0 34.6 135.5 0`)}</bldg:Building>`;

function colors(glb) {
  const jl = glb.readUInt32LE(12), json = JSON.parse(glb.toString('utf8', 20, 20 + jl));
  const bv = json.bufferViews[json.accessors[2].bufferView], o = glb.byteOffset + 20 + jl + 8 + bv.byteOffset;
  return { json, C: new Float32Array(glb.buffer.slice(o, o + bv.byteLength)) };
}

test('LOD2 GLB 頂点色が全高さで LOD1 colorFor(屋根)/×0.78(壁) と一致し、黒化せず青灰系', () => {
  for (const h of [3, 10, 30, 60, 120]) {
    const mesh = buildLod2Mesh(new Map([['a', bld(h)]]), { lat: 34.6, lon: 135.5, h: 0 });
    const { json, C } = colors(meshToGlb(mesh));
    assert.ok(json.extensionsUsed.includes('KHR_materials_unlit'), '無陰影(時刻非依存)');
    const roof = colorFor(h).map((v) => v / 255), wall = colorFor(h).map((v) => Math.round(v * 0.78) / 255);
    // ENU 高さは楕円体曲率で h より ~1e-5m 小さく、丸め境界(例 h=3 → 186.5)で 1 階調ずれ得るため許容は 1 階調
    const ok = (i, ref) => ref.every((v, c) => Math.abs(C[i * 3 + c] - v) <= 1.01 / 255);
    for (let i = 0; i < C.length / 3; i++) {
      assert.ok(ok(i, roof) || ok(i, wall), `h=${h} 頂点${i} が LOD1 色と不一致`);
      const lum = (C[i * 3] + C[i * 3 + 1] + C[i * 3 + 2]) / 3;
      assert.ok(lum > 0.3, `h=${h} 黒化 lum=${lum}`);
      assert.ok(C[i * 3 + 2] > C[i * 3], '青>赤');
    }
  }
});

test('overlay は LOD2 tileset に style(色/アルファ上書き)を設定しない', () => {
  const s = fs.readFileSync(new URL('../tools/lod2/lod2-overlay.js', import.meta.url), 'utf8');
  assert.ok(!/\.style\s*=\s*(new\s+)?Cesium\.Cesium3DTileStyle|\.style\s*=\s*new/.test(s), 'LOD2 に Cesium3DTileStyle を付けていない');
});

test('single-pass(all-wards 既定)は LOD2 なしの区を空 LOD2 で続行し、旧 two-pass のみ失敗(未使用経路・変更せず)', () => {
  const s = fs.readFileSync(new URL('../tools/cloud/build-cloud-preview.mjs', import.meta.url), 'utf8');
  assert.ok(s.includes("const SINGLE = ALL ? !a.includes('--legacy-two-pass')"));
  assert.ok(s.includes('NO_LOD2 = true') && s.includes('writeEmptyLod2'));
});
