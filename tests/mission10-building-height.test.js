// tests/mission10-building-height.test.js
// [見た目改善 Mission10] 高層建物の高さ表現強化: HTML 配線・不変条件・保護ファイル。
//   成功条件は「派手にすること」ではなく、白い都市模型のまま高さ差でスカイラインが読めること。
//   → geometry の実高度は不変 / 新 material・draw call 0 / 高さ階級カラー無し を機械的に守る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { classifyBuildingHeight, HEIGHT_THRESHOLDS } from '../tools/lib/building-height-style.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const iife = html.slice(html.indexOf('const BUILDING_HEIGHT_STYLE = (function'), html.indexOf('function msLerpClamp'));

test('[Mission10] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const s = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m10-${process.pid}.js`);
  fs.writeFileSync(f, s[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission10] BUILDING_HEIGHT_STYLE IIFE: canonical lib と同じしきい値', () => {
  assert.ok(iife.length > 200, 'IIFE を特定できない');
  const m = iife.match(/THRESHOLDS = \{ MID: (\d+), HIGH: (\d+), SKYSCRAPER: (\d+), VERY_TALL: (\d+) \}/);
  assert.ok(m, 'THRESHOLDS 定義が見つからない');
  assert.equal(Number(m[1]), HEIGHT_THRESHOLDS.MID);
  assert.equal(Number(m[2]), HEIGHT_THRESHOLDS.HIGH);
  assert.equal(Number(m[3]), HEIGHT_THRESHOLDS.SKYSCRAPER);
  assert.equal(Number(m[4]), HEIGHT_THRESHOLDS.VERY_TALL);
});

test('[Mission10] 高さ階級カラー無し: IIFE に色コード / emissive / THREE.Color が無い', () => {
  assert.ok(!/0x[0-9a-fA-F]{6}/.test(iife), 'IIFE に色コード');
  assert.ok(!/emissive|neon|new THREE\.Color|setHSL|setRGB/.test(iife), 'IIFE に色/発光の痕跡');
});

test('[Mission10] MODEL_STYLE ゲート: isEnabled() が MODEL_STYLE.on を参照', () => {
  assert.ok(/isEnabled: \(\) => \(typeof MODEL_STYLE !== 'undefined' && MODEL_STYLE\.on\)/.test(iife));
});

