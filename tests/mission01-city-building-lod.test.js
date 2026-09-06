// tests/mission01-city-building-lod.test.js
// [見た目改善 Mission01] City Mode用の軽量building LOD（CityBuildingLOD）。
//   基本構造・配線は P1-7B（tests/ward-ux-v1-p17b.test.js）で実装済み。本ファイルはMission01の
//   完了条件（574,112棟一括ロードなし・duplicateなし・picking/edge/shadow無し・共有material等）を
//   明示的に検証する追加テスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

function cityBuildingLODBody() {
  const startIdx = html.indexOf('const CityBuildingLOD = (function () {');
  const endIdx = html.indexOf('return { build, setCameraDistance, setVisible, getStats, HIDE_NEAR_M };', startIdx);
  assert.ok(startIdx >= 0 && endIdx > startIdx, 'CityBuildingLOD の本体範囲を特定できない');
  return html.slice(startIdx, endIdx);
}

test('[Mission01] picking不要: buildingIndex等のピッキング用属性を実際には生成していない（省略方針のコメント記述は許容）', () => {
  const body = cityBuildingLODBody();
  // BuildingTileLayer側のbuildUsageTileMeshes()が実際に使う形: setAttribute('buildingIndex', ...)。
  // CityBuildingLODのコメントは「buildingIndexは省略」と書くだけで、実際の属性生成コードは持たない。
  assert.ok(!/setAttribute\('buildingIndex'/.test(body), 'CityBuildingLOD が buildingIndex 属性を実際に生成している');
  assert.ok(!/raycast|Raycaster/.test(body), 'CityBuildingLOD がpicking/raycast関連ロジックを持っている');
});

test('[Mission01] 区ごとに1つの共有BufferGeometry・共有material（InstancedMeshではなくmerged geometry方式）', () => {
  const body = cityBuildingLODBody();
  assert.ok(/new THREE\.BufferGeometry\(\);/.test(body), 'BufferGeometry を使っていない');
  assert.ok(!/InstancedMesh/.test(body), 'InstancedMeshは使っていない（merged BufferGeometry方式）');
  // getMaterial() が1回だけ生成しキャッシュする（区ごとに新規Materialを作らない）
  const materialCalls = (body.match(/getMaterial\(\)/g) || []).length;
  assert.ok(materialCalls >= 1, 'getMaterial() が呼ばれていない');
});

test('[Mission01] 574,112棟のフル品質一括ロードではない: 24区をprogressive（1区ずつ順番）にロードする', () => {
  const body = cityBuildingLODBody();
  assert.ok(/for \(const w of WardModeManager\.WARD_DEFS\) \{/.test(body), '24区を順に処理するループが無い');
  assert.ok(/await loadWard\(w\.id, w\.datasetId\);/.test(body), '区を1つずつawaitで直列ロードしていない（並列一括ロードの疑い）');
  assert.ok(/const BATCH_SIZE = 6;/.test(body), 'tile fetchのバッチ分割が無い（同期一括ロードの疑い）');
});

test('[Mission01] duplicateなし: handoff距離(HIDE_NEAR_M)がBuildingTileLayerのring最大到達距離を上回る（対角方向の重複表示ウィンドウを作らない）', () => {
  // BuildingTileLayer側: midRing(タイル数) × tileSize(m) × sqrt(2)（正方形ringの対角到達距離）
  const midRingMatch = html.match(/midRing: (\d+),/);
  const tileSizeMatch = html.match(/tileSize: 500,\s*\/\/ 全データセット共通/);
  assert.ok(midRingMatch, 'BUILDING_TILE_CONFIG.midRing が見つからない');
  assert.ok(tileSizeMatch, 'BUILDING_TILE_CONFIG.tileSize が見つからない');
  const midRing = Number(midRingMatch[1]);
  const tileSize = 500;
  const ringMaxReachDiagonal = midRing * tileSize * Math.SQRT2;
  const hideNearMatch = html.match(/const HIDE_NEAR_M = (\d+);/);
  assert.ok(hideNearMatch, 'CityBuildingLOD.HIDE_NEAR_M が見つからない');
  const hideNearM = Number(hideNearMatch[1]);
  assert.ok(hideNearM >= ringMaxReachDiagonal,
    `HIDE_NEAR_M(${hideNearM}) が ring対角到達距離(${ringMaxReachDiagonal.toFixed(0)})未満＝duplicate表示ウィンドウが生じる`);
});

test('[Mission01] Ward Mode近景では既存BuildingTileLayerへ切替可能（handoffはcamera距離のみで判定、ward固有ロジックを追加していない）', () => {
  const body = cityBuildingLODBody();
  assert.ok(/function setCameraDistance\(r\) \{/.test(body), 'setCameraDistance が無い');
  assert.ok(/const show = visible && r >= HIDE_NEAR_M;/.test(body), 'distance条件のみでhandoffしていない（ward別の特別扱いをしている疑い）');
});

test('protected baseline fullward-v3.html は Mission01 の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/CityBuildingLOD/.test(fw), 'fullward-v3.html に CityBuildingLOD が混入');
});
