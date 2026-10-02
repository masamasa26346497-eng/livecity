// tests/ward-ux-v1-p16g.test.js
// P1-6G: 河川描画の LOD 化（岸線 + 距離別フィル）の HTML 配線検証。
//   ロジック本体は tools/lib/water-classify.js / water-render-lod.js でテスト済み。

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
  const f = path.join(os.tmpdir(), `wux-p16g-${process.pid}.js`);
  fs.writeFileSync(f, m[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('水域: ベタ塗り単一 mesh をやめ、buildWaterMeshes（岸線 + ファミリ別フィル）へ', () => {
  assert.ok(/function buildWaterMeshes\(areaFeats, tileId\)/.test(html), 'buildWaterMeshes 未定義');
  assert.ok(/for \(const wm of buildWaterMeshes\(feats\.filter\(\(f\) => f\.kind === 'area'\), key\)\)/.test(html), 'renderTileMeshes で buildWaterMeshes を使っていない');
  // 岸線 LineSegments
  assert.ok(/role: 'shore'/.test(html) && /WATER_SHORE_COLOR/.test(html), '岸線 mesh が無い');
  // ファミリ別フィル
  assert.ok(/role: 'fill', family: fam/.test(html), 'フィル mesh に family タグが無い');
  assert.ok(/linear|linearGiant|basin|harbour/.test(html), 'バケット分けが無い');
});

test('距離 LOD: waterBand / waterLod / applyCityLOD / setCameraDistance', () => {
  assert.ok(/function waterBand\(d\)/.test(html) && /d > 6000 \? 'far' : d > 3000 \? 'mid' : 'near'/.test(html), 'waterBand しきい値が違う');
  assert.ok(/function waterLod\(distance, mode, family, giant\)/.test(html), 'waterLod 未定義');
  // [P1-7] applyWaterLOD は水域だけでなく道路/公園/駅も含む applyCityLOD へ統合された
  assert.ok(/function applyCityLOD\(distance, force\)/.test(html), 'applyCityLOD 未定義');
  assert.ok(/function applyLodToOneMesh\(m, distance, mode\)/.test(html), 'applyLodToOneMesh 未定義（水域/道路/公園/駅の共通LOD適用）');
  assert.ok(/setCameraDistance\(r\) \{ if \(Number\.isFinite\(r\)\)/.test(html), 'setCameraDistance 未定義');
  assert.ok(/CityTileLayer\.setCameraDistance\(cs\.r\)/.test(html), 'camUpd で setCameraDistance を呼んでいない');
  // band 変化時のみ全走査
  assert.ok(/if \(!force && key === lastCityLodKey\) return;/.test(html), 'band 変化ガードが無い');
});

test('巨大河川 giant suppression: WATER_GIANT_DIAG と giant を早く薄く消す曲線', () => {
  assert.ok(/const WATER_GIANT_DIAG = 2500/.test(html), 'WATER_GIANT_DIAG が無い');
  // giant はより早い距離で opacity 0 へ（normal 6200m に対し giant 5200m）
  assert.ok(/else if \(giant\) \{ fo = wLerp\(d, 1800, 5200, 0\.20, 0\.0\)/.test(html), 'giant の早期減衰カーブが無い');
  assert.ok(/else \{ fo = wLerp\(d, 2200, 6200, 0\.30, 0\.0\)/.test(html), 'normal 河川の減衰カーブが無い');
});

test('window.__WATER_STYLE_MODE__ = legacy | shoreline | lod（既定 lod）', () => {
  assert.ok(/window\.__WATER_STYLE_MODE__\) \|\| 'lod'/.test(html), 'style mode 既定が lod でない');
  assert.ok(/mode === 'legacy'/.test(html) && /mode === 'shoreline'/.test(html), 'legacy / shoreline モードが無い');
  assert.ok(/setWaterStyleMode\(mode\)/.test(html), 'setWaterStyleMode 未公開');
});

test('水面が都市を覆わない: fill y は道路/公園より下、renderOrder も下', () => {
  const y = html.match(/const WATER_FILL_Y = ([\d.]+);/);
  assert.ok(y && Number(y[1]) < 0.07, `WATER_FILL_Y=${y && y[1]} は公園(0.07)以上`);
  assert.ok(/m\.renderOrder = 906;/.test(html), 'fill mesh renderOrder が 906 でない（道路 930 より下）');
  assert.ok(/m\.renderOrder = 923;/.test(html), 'shore mesh renderOrder が 923 でない');
});

test('[WATER-DRAW-DEBUG] に waterClass / family / giant / styleMode', () => {
  const m = html.match(/\[WATER-DRAW-DEBUG\][\s\S]{0,700}?\}\)\);/);
  assert.ok(m);
  assert.ok(/waterClass: cls/.test(m[0]) && /family: fam/.test(m[0]) && /giant,/.test(m[0]) && /styleMode: mode/.test(m[0]));
});

test('protected baseline fullward-v3.html は P1-6G の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/buildWaterMeshes|applyWaterLOD|WATER_STYLE_MODE|WATER_GIANT_DIAG/.test(fw), 'fullward-v3.html に混入');
});

test('既存レイヤー定義は重複・消失していない', () => {
  for (const L of ['RoadLayer', 'ParkLayer', 'WaterLayer', 'BuildingTileLayer']) {
    assert.equal((html.match(new RegExp(`^const ${L} = `, 'gm')) || []).length, 1, `${L}`);
  }
  assert.equal((html.match(/^const CityTileLayer = \(function \(\) \{/gm) || []).length, 1);
});