test('[Mission10] CityBuildingLOD: 高さ係数は既存 wc 配列へ掛けるだけ（新 material / mesh 0）', () => {
  const start = html.indexOf('const CityBuildingLOD = (function');
  const end = html.indexOf('const CityModeManager = (function', start);
  const block = html.slice(start, end);
  assert.ok(start >= 0 && end > start, 'CityBuildingLOD ブロック特定失敗');

  // material 生成は 1 箇所（shared）だけ
  const mats = block.match(/new THREE\.(Mesh\w*Material|LineBasicMaterial|ShaderMaterial)/g) || [];
  assert.equal(mats.length, 1, `CityBuildingLOD の material 生成が ${mats.length} 箇所: ${mats.join(',')}`);
  assert.ok(/if \(!sharedMaterial\) sharedMaterial = new THREE\.MeshLambertMaterial\(\{ color: LOD_COLOR, vertexColors: true \}\)/.test(block), 'shared material 構造が変わった');

  // appendBuilding は BUILDING_HEIGHT_STYLE で係数を作り wc へ push するだけ。per-building geometry/mesh 無し
  const append = block.slice(block.indexOf('function appendBuilding'), block.indexOf('function buildOneMesh'));
  assert.ok(/BUILDING_HEIGHT_STYLE\.getHeightStyle\(b\.dz, 'cityLOD'\)/.test(append), 'appendBuilding が高さ係数を使っていない');
  assert.ok(/lmClamp\(LOD_BOTTOM_SHADE \* botMul/.test(append), 'appendBuilding が clamp していない');
  assert.ok(/lmClamp = BUILDING_HEIGHT_STYLE\.clampShade/.test(append), '非ランドマークの clamp が Mission10 の clampShade でない');
  assert.ok(!/new THREE\.(Mesh|BufferGeometry|Line)\(/.test(append), 'appendBuilding が per-building オブジェクトを生成している');
  // 押し出しは y0 = b.z0 / y1 = b.z0 + b.dz のまま（実高度不変）
  assert.ok(/const y0 = b\.z0, y1 = b\.z0 \+ b\.dz;/.test(append), 'CityBuildingLOD の押し出し高さが b.z0 + b.dz でない（実高度改変の疑い）');
});

test('[Mission10] detail 壁: real（白模型）頂点カラーにのみ係数、data モードの wcol は不変', () => {
  const fn = html.slice(html.indexOf('function buildUsageTileMeshes'), html.indexOf('function buildUsageTileMeshes') + 6000);
  // data 用 wcol は従来式（tint × 接地暗化）のまま
  assert.ok(/wcol\.push\(tint\.r\*dBottom, tint\.g\*dBottom, tint\.b\*dBottom\)/.test(fn), 'data モードの wcol 式が変わった');
  // real 用のみ高さ係数（Mission11 で landmark 係数 lmWallMul が合成されたが、height 係数 hBotMul/hTopMul は維持）
  assert.ok(/rf \* dBottom \* hBotMul/.test(fn), 'real wcolReal に高さ係数 hBotMul が入っていない');
  assert.ok(/rf \* dTop \* hTopMul/.test(fn), 'real wcolReal に高さ係数 hTopMul が入っていない');
  assert.ok(/\(lmWallMul !== 1\) \? LANDMARK_REGISTRY\.clampShade : BUILDING_HEIGHT_STYLE\.clampShade/.test(fn),
    '非ランドマークが Mission10 の clamp(1.09) を維持していない');
  assert.ok(/const hs = BUILDING_HEIGHT_STYLE\.getHeightStyle\(b\.dz, 'detail'\)/.test(fn), 'detail 係数の取得が無い');
  // 実高度は y0=b.z0 / y1=b.z0+b.dz のまま
  assert.ok(/const P = b\.fp, y0 = b\.z0, y1 = b\.z0 \+ b\.dz, n = P\.length;/.test(fn), 'detail 壁の押し出し高さが変わった（実高度改変の疑い）');
});

test('[Mission10] geometry 実高度を書き換えていない（b.dz / b.z0 / b.h への代入なし）', () => {
  const stripped = html.split('\n').map((ln) => { const i = ln.indexOf('//'); return (i > 0 && ln[i - 1] === ':') || i < 0 ? ln : ln.slice(0, i); }).join('\n');
  const muts = stripped.match(/\bb\.(dz|z0|h)\s*[*+/-]?=\s*[^=]/g) || [];
  assert.deepEqual(muts, [], `実高度への代入: ${muts.join(' | ')}`);
});

test('[Mission10] __BUILDING_HEIGHT_DEBUG__: 必須キーを返す', () => {
  const dbg = html.slice(html.indexOf('window.__BUILDING_HEIGHT_DEBUG__ = () => {'), html.indexOf('window.__BUILDING_HEIGHT_DEBUG__ = () => {') + 2200);
  for (const k of ['thresholds', 'total', 'low', 'mid', 'high', 'skyscraper', 'veryTall', 'maxHeight',
    'styleEnabled', 'cityLODHeightStyling', 'drawCalls', 'materialsAdded', 'hover']) {
    assert.ok(dbg.includes(k + ':') || dbg.includes(k + ' :'), `__BUILDING_HEIGHT_DEBUG__ に ${k} が無い`);
  }
  assert.ok(/materialsAdded: 0/.test(dbg), 'materialsAdded が 0 でない');
  assert.ok(/texturesAdded: 0/.test(dbg), 'texturesAdded が 0 でない');
});

test('[Mission10] hover 建物の高さ情報を追える（noteHover 配線 + describe）', () => {
  assert.ok(/BUILDING_HEIGHT_STYLE\.noteHover\(h \? h\.d : null\)/.test(html), 'mousemove で noteHover を呼んでいない');
  assert.ok(/wallLowerFactor|wallUpperFactor|edgeMultiplier/.test(iife), 'describe() が factor を返していない');
});

test('[Mission10] RiverLayerV2 / road / park / rail / water / projection は不変', () => {
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html), 'projection 式が変わった');
  // 高さスタイルは建物系のみ。他レイヤーの IIFE に BUILDING_HEIGHT_STYLE 参照が漏れていない
  for (const layer of ['const RiverLayerV2 = (function', 'const WaterSurfaceLayer = (function']) {
    const s = html.indexOf(layer);
    const block = html.slice(s, s + 8000);
    assert.ok(!/BUILDING_HEIGHT_STYLE/.test(block), `${layer} に BUILDING_HEIGHT_STYLE が漏れている`);
  }
});

test('[Mission10] protected HTML に変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/BUILDING_HEIGHT_STYLE|__BUILDING_HEIGHT_DEBUG__/.test(h), `${rel} に Mission10 の変更が混入`);
  }
});

test('[Mission10] 実データ分布のサニティ（>=100m 建物が存在＝スカイライン表現に足る）', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'buildings', 'manifest.json'), 'utf-8'));
  let n = 0, ge100 = 0, kita100 = 0;
  for (const ds of manifest.datasets || []) {
    const dir = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'buildings', ds.id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      for (const b of (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')).buildings || [])) {
        const h = b.dz != null ? b.dz : b.h;
        if (typeof h !== 'number') continue;
        n++;
        if (classifyBuildingHeight(h) === 'skyscraper' || classifyBuildingHeight(h) === 'very_tall') {
          ge100++;
          if (ds.id === 'osaka-kita') kita100++;
        }
      }
    }
  }
  assert.ok(n > 100000, `建物データが少ない (${n})`);
  assert.ok(ge100 >= 20, `>=100m 建物が ${ge100} 件`);
  assert.ok(kita100 >= 10, `梅田・北区の >=100m が ${kita100} 件（スカイライン集積の確認）`);
});
