// tests/ward-ux-v1-p16f.test.js
// P1-6F: HTML 側の配線検証（SOURCE geometry 追跡 + 巨大 feature ガード + LRU dedup 修正）。
//   ロジック本体は tools/lib/{polygon-fill,osm-multipolygon,feature-ward-overlap,water-semantic-validator}.js でテスト済み。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

test('[WATER-DRAW-DEBUG] に sourceType / sourceId が出る', () => {
  const m = html.match(/\[WATER-DRAW-DEBUG\][\s\S]{0,600}?\}\)\);/);
  assert.ok(m, '[WATER-DRAW-DEBUG] ブロックが無い');
  assert.ok(/sourceType: f\.source \? f\.source\.type/.test(m[0]), 'sourceType が出力されていない');
  assert.ok(/sourceId: f\.source \? f\.source\.id/.test(m[0]), 'sourceId が出力されていない');
});

test('CityTileLayer: LRU dedup 修正（ownedIds / reconcileLayer / renderTileMeshes）', () => {
  assert.ok(/function renderTileMeshes\(layer, key, rec\)/.test(html), 'renderTileMeshes 未定義');
  assert.ok(/function reconcileLayer\(layer\)/.test(html), 'reconcileLayer 未定義');
  // disposeTile が ownedIds を dedup Set から外す
  assert.ok(/for \(const gid of \(rec\.ownedIds \|\| \[\]\)\) seenFeatureIds\.delete\(gid\)/.test(html), 'disposeTile が ownedIds を解放していない');
  // dispose 後に reconcile
  assert.ok(/if \(!opts \|\| !opts\.skipReconcile\) reconcileLayer\(layer\)/.test(html), 'disposeTile 後の reconcile が無い');
  // rec に allFeats をキャッシュ
  assert.ok(/cur\.allFeats = tile\.features/.test(html), 'tile feature をキャッシュしていない');
});

test('areaMesh: dominant / centroid-outside しきい値が緩和版（実河川を誤拒否しない）', () => {
  assert.ok(/dom > 0\.85/.test(html), 'dominant しきい値が 0.85 になっていない');
  assert.ok(/outCen > 3 && outFrac > 0\.06/.test(html), 'centroid-outside が割合ベースになっていない');
});

test('protected baseline fullward-v3.html は P1-6F の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/renderTileMeshes|reconcileLayer|WATER-DRAW-DEBUG|pfValidate/.test(fw), 'fullward-v3.html に混入');
});
