// tests/mission11b-landmark-layer.test.js
// [見た目改善 Mission11B] LandmarkLayer（ランドマーク専用 3D モデル経路）の HTML 配線・配信データ・回帰保護。
//   成功条件: Registry → provider → LandmarkLayer → 実世界座標で表示、の経路が動くこと（19件全部でなくてよい）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { getModelSpec, buildGeometry } from '../tools/lib/landmark-model-provider.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const DATA = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json');
const iife = html.slice(html.indexOf('const LandmarkLayer = (function'), html.indexOf('LandmarkLayer.init()'));

test('[Mission11B] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const s = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m11b-${process.pid}.js`);
  fs.writeFileSync(f, s[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission11B] LandmarkLayer: 1 merged mesh / 1 material（City Mode bulk-load 禁止）', () => {
  assert.ok(iife.length > 600, 'IIFE を特定できない');
  assert.equal((iife.match(/new THREE\.Mesh\(/g) || []).length, 1, 'Mesh 生成が 1 個でない（merged のはず）');
  assert.equal((iife.match(/new THREE\.\w*Material\(/g) || []).length, 1, 'material 生成が 1 個でない');
  assert.ok(!/GLTFLoader|DRACOLoader|loadAsync/.test(iife), 'GLTF loader を実装している（今回は spec のみのはず）');
  // geometry は landmarks.json 焼き込み済みを使う（HTML に生成コードを持たせない）
  assert.ok(!/generateTower|generateDome|pushRectFrustum/.test(iife), 'HTML に procedural 生成コードが混入');
  assert.ok(/m\.positions/.test(iife) && /m\.indices/.test(iife), 'landmarks.json の焼き込み geometry を読んでいない');
});

test('[Mission11B] 実世界座標 + スケール不変: anchor へ平行移動のみ、y はそのまま', () => {
  assert.ok(/m\.positions\[i\] \+ l\.x/.test(iife), 'anchor.x への平行移動が無い');
  assert.ok(/m\.positions\[i \+ 2\] \+ l\.z/.test(iife), 'anchor.z への平行移動が無い');
  assert.ok(!/\*\s*1\.[0-9]|scale\.set\(|multiplyScalar/.test(iife.replace(/renderOrder|FAR_HIDE_M/g, '')), 'スケール倍率が掛かっている');
});

test('[Mission11B] duplicate suppression: building builder 2 経路に配線 + 実高度不変', () => {
  assert.ok(/if \(typeof LandmarkLayer !== 'undefined' && LandmarkLayer\.isSuppressedBuilding\(b\.id\)\) continue;/.test(html),
    'buildUsageTileMeshes に suppress の配線が無い');
  assert.ok(/if \(typeof LandmarkLayer !== 'undefined' && LandmarkLayer\.isSuppressedBuilding\(b\.id\)\) return;/.test(html),
    'CityBuildingLOD.appendBuilding に suppress の配線が無い');
  // suppress は resolved + model ありのランドマークの buildingId のみ（PoC は 0 件）
  assert.ok(/if \(l\.resolved && Array\.isArray\(l\.buildingIds\)\) for \(const bid of l\.buildingIds\) suppressed\.add\(bid\)/.test(iife),
    'suppress 対象が resolved + buildingIds に限定されていない');
  const stripped = html.split('\n').map((ln) => { const i = ln.indexOf('//'); return (i > 0 && ln[i - 1] === ':') || i < 0 ? ln : ln.slice(0, i); }).join('\n');
  assert.deepEqual(stripped.match(/\bb\.(dz|z0|h)\s*[*+/-]?=\s*[^=]/g) || [], []);
});

test('[Mission11B] CityBuildingLOD.build が LandmarkLayer.ready を await（遠景の二重表示防止）', () => {
  const s = html.indexOf('const CityBuildingLOD = (function');
  const e = html.indexOf('const CityModeManager = (function', s);
  const block = html.slice(s, e);
  assert.ok(/await LandmarkLayer\.ready\(\)/.test(block), 'CityBuildingLOD.build が LandmarkLayer.ready を await していない');
});

test('[Mission11B] __LANDMARK_LAYER_DEBUG__: 必須キー + 個別確認', () => {
  const g = html.slice(html.indexOf('function getDebug(id)', html.indexOf('const LandmarkLayer')), html.indexOf('function getDebug(id)', html.indexOf('const LandmarkLayer')) + 1800);
  for (const k of ['registered', 'availableModels', 'loaded', 'visible', 'failed', 'triangles',
    'drawCalls', 'textures', 'memoryEstimate', 'lod', 'landmarks']) {
    assert.ok(g.includes(k + ':'), `__LANDMARK_LAYER_DEBUG__ に ${k} が無い`);
  }
  assert.ok(/if \(id\)/.test(g), '個別確認 (id) の分岐が無い');
  assert.ok(/source[,:]|modelType[,:]|distance[,:]|position[,:]/.test(g), '個別確認が source/modelType/distance/position を返していない');
});

test('[Mission11B] camUpd に LandmarkLayer.updateByCamera / mousemove に noteHover', () => {
  assert.ok(/if \(typeof LandmarkLayer !== 'undefined'\) LandmarkLayer\.updateByCamera\(cs\.r\);/.test(html));
  assert.ok(/if \(typeof LandmarkLayer !== 'undefined'\) LandmarkLayer\.noteHover\(h \? h\.d : null\);/.test(html));
});

test('[Mission11B QA] __LANDMARK_FOCUS__: registry の x/z を読み cs を書いて camUpd するだけ（既存 camera ロジック不変）', () => {
  const fn = html.slice(html.indexOf('window.__LANDMARK_FOCUS__ = function'), html.indexOf('window.__LANDMARK_FOCUS__ = function') + 1600);
  assert.ok(fn.length > 200, '__LANDMARK_FOCUS__ が無い');
  assert.ok(/LANDMARK_REGISTRY\.getRegistry\(\)/.test(fn), 'registry から x/z を取得していない');
  assert.ok(/cs\.tgt\.set\(l\.x,.*l\.z\)/.test(fn), 'target を landmark x/z にしていない');
  assert.ok(/camUpd\(\)/.test(fn), 'camUpd を呼んでいない');
  // 目安レンジ: radius 600〜1000 / elevation 35〜45
  assert.ok(/Math\.max\(600, Math\.min\(1000,/.test(fn), 'radius が 600〜1000 の範囲でクランプされていない');
  const elev = parseInt(fn.match(/const elevationDeg = (\d+)/)[1], 10);
  assert.ok(elev >= 35 && elev <= 45, `elevationDeg=${elev} が 35〜45 の範囲外`);
  // registry / projection / camera preset を書き換えていない
  assert.ok(!/LANDMARK_REGISTRY\.\w+\s*=[^=]|CITY_CAMERA_PRESET\.\w+\s*=[^=]|SEARCH_MPD\s*=[^=]/.test(fn), '定数を書き換えている');
  // 本番 UI に露出していない: onclick / addEventListener / ボタン等から呼ばれていない（window.__ debug のみ）
  assert.ok(!/onclick=["'][^"']*__LANDMARK_FOCUS__|addEventListener\([^)]*__LANDMARK_FOCUS__|id=["'][^"']*landmark-focus/.test(html),
    '__LANDMARK_FOCUS__ が本番 UI（onclick / listener / button）から参照されている');
  // 既存 camera 関数（camUpd / flyTo / CityModeManager / getCityCameraTarget）を書き換えていない
  assert.ok(!/function camUpd|function flyTo|function getCityCameraTarget/.test(fn), '__LANDMARK_FOCUS__ 内で既存 camera 関数を再定義している');
});

test('[Mission11B] 配信データ landmarks.json: PoC 3 件が procedural geometry を焼き込み済み', () => {
  assert.ok(fs.existsSync(DATA), 'landmarks.json が無い');
  const doc = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  const withModel = doc.landmarks.filter((l) => l.model && l.model.kind === 'procedural');
  assert.equal(withModel.length, 3, 'procedural model 件数が 3 でない');
  assert.deepEqual(withModel.map((l) => l.id).sort(), ['kyocera-dome-osaka', 'tsutenkaku', 'umeda-sky-building']);

  let totalTri = 0;
  for (const l of withModel) {
    const m = l.model;
    assert.ok(Array.isArray(m.positions) && m.positions.length % 3 === 0);
    assert.ok(Array.isArray(m.indices) && m.indices.length % 3 === 0);
    assert.equal(m.indices.length / 3, m.triangleCount);
    assert.ok(m.positions.every(Number.isFinite), `${l.id}: 非有限座標`);
    const nv = m.positions.length / 3;
    assert.ok(m.indices.every((i) => Number.isInteger(i) && i >= 0 && i < nv), `${l.id}: index 範囲外`);
    totalTri += m.triangleCount;
    // 底 y=0
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < m.positions.length; i += 3) { minY = Math.min(minY, m.positions[i]); maxY = Math.max(maxY, m.positions[i]); }
    assert.ok(Math.abs(minY) < 0.5, `${l.id}: 底が y=0 でない`);
    // 高さ ≈ osmHeight（拡大していない）
    const r = maxY / l.osmHeight;
    assert.ok(r > 0.9 && r < 1.15, `${l.id}: 高さ比 ${r.toFixed(2)}（拡大の疑い）`);
    // 焼き込みが再生成と一致（決定的）
    const spec = getModelSpec(l);
    assert.equal(buildGeometry(spec).triangleCount, m.triangleCount, `${l.id}: 焼き込みが非決定的`);
  }
  assert.ok(totalTri < 100000, `procedural 合計 ${totalTri} tri（budget 超過）`);
  assert.equal(doc.counts.withModel, 3);
});

test('[Mission11B] Mission10 / Mission11 / Mission14 / Mission15 regression', () => {
  assert.ok(/const BUILDING_HEIGHT_STYLE = \(function \(\) \{/.test(html), 'Mission10 が消えた');
  assert.ok(/window\.__BUILDING_HEIGHT_DEBUG__ = /.test(html), 'Mission10 debug が消えた');
  assert.ok(/const LANDMARK_REGISTRY = \(function \(\) \{/.test(html), 'Mission11 registry が消えた');
  assert.ok(/window\.__LANDMARK_DEBUG__ = /.test(html), 'Mission11 debug が消えた');
  assert.ok(/now - pendingSince > 1600 && now - lastRebuildAt > 3000/.test(html), 'Mission14 station debounce が変わった');
  assert.ok(!/const LabelEngine = \(function/.test(html), 'Mission15 LabelEngine が復活している');
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html), 'projection が変わった');
});

test('[Mission11B] protected HTML に変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/LandmarkLayer|__LANDMARK_LAYER_DEBUG__/.test(h), `${rel} に Mission11B の変更が混入`);
  }
});

test('[Mission11B] Data QA: 異常 height（>500m）はランドマーク候補に採用されていない', () => {
  const doc = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  for (const l of doc.landmarks) {
    if (typeof l.osmHeight === 'number') assert.ok(l.osmHeight <= 500, `${l.id}: osmHeight ${l.osmHeight} > 500`);
    if (l.matchedHeights) for (const h of l.matchedHeights) assert.ok(h <= 500, `${l.id}: matchedHeight ${h} > 500`);
  }
});
