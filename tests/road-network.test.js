// tests/road-network.test.js
// [Mission23] tools/lib/road-network.js の純粋ロジック（分類 / access フィルタ / 幅 / 連続性監査）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRoad, classifyRoadLod, resolveRoadWidth, auditRoadContinuity,
  ROAD_DETAIL, ROAD_W_MIN, ROAD_W_MAX, polylineLengthXZ,
} from '../tools/lib/road-network.js';

test('[Mission23] classifyRoad: tier（major/mid/local）', () => {
  assert.equal(classifyRoad({ highway: 'motorway' }).tier, 'major');
  assert.equal(classifyRoad({ highway: 'primary_link' }).tier, 'major');
  assert.equal(classifyRoad({ highway: 'secondary' }).tier, 'mid');
  assert.equal(classifyRoad({ highway: 'tertiary_link' }).tier, 'mid');
  assert.equal(classifyRoad({ highway: 'residential' }).tier, 'local');
  assert.equal(classifyRoad({ highway: 'service' }).tier, 'local');
  assert.equal(classifyRoad({ highway: 'pedestrian' }).tier, 'local');
});

test('[Mission23] classifyRoad: detail 細分類', () => {
  assert.equal(classifyRoad({ highway: 'residential' }).detail, ROAD_DETAIL.LOCAL_RESIDENTIAL);
  assert.equal(classifyRoad({ highway: 'living_street' }).detail, ROAD_DETAIL.LOCAL_LIVING);
  assert.equal(classifyRoad({ highway: 'unclassified' }).detail, ROAD_DETAIL.LOCAL_UNCLASSIFIED);
  assert.equal(classifyRoad({ highway: 'service' }).detail, ROAD_DETAIL.LOCAL_SERVICE);
  assert.equal(classifyRoad({ highway: 'pedestrian' }).detail, ROAD_DETAIL.PEDESTRIAN);
  assert.equal(classifyRoad({ highway: 'road' }).detail, ROAD_DETAIL.LOCAL_ROAD);
});

test('[Mission23] classifyRoad: access / service フィルタ（§5）', () => {
  assert.equal(classifyRoad({ highway: 'service', service: 'driveway' }).eligible, false);
  assert.equal(classifyRoad({ highway: 'service', service: 'parking_aisle' }).eligible, false);
  assert.equal(classifyRoad({ highway: 'service', service: 'alley' }).eligible, true, '路地(alley)は公共の通り抜け＝残す');
  assert.equal(classifyRoad({ highway: 'residential', access: 'private' }).eligible, false);
  assert.equal(classifyRoad({ highway: 'residential', access: 'no' }).eligible, false);
  assert.equal(classifyRoad({ highway: 'residential', motor_vehicle: 'no' }).eligible, false);
  // pedestrian / living_street は motor_vehicle=no でも正当
  assert.equal(classifyRoad({ highway: 'pedestrian', motor_vehicle: 'no' }).eligible, true);
});

test('[Mission23] classifyRoad: footway/path/steps/cycleway は対象外', () => {
  for (const hw of ['footway', 'path', 'steps', 'cycleway', 'corridor', 'construction']) {
    assert.equal(classifyRoad({ highway: hw }).eligible, false, hw);
  }
});

test('[Mission26] classifyRoad: track は access で通行可否を判定（既定は eligible / 農地・林道は除外）', () => {
  assert.equal(classifyRoad({ highway: 'track' }).eligible, true);
  assert.equal(classifyRoad({ highway: 'track' }).detail, 'LOCAL_TRACK');
  assert.equal(classifyRoad({ highway: 'track' }).tier, 'local');
  assert.equal(classifyRoad({ highway: 'track', access: 'private' }).eligible, false);
  assert.equal(classifyRoad({ highway: 'track', access: 'agricultural' }).eligible, false);
  assert.equal(classifyRoad({ highway: 'track', access: 'forestry' }).eligible, false);
  assert.equal(classifyRoad({ highway: 'track', access: 'yes' }).eligible, true);
});

test('[Mission26] classifyRoad: service=alley は LOCAL_ALLEY / ultraLocal', () => {
  const a = classifyRoad({ highway: 'service', service: 'alley' });
  assert.equal(a.eligible, true);
  assert.equal(a.detail, 'LOCAL_ALLEY');
  assert.equal(a.ultraLocal, true);
  assert.equal(a.serviceType, 'alley');
  const s = classifyRoad({ highway: 'service' });
  assert.equal(s.detail, 'LOCAL_SERVICE');
  assert.equal(s.ultraLocal, false);
});

test('[Mission23] classifyRoad: bridge / tunnel / underground', () => {
  assert.equal(classifyRoad({ highway: 'primary', bridge: 'yes' }).bridge, true);
  assert.equal(classifyRoad({ highway: 'primary', tunnel: 'yes' }).underground, true);
  assert.equal(classifyRoad({ highway: 'primary', layer: '-1' }).underground, true);
  assert.equal(classifyRoad({ highway: 'primary', bridge: 'yes', layer: '1' }).underground, false);
});

test('[Mission23] resolveRoadWidth: width → lanes → class default', () => {
  assert.deepEqual(resolveRoadWidth({ highway: 'residential', width: '8' }), { width: 8, source: 'width' });
  assert.deepEqual(resolveRoadWidth({ highway: 'residential', lanes: '2' }), { width: 6.5, source: 'lanes' });
  const d = resolveRoadWidth({ highway: 'residential' });
  assert.equal(d.source, 'class-default');
  assert.ok(d.width >= ROAD_W_MIN && d.width <= ROAD_W_MAX);
  // clamp
  assert.equal(resolveRoadWidth({ highway: 'service', width: '0.5' }).width, ROAD_W_MIN);
  assert.equal(resolveRoadWidth({ highway: 'motorway', width: '999' }).width, ROAD_W_MAX);
});

test('[Mission23] classifyRoadLod は road-lod.js から再エクスポートされる', () => {
  assert.equal(classifyRoadLod('primary'), 'major');
  assert.equal(classifyRoadLod('unclassified'), 'local');
});

test('[Mission23] auditRoadContinuity: T字接続（端点が別道路の途中に載る）は dangling でない', () => {
  const roads = [
    { p: [[0, 0], [100, 0]], id: 'a' },       // 横棒
    { p: [[50, 0], [50, 80]], id: 'b' },       // 縦棒（端点 (50,0) は a の途中に載る）
  ];
  const r = auditRoadContinuity(roads, { tolM: 6 });
  // a の両端は孤立（袋小路）、b の (50,80) も孤立 → dangling 3、(50,0) は接続扱い
  assert.equal(r.danglingEndpoints, 3);
  assert.equal(r.tileBoundaryBreaks, 0, 'line は tile 境界でクリップされない＝構造的に 0');
});

test('[Mission23] auditRoadContinuity: cityEdgeClips は wardRings で分離される', () => {
  const ring = [[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]];
  const roads = [{ p: [[0, 0], [0, 9.9]], id: 'x' }]; // (0,9.9) は ring の辺 z=10 の近く
  const r = auditRoadContinuity(roads, { tolM: 6, wardRings: [ring], cityEdgeTolM: 5 });
  assert.ok(r.cityEdgeClips >= 1, '区界近傍の孤立端点が cityEdgeClips に分類されない');
});

test('[Mission23] polylineLengthXZ', () => {
  assert.equal(polylineLengthXZ([[0, 0], [3, 4]]), 5);
});
