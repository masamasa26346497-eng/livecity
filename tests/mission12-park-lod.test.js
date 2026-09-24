// tests/mission12-park-lod.test.js
// [見た目改善 Mission12] 公園・緑地 LOD の HTML 配線 + 実データ検証。
//   CityTileLayer 公園を面積3段階でLOD、埋め込み ParkLayer も同方針、色は淡い soft green。
//   layer order（water < park < road）維持。1 park = 1 mesh でない。geometry は不変。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { classifyParkArea, polygonAreaWithHoles } from '../tools/lib/park-lod.js';
import { skipIfMissingRel } from './_generated-data.mjs';
// [Mission 35L] 検証対象の生成物が無いときだけ skip（生成済みなら従来どおり全部検証する）
const TILE_SKIP = skipIfMissingRel('public/map-data/osaka-city/parks');

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const PARKS_DIR = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'parks');

function loadParkFeatures() {
  const byId = new Map();
  for (const f of fs.readdirSync(PARKS_DIR).filter((n) => /^tile_.*\.json$/.test(n))) {
    const tile = JSON.parse(fs.readFileSync(path.join(PARKS_DIR, f), 'utf-8'));
    for (const ft of (tile.features || [])) {
      if (ft.kind && ft.kind !== 'area') continue;
      if (!byId.has(ft.id)) byId.set(ft.id, ft);
    }
  }
  return [...byId.values()];
}

test('[Mission12] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m12-${process.pid}.js`);
  fs.writeFileSync(f, m[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission12] 実データ: 公園 area feature 数と面積3分類', { skip: TILE_SKIP }, () => {
  const feats = loadParkFeatures();
  assert.ok(feats.length > 2000, `公園 feature が少なすぎる: ${feats.length}`);
  const c = { large: 0, medium: 0, small: 0 };
  for (const f of feats) c[classifyParkArea(polygonAreaWithHoles(f.p, f.holes))]++;
  assert.equal(c.large + c.medium + c.small, feats.length, '分類合計 != feature数');
  // 実データ監査: LARGE は十数件、SMALL が大多数
  assert.ok(c.large >= 8 && c.large <= 25, `LARGE=${c.large}（大阪城/鶴見緑地/長居 等）`);
  assert.ok(c.small / feats.length > 0.85, `SMALL 比率=${(c.small / feats.length).toFixed(2)}（街区公園がノイズ源）`);
});

test('[Mission12] 実データ: 主要大公園が面積classificationで large になる（名前一致に依存しない）', { skip: TILE_SKIP }, () => {
  const feats = loadParkFeatures();
  const byName = (kw) => feats.filter((f) => f.name && f.name.includes(kw))
    .map((f) => ({ name: f.name, area: polygonAreaWithHoles(f.p, f.holes), cls: classifyParkArea(polygonAreaWithHoles(f.p, f.holes)) }))
    .sort((a, b) => b.area - a.area)[0];
  for (const kw of ['大阪城公園', '長居公園', '鶴見緑地', '天王寺公園']) {
    const top = byName(kw);
    assert.ok(top, `${kw} が見つからない`);
    assert.equal(top.cls, 'large', `${kw}（最大 ${(top.area / 1e4).toFixed(1)}ha）が large でない`);
  }
});

