// Mission 152: LOD2選択モジュールのfixtureテスト(合成CityGML。実データではない)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLod2Index, planBuildingSources, assertDisjoint, pickRepresentation, FALLBACK,
} from '../tools/lod2/lod2-selector.js';

const poly = (name, coords) => `<bldg:boundedBy><bldg:${name}Surface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>${coords}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:${name}Surface></bldg:boundedBy>`;
const full = (id, top, tex = '') => `<bldg:Building gml:id="${id}"><bldg:lod2Solid><gml:Solid/></bldg:lod2Solid>
${poly('Roof', `34.6 135.5 ${top} 34.6001 135.5 ${top + 2} 34.6001 135.5001 ${top} 34.6 135.5 ${top}`)}
${poly('Wall', '34.6 135.5 0 34.6 135.5 10 34.6001 135.5 10 34.6001 135.5 0 34.6 135.5 0')}
${poly('Ground', '34.6 135.5 0 34.6001 135.5 0 34.6001 135.5001 0 34.6 135.5 0')}${tex}</bldg:Building>`;
const GML = `<core:CityModel>
${full('bldg_A', 10, '<app:ParameterizedTexture/>')}
${full('bldg_B', 8)}
<bldg:Building gml:id="bldg_C"><bldg:lod1Solid><gml:Solid/></bldg:lod1Solid></bldg:Building>
${full('bldg_D', -5)}
<bldg:Building gml:id="bldg_E"><bldg:lod2Solid><gml:Solid/></bldg:lod2Solid></bldg:Building>
${full('bldg_X', 9)}
</core:CityModel>`;

test('LOD2を持つ建物のみ索引化し、診断(高さ/テクスチャ/勾配)を出す', () => {
  const { index, totalBuildings } = buildLod2Index([GML]);
  assert.equal(totalBuildings, 6);
  assert.equal(index.has('bldg_C'), false); // LOD1のみ
  const a = index.get('bldg_A');
  assert.equal(a.valid, true);
  assert.equal(a.heightM, 12); // 屋根頂12 - 底面0
  assert.equal(a.roofRelief, 2); // 勾配あり
  assert.equal(a.hasTexture, true);
  assert.equal(index.get('bldg_B').hasTexture, false);
});

test('LOD2あり→LOD2のみ描画、なし/不正/包絡欠損→LOD1フォールバック、重複なし', () => {
  const { index } = buildLod2Index([GML]);
  const plan = planBuildingSources(['bldg_A', 'bldg_B', 'bldg_C', 'bldg_D', 'bldg_E'], index);
  assertDisjoint(plan);
  assert.deepEqual([...plan.lod2Draw].sort(), ['bldg_A', 'bldg_B']);
  assert.deepEqual([...plan.lod1Draw].sort(), ['bldg_C', 'bldg_D', 'bldg_E']);
  assert.equal(plan.fallbacks.get('bldg_D'), FALLBACK.INVALID_GEOMETRY);
  assert.equal(plan.fallbacks.get('bldg_E'), FALLBACK.NO_ENVELOPE);
  assert.equal(plan.fallbacks.get('bldg_X'), FALLBACK.NOT_IN_LOD1); // LOD1に無いIDは描かない
  assert.equal(plan.stats.lod2Used, 2);
  assert.equal(plan.stats.withTexture, 1);
});

test('LOD2が一件もなければ全棟LOD1(全棟LOD2と偽らない)', () => {
  const plan = planBuildingSources(['p', 'q'], new Map());
  assert.equal(plan.lod2Draw.size, 0);
  assert.equal(plan.lod1Draw.size, 2);
  assert.equal(plan.stats.lod2Ratio, 0);
});

test('容量超過はLOD1へフォールバック', () => {
  const { index } = buildLod2Index([GML]);
  const plan = planBuildingSources(['bldg_A', 'bldg_B'], index, { maxTotalTriangles: 7});
  assert.equal(plan.lod2Draw.size, 1);
  assert.equal(plan.fallbacks.get('bldg_B'), FALLBACK.OVER_BYTE_BUDGET);
  assertDisjoint(plan);
});

test('距離による表現選択はヒステリシスで境界ちらつきを防ぐ', () => {
  assert.equal(pickRepresentation(300, 'lod1'), 'lod2');
  assert.equal(pickRepresentation(450, 'lod1'), 'lod1');
  assert.equal(pickRepresentation(450, 'lod2'), 'lod2'); // 近→遠の途中は維持
  assert.equal(pickRepresentation(600, 'lod2'), 'lod1');
});
