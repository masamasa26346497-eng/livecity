// tests/ward-ux-v1-p17.test.js
// P1-7: City Mode（大阪市24区全域表示）の HTML 配線検証。
//   純粋ロジックは tools/lib/city-mode.js / tests/city-mode-p17.test.js でテスト済み。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

test('ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `wux-p17-${process.pid}.js`);
  fs.writeFileSync(f, m[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('city bbox → tile set: manifest 由来（156 tile ID を手書きしない）', () => {
  assert.ok(/function coverCityBbox\(\)/.test(html), 'coverCityBbox 未定義');
  assert.ok(/const all = \[\.\.\.m\.tileSet\]\.map/.test(html), 'manifest.tileSet 由来でない（tile を手書きしている疑い）');
  assert.ok(!/tile_-9_-10|tile_3_1\.json.*tile_3_2\.json/.test(html), '156 tile を手書きしている痕跡がある');
});

test('progressive load: center-first ソート + batchProgressive相当（同期一括ロードしない）', () => {
  assert.ok(/all\.sort\(\(a, b\) => \(Math\.hypot\(a\.tx - centerTx, a\.tz - centerTz\) - Math\.hypot\(b\.tx - centerTx, b\.tz - centerTz\)\)\)/.test(html),
    '中心タイルからの距離でソートしていない');
  assert.ok(/function loadTilesProgressively\(layer, tileList\)/.test(html), 'loadTilesProgressively 未定義');
  assert.ok(/const CITY_BATCH_SIZE = 10/.test(html) && /setTimeout\(step, CITY_BATCH_DELAY_MS\)/.test(html), 'バッチ間隔（setTimeout）が無い＝同期一括ロードの疑い');
});

test('City Mode camera: getCityCameraTarget が地表範囲から center/radius を算出（ハードコードでない）', () => {
  assert.ok(/function getCityCameraTarget\(\)/.test(html), 'getCityCameraTarget 未定義');
  assert.ok(/const width = ext\.maxX - ext\.minX, height = ext\.maxZ - ext\.minZ;/.test(html), 'extent から動的算出していない');
  assert.ok(/const diag = Math\.hypot\(width, height\);/.test(html), 'diag を算出していない');
  // [P1-7B] 市外余白が目立たないよう ward 用の 0.62 より詰めた 0.5 を使う（tools/lib/city-mode.js と同係数）
  assert.ok(/let radius = diag \* 0\.5;/.test(html), 'getCityCameraTarget の radiusFactor が 0.5 になっていない');
});

test('roads: buildRoadMeshes が定義されている（分類・LOD詳細は tests/mission02-road-lod.test.js でカバー）', () => {
  assert.ok(/function buildRoadMeshes\(features, y, baseColor\)/.test(html), 'buildRoadMeshes 未定義');
});

test('[Mission12] park LOD: 面積3段階(large/medium/small)+道路と同じFAR/MID/NEAR band', () => {
  assert.ok(/function buildParkMeshes\(features, y, color, meta\)/.test(html), 'buildParkMeshes 未定義');
  assert.ok(/const PARK_AREA_LARGE_M2 = 100000, PARK_AREA_MEDIUM_M2 = 10000;/.test(html), '公園面積しきい値が無い');
  assert.ok(/function parkClassVisible\(cls, d\) \{ const b = parkLodBand\(d\); if \(cls === 'large'\) return true; if \(cls === 'medium'\) return b !== 'far'; return b === 'near'; \}/.test(html),
    'parkClassVisible の実装が違う');
  assert.ok(/const PARK_LOD_FAR_M = 9000, PARK_LOD_MID_M = 3500;/.test(html), '公園 band しきい値が道路(9000/3500)と揃っていない');
});

test('[Mission13] rail LOD: MAJOR/URBAN/LOCAL の tier別、駅は近距離のみ', () => {
  assert.ok(/function buildRailMeshes\(features, y\)/.test(html), 'buildRailMeshes 未定義（tier別 mesh でない）');
  assert.ok(/m\.userData\.railTier = tier;/.test(html), 'railTier タグが無い');
  assert.ok(/if \(ud\.rail === 'line'\) \{[\s\S]*?railClassVisible\(ud\.railTier[\s\S]*?railTierOpacity\(ud\.railTier/.test(html),
    'applyLodToOneMesh の rail LOD 処理が無い（常時表示のまま）');
  assert.ok(/function railClassVisible\(cls, d\) \{ const b = railLodBand\(d\); if \(cls === 'major'\) return true; if \(cls === 'urban'\) return b !== 'far'; return b === 'near'; \}/.test(html),
    'railClassVisible の実装が違う');
  assert.ok(/const STATION_MAX_M = 5000;/.test(html) && /function stationVisible\(d\) \{ return d <= STATION_MAX_M; \}/.test(html), '駅の距離LODが無い');
});

test('City↔Ward lifecycle: CityModeManager.enter/exit と WardModeManager.clearActiveWard', () => {
  assert.ok(/const CityModeManager = \(function \(\) \{/.test(html), 'CityModeManager 未定義');
  assert.ok(/function enter\(\) \{/.test(html) && /function exit\(nextWardId\) \{/.test(html), 'enter/exit 未定義');
  assert.ok(/clearActiveWard\(\) \{ currentWardId = null; \}/.test(html), 'WardModeManager.clearActiveWard 未定義');
  assert.ok(/if \(typeof WardModeManager !== 'undefined' && WardModeManager\.clearActiveWard\) WardModeManager\.clearActiveWard\(\);/.test(html), 'enter() が clearActiveWard を呼んでいない');
  assert.ok(/if \(typeof CityModeManager !== 'undefined' && CityModeManager\.isActive\(\)\) CityModeManager\.exit\(def\.id\);/.test(html), '区選択時に CityModeManager.exit を呼んでいない');
  // enter() は Option A（全24区 dataset を enable。実際の fetch は BuildingTileLayer の ring 判定に委ねる）
  assert.ok(/for \(const w of WardModeManager\.WARD_DEFS\) BuildingTileLayer\.enableDataset\(w\.datasetId\);/.test(html), '24区 dataset を enable していない');
  // exit() は対象区以外を disable（dispose ではない = LRU に委ねる。「古い tile が壊れない」）
  assert.ok(/if \(w\.id !== nextWardId\) BuildingTileLayer\.disableDataset\(w\.datasetId\);/.test(html), 'exit() が他区 dataset を disable していない');
});

test('重複防止: dedup は seenFeatureIds（module 全体で共有、Ward/City で分かれていない）', () => {
  const idx = html.indexOf('const seenFeatureIds = new Set();');
  assert.ok(idx >= 0, 'seenFeatureIds 未定義');
  // CityModeManager / coverCityBbox がこの Set を再定義・分岐させていない
  assert.equal((html.match(/const seenFeatureIds = new Set\(\);/g) || []).length, 1, 'seenFeatureIds が複数定義されている（City/Ward で dedup が分離している疑い）');
});

test('LRU: 大阪市全域（156 tile 級）を保持できる上限へ引き上げ', () => {
  const m = html.match(/const MAX_TILES_PER_LAYER = (\d+);/);
  assert.ok(m && Number(m[1]) >= 156, `MAX_TILES_PER_LAYER=${m && m[1]} は156 tile 未満`);
});

test('[CITY-PERF] ログ: 指定フィールドを出力', () => {
  const m = html.match(/\[CITY-PERF\][\s\S]{0,900}?\}\)\);/);
  assert.ok(m, '[CITY-PERF] ブロックが無い');
  for (const f of ['firstRoadMs', 'firstWaterMs', 'firstParkMs', 'firstRailMs',
    'loadedRoadTiles', 'loadedWaterTiles', 'loadedParkTiles', 'loadedRailTiles',
    'drawCalls', 'geometries', 'triangles']) {
    assert.ok(m[0].includes(f), `[CITY-PERF] に ${f} が無い`);
  }
});

test('layer UI: 建物/道路/河川/公園/鉄道/駅名 のチェックボックス', () => {
  assert.ok(/function initLayerToggles\(\)/.test(html), 'initLayerToggles 未定義');
  for (const label of ['建物', '道路', '河川', '公園', '鉄道', '駅名']) {
    assert.ok(html.includes(`label: '${label}'`), `layer UI に「${label}」が無い`);
  }
  assert.ok(/CityTileLayer\.setLayerEnabled\('roads', on\)/.test(html), '道路トグルが CityTileLayer に配線されていない');
  assert.ok(/CityTileLayer\.setLayerEnabled\('railStations', on\)/.test(html), '駅名トグルが CityTileLayer に配線されていない');
});

test('City Mode UI: 「大阪市全域」行がセレクタに追加されている', () => {
  assert.ok(/cityRow\.addEventListener\('click', \(\) => \{ CityModeManager\.enter\(\); closePanel\(\); \}\);/.test(html), 'City Mode 行のクリックハンドラが無い');
  assert.ok(html.includes("cityNameEl.textContent = '大阪市全域';"), '「大阪市全域」ラベルが無い');
});

test('protected baseline fullward-v3.html は P1-7 の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/CityModeManager|coverCityBbox|getCityCameraTarget|buildRoadMeshes|buildParkMeshes|CITY-PERF/.test(fw), 'fullward-v3.html に P1-7 の変更が混入');
});

test('既存レイヤー定義は重複・消失していない', () => {
  for (const L of ['RoadLayer', 'ParkLayer', 'WaterLayer', 'BuildingTileLayer', 'WardModeManager']) {
    assert.equal((html.match(new RegExp(`^const ${L} = `, 'gm')) || []).length, 1, `${L}`);
  }
  assert.equal((html.match(/^const CityTileLayer = \(function \(\) \{/gm) || []).length, 1);
  assert.equal((html.match(/^const CityModeManager = \(function \(\) \{/gm) || []).length, 1);
});
