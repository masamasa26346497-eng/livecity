// tests/ward-ux-v1-p17b.test.js
// P1-7B: City Mode 最終整形（ward-ux-v1.html 配線検証）。
//   純粋ロジックの polyline clip は tools/lib/polyline-ward-clip.js / tests/polyline-ward-clip.test.js、
//   road tier / camera radiusFactor は tests/city-mode-p17.test.js / tests/ward-ux-v1-p17.test.js で
//   カバー済み。ここでは本ラウンドで追加した Ground extent 対策のみを検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

test('[P1-7B] Ground extent: computeBounds が groundPad で OSAKA_CITY_GROUND_EXTENT より外側まで拡張する', () => {
  assert.ok(/groundPad: 9000/.test(html), 'GROUND_VISUAL_STYLE.groundPad が定義されていない');
  assert.ok(/const pad = GROUND_VISUAL_STYLE\.groundPad \|\| 0;/.test(html), 'computeBounds が groundPad を参照していない');
  assert.ok(/minX: Math\.min\(minX - m, E\.minX - pad\), maxX: Math\.max\(maxX \+ m, E\.maxX \+ pad\),/.test(html),
    'computeBounds の bounds 算出に pad が反映されていない');
  // OSAKA_CITY_GROUND_EXTENT 定数自体は camera/tile grid と共有のため不変であること
  assert.ok(/const OSAKA_CITY_GROUND_EXTENT = \{ minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 \};/.test(html),
    'OSAKA_CITY_GROUND_EXTENT 定数が変更されている（camera/tile grid 側へ影響するため変更禁止）');
});

test('[P1-7B/Mission17] Ground extent: colorReal を背景/fog と同一色にして遠景での境目を消す', () => {
  assert.ok(/GROUND_VISUAL_STYLE\.colorReal = MODEL_STYLE\.on \? MS_BG_NEUTRAL : GROUND_VISUAL_STYLE\._crOrig;/.test(html),
    '地表色が背景色(MS_BG_NEUTRAL)へ統一されていない');
  // legacy 復元用の _crOrig 退避は維持
  assert.ok(/if \(GROUND_VISUAL_STYLE\._crOrig === undefined\) GROUND_VISUAL_STYLE\._crOrig = GROUND_VISUAL_STYLE\.colorReal;/.test(html),
    'legacy 復元用の _crOrig 退避が無い');
});

test('[P1-7B] CityBuildingLOD: 24区の軽量建物メッシュを progressive load し、近距離でBuildingTileLayer実体へhandoffする', () => {
  assert.ok(/const CityBuildingLOD = \(function \(\) \{/.test(html), 'CityBuildingLOD 未定義');
  assert.ok(/const HIDE_NEAR_M = 4000;/.test(html), 'handoff距離しきい値が無い（Mission01でring最大到達距離を踏まえ4000へ調整）');
  // manifest/tile の fetch URL は BuildingTileLayer と同じ basePath・構造を使う（データ形状を独自定義しない）
  assert.ok(/\$\{BUILDING_TILE_CONFIG\.basePath\}\/\$\{datasetId\}\/manifest\.json/.test(html), 'manifest fetch URL が BuildingTileLayer と揃っていない');
  assert.ok(/\$\{BUILDING_TILE_CONFIG\.basePath\}\/\$\{datasetId\}\/tile_\$\{t\.tx\}_\$\{t\.tz\}\.json/.test(html), 'tile fetch URL が BuildingTileLayer と揃っていない');
  // 軽量化: 壁のみ押し出し+屋根（fan）。底面・エッジ・UV・buildingIndex属性は生成しない
  //   （[Mission09] 頂点カラー wc = 軽い接地暗化のみは許容。UV/buildingIndex は不可）
  assert.ok(/function appendBuilding\(wv, wc, b\)/.test(html), 'appendBuilding（壁+屋根のみの押し出し）が無い');
  assert.ok(!/appendBuilding[\s\S]{0,120}wuv|setAttribute\('uv'[\s\S]{0,200}CityBuildingLOD/.test(html), 'CityBuildingLOD が UV 属性を持っている疑い');
  // 共有マテリアル1個（区ごとに新規マテリアルを作らない）・影なし・vertexColors（軽い接地暗化）は可
  assert.ok(/function getMaterial\(\) \{[\s\S]{0,300}sharedMaterial = new THREE\.MeshLambertMaterial\(\{ color: LOD_COLOR, vertexColors: true \}\);/.test(html),
    '共有マテリアルが1個になっていない');
  assert.ok(/mesh\.castShadow = false; mesh\.receiveShadow = false;/.test(html), 'CityBuildingLOD が影を落とす設定になっている（軽量方針違反）');
  // CityModeManager.enter() から起動され、camUpdからカメラ距離で表示/非表示が切り替わる
  assert.ok(/if \(typeof CityBuildingLOD !== 'undefined'\) CityBuildingLOD\.build\(\);/.test(html), 'CityModeManager.enter() が CityBuildingLOD.build() を呼んでいない');
  assert.ok(/if \(typeof CityBuildingLOD !== 'undefined'\) CityBuildingLOD\.setCameraDistance\(cs\.r\);/.test(html), 'camUpd が CityBuildingLOD.setCameraDistance を呼んでいない');
  // layer-toggle「建物」と連動
  assert.ok(/if \(typeof CityBuildingLOD !== 'undefined'\) CityBuildingLOD\.setVisible\(on\);/.test(html), '建物レイヤートグルが CityBuildingLOD に配線されていない');
});

test('protected baseline fullward-v3.html は本ラウンドの変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/groundPad/.test(fw), 'fullward-v3.html に groundPad が混入');
  assert.ok(!/CityBuildingLOD/.test(fw), 'fullward-v3.html に CityBuildingLOD が混入');
});