test('[Mission12] CityTileLayer: 公園を large/medium/small の3 mesh へ統合（1 park = 1 mesh でない）', () => {
  assert.ok(/function buildParkMeshes\(features, y, color, meta\) \{[\s\S]*?const buckets = \{ large: \[\], medium: \[\], small: \[\] \};/.test(html),
    'buildParkMeshes が3バケットに分けていない');
  assert.ok(/for \(const tier of \['large', 'medium', 'small'\]\) \{\s*const m = areaMesh\(buckets\[tier\], y, color, meta\);/.test(html),
    'tier ごとに1 mesh へ統合していない');
  assert.ok(/m\.userData\.parkTier = tier;/.test(html), 'parkTier タグが無い');
});

test('[Mission12] CityTileLayer: 距離LODで tier別 visible + band別 opacity', () => {
  assert.ok(/if \(ud\.parkTier\) \{[\s\S]*?parkClassVisible\(ud\.parkTier, distance\)[\s\S]*?parkTierOpacity\(ud\.parkTier, distance\)/.test(html),
    'applyLodToOneMesh の公園 LOD 処理が無い');
  assert.ok(/const PARK_TIER_OPACITY = \{ large: \{ near: 0\.80, mid: 0\.62, far: 0\.46 \}/.test(html), 'opacity テーブルが無い');
});

test('[Mission12] band しきい値が道路LOD（9000/3500）と一致', () => {
  assert.ok(/const PARK_LOD_FAR_M = 9000, PARK_LOD_MID_M = 3500;/.test(html), '公園 band が道路と揃っていない');
  assert.ok(/const ROAD_LOD_FAR_M = 9000, ROAD_LOD_MID_M = 3500;/.test(html), '道路 band 定義が変わった');
});

test('[Mission12] park color: 淡い soft green（河川シアン #9ed6e6 と区別・彩度控えめ）', () => {
  const m = html.match(/const MS_PARK_GREEN = (0x[0-9a-f]{6});/);
  assert.ok(m, 'MS_PARK_GREEN 未定義');
  const v = parseInt(m[1], 16), r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  assert.ok(g > r && g > b, `緑優勢でない #${m[1].slice(2)}`);
  assert.ok(g >= 200, `緑地として淡すぎ/暗すぎ g=${g}`);
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 40, '彩度が高い（soft でない）');
  // 河川色 0x9ed6e6 は青優勢（B>G>R）。公園は緑優勢。→ 明確に別系統。
  const river = 0x9ed6e6;
  assert.ok((river & 255) > ((river >> 8) & 255), '河川色が青優勢でない（前提崩れ）');
  // CityTileLayer / ParkLayer が MODEL_STYLE 時にこの色を使う
  assert.ok(/color: \(\(typeof MODEL_STYLE !== 'undefined' && MODEL_STYLE\.on\) \? MS_PARK_GREEN : 0x7bb36a\)/.test(html),
    'CityTileLayer parks の色が MS_PARK_GREEN を通っていない');
  assert.ok(/function parkFillColor\(isReal\) \{[\s\S]*?return MS_PARK_GREEN;/.test(html), 'ParkLayer が MS_PARK_GREEN を使っていない');
});

test('[Mission12] layer order: water(0.04/0.05) < park(0.07) < road(0.13)', () => {
  assert.ok(/parks:\s+\{ y: 0\.07,/.test(html), 'CityTileLayer parks の y が 0.07 でない');
  assert.ok(/roads:\s+\{ y: 0\.13,/.test(html), 'CityTileLayer roads の y が 0.13 でない');
  assert.ok(/const WATER_FILL_Y = 0\.04;/.test(html), 'water fill y が変わった');
  // renderOrder: park 930、road tier は 0（ROAD_TIER_DY で微差）。road ribbon は park より上。
  assert.ok(/m\.renderOrder = 930;/.test(html), 'park mesh の renderOrder が変わった');
});

test('[Mission12] 埋め込み ParkLayer: tier分割 + updateByCamera + camUpd 配線', () => {
  assert.ok(/const parkMeshes = \{\};/.test(html), 'ParkLayer が tier 別 mesh へ分割されていない');
  assert.ok(/updateByCamera\(distance\) \{[\s\S]*?pClassVisible\(tier, d\)/.test(html), 'ParkLayer.updateByCamera が無い');
  assert.ok(/if \(typeof ParkLayer !== 'undefined' && ParkLayer\.updateByCamera\) ParkLayer\.updateByCamera\(cs\.r\);/.test(html),
    'camUpd が ParkLayer.updateByCamera を呼んでいない');
  assert.ok(!/let parkMesh = null;/.test(html), '旧 単一 parkMesh 変数が残っている');
});

test('[Mission12] debug API: __PARK_LOD_DEBUG__ / __PARK_LOD_FORCE__', () => {
  assert.ok(/window\.__PARK_LOD_DEBUG__ = \(\) => \(typeof CityTileLayer !== 'undefined' \? CityTileLayer\.getParkLodDebug\(\)/.test(html),
    '__PARK_LOD_DEBUG__ が無い');
  assert.ok(/window\.__PARK_LOD_FORCE__ = \(band\) => \(typeof CityTileLayer !== 'undefined' \? CityTileLayer\.setParkLodForce\(band\)/.test(html),
    '__PARK_LOD_FORCE__ が無い');
  const dbg = html.match(/function getParkLodDebug\(\) \{[\s\S]*?\n  \}/)[0];
  for (const k of ['cameraDistance', 'band', 'visibleLarge', 'visibleMedium', 'visibleSmall', 'loadedTiles', 'visibleFeatures', 'drawCallsEstimate']) {
    assert.ok(dbg.includes(k), `getParkLodDebug に ${k} が無い`);
  }
});

test('[Mission12] 他ミッションの成果を壊していない', () => {
  assert.ok(/fillColor: 0x9ed6e6/.test(html), '河川色が変わった');
  assert.ok(/const ROAD_RIBBON_COLOR = \{ major: 0xb8bdc3, mid: 0xc4c8cc, local: 0xd0d3d6 \};/.test(html), '道路 ribbon 色が変わった');
  // [Mission 33A] 背景は 0xf3f4f1 → 0xf6f7f3 へ一段明るくした（Mission17 の「明るい neutral」方針は維持）
  assert.ok(/const MS_BG_NEUTRAL = 0xf6f7f3;/.test(html), 'Mission17 背景色が変わった');
  assert.ok(/const MODEL_FOG = \{/.test(html), 'Mission18 fog が消えた');
  assert.ok(/const CITY_CAMERA_PRESET = \{/.test(html), 'Mission16 camera preset が消えた');
});

test('[Mission12] protected baseline fullward-v3.html は Mission12 の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/MS_PARK_GREEN|parkClassVisible|__PARK_LOD_DEBUG__|PARK_AREA_LARGE_M2/.test(fw), 'fullward-v3.html に Mission12 の変更が混入');
});

test('[Mission 32U] production osaka_3d_buildings.html は promoted build（Mission12 を含む）', () => {
  const prod = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.html'), 'utf-8');
  assert.ok(/MS_PARK_GREEN|__PARK_LOD_DEBUG__|PARK_AREA_LARGE_M2/.test(prod), 'production HTML に Mission12 の内容が無い（32U cutover 後の production は ward-ux-v1 から生成した promoted build）');
});
