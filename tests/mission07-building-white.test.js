// tests/mission07-building-white.test.js
// [見た目改善 Mission07] 通常表示（MODEL_STYLE=true）の建物用途色をさらに白へ寄せ、「ほぼ白〜薄灰の
//   都市模型」に統一する。用途色そのものは削除せず分析/legacy で復活可能。geometry / lighting は不変。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { modelBuildingColor, modelRoofColor, hexToRgb, MODEL_BUILDING_WHITE, MODEL_ROOF_WHITE } from '../tools/lib/model-style.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const sat = (v) => { const { r, g, b } = hexToRgb(v); return Math.max(r, g, b) - Math.min(r, g, b); };

test('[Mission07] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m07-${process.pid}.js`);
  fs.writeFileSync(f, m[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission07] 壁の白寄せ率を強化（MS_BUILDING_BLEND ≈ 0.92、用途色は 1 割未満だけ残す）', () => {
  const m = html.match(/const MS_BUILDING_BLEND = ([0-9.]+), MS_ROOF_BLEND = ([0-9.]+);/);
  assert.ok(m, 'MS_BUILDING_BLEND / MS_ROOF_BLEND 未定義');
  const wall = parseFloat(m[1]), roof = parseFloat(m[2]);
  assert.ok(wall >= 0.88 && wall <= 0.95, `壁 blend=${wall}`);
  assert.ok(roof >= 0.88 && roof <= 0.96, `屋根 blend=${roof}`);
  assert.ok(/msBlend\(usageHex, MS_BUILDING_WHITE, MS_BUILDING_BLEND\)/.test(html), 'msBuildingColor が定数を使っていない');
  assert.ok(/msBlend\(usageHex, MS_ROOF_WHITE, MS_ROOF_BLEND\)/.test(html), 'msRoofColor が定数を使っていない');
});

test('[Mission07] canonical wall color はオフホワイト（黒/濃灰/強い色でない）', () => {
  const w = html.match(/const MS_BUILDING_WHITE = (0x[0-9a-f]{6});/);
  const v = parseInt(w[1], 16), { r, g, b } = hexToRgb(v);
  assert.ok(r >= 225 && g >= 225 && b >= 225, `wall白が暗い #${w[1].slice(2)}`);
  assert.ok(sat(v) <= 12, 'wall白の色味が強い');
});

test('[Mission07] roof > wall の明度差を維持（Mission09の roof/wall 差を消さない）', () => {
  const wall = parseInt(html.match(/const MS_BUILDING_WHITE = (0x[0-9a-f]+);/)[1], 16);
  const roof = parseInt(html.match(/const MS_ROOF_WHITE = (0x[0-9a-f]+);/)[1], 16);
  const bright = (v) => { const { r, g, b } = hexToRgb(v); return r + g + b; };
  assert.ok(bright(roof) > bright(wall), 'roof が wall より明るくない');
  // 差は小さい（派手にしない）
  const dr = Math.abs(((roof >> 16) & 255) - ((wall >> 16) & 255));
  const dg = Math.abs(((roof >> 8) & 255) - ((wall >> 8) & 255));
  const db = Math.abs((roof & 255) - (wall & 255));
  assert.ok(Math.max(dr, dg, db) <= 14, `roof/wall 差が大きすぎる max ${Math.max(dr, dg, db)}/255`);
});

test('[Mission07] 白模型の壁色は用途によらずほぼ同一（差は僅かな色温度のみ）', () => {
  // presetWallColor は '411'(住宅)/'401'(事務所)/'441'(工場) で計算される。lib の modelBuildingColor と同率。
  const keys = [0xf0d9a8, 0x9fc8ef, 0x8fbcd6, 0xf2c9a0]; // residential / office / industrial / commercial
  const whites = keys.map((k) => modelBuildingColor(k));
  for (const w of whites) {
    const { r, g, b } = hexToRgb(w);
    assert.ok(r > 220 && g > 220 && b > 220, `白模型壁が白くない ${JSON.stringify({ r, g, b })}`);
    assert.ok(sat(w) <= 12, `用途色が残りすぎ（sat=${sat(w)}）`);
  }
  // 用途間の最大チャンネル差（=遠景ノイズの元）が小さいこと
  const chan = (v, s) => (v >> s) & 255;
  for (const s of [16, 8, 0]) {
    const vals = whites.map((w) => chan(w, s));
    assert.ok(Math.max(...vals) - Math.min(...vals) <= 16, `用途間の色差が大きい（shift ${s}: ${Math.max(...vals) - Math.min(...vals)}）`);
  }
});

