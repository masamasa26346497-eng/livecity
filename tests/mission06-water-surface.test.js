// tests/mission06-water-surface.test.js
// [見た目改善 Mission06] WaterSurfaceLayer（大阪湾・港湾水面）の HTML 配線・配信データ・保護ファイル。
//   最優先: 過去の巨大水面バグ（陸地塗り潰し / 巨大三角形 / N03境界誤利用）を再発させない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { GROUND_EXTENT, INLAND_TEST_POINTS, validateWaterSurface, pointInTriangle } from '../tools/lib/water-surface.js';
import { skipIfMissingRel } from './_generated-data.mjs';
// [Mission 35L] 検証対象の生成物が無いときだけ skip（生成済みなら従来どおり全部検証する）
const DATA_SKIP = skipIfMissingRel('public/map-data/osaka-city/water-surface/water-surface.json');

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const DATA_PATH = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'water-surface', 'water-surface.json');

test('[Mission06] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const s = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m06-${process.pid}.js`);
  fs.writeFileSync(f, s[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission06] WaterSurfaceLayer は RiverLayerV2 と独立した別モジュール', () => {
  assert.ok(/const WaterSurfaceLayer = \(function \(\) \{/.test(html), 'WaterSurfaceLayer IIFE が無い');
  // 河川の geometry/width ロジックに触れていない（RiverLayerV2 の関数を呼んでいない / 共有状態を触らない）
  const iife = html.slice(html.indexOf('const WaterSurfaceLayer = (function'), html.indexOf('WaterSurfaceLayer.init();'));
  assert.ok(!/RiverLayerV2\.\w+\(|buildRiverRibbon|MAJOR_RIVER_NAMES|cachedData\b|rivers\.json/.test(iife), 'WaterSurfaceLayer が河川ロジックを呼んでいる');
  // 旧 WaterLayer / 旧 multipolygon を復活させていない
  assert.ok(!/assembleMultipolygon|WATER_LAYER_ENABLED\s*=\s*true|new OSM_WATER/.test(iife), '旧水域ロジックを復活させている');
  // coastline のリング組み立てをブラウザでやっていない
  assert.ok(!/coastline|triangulateShape|earcut/i.test(iife), 'WaterSurfaceLayer がブラウザ側で三角形分割/coastline処理をしている');
});

test('[Mission06] 独立した show/hide/dispose + camUpd の opacity LOD hook + 河川トグル追従', () => {
  const iife = html.slice(html.indexOf('const WaterSurfaceLayer = (function'), html.indexOf('WaterSurfaceLayer.init();'));
  for (const fn of ['function show()', 'function hide()', 'function dispose()', 'function updateByCamera(', 'function load()', 'function init()']) {
    assert.ok(iife.includes(fn), `WaterSurfaceLayer に ${fn} が無い`);
  }
  assert.ok(/if \(typeof WaterSurfaceLayer !== 'undefined'\) WaterSurfaceLayer\.updateByCamera\(cs\.r\);/.test(html), 'camUpd の LOD hook が無い');
  assert.ok(/if \(typeof WaterSurfaceLayer !== 'undefined'\) \(on \? WaterSurfaceLayer\.show\(\) : WaterSurfaceLayer\.hide\(\)\);/.test(html), '河川トグル追従の配線が無い');
});

test('[Mission06] Y は 地表 < 海面 < 河川、renderOrder は河川 fill より下', () => {
  const iife = html.slice(html.indexOf('const WaterSurfaceLayer = (function'), html.indexOf('WaterSurfaceLayer.init();'));
  const y = parseFloat(iife.match(/const Y = ([0-9.]+);/)[1]);
  assert.ok(y > -0.02 && y < 0.04, `海面 Y=${y} が 地表(-0.02)〜河川(0.04) の間でない`);
  const ro = parseInt(iife.match(/mesh\.renderOrder = (\d+);/)[1], 10);
  assert.ok(ro < 922, `renderOrder ${ro} が河川 fill(922) より下でない`);
});

test('[Mission06] 海面色は #b7dce6 前後 / opacity 0.55〜0.70', () => {
  const iife = html.slice(html.indexOf('const WaterSurfaceLayer = (function'), html.indexOf('WaterSurfaceLayer.init();'));
  const fill = parseInt(iife.match(/fillColor:\s*0x([0-9a-fA-F]{6})/)[1], 16);
  const r = (fill >> 16) & 255, g = (fill >> 8) & 255, b = fill & 255;
  assert.ok(b >= g && g >= r, '海の色として青みが弱い');
  assert.ok(b > 200 && r > 150, '想定より濃い/暗い');
  const near = parseFloat(iife.match(/opacityNear:\s*([0-9.]+)/)[1]);
  assert.ok(near >= 0.5 && near <= 0.72, `opacityNear=${near} が範囲外`);
});

test('[Mission06] __WATER_SURFACE_DEBUG__ が enabled/polygons/triangles/bbox/source/invalidRejected を返す', () => {
  assert.ok(/window\.__WATER_SURFACE_DEBUG__ = \(\) => WaterSurfaceLayer\.getDebug\(\);/.test(html));
  const dbg = html.match(/function waterSurfaceDebugSnapshot\(\) \{[\s\S]*?\n  \}/)[0];
  for (const k of ['enabled', 'polygons', 'triangles', 'drawCalls', 'bbox', 'source', 'invalidRejected', 'validationErrors']) {
    assert.ok(dbg.includes(k), `getDebug に ${k} が無い`);
  }
});

test('[Mission06] 配信データ: znorth-neg-v1 / emitted / 多重ゲート検証を全通過', { skip: DATA_SKIP }, () => {
  assert.ok(fs.existsSync(DATA_PATH), 'water-surface.json が無い（node tools/build-water-surface.js）');
  const doc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  assert.equal(doc.coordinateConvention, 'znorth-neg-v1');
  assert.equal(doc.emitted, true, 'emitted !== true（reject-to-empty されている）: ' + (doc.validationErrors || []).join(' / '));
  assert.equal(doc.rejectedToEmpty, false);
  assert.ok(Array.isArray(doc.positions) && doc.positions.length >= 6, 'positions が空');
  assert.equal(doc.positions.length % 6, 0);

  const v = validateWaterSurface({ positions: doc.positions, cellM: doc.cellM, extent: GROUND_EXTENT, inlandPoints: INLAND_TEST_POINTS });
  assert.equal(v.ok, true, v.errors.join(' / '));
  assert.equal(v.stats.nanCount, 0);
  assert.equal(v.stats.degenerateCount, 0);
  assert.equal(v.stats.sliverCount, 0);
  assert.equal(v.stats.oversizeCount, 0);
  assert.equal(v.stats.tallCount, 0);
  assert.equal(v.stats.inlandHits, 0, '内陸テスト点が海面に内包されている');
});

test('[Mission06] 配信データ: 既知の内陸/沿岸市街地点が海面に含まれない', { skip: DATA_SKIP }, () => {
  const doc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const pos = doc.positions;
  const LAND_POINTS = [
    ['梅田', -2500, -9500], ['難波', -1500, -6500], ['天王寺', -300, -6000], ['大阪城', 0, -8600],
    ['港区役所', -6800, -6300], ['大正区中心', -5400, -4700], ['此花USJ', -7000, -7800],
    ['咲洲庁舎', -9000, -3200], ['平野区', 3575, -1261], ['鶴見区', 4955, -11242],
  ];
  for (const [name, x, z] of LAND_POINTS) {
    let hit = false;
    for (let i = 0; i + 6 <= pos.length; i += 6) {
      if (pointInTriangle(x, z, pos[i], pos[i + 1], pos[i + 2], pos[i + 3], pos[i + 4], pos[i + 5])) { hit = true; break; }
    }
    assert.equal(hit, false, `${name} (${x},${z}) が海面に塗られている`);
  }
});

test('[Mission06] 配信データ: 総面積が妥当（陸を塗っていない）/ bbox は西・南のみ', { skip: DATA_SKIP }, () => {
  const doc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const km2 = doc.areaM2 / 1e6;
  assert.ok(km2 >= 20 && km2 <= 120, `海面総面積 ${km2.toFixed(1)}km² が想定外`);
  // 海は西(x<0)・南寄り。東半分(x>0)や内陸は塗らない
  assert.ok(doc.bbox.maxX <= 0, `bbox.maxX=${doc.bbox.maxX} が東へ延びている`);
  assert.ok(doc.bbox.minX >= GROUND_EXTENT.minX - 1 && doc.bbox.maxZ <= GROUND_EXTENT.maxZ + 1, 'bbox が地表矩形を外れる');
});

test('[Mission06] protected HTML に変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/WaterSurfaceLayer|__WATER_SURFACE_DEBUG__|water-surface\.json/.test(h), `${rel} に Mission06 の変更が混入`);
  }
});

test('[Mission06] projection / znorth-neg-v1 は不変', () => {
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html), 'projection 式が変わった');
});
