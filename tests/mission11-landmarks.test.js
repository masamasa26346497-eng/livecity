// tests/mission11-landmarks.test.js
// [見た目改善 Mission11] ランドマーク識別・表現基盤の HTML 配線・配信データ・回帰保護。
//   成功条件は「派手にする」ではなく「主要建築物を自然に認識できる都市模型」へ一段進むこと。
//   → 実高度不変 / draw call・material・texture 増 0 / 誤識別しない / Mission10・14 を壊さない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { LANDMARK_SEED, LANDMARK_CATEGORIES } from '../tools/lib/landmark-registry.js';
import { skipIfMissingRel } from './_generated-data.mjs';
// [Mission 35L] 検証対象の生成物が無いときだけ skip（生成済みなら従来どおり全部検証する）
const DATA_SKIP = skipIfMissingRel('public/map-data/osaka-city/landmarks/landmarks.json');

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const DATA = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json');
const iife = html.slice(html.indexOf('const LANDMARK_REGISTRY = (function'), html.indexOf('LANDMARK_REGISTRY.load('));

test('[Mission11] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const s = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m11-${process.pid}.js`);
  fs.writeFileSync(f, s[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission11] LANDMARK_REGISTRY IIFE: canonical な landmarks.json を fetch し名称をハードコードしない', () => {
  assert.ok(iife.length > 400, 'IIFE を特定できない');
  assert.ok(/fetch\(DATA_URL\)/.test(iife), 'landmarks.json を fetch していない');
  assert.ok(/map-data\/osaka-city\/landmarks\/landmarks\.json/.test(iife), 'DATA_URL が違う');
  // ランドマーク名を HTML に列挙していない（レジストリ由来のみ）。
  // [Mission 34B] 例外は dev QA の camera preset（LOD_VIEW_SITES）だけ。あれは地点へ飛ぶための
  //   座標表で、ランドマークの登録にも表示名にも一切使われない（LANDMARK_REGISTRY /
  //   LandmarkHDLayer は従来どおり landmarks.json 由来）。この test が守りたいのは
  //   「表示されるランドマーク名がレジストリ以外から来ていないこと」なので、そこだけ外す。
  const presetStart = html.indexOf('const LOD_VIEW_SITES = [');
  const withoutPresets = presetStart < 0 ? html
    : html.slice(0, presetStart) + html.slice(html.indexOf('];', presetStart) + 2);
  if (presetStart >= 0) {
    const presets = html.slice(presetStart, html.indexOf('];', presetStart));
    assert.ok(!/LANDMARK_REGISTRY|LandmarkHDLayer|landmarks\.json/.test(presets),
      'camera preset がランドマークのレジストリに繋がっている');
  }
  for (const s of LANDMARK_SEED.slice(0, 8)) {
    assert.ok(!withoutPresets.includes(s.name), `HTML にランドマーク名「${s.name}」がハードコードされている`);
  }
});

test('[Mission11] 色を使わない: IIFE に色コード / emissive / neon が無い', () => {
  assert.ok(!/emissive|neon|setHSL|0x[0-9a-fA-F]{6}/.test(iife), 'LANDMARK_REGISTRY に色/発光');
  // wallMul / roofMul は明度係数（1.0 前後）
  const m = iife.match(/wallMul:\s*([0-9.]+)/);
  assert.ok(m && parseFloat(m[1]) > 1 && parseFloat(m[1]) < 1.1, `wallMul ${m && m[1]} が想定外`);
});

test('[Mission11] 実高度不変: b.dz / b.z0 / b.h への代入なし', () => {
  const stripped = html.split('\n').map((ln) => { const i = ln.indexOf('//'); return (i > 0 && ln[i - 1] === ':') || i < 0 ? ln : ln.slice(0, i); }).join('\n');
  assert.deepEqual(stripped.match(/\bb\.(dz|z0|h)\s*[*+/-]?=\s*[^=]/g) || [], []);
});

test('[Mission11] detail 壁: 合成順序 base × height × landmark、非ランドマークは Mission10 の clamp を維持', () => {
  const fn = html.slice(html.indexOf('function buildUsageTileMeshes'), html.indexOf('function buildUsageTileMeshes') + 7000);
  assert.ok(/LANDMARK_REGISTRY\.isLandmark\(b\.id\)/.test(fn), 'detail 壁で isLandmark を見ていない');
  assert.ok(/rf \* dBottom \* hBotMul \* lmWallMul/.test(fn), '合成順序 (rf × dBottom × height × landmark) でない');
  assert.ok(/\(lmWallMul !== 1\) \? LANDMARK_REGISTRY\.clampShade : BUILDING_HEIGHT_STYLE\.clampShade/.test(fn),
    '非ランドマークが Mission10 の clamp(1.09) を維持していない');
});