test('[Mission07] 用途色は削除せず分析/legacy で復活する（msBuildingColor / msRoofColor は MODEL_STYLE.on ゲート）', () => {
  assert.ok(/const msBuildingColor = \(usageHex\) => MODEL_STYLE\.on \? [^:]+ : usageHex;/.test(html), 'msBuildingColor の legacy パスが無い');
  assert.ok(/const msRoofColor = \(usageHex\) => MODEL_STYLE\.on \? [^:]+ : usageHex;/.test(html), 'msRoofColor の legacy パスが無い');
  // 鮮やかな用途色パレット自体は残っている
  assert.ok(/const PRESET_WALL_COLOR = \{/.test(html) && /residential_low: 0xf0d9a8/.test(html), 'PRESET_WALL_COLOR が消えた');
  assert.ok(/const UST = \{/.test(html) && /const UST_REAL = \{/.test(html), '用途色テーブル(UST / UST_REAL)が消えた');
  // データ表示（分析）モードの壁マテリアルは用途色を使い続ける
  assert.ok(/bldgWM\.forEach\(o=>\{ o\.mesh\.material = wm\(o\.usage\); \}\)/.test(html), 'data モードが用途色壁(wm)を使っていない');
});

test('[Mission07] lib model-style.js: modelBuildingColor 既定 0.92 / modelRoofColor 既定 0.93、roof>wall', () => {
  const before = 0xa8dcea;
  const w = modelBuildingColor(before), r = modelRoofColor(before);
  assert.ok(sat(w) < sat(before) * 0.25, `壁の彩度が十分落ちていない ${sat(before)}->${sat(w)}`);
  const bright = (v) => { const x = hexToRgb(v); return x.r + x.g + x.b; };
  assert.ok(bright(r) > bright(w), 'lib: roof が wall より明るくない');
  assert.equal(MODEL_BUILDING_WHITE, 0xeef0ec);
  assert.equal(MODEL_ROOF_WHITE, 0xf6f7f3);
});

test('[Mission07] CityBuildingLOD の色は白模型の壁色に統一（軽量: shared material / edge無 / shadow無）', () => {
  const startIdx = html.indexOf('const CityBuildingLOD = (function () {');
  assert.ok(startIdx >= 0, 'CityBuildingLOD 定義が見つからない');
  // 完全一致の return 文字列は後続ミッションで戻り値フィールドが増えるたびに追随が必要で壊れやすいため、
  // 安定した prefix のみで終端を特定する（endIdx が -1 のままファイル末尾まで暴走するのを防ぐ）。
  const endIdx = html.indexOf('return { build, setCameraDistance, setVisible, getStats,', startIdx);
  assert.ok(endIdx > startIdx, 'CityBuildingLOD の return 文が見つからない');
  const body = html.slice(startIdx, endIdx);
  assert.ok(/const LOD_COLOR = MS_BUILDING_WHITE;/.test(body), 'LOD_COLOR が MS_BUILDING_WHITE ではない');
  assert.ok(/if \(!sharedMaterial\) sharedMaterial = new THREE\.MeshLambertMaterial\(\{ color: LOD_COLOR, vertexColors: true \}\);/.test(body),
    '共有マテリアル1個でない / 色が違う');
  assert.ok(/mesh\.castShadow = false; mesh\.receiveShadow = false;/.test(body), '影が付いた（軽量方針違反）');
  assert.ok(!/LineSegments|EdgesGeometry/.test(body), 'エッジが付いた（軽量方針違反）');
});

test('[Mission07] emissive を使わない（MODEL_STYLE時は宝石的発光なし）', () => {
  // wmReal / tmReal の MODEL_STYLE ブランチに emissive を書かない
  const wmReal = html.match(/if \(wmRealC\[u\]\) return wmRealC\[u\];\s*if \(MODEL_STYLE\.on\) \{[\s\S]{0,260}?\}\)\);/);
  assert.ok(wmReal, 'wmReal の MODEL_STYLE ブランチが取れない');
  assert.ok(!/emissive/.test(wmReal[0]), 'wmReal(model) に emissive がある');
  const tmReal = html.match(/if \(MODEL_STYLE\.on\) \{\s*return \(tmRealC\[u\] = new THREE\.MeshLambertMaterial\(\{ color: c \}\)\);/);
  assert.ok(tmReal, 'tmReal(model) が Lambert 単色でない（emissive の疑い）');
});

test('[Mission07] プラスチック/ガラス光沢を避ける（低 shininess・暗い specular）', () => {
  const m = html.match(/if \(MODEL_STYLE\.on\) \{\s*\/\/ \[P1-6H\] マット模型[\s\S]{0,220}?shininess: (\d+), specular: (0x[0-9a-f]+)/);
  assert.ok(m, 'wmReal(model) の matte パラメータが取れない');
  assert.ok(parseInt(m[1], 10) <= 8, `shininess=${m[1]}（高すぎ）`);
  const spec = parseInt(m[2], 16);
  assert.ok(((spec >> 16) & 255) <= 40, `specular が明るすぎる ${m[2]}`);
});

test('[Mission07] 4色構成: 建物白 / 道路グレー / 河川シアン / 公園グリーン が別系統', () => {
  const bWhite = parseInt(html.match(/const MS_BUILDING_WHITE = (0x[0-9a-f]+);/)[1], 16);
  const river = parseInt(html.match(/fillColor: (0x9ed6e6)/)[1], 16);
  assert.ok(sat(bWhite) <= 12, '建物白に色味');
  // 河川は青緑（B >= R, G が高い）
  assert.ok((river & 255) > ((river >> 16) & 255), '河川色が青緑でない');
  // 道路 tier 色は無彩色グレー
  assert.ok(/const ROAD_RIBBON_COLOR = \{ major: 0xb8bdc3, mid: 0xc4c8cc, local: 0xd0d3d6 \};/.test(html), '道路色が変わった');
});

test('[Mission07] applyModelStyle 往復で建物 material cache が入れ替わる（色が混ざらない）', () => {
  assert.ok(/for \(const c of \[wmRealC, tmRealC, wmRealNearC, wmRealMidC, wmc, tmc, emc\]\) for \(const kk in c\) delete c\[kk\];/.test(html),
    'applyModelStyle が建物 material cache を破棄していない');
  assert.ok(/wallLOD = 'none'; windowsOn = false;/.test(html), 'wallLOD の再評価トリガが無い');
});

test('[Mission07] window.__BUILDING_COLOR_DEBUG__ が wall/roof/blend/samples を返す', () => {
  assert.ok(/window\.__BUILDING_COLOR_DEBUG__ = function \(\) \{/.test(html), 'color debug API が無い');
  const m = html.match(/window\.__BUILDING_COLOR_DEBUG__ = function \(\) \{[\s\S]*?\n\};/);
  for (const k of ['wallWhite', 'roofWhite', 'wallBlend', 'roofBlend', 'samples', 'modelStyle']) {
    assert.ok(m[0].includes(k), `debug に ${k} が無い`);
  }
});

test('[Mission07] lighting / 接地暗化 / edge LOD を変更していない', () => {
  assert.ok(/hemiLight\.intensity = modelDay \? 1\.0/.test(html), 'model-day hemi が変わった');
  assert.ok(/sun\.intensity = modelDay \? 1\.0[0-9]/.test(html), 'model-day sun が変わった');
  assert.ok(/const minDarken = 0\.7[0-9];/.test(html), '接地暗化 minDarken が変わった');
  assert.ok(/const OP = \{ near: 0\.16, mid: 0\.08, far: 0\.0 \};/.test(html), 'Mission08 edge LOD が変わった');
});

test('protected baseline fullward-v3.html は Mission07 の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/MS_BUILDING_BLEND|MS_ROOF_BLEND|__BUILDING_COLOR_DEBUG__/.test(fw), 'fullward-v3.html に Mission07 の変更が混入');
});

test('[Mission 32U] production osaka_3d_buildings.html は promoted build（Mission07 を含む）', () => {
  const prod = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.html'), 'utf-8');
  assert.ok(/MS_BUILDING_BLEND|__BUILDING_COLOR_DEBUG__/.test(prod), 'production HTML に Mission07 の内容が無い（32U cutover 後の production は ward-ux-v1 から生成した promoted build）');
});
