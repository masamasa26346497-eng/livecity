// tests/mission02-road-lod.test.js
// [見た目改善 Mission02] 道路の距離LOD（City Mode遠景ノイズ低減）のHTML配線検証。
//   純粋ロジック（分類・band・可視判定）は tests/road-lod.test.js でカバー済み。
//   本ファイルはHTML(ward-ux-v1.html)側の inline 実装がそれと一致していること、
//   および tile mesh 分離・band変化時のみ再計算・デバッグAPI・Ward/City両対応を検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { classifyRoadLod, roadClassVisible, ROAD_LOD_BANDS } from '../tools/lib/road-lod.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

test('[Mission02] HTML inline のMAJOR/MID/LOCAL分類が road-lod.js と同じSetを使う', () => {
  assert.ok(/const ROAD_LOD_MAJOR = new Set\(\['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link'\]\);/.test(html),
    'ROAD_LOD_MAJOR が指示書の分類と一致しない');
  assert.ok(/const ROAD_LOD_MID = new Set\(\['secondary', 'secondary_link', 'tertiary', 'tertiary_link'\]\);/.test(html),
    'ROAD_LOD_MID が指示書の分類と一致しない');
  assert.ok(/function classifyRoadLod\(hw\) \{ if \(ROAD_LOD_MAJOR\.has\(hw\)\) return 'major'; if \(ROAD_LOD_MID\.has\(hw\)\) return 'mid'; return 'local'; \}/.test(html),
    'classifyRoadLod がMAJOR→MID→LOCALの優先順位で分類していない');
});

test('[Mission02] HTML inline のband境界(FAR>9000 / 3500<MID<=9000 / NEAR<=3500)がpure libと一致', () => {
  assert.ok(new RegExp(`const ROAD_LOD_FAR_M = ${ROAD_LOD_BANDS.farM}, ROAD_LOD_MID_M = ${ROAD_LOD_BANDS.midM};`).test(html),
    'ROAD_LOD_FAR_M/ROAD_LOD_MID_M がpure libのROAD_LOD_BANDSと一致しない');
  assert.ok(/function roadLodBand\(d\) \{ if \(d > ROAD_LOD_FAR_M\) return 'far'; if \(d > ROAD_LOD_MID_M\) return 'mid'; return 'near'; \}/.test(html),
    'roadLodBand の実装が違う');
});

test('[Mission02] FARではMAJORのみ・MIDではMAJOR+MID・NEARでは全道路（HTML inline関数を直接実行して検証）', () => {
  // HTML内の関数定義を抜き出してNode上で直接評価し、実際の挙動を確認する（正規表現一致だけでなく）。
  const startIdx = html.indexOf('const ROAD_LOD_MAJOR = new Set');
  const endIdx = html.indexOf('// [Mission12] 公園を面積で', startIdx);
  assert.ok(startIdx >= 0 && endIdx > startIdx, 'road LOD 関数群の範囲を特定できない');
  const src = html.slice(startIdx, endIdx);
  const fn = new Function(`${src}\nreturn { classifyRoadLod, roadLodBand, roadClassVisible };`);
  const { classifyRoadLod: htmlClassify, roadClassVisible: htmlVisible } = fn();

  for (const hw of ['motorway', 'trunk', 'primary']) assert.equal(htmlClassify(hw), 'major', hw);
  for (const hw of ['secondary', 'tertiary']) assert.equal(htmlClassify(hw), 'mid', hw);
  for (const hw of ['residential', 'unclassified', 'service', '']) assert.equal(htmlClassify(hw), 'local', hw);

  const far = ROAD_LOD_BANDS.farM + 1000;
  assert.equal(htmlVisible('major', far), true);
  assert.equal(htmlVisible('mid', far), false);
  assert.equal(htmlVisible('local', far), false);

  const mid = (ROAD_LOD_BANDS.farM + ROAD_LOD_BANDS.midM) / 2;
  assert.equal(htmlVisible('major', mid), true);
  assert.equal(htmlVisible('mid', mid), true);
  assert.equal(htmlVisible('local', mid), false);

  const near = ROAD_LOD_BANDS.midM - 100;
  assert.equal(htmlVisible('major', near), true);
  assert.equal(htmlVisible('mid', near), true);
  assert.equal(htmlVisible('local', near), true);

  // pure lib と完全一致すること（二重実装のズレ防止）
  for (const hw of ['motorway', 'secondary', 'residential', 'tertiary_link', 'unknown_tag']) {
    assert.equal(htmlClassify(hw), classifyRoadLod(hw), `分類がpure libとズレている: ${hw}`);
  }
  for (const d of [1000, 3500, 3501, 9000, 9001, 15000]) {
    for (const cls of ['major', 'mid', 'local']) {
      assert.equal(htmlVisible(cls, d), roadClassVisible(cls, d), `可視判定がpure libとズレている: cls=${cls} d=${d}`);
    }
  }
});

