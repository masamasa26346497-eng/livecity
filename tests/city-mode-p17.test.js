// tests/city-mode-p17.test.js
// P1-7: City Mode（大阪市24区全域表示）の純粋ロジック（tools/lib/city-mode.js）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cityCameraTarget, classifyRoadLod, roadClassVisible, classifyParkArea, parkClassVisible,
  classifyRail, railClassVisible, railIncluded, polylineLengthXZ, stationVisible,
  batchProgressive, sortTilesByCenterDistance,
  PARK_AREA_LARGE_M2, PARK_AREA_MEDIUM_M2, RAIL_MAJOR_MIN_LEN_M, STATION_MAX_M,
} from '../tools/lib/city-mode.js';

const OSAKA_CITY_GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };

test('cityCameraTarget: ハードコードでなく extent から center/width/height/diag/radius を算出', () => {
  const t = cityCameraTarget(OSAKA_CITY_GROUND_EXTENT, { maxR: 24000 });
  assert.equal(t.x, (-16900 + 7100) / 2);
  assert.equal(t.z, (-18600 + 2300) / 2);
  assert.equal(t.width, 24000);
  assert.equal(t.height, 20900);
  assert.ok(Math.abs(t.diag - Math.hypot(24000, 20900)) < 1e-6);
  assert.ok(t.radius > 12000 && t.radius <= 20000, `radius=${t.radius}`);
});

test('cityCameraTarget: 既定 radiusFactor=0.5（市外の余白が目立たないようward用の0.62より詰める）', () => {
  const t = cityCameraTarget(OSAKA_CITY_GROUND_EXTENT, {});
  const expected = Math.hypot(24000, 20900) * 0.5;
  assert.ok(Math.abs(t.radius - expected) < 1e-6, `radius=${t.radius} expected=${expected}`);
});

test('cityCameraTarget: maxR でクランプされる', () => {
  const t = cityCameraTarget(OSAKA_CITY_GROUND_EXTENT, { radiusFactor: 5, maxR: 9000 });
  assert.equal(t.radius, 9000);
});

test('[Mission02] city-mode.js は road-lod.js の分類/可視判定を re-export している', () => {
  // 詳細な仕様（3クラス分類・FAR/MID/NEAR band）は tests/road-lod.test.js でカバー済み。
  // ここでは city-mode.js 経由でも同じ関数が使えることだけ確認する。
  assert.equal(classifyRoadLod('motorway'), 'major');
  assert.equal(classifyRoadLod('tertiary'), 'mid');
  assert.equal(classifyRoadLod('residential'), 'local');
  assert.equal(roadClassVisible('major', 15000), true);
  assert.equal(roadClassVisible('mid', 15000), false);
  assert.equal(roadClassVisible('local', 15000), false);
});

test('[Mission12] classifyParkArea / parkClassVisible: FAR=large / MID=large+medium / NEAR=all', () => {
  assert.equal(classifyParkArea(PARK_AREA_LARGE_M2), 'large');
  assert.equal(classifyParkArea(PARK_AREA_LARGE_M2 - 1), 'medium');
  assert.equal(classifyParkArea(PARK_AREA_MEDIUM_M2), 'medium');
  assert.equal(classifyParkArea(PARK_AREA_MEDIUM_M2 - 1), 'small');
  assert.equal(classifyParkArea(0), 'small');
  assert.equal(classifyParkArea(NaN), 'small');
  // FAR (>9000)
  assert.equal(parkClassVisible('large', 12000), true);
  assert.equal(parkClassVisible('medium', 12000), false);
  assert.equal(parkClassVisible('small', 12000), false);
  // MID (3500-9000)
  assert.equal(parkClassVisible('large', 6000), true);
  assert.equal(parkClassVisible('medium', 6000), true);
  assert.equal(parkClassVisible('small', 6000), false);
  // NEAR (<=3500)
  assert.equal(parkClassVisible('large', 1000), true);
  assert.equal(parkClassVisible('medium', 1000), true);
  assert.equal(parkClassVisible('small', 1000), true);
});

test('[Mission13] classifyRail / railClassVisible: MAJOR/URBAN/LOCAL + FAR/MID/NEAR band', () => {
  // subway=urban / light_rail=local / rail は長さで major(>=60m) or local
  assert.equal(classifyRail('subway', 5000), 'urban');
  assert.equal(classifyRail('light_rail', 5000), 'local');
  assert.equal(classifyRail('rail', 500), 'major');
  assert.equal(classifyRail('rail', 40), 'local', '短い rail way は側線=local');
  assert.equal(classifyRail('rail', RAIL_MAJOR_MIN_LEN_M), 'major');
  assert.equal(classifyRail('tram', 100), 'local');
  // FAR (>9000): major only
  assert.equal(railClassVisible('major', 12000), true);
  assert.equal(railClassVisible('urban', 12000), false);
  assert.equal(railClassVisible('local', 12000), false);
  // MID (3500-9000): major + urban
  assert.equal(railClassVisible('major', 6000), true);
  assert.equal(railClassVisible('urban', 6000), true);
  assert.equal(railClassVisible('local', 6000), false);
  // NEAR (<=3500): all
  assert.equal(railClassVisible('local', 2000), true);
  // 廃線・工事中は除外
  assert.equal(railIncluded('rail'), true);
  assert.equal(railIncluded('construction'), false);
  assert.equal(railIncluded('abandoned'), false);
  // 長さ計算
  assert.equal(polylineLengthXZ([[0, 0], [30, 40]]), 50);
});

test('stationVisible: 遠景では非表示、閾値内で表示', () => {
  assert.equal(stationVisible(STATION_MAX_M - 1), true);
  assert.equal(stationVisible(STATION_MAX_M + 1), false);
  assert.equal(stationVisible(15000), false, '大阪市全域を一望する距離では駅を全件表示しない');
});

test('batchProgressive: 156 tile を同期一括ロードせず N 件ずつに分割する', () => {
  const list = Array.from({ length: 156 }, (_, i) => ({ tx: i, tz: 0 }));
  const batches = batchProgressive(list, 10);
  assert.equal(batches.length, 16); // ceil(156/10)
  assert.equal(batches[0].length, 10);
  assert.equal(batches.flat().length, 156);
  // 順序を保持（中心→外のソート後の順序が壊れない）
  assert.deepEqual(batches.flat().map((t) => t.tx), list.map((t) => t.tx));
});

test('sortTilesByCenterDistance: 中心タイルから近い順（progressive load の順序）', () => {
  const tiles = [{ tx: 5, tz: 5 }, { tx: 0, tz: 0 }, { tx: -3, tz: -3 }, { tx: 1, tz: 0 }];
  const sorted = sortTilesByCenterDistance(tiles, 0, 0);
  assert.deepEqual(sorted[0], { tx: 0, tz: 0 });
  assert.deepEqual(sorted[1], { tx: 1, tz: 0 });
  // 距離が単調非減少
  let prev = -1;
  for (const t of sorted) {
    const d = Math.hypot(t.tx, t.tz);
    assert.ok(d >= prev - 1e-9);
    prev = d;
  }
  // 元配列は変更しない
  assert.deepEqual(tiles, [{ tx: 5, tz: 5 }, { tx: 0, tz: 0 }, { tx: -3, tz: -3 }, { tx: 1, tz: 0 }]);
});
