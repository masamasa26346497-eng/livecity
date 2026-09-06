// tests/ward-ux-v1-p16h.test.js
// P1-6H: 都市模型スタイル（白い建物 / 淡い水色の川 / 整然とした道路 / 落ち着いた台座）の HTML 配線検証。
//   計算ロジックは tools/lib/model-style.js でテスト済み。

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
  const f = path.join(os.tmpdir(), `wux-p16h-${process.pid}.js`);
  fs.writeFileSync(f, m[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('MODEL_STYLE が正式な既定表示（ページを開くだけで適用）', () => {
  // window.__MODEL_STYLE__ を明示的に true 初期化（未設定時）
  assert.ok(/if \(typeof window !== 'undefined' && window\.__MODEL_STYLE__ === undefined\) window\.__MODEL_STYLE__ = true;/.test(html),
    'window.__MODEL_STYLE__ の明示的 true 初期化が無い');
  assert.ok(/const MODEL_STYLE = \{ on: \(typeof window === 'undefined' \|\| window\.__MODEL_STYLE__ !== false\) \}/.test(html), 'MODEL_STYLE 既定 ON でない');
  assert.ok(/function applyModelStyle\(\)/.test(html), 'applyModelStyle 未定義');
  // initVisualSystem 内で自動適用
  assert.ok(/applyModelStyle\(\);\s*\/\/ \[P1-6H\]/.test(html), '初期化で applyModelStyle を自動実行していない');
  // 適用確認ログ
  assert.ok(/\[MODEL-STYLE\] applied: /.test(html), '適用確認ログが無い');
  // legacy はデバッグ用として残る（切替経路）
  assert.ok(/window\.__MODEL_STYLE__ !== false/.test(html) && /legacy（debug）/.test(html), 'legacy 切替（debug 用）が説明されていない');
});

test('建物: 用途色を白へ寄せ、マット材質にする', () => {
  // [Mission07] 白寄せ率は MS_BUILDING_BLEND（0.92）へ強化。0.82 の直書きは廃止。
  assert.ok(/const msBuildingColor = \(usageHex\) => MODEL_STYLE\.on \? msBlend\(usageHex, MS_BUILDING_WHITE, MS_BUILDING_BLEND\)/.test(html), '白寄せ関数が無い');
  const blend = html.match(/const MS_BUILDING_BLEND = ([0-9.]+)/);
  assert.ok(blend && parseFloat(blend[1]) >= 0.88 && parseFloat(blend[1]) <= 0.95, `MS_BUILDING_BLEND=${blend && blend[1]}（用途色が残りすぎ/消えすぎ）`);
  assert.ok(/return msBuildingColor\(PRESET_WALL_COLOR/.test(html), 'presetWallColor が白寄せを通っていない');
  assert.ok(/function gsReal\(u\)\{ return msBuildingColor\(/.test(html), 'gsReal が白寄せを通っていない');
  // wmReal のマット分岐（発光なし・低 shininess）
  assert.ok(/if \(MODEL_STYLE\.on\) \{[\s\S]{0,200}?shininess: 6, specular: 0x161616/.test(html), 'wmReal のマット分岐が無い');
  assert.ok(/return \(tmRealC\[u\] = new THREE\.MeshLambertMaterial\(\{ color: c \}\)\);/.test(html), 'tmReal のマット分岐が無い');
});

test('水域: 淡いシアン色 + 距離で滑らかに減衰する低 opacity', () => {
  assert.ok(/const WATER_FILL_COLOR = \{ linear: 0xbcdce6, basin: 0xb2d6e2, harbour: 0x9fc4d2 \}/.test(html), '淡いシアンパレットでない');
  assert.ok(/const wLerp = /.test(html) && /fo = wLerp\(d, 2200, 6200, 0\.30, 0\.0\)/.test(html), '滑らかな距離減衰カーブが無い');
  assert.ok(/fillVisible: fo > 0\.005/.test(html), 'opacity ベースの可視判定でない');
});

test('道路・地表: 模型向けの明るいグレーへ寄せる', () => {
  assert.ok(/s\.colorReal = MODEL_STYLE\.on \? msBlend\(s\._crOrig, 0x9aa0a6, 0\.55\)/.test(html), '道路 colorReal の白寄せが無い');
  // [Mission17] GroundVisualLayer の外周を消すため地表色を背景/fog と同一(MS_BG_NEUTRAL)にする
  assert.ok(/GROUND_VISUAL_STYLE\.colorReal = MODEL_STYLE\.on \? MS_BG_NEUTRAL/.test(html), '地表の模型色が背景色へ統一されていない');
  assert.ok(/roads:\s+\{ y: 0\.13, color: 0x9aa1a8/.test(html), 'CityTileLayer roads の色が模型向けでない');
});

test('背景・ライト: 昼は明るい台座色（Mission09で hemi弱め/sun強めへ再調整）', () => {
  assert.ok(/const modelDay = MODEL_STYLE\.on && currentTimeOfDay === 'day'/.test(html), 'applySkyAndFog の modelDay 分岐が無い');
  // [Mission17] 模型背景は明るい neutral tone（MS_BG_NEUTRAL）へ。fog も同色。
  assert.ok(/const skyHex = modelDay \? MS_BG_NEUTRAL/.test(html), '模型背景色(MS_BG_NEUTRAL)が無い');
  assert.ok(/const fogHex = modelDay \? MS_BG_NEUTRAL/.test(html), '模型fog色が背景と同一でない');
  // [Mission09] 平坦化を抑えるため hemi < 1.2 / sun > 1.0（立体感を出す方向）
  const hemi = html.match(/hemiLight\.intensity = modelDay \? ([0-9.]+)/);
  const sunI = html.match(/sun\.intensity = modelDay \? ([0-9.]+)/);
  assert.ok(hemi && parseFloat(hemi[1]) < 1.2, `model-day hemi=${hemi && hemi[1]}（強すぎると平坦）`);
  assert.ok(sunI && parseFloat(sunI[1]) > 1.0, `model-day sun=${sunI && sunI[1]}（弱すぎると側面の明暗差が出ない）`);
});

test('protected baseline fullward-v3.html は P1-6H の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/MODEL_STYLE|applyModelStyle|msBuildingColor/.test(fw), 'fullward-v3.html に混入');
});

test('既存レイヤー定義は重複・消失していない', () => {
  for (const L of ['RoadLayer', 'ParkLayer', 'WaterLayer', 'BuildingTileLayer', 'GroundVisualLayer']) {
    assert.equal((html.match(new RegExp(`^const ${L} = `, 'gm')) || []).length, 1, `${L}`);
  }
});