test('[Mission02] tileごとに道路meshを最大3つ（major/mid/local）へ分離する', () => {
  const idx = html.indexOf('function buildRoadMeshes(features, y, baseColor) {');
  assert.ok(idx >= 0, 'buildRoadMeshes 未定義');
  const body = html.slice(idx, idx + 1200);
  assert.ok(/const buckets = \{ major: \[\], mid: \[\], local: \[\] \};/.test(body), 'major/mid/localの3バケットに分離していない');
  assert.ok(/for \(const tier of \['major', 'mid', 'local'\]\)/.test(body), '3tierのみ mesh 化している（過剰なmesh分割をしていない）');
});

test('[Mission02] band変化時のみ全走査で再適用する（毎フレーム全feature走査しない）', () => {
  assert.ok(/let lastCityLodKey = null;/.test(html), 'lastCityLodKeyによる変化検出が無い');
  assert.ok(/if \(!force && key === lastCityLodKey\) return;/.test(html), 'キー不変時にearly returnしていない（毎フレーム再走査の疑い）');
  // road LOD の band境界(9000/3500)がキーに含まれている
  assert.ok(/const key = waterBand\(distance\) \+ '\|' \+ \(distance <= 9000\) \+ '\|' \+ \(distance <= 3500\)/.test(html),
    'applyCityLODのkeyに道路band境界(9000\/3500)が含まれていない');
});

test('[Mission02] applyLodToOneMesh が roadClassVisible を使う（旧roadTierVisibleは残っていない）', () => {
  assert.ok(/if \(ud\.roadTier\) \{ m\.visible = layerEnabled\.roads && roadClassVisible\(ud\.roadTier, distance\); return; \}/.test(html),
    'applyLodToOneMesh が新しい roadClassVisible を使っていない');
  assert.ok(!/roadTierVisible|ROAD_TIER_MAJOR|ROAD_TIER_SECONDARY|function roadTierOf/.test(html), '旧2段階(major/secondary)実装が残っている');
});

test('[Mission02・指示書8節] CityTileLayer.getRoadLodDebug(): distance/band/各クラス可視/feature数を返す', () => {
  assert.ok(/function getRoadLodDebug\(\) \{/.test(html), 'getRoadLodDebug 未定義');
  const idx = html.indexOf('function getRoadLodDebug() {');
  const body = html.slice(idx, idx + 900);
  for (const field of ['distance', 'band', 'majorVisible', 'midVisible', 'localVisible', 'majorFeatureCount', 'midFeatureCount', 'localFeatureCount']) {
    assert.ok(body.includes(field), `getRoadLodDebug の戻り値に ${field} が無い`);
  }
  assert.ok(/getRoadLodDebug, \/\/ \[見た目改善 Mission02\]/.test(html), 'CityTileLayer が getRoadLodDebug を公開していない');
});

test('[Mission02] Ward Modeでも同じ buildRoadMeshes/classifyRoadLod が使われる（Ward専用の別ロジックを追加していない）', () => {
  // CityTileLayerはWard Mode（区周辺のtile progressive load）とCity Modeの両方で共有される単一実装。
  // Ward専用の道路分類・LOD関数が別途追加されていないことを確認する。
  const roadLodFnNames = (html.match(/function (roadTierOf|classifyRoadLod|roadLodBand|roadClassVisible|buildRoadMeshes)\(/g) || []);
  const unique = new Set(roadLodFnNames);
  assert.ok(!unique.has('function roadTierOf('), '旧関数roadTierOfが残っている');
  // 各関数が1回だけ定義されている（Ward/City用に重複定義していない）
  for (const name of ['classifyRoadLod', 'roadLodBand', 'roadClassVisible', 'buildRoadMeshes']) {
    const count = (html.match(new RegExp(`function ${name}\\(`, 'g')) || []).length;
    assert.equal(count, 1, `${name} が複数回定義されている（Ward/Cityで分離している疑い）`);
  }
});

test('protected baseline fullward-v3.html は Mission02 の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/ROAD_LOD_MAJOR|classifyRoadLod|getRoadLodDebug/.test(fw), 'fullward-v3.html に Mission02 の変更が混入');
});
