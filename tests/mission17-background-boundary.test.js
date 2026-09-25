// tests/mission17-background-boundary.test.js
// [見た目改善 Mission17] 地表/背景の「四角い板」を消す。scene.background / renderer.clearColor /
//   scene.fog.color / CSS body / GroundVisualLayer(model) を明るい neutral tone へ統一する。
//   ground mesh(gnd) の visible=false 方針は維持。geometry / 新 mesh は追加しない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

test('[Mission17] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m17-${process.pid}.js`);
  fs.writeFileSync(f, m[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

// [Mission 35V] 背景色はテーマが持つようになった。ここで解決して以降の検査に使う。
//   Mission17 の主眼は「背景・fog・body・地表が同じ色で、四角い境界が見えないこと」で、
//   それはテーマが変わっても守るべき性質。値そのものの検査はテーマごとに分ける。
function themeBg() {
  const t = html.match(/const CITY_THEME = \{\s*name: '(\w+)',/);
  assert.ok(t, 'CITY_THEME 未定義');
  const key = (t[1] === 'NAVY') ? 'navy: {' : 'light: {';
  const i = html.indexOf(key);
  assert.ok(i > 0, 'テーマ ' + t[1] + ' のブロックが見つからない');
  const m = html.slice(i, i + 600).match(/bg: (0x[0-9a-f]{6})/);
  assert.ok(m, 'テーマの bg 未定義');
  return { name: t[1], hex: m[1], v: parseInt(m[1], 16) };
}

test('[Mission17] canonical background color: 建物白(#eef0ec)と明確に分離し、純白でない', () => {
  assert.match(html, /const MS_BG_NEUTRAL = cityTheme\('bg'\);/, 'MS_BG_NEUTRAL がテーマから引かれていない');
  const bg = themeBg();
  const r = (bg.v >> 16) & 255, g = (bg.v >> 8) & 255, b = bg.v & 255;
  const wall = 0xeef0ec, wr = (wall >> 16) & 255, wg = (wall >> 8) & 255, wb = wall & 255;
  assert.ok(r < 252 && g < 252 && b < 252, '背景が純白に近すぎる（白建物が溶ける）');
  if (bg.name === 'NAVY') {
    // [Mission 35V] 暗い地面。建物白より **明確に暗い** ことで建物が前に出る。
    assert.ok(wr - r > 80 && wg - g > 80 && wb - b > 80, `背景が建物白と十分離れていない #${bg.hex.slice(2)}`);
    assert.ok(b > r, `ネイビーなのに青くない #${bg.hex.slice(2)}`);
  } else {
    assert.ok(r >= wr && g >= wg && b >= wb, `背景が建物白より暗い #${bg.hex.slice(2)}`);
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 8, '背景に色味が強い（neutral でない）');
  }
});

test('[Mission17] scene.background / renderer.clearColor / scene.fog 初期値が MS_BG_NEUTRAL で統一', () => {
  assert.ok(/renderer\.setClearColor\(MS_BG_NEUTRAL\)/.test(html), 'renderer.setClearColor が統一されていない');
  assert.ok(/scene\.background = new THREE\.Color\(MS_BG_NEUTRAL\)/.test(html), 'scene.background 初期値が統一されていない');
  assert.ok(/scene\.fog = new THREE\.Fog\(MS_BG_NEUTRAL,/.test(html), 'scene.fog 初期色が統一されていない');
  assert.ok(!/setClearColor\(0x4a6178\)|new THREE\.Color\(0x4a6178\)|new THREE\.Fog\(0x4a6178/.test(html), '旧背景色(0x4a6178)が残っている');
});

test('[Mission17] applySkyAndFog: 模型・昼は背景=fog=MS_BG_NEUTRAL（fog終端が背景へ溶ける）', () => {
  assert.ok(/const skyHex = modelDay \? MS_BG_NEUTRAL : L\.skyColor;/.test(html), 'skyHex が MS_BG_NEUTRAL でない');
  assert.ok(/const fogHex = modelDay \? MS_BG_NEUTRAL : L\.fogColor;/.test(html), 'fogHex が背景と同一でない');
  // renderer.setClearColor(skyHex) が applySkyAndFog 内でも呼ばれる（scene.background と一致）
  assert.ok(/renderer\.setClearColor\(skyHex\);/.test(html), 'applySkyAndFog が clearColor を同期していない');
  // legacy（MODEL_STYLE=false / 昼以外）は従来の L.skyColor / L.fogColor のまま
  assert.ok(/modelDay \? MS_BG_NEUTRAL : L\.skyColor/.test(html) && /modelDay \? MS_BG_NEUTRAL : L\.fogColor/.test(html),
    'legacy 分岐が壊れている');
});

test('[Mission17] CSS body の背景も現在のテーマ背景へ統一（四角い境界を出さない）', () => {
  const m = html.match(/html,body\{[^}]*background:(#[0-9a-fA-F]{6})[^}]*\}/);
  assert.ok(m, 'body の background 指定が見つからない');
  // [Mission 35V] 値は変わっても「body と WebGL 背景が同じ色」という条件は変えない。
  const bg = themeBg();
  assert.equal(m[1].toLowerCase(), '#' + bg.hex.slice(2), `body 背景がテーマ背景と違う: ${m[1]}`);
  assert.ok(!/background:#0d1117/.test(html), '旧 body 背景(#0d1117)が残っている');
});

test('[Mission17] GroundVisualLayer(model) の地表色を背景/fog と同一色にする', () => {
  assert.ok(/GROUND_VISUAL_STYLE\.colorReal = MODEL_STYLE\.on \? MS_BG_NEUTRAL : GROUND_VISUAL_STYLE\._crOrig;/.test(html),
    '地表色が MS_BG_NEUTRAL へ統一されていない');
  // legacy 復元用の退避は維持
  assert.ok(/if \(GROUND_VISUAL_STYLE\._crOrig === undefined\) GROUND_VISUAL_STYLE\._crOrig = GROUND_VISUAL_STYLE\.colorReal;/.test(html),
    'legacy 復元用 _crOrig 退避が無い');
});

test('[Mission17] 旧 ground mesh(gnd) は visible=false を維持（再表示しない）', () => {
  assert.ok(/SHOW_LEGACY_GROUND: false/.test(html), 'SHOW_LEGACY_GROUND が false でない');
  assert.ok(/gnd\.visible = MAP_RENDER_CONFIG\.SHOW_LEGACY_GROUND;/.test(html), 'gnd.visible が SHOW_LEGACY_GROUND に連動していない');
  // gnd の Mesh / geometry 自体は残す（削除しない）
  assert.ok(/const gnd = new THREE\.Mesh\(\s*new THREE\.PlaneGeometry\(2500, 1500\)/.test(html), 'gnd geometry が削除された');
});

test('[Mission17] 新しい巨大 plane / grid helper を追加していない', () => {
  // Mission17 の変更で PlaneGeometry / GridHelper を新規追加していないこと
  assert.equal((html.match(/new THREE\.PlaneGeometry\(/g) || []).length, 1, 'PlaneGeometry が増えた（gnd の1個のみのはず）');
  assert.ok(!/new THREE\.GridHelper|new THREE\.AxesHelper|new THREE\.PolarGridHelper/.test(html), 'helper 系が追加された');
});

test('[Mission17] shadow receiver を壊さない（GroundVisualLayer は receiveShadow のまま・影用に gnd を復活しない）', () => {
  assert.ok(/groundMesh\.receiveShadow = true;/.test(html), 'GroundVisualLayer の receiveShadow が外れた');
  // gnd を影受け目的で visible=true にしていない
  assert.ok(!/gnd\.visible = true/.test(html), 'gnd を再表示している');
});

test('[Mission17] 色階層を維持: 背景・建物白・道路グレーが明度で分かれている', () => {
  // [Mission 35V] 明度の **向き** はテーマで反転する。
  //   LIGHT: 背景 > 建物白 > 道路（明るい台座の上の模型）
  //   NAVY : 背景 < 道路 < 建物白（暗い地面の上で道路と建物が浮く）
  //   守りたいのは「3 者が明度で十分に離れていて、どれかが他へ溶けないこと」。
  const bg = themeBg().v;
  const wall = 0xeef0ec;
  const bright = (v) => ((v >> 16) & 255) + ((v >> 8) & 255) + (v & 255);
  if (themeBg().name === 'NAVY') {
    // [Mission 35V 道路色の差し戻し] 道路は 35V で上書きしなくなったので、
    //   実効値は profile（既定 DEPTH）の値。暗い地面の上でも道路が沈まないことだけ見る。
    const road = parseInt(html.match(/const COL_DEPTH = \{[\s\S]*?road: (0x[0-9a-f]{6}),/)[1], 16);
    assert.ok(bright(bg) < bright(road), '道路が地面より暗い（暗い地面では道路が見えない）');
    assert.ok(bright(road) < bright(wall), '道路が建物白より明るい（道路が建物より前に出る）');
  } else {
    assert.ok(bright(bg) >= bright(wall), '背景が建物白より暗い');
  }
  assert.ok(/const ROAD_RIBBON_COLOR = \{ major: 0xb8bdc3, mid: 0xc4c8cc, local: 0xd0d3d6 \};/.test(html), '道路色が変わった');
  assert.ok(/fillColor: 0x9ed6e6/.test(html), '河川色が変わった');
});

test('[Mission17] Mission07/08/09 を変更していない', () => {
  assert.ok(/const MS_BUILDING_BLEND = 0\.92, MS_ROOF_BLEND = 0\.93;/.test(html), 'Mission07 blend が変わった');
  assert.ok(/const OP = \{ near: 0\.16, mid: 0\.08, far: 0\.0 \};/.test(html), 'Mission08 edge LOD が変わった');
  assert.ok(/const minDarken = 0\.76;/.test(html), 'Mission09 接地暗化が変わった');
  assert.ok(/hemiLight\.intensity = modelDay \? 1\.02/.test(html), 'Mission09 hemi が変わった');
});

test('[Mission17] window.__BACKGROUND_DEBUG__ が background/clearColor/fog/body/ground を返す', () => {
  assert.ok(/window\.__BACKGROUND_DEBUG__ = function \(\) \{/.test(html), 'debug API が無い');
  const m = html.match(/window\.__BACKGROUND_DEBUG__ = function \(\) \{[\s\S]*?\n\};/);
  for (const k of ['sceneBackground', 'rendererClearColor', 'fogColor', 'bodyBackground', 'legacyGround', 'groundVisualLayer']) {
    assert.ok(m[0].includes(k), `debug に ${k} が無い`);
  }
});

test('[Mission17] drawCalls を増やさない（GroundVisualLayer は 1 Draw Call のまま）', () => {
  assert.ok(/drawCalls: 1,/.test(html), 'GroundVisualLayer が 1 Draw Call でない');
  assert.ok(/全タイルの頂点を1つのバッファへ統合/.test(html), 'ground の統合メッシュ方針が変わった');
});

test('protected baseline fullward-v3.html は Mission17 の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/MS_BG_NEUTRAL|__BACKGROUND_DEBUG__/.test(fw), 'fullward-v3.html に Mission17 の変更が混入');
  assert.ok(!/background:#f3f4f1/.test(fw), 'fullward-v3.html の CSS 背景が変わった');
});

test('[Mission 32U] production osaka_3d_buildings.html は promoted build（Mission17 を含む）', () => {
  const prod = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.html'), 'utf-8');
  assert.ok(/MS_BG_NEUTRAL|__BACKGROUND_DEBUG__/.test(prod), 'production HTML に Mission17 の内容が無い（32U cutover 後の production は ward-ux-v1 から生成した promoted build）');
});
