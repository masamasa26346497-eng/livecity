// Mission 166: 合成 fixture のテスト(実データではない)。実データ比較は tools/lod2/lod2-lod1-compare.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareBuilding, summarize } from '../tools/lod2/lod2-lod1-compare.mjs';
import { lod2IdsFromManifest, planLod1Exclusion, styleShowExpression } from '../tools/lod2/lod2-lod1-exclude.mjs';
import { validateTag, defaultTag } from '../tools/lod2/lod2-persist.mjs';

const pl = (z0, z1) => `<gml:posList>34.0 135.0 ${z0} 34.0 135.001 ${z0} 34.001 135.001 ${z1} 34.0 135.0 ${z0}</gml:posList>`;
const bldg = (l2) => `<bldg:measuredHeight>5</bldg:measuredHeight><bldg:lod1Solid>${pl(10, 15)}</bldg:lod1Solid>` +
  (l2 ? `<bldg:lod2MultiSurface>${pl(10.1, 14)}</bldg:lod2MultiSurface><bldg:lod2MultiSurface>${pl(10.1, 16)}</bldg:lod2MultiSurface>` : '');

test('LOD2 の無い棟は比較対象外、複数の lod2 ブロックを全て読む', () => {
  assert.equal(compareBuilding(bldg(false)), null);
  const r = compareBuilding(bldg(true));
  assert.equal(r.l2Base, 10.1);
  assert.equal(r.l2Height, 5.9); // 2 つ目のブロックの 16 も反映(最初の 1 つだけではない)
  assert.ok(Math.abs(r.baseDiffM - 0.1) < 1e-9);
  assert.equal(r.horizDiffM, 0);
});
test('底面差が大きいと minH→0 は一貫しないと判定', () => {
  assert.equal(summarize([{ baseDiffM: 0.1, heightDiffM: 0, horizDiffM: 0 }]).perBuildingGroundToZeroConsistent, true);
  assert.equal(summarize([{ baseDiffM: 3, heightDiffM: 0, horizDiffM: 0 }]).perBuildingGroundToZeroConsistent, false);
  assert.equal(summarize([]).perBuildingGroundToZeroConsistent, false);
});
test('LOD1 除外: LOD2 のある棟だけ除外し、LOD2 の無い LOD1 は欠落しない', () => {
  const m = { assets: [{ ids: ['a', 'b'] }, { ids: ['z'] }] };
  const p = planLod1Exclusion(new Set(['a', 'b', 'c', 'd']), lod2IdsFromManifest(m));
  assert.equal(p.excluded, 2);
  assert.deepEqual([...p.lod1Kept].sort(), ['c', 'd']);
  assert.deepEqual(p.lod2WithoutLod1, ['z']);
  assert.equal(p.noLossCheck, true);
});
test('LOD2 ID の重複は拒否、巨大な style 式は null', () => {
  assert.throws(() => lod2IdsFromManifest({ assets: [{ ids: ['a'] }, { ids: ['a'] }] }));
  assert.equal(styleShowExpression(new Set(['a', 'b']), 'x', 1), null);
  assert.match(styleShowExpression(new Set(['a'])), /!== "a"/);
});
test('private 保存: 既存タグの上書き拒否、タグ形式検証', () => {
  assert.throws(() => validateTag('lod2-osaka2025-x', ['lod2-osaka2025-x']));
  assert.throws(() => validateTag('plateau2025-converted'));
  assert.equal(validateTag(defaultTag()), defaultTag());
});