test('[Mission11] CityBuildingLOD: landmark 係数は既存 wc へ掛けるだけ（新 material / mesh / draw call 0）', () => {
  const start = html.indexOf('const CityBuildingLOD = (function');
  const end = html.indexOf('const CityModeManager = (function', start);
  const block = html.slice(start, end);
  const mats = block.match(/new THREE\.(Mesh\w*Material|LineBasicMaterial|ShaderMaterial)/g) || [];
  assert.equal(mats.length, 1, `CityBuildingLOD の material 生成が ${mats.length} 箇所`);
  const append = block.slice(block.indexOf('function appendBuilding'), block.indexOf('function buildOneMesh'));
  assert.ok(/LANDMARK_REGISTRY\.isLandmark\(b\.id\)/.test(append), 'appendBuilding で isLandmark を見ていない');
  assert.ok(/LOD_BOTTOM_SHADE \* botMul \* lmMul/.test(append), 'cityLOD 合成順序が base × height × landmark でない');
  assert.ok(!/new THREE\.(Mesh|BufferGeometry|Line)\(/.test(append), 'appendBuilding が per-building オブジェクトを生成');
  assert.ok(/const y0 = b\.z0, y1 = b\.z0 \+ b\.dz;/.test(append), 'CityBuildingLOD 押し出し高さが変わった');
  // build() が landmarks を先に確定させる
  assert.ok(/await LANDMARK_REGISTRY\.ready\(\)/.test(block), 'CityBuildingLOD.build が LANDMARK_REGISTRY.ready を await していない');
});

test('[Mission11] __LANDMARK_DEBUG__: 必須キー + 個別確認', () => {
  const dbg = html.slice(html.indexOf('function getDebug(id)'), html.indexOf('function getDebug(id)') + 1600);
  for (const k of ['total', 'resolved', 'unresolved', 'major', 'regional', 'local', 'visible',
    'cityLODStyled', 'detailStyled', 'labelsEnabled', 'drawCalls', 'materialsAdded', 'texturesAdded', 'landmarks']) {
    assert.ok(dbg.includes(k + ':') || dbg.includes(k + ' :'), `__LANDMARK_DEBUG__ に ${k} が無い`);
  }
  assert.ok(/materialsAdded: 0/.test(dbg) && /texturesAdded: 0/.test(dbg));
  assert.ok(/labelsEnabled: false/.test(dbg), 'Mission11 はラベル追加なし（labelsEnabled:false）');
  assert.ok(/if \(id\) return list\.find/.test(dbg), '__LANDMARK_DEBUG__(id) の個別確認が無い');
});

test('[Mission11] Mission14 station label debounce を壊していない', () => {
  assert.ok(/let pendingCount = -1, pendingSince = 0, lastRebuildAt = 0;/.test(html), 'station debounce 状態が消えた');
  assert.ok(/now - pendingSince > 1600 && now - lastRebuildAt > 3000/.test(html), 'station debounce 条件が変わった');
});

test('[Mission11] Mission15 LabelEngine を復活させていない / Mission10 を維持', () => {
  assert.ok(!/const LabelEngine = \(function/.test(html), 'LabelEngine が復活している');
  assert.ok(/const BUILDING_HEIGHT_STYLE = \(function \(\) \{/.test(html), 'Mission10 BUILDING_HEIGHT_STYLE が消えた');
  assert.ok(/window\.__BUILDING_HEIGHT_DEBUG__ = /.test(html), 'Mission10 debug が消えた');
});

test('[Mission11] projection / znorth-neg-v1 不変', () => {
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html));
});

test('[Mission11] protected HTML に変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/LANDMARK_REGISTRY|__LANDMARK_DEBUG__|landmarks\.json/.test(h), `${rel} に Mission11 の変更が混入`);
  }
});

test('[Mission11] 配信データ landmarks.json: 健全性', { skip: DATA_SKIP }, () => {
  assert.ok(fs.existsSync(DATA), 'landmarks.json が無い（node tools/build-landmark-registry.js）');
  const doc = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  assert.equal(doc.coordinateConvention, 'znorth-neg-v1');
  assert.equal(doc.landmarks.length, LANDMARK_SEED.length);
  const ids = new Set();
  for (const l of doc.landmarks) {
    assert.ok(!ids.has(l.id), `duplicate id ${l.id}`); ids.add(l.id);
    assert.ok(Number.isFinite(l.x) && Number.isFinite(l.z), `${l.id}: NaN 座標`);
    assert.ok(LANDMARK_CATEGORIES.includes(l.category));
    // [Mission11B] modelType は enum（PoC で LOD1/LOD2 も入る）。modelUrl は将来の GLTF 差し替え用。
    assert.ok(['PROCEDURAL', 'LOD1', 'LOD2', 'LOD3', 'GLTF'].includes(l.modelType), `${l.id}: modelType ${l.modelType}`);
    assert.ok('modelUrl' in l, `${l.id}: modelUrl フィールドが無い（将来の GLTF 差し替え用）`);
    if (l.resolved) assert.ok(l.buildingIds.length > 0, `${l.id}: resolved なのに buildingIds 空`);
    else assert.equal(l.buildingIds.length, 0, `${l.id}: unresolved なのに buildingIds 残存`);
  }
  // resolved の建物 id が実在する
  const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'buildings', 'manifest.json'), 'utf-8'));
  const real = new Set();
  for (const ds of manifest.datasets) {
    const dir = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'buildings', ds.id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      for (const b of (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')).buildings || [])) real.add(b.id);
    }
  }
  for (const l of doc.landmarks.filter((x) => x.resolved)) {
    for (const bid of l.buildingIds) assert.ok(real.has(bid), `${l.id}: buildingId ${bid} が存在しない`);
  }
});
