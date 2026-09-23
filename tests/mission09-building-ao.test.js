// tests/mission09-building-ao.test.js
// [見た目改善 Mission09] 建物の接地影・AO・ライティング調整（MODEL_STYLE=true 対象）。
//   色（用途色・河川色）は変更しない。geometry/topology は不変。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

test('[Mission09] 接地暗化を強化（minDarken を下げ・グラデ区間を短く。ただし黒くはしない）', () => {
  const m = html.match(/function groundContactDarken\(heightRatio\) \{[\s\S]{0,260}?\n\}/);
  assert.ok(m, 'groundContactDarken 未定義');
  const min = m[0].match(/const minDarken = ([0-9.]+);/);
  assert.ok(min && parseFloat(min[1]) >= 0.68 && parseFloat(min[1]) < 0.82,
    `minDarken=${min && min[1]}（下げすぎ=黒 / 高すぎ=接地感が弱い）`);
  assert.ok(/Math\.min\(1, heightRatio \/ 0\.24\)/.test(m[0]), 'グラデ区間が下から24%へ短縮されていない');
});

test('[Mission09] roof は wall よりごく僅かに明るい白（MODEL_STYLE時のみ・差は小さい）', () => {
  assert.ok(/const MS_ROOF_WHITE = 0xf6f7f3;/.test(html), 'MS_ROOF_WHITE が無い');
  assert.ok(/const msRoofColor = \(usageHex\) => MODEL_STYLE\.on \? msBlend\(usageHex, MS_ROOF_WHITE, MS_ROOF_BLEND\) : usageHex;/.test(html),
    'msRoofColor（roof専用の白寄せ）が無い');
  assert.ok(/function presetRoofColor\(usage\)\{ return msRoofColor\(/.test(html), 'presetRoofColor が msRoofColor を使っていない');
  // legacy（MODEL_STYLE=false）では usageHex をそのまま返す＝色を壊さない
  assert.ok(/msRoofColor = \(usageHex\) => MODEL_STYLE\.on \? [^:]+: usageHex;/.test(html), 'legacyで roof 色を変えてしまう疑い');
});

test('[Mission09] MS_BUILDING_WHITE（wall）と MS_ROOF_WHITE の差は小さい（派手にしない）', () => {
  const wall = parseInt(html.match(/const MS_BUILDING_WHITE = (0x[0-9a-f]+);/)[1], 16);
  const roof = parseInt(html.match(/const MS_ROOF_WHITE = (0x[0-9a-f]+);/)[1], 16);
  const ch = (h, s) => (h >> s) & 255;
  const dr = Math.abs(ch(roof, 16) - ch(wall, 16)), dg = Math.abs(ch(roof, 8) - ch(wall, 8)), db = Math.abs(ch(roof, 0) - ch(wall, 0));
  assert.ok(Math.max(dr, dg, db) <= 14, `roof/wall白の差が大きすぎる（max ${Math.max(dr, dg, db)}/255）`);
  assert.ok(roof > wall, 'roof が wall より明るくない');
});

test('[Mission09] model-day ライト: hemi弱め(<1.2)・sun強め(>1.0)・fillで暗部を持ち上げる', () => {
  const hemi = parseFloat(html.match(/hemiLight\.intensity = modelDay \? ([0-9.]+)/)[1]);
  const sunI = parseFloat(html.match(/sun\.intensity = modelDay \? ([0-9.]+)/)[1]);
  const fillI = parseFloat(html.match(/fillLight\.intensity = modelDay \? ([0-9.]+)/)[1]);
  assert.ok(hemi < 1.2 && hemi > 0.8, `hemi=${hemi}`);
  assert.ok(sunI > 1.0 && sunI < 1.4, `sun=${sunI}`);
  assert.ok(fillI > 0.15 && fillI < 0.45, `fill=${fillI}（0＝暗部が黒 / 大きすぎ＝平坦）`);
  assert.ok(sunI > hemi, 'sun <= hemi（方向性のある陰影にならない）');
});

test('[Mission09] CityBuildingLOD: 頂点接地暗化のみ追加（影・UV・pickingは無しのまま＝軽量維持）', () => {
  const startIdx = html.indexOf('const CityBuildingLOD = (function () {');
  assert.ok(startIdx >= 0, 'CityBuildingLOD 定義が見つからない');
  // 完全一致の return 文字列は後続ミッションで戻り値フィールドが増えるたびに追随が必要で壊れやすいため、
  // 安定した prefix のみで終端を特定する（endIdx が -1 のままファイル末尾まで暴走するのを防ぐ）。
  const endIdx = html.indexOf('return { build, setCameraDistance, setVisible, getStats,', startIdx);
  assert.ok(endIdx > startIdx, 'CityBuildingLOD の return 文が見つからない');
  const body = html.slice(startIdx, endIdx);
  assert.ok(/new THREE\.MeshLambertMaterial\(\{ color: LOD_COLOR, vertexColors: true \}\)/.test(body), 'vertexColors が有効になっていない');
  assert.ok(/const LOD_BOTTOM_SHADE = 0\.80, LOD_TOP_SHADE = 1\.0, LOD_ROOF_SHADE = 1\.03;/.test(body), '接地暗化係数が無い');
  assert.ok(/geom\.setAttribute\('color', new THREE\.BufferAttribute\(new Float32Array\(wc\), 3\)\)/.test(body), 'color 属性を設定していない');
  assert.ok(/mesh\.castShadow = false; mesh\.receiveShadow = false;/.test(body), 'CityBuildingLOD に影が付いた（軽量方針違反）');
  assert.ok(!/setAttribute\('uv'|setAttribute\('buildingIndex'/.test(body), 'UV/buildingIndex を持っている（軽量方針違反）');
});

test('[Mission09] City Mode遠景(cs.r>8000)で sun.castShadow を止める（shadow描画負荷削減）', () => {
  assert.ok(/if \(typeof sun !== 'undefined' && typeof shadowEnabled !== 'undefined' && shadowEnabled && !nightMode\) \{/.test(html),
    'City Mode shadow ゲートが無い');
  assert.ok(/const wantCastShadow = cs\.r <= 8000;/.test(html), '距離しきい値(8000)が無い');
  assert.ok(/if \(sun\.castShadow !== wantCastShadow\) sun\.castShadow = wantCastShadow;/.test(html), '変化時のみ切替になっていない');
});

test('[Mission09] 色を壊さない: 河川色 #9ed6e6・道路tier色は不変', () => {
  assert.ok(/fillColor: 0x9ed6e6/.test(html), '河川fill色が変わっている');
  assert.ok(/const ROAD_RIBBON_COLOR = \{ major: 0xb8bdc3, mid: 0xc4c8cc, local: 0xd0d3d6 \};/.test(html), '道路tier色が変わっている');
  assert.ok(/const MS_BUILDING_WHITE = 0xeef0ec;/.test(html), '建物白(壁)基準色が変わっている');
});

test('[Mission09] legacy（MODEL_STYLE=false）副作用なし: roof色・ライトは modelDay ゲート内', () => {
  // presetRoofColor は MODEL_STYLE.on の時だけ白へ寄せる
  assert.ok(/msRoofColor = \(usageHex\) => MODEL_STYLE\.on \?/.test(html));
  // ライト調整は modelDay 分岐内
  assert.ok(/const modelDay = MODEL_STYLE\.on && t === 'day';[\s\S]{0,600}hemiLight\.intensity = modelDay \?/.test(html),
    'ライト調整が modelDay ゲート内に無い');
});

test('protected baseline fullward-v3.html は Mission09 の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/MS_ROOF_WHITE|msRoofColor|LOD_BOTTOM_SHADE|wantCastShadow/.test(fw), 'fullward-v3.html に Mission09 の変更が混入');
});
