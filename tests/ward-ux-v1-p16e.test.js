// tests/ward-ux-v1-p16e.test.js
// P1-6E: 実機描画修正（河川巨大面ガード / 建物・都市レイヤーの表示範囲整合）の静的検証。
//   ロジック本体は tools/lib/polygon-fill.js・tools/lib/ward-tile-coverage.js でテスト済み。
//   ここでは HTML への配線とガードの存在、および protected baseline 不変を確認する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const HTML = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML, 'utf-8');

test('ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(blocks.length >= 1);
  blocks.forEach((m, i) => {
    const f = path.join(os.tmpdir(), `wardux-p16e-${process.pid}-${i}.js`);
    fs.writeFileSync(f, m[1]);
    try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); }
    finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
  });
});

test('areaMesh: 入力正規化 + 分割結果検証 + line 除外ガードが入っている', () => {
  assert.ok(/function pfPrepare\(/.test(html) && /function pfValidate\(/.test(html), 'pfPrepare/pfValidate 未定義');
  // line は面フィルへ流さない
  assert.ok(/if \(f\.kind && f\.kind !== 'area'\) continue;.*中心線\(line\)/s.test(html)
    || /f\.kind !== 'area'\) continue; \/\/ \[P1-6E\/E\]/.test(html), 'line 除外ガードが無い');
  // 検証 NG は描画拒否
  assert.ok(/if \(!v\.ok\) \{ rejected\+\+; continue; \}/.test(html), '検証 NG 時に描画拒否していない');
  // 巨大 bbox の防御ガード
  assert.ok(/MAX_AREA_FEATURE_DIAG/.test(html) && /bbox-too-large/.test(html), 'MAX_AREA_FEATURE_DIAG ガードが無い');
});

test('water 材質: DoubleSide/opacity 0.85 の全面シートをやめ、FrontSide・depthWrite:false へ', () => {
  // areaMesh の material 定義（P1-7: buildParkMeshes がこの直後に続くため stationMesh 直前という
  //   位置依存の照合はやめ、material 生成ブロック自体を照合する）
  const m = html.match(/return new THREE\.Mesh\(g, new THREE\.MeshBasicMaterial\(\{\s*([\s\S]*?)\}\)\);\s*\}/);
  assert.ok(m, 'areaMesh の material 定義が見つからない');
  const mat = m[1];
  assert.ok(/side: THREE\.FrontSide/.test(mat), 'FrontSide になっていない（DoubleSide のまま）');
  assert.ok(/depthWrite: false/.test(mat), 'depthWrite:false が無い');
  assert.ok(/opacity: 0\.5/.test(mat), 'opacity を下げていない');
  assert.ok(/polygonOffset: true/.test(mat), 'polygonOffset が無い（地表と z-fight）');
});

test('[WATER-DRAW-DEBUG] / [BUILDING-DRAW-DEBUG] の診断出力がある', () => {
  assert.ok(/\[WATER-DRAW-DEBUG\]/.test(html), '[WATER-DRAW-DEBUG] が無い');
  assert.ok(/window\.__WATER_DRAW_DEBUG__/.test(html), 'WATER-DRAW-DEBUG のフラグゲートが無い');
  assert.ok(/\[BUILDING-DRAW-DEBUG\]/.test(html), '[BUILDING-DRAW-DEBUG] が無い');
  assert.ok(/window\.__BUILDING_DRAW_DEBUG__/.test(html), 'BUILDING-DRAW-DEBUG のフラグゲートが無い');
  assert.ok(/getDrawDebug\(\)/.test(html), 'BuildingTileLayer.getDrawDebug が無い');
});

test('Ward 全域カバー: 建物・都市レイヤーが同じ footprint を段階ロードする配線', () => {
  assert.ok(/function wardTilesForBboxXZ\(bbox, tileSize, cap, bufferM\)/.test(html), 'wardTilesForBboxXZ 未定義');
  // 建物側
  assert.ok(/loadDatasetBbox\(datasetId, bbox, cap\)/.test(html), 'BuildingTileLayer.loadDatasetBbox 未定義');
  assert.ok(/BuildingTileLayer\.loadDatasetBbox\(def\.datasetId, wt\.bbox\)/.test(html), 'switchWard(stream) で loadDatasetBbox を呼んでいない');
  // 都市レイヤー側
  assert.ok(/function coverBbox\(bbox\)/.test(html), 'CityTileLayer.coverBbox 未定義');
  assert.ok(/onWardSwitch\(x, z, bbox\)/.test(html), 'CityTileLayer.onWardSwitch が bbox を受けていない');
  assert.ok(/CityTileLayer\.onWardSwitch\(tgt\.x, tgt\.z, wardBbox\)/.test(html), 'flyToWardCentroid が bbox を渡していない');
  // getWardCameraTarget が bbox を返す
  assert.ok(/return \{ x: n03\.centroid\.x, z: n03\.centroid\.z, radius: diag \* 0\.62, bbox: n03\.bbox \}/.test(html), 'getWardCameraTarget が bbox を返していない');
});

test('CityTileLayer: 区1つ分の tile を LRU 退避させない上限に引き上げ', () => {
  const m = html.match(/const MAX_TILES_PER_LAYER = (\d+);/);
  assert.ok(m && Number(m[1]) >= 60, `MAX_TILES_PER_LAYER=${m && m[1]} は小さすぎる`);
});

test('既存レイヤー定義は重複・消失していない（html-regression と重複するが明示）', () => {
  for (const L of ['RoadLayer', 'ParkLayer', 'WaterLayer', 'BuildingTileLayer']) {
    const n = (html.match(new RegExp(`^const ${L} = `, 'gm')) || []).length;
    assert.equal(n, 1, `${L} の定義数が ${n}`);
  }
  assert.equal((html.match(/^const CityTileLayer = \(function \(\) \{/gm) || []).length, 1, 'CityTileLayer 定義数');
});

test('protected baseline fullward-v3.html は P1-6E の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/pfValidate|WATER-DRAW-DEBUG|loadDatasetBbox|wardTilesForBboxXZ/.test(fw), 'fullward-v3.html に P1-6E の変更が混入');
});
