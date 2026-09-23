// tests/mission13-rail-lod.test.js
// [見た目改善 Mission13] 鉄道 LOD の HTML 配線 + 実データ検証。
//   鉄道を「道路と似た灰色の線」から独立した交通レイヤーへ。MAJOR/URBAN/LOCAL 3クラス、
//   道路より濃い色・道路より上の y、地下鉄は弱め、station データ保持。1 way = 1 mesh でない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { classifyRail, polylineLengthXZ, countByRailClass } from '../tools/lib/rail-lod.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const RAIL_DIR = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'railways');

function loadRail() {
  const lineById = new Map(), stById = new Map();
  for (const f of fs.readdirSync(RAIL_DIR).filter((n) => /^tile_.*\.json$/.test(n))) {
    const tile = JSON.parse(fs.readFileSync(path.join(RAIL_DIR, f), 'utf-8'));
    for (const ft of (tile.features || [])) {
      if (ft.kind === 'station' || ft.kind === 'node') { if (!stById.has(ft.id)) stById.set(ft.id, ft); }
      else if (ft.kind === 'line') { if (!lineById.has(ft.id)) lineById.set(ft.id, ft); }
    }
  }
  return { lines: [...lineById.values()], stations: [...stById.values()] };
}

test('[Mission13] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m13-${process.pid}.js`);
  fs.writeFileSync(f, m[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission13] 実データ: railway tag 内訳と3クラス分類', () => {
  const { lines } = loadRail();
  assert.ok(lines.length > 2000, `line feature が少なすぎる: ${lines.length}`);
  const byTag = {};
  for (const f of lines) byTag[f.railway || '(none)'] = (byTag[f.railway || '(none)'] || 0) + 1;
  // 実データ: rail が大多数、subway・light_rail が存在。tram/monorail/construction は無い。
  assert.ok(byTag.rail > 1500, `rail=${byTag.rail}`);
  assert.ok(byTag.subway > 200, `subway=${byTag.subway}`);
  assert.ok(byTag.light_rail > 0, `light_rail=${byTag.light_rail}`);
  const c = countByRailClass(lines);
  assert.equal(c.major + c.urban + c.local + c.excluded, lines.length, '分類合計 != feature数');
  assert.equal(c.urban, byTag.subway, 'URBAN = subway 件数');
  assert.ok(c.major > 800 && c.major < byTag.rail, `MAJOR=${c.major}（rail の一部＝本線骨格）`);
});

test('[Mission13] 実データ: 主要路線相当の geometry が存在（name 欠落でも表示できる）', () => {
  const { lines } = loadRail();
  // [Mission24] rail way に路線名を保持するようになった（生データの 2/3 が name あり）。
  //   ただし name が無くても geometry + tag + railClass だけで扱えること（下記の geometry チェック）。
  assert.ok(lines.filter((f) => f.name).length > 1500, '路線名が保持されていない（Mission24）');
  assert.ok(lines.some((f) => !f.name), 'name 無し way も存在（geometry のみで扱える前提の検証）');
  // 御堂筋線相当: 南北に長い subway 骨格 → 長い subway way が複数ある
  const longSubway = lines.filter((f) => f.railway === 'subway' && polylineLengthXZ(f.p) > 1000);
  assert.ok(longSubway.length >= 3, `長い subway way が少ない: ${longSubway.length}`);
  // 大阪環状線相当: 中心部に rail が密集
  const centralRail = lines.filter((f) => f.railway === 'rail' && f.p.some((p) => Math.abs(p[0]) < 3000 && Math.abs(p[1] + 8500) < 4000));
  assert.ok(centralRail.length > 50, `中心部の rail feature が少ない: ${centralRail.length}`);
});

test('[Mission13] 実データ: station node 233件前後・全件 name 付き（Mission 14 用に保持）', () => {
  const { stations } = loadRail();
  assert.ok(stations.length >= 200 && stations.length <= 300, `station 数=${stations.length}`);
  assert.equal(stations.filter((s) => s.name).length, stations.length, '全 station に name');
  assert.ok(!stations.some((s) => /�/.test(s.name)), 'station name に文字化けがある');
});

test('[Mission13] CityTileLayer: rail を MAJOR/URBAN/LOCAL の tier別 mesh へ統合（1 way = 1 mesh でない）', () => {
  assert.ok(/function buildRailMeshes\(features, y\) \{[\s\S]*?const buckets = \{ major: \[\], urban: \[\], local: \[\] \};/.test(html),
    'buildRailMeshes が3バケットに分けていない');
  assert.ok(/for \(const tier of \['major', 'urban', 'local'\]\) \{\s*const m = lineMesh\(buckets\[tier\], y \+ dy\[tier\], RAIL_COLORS\[tier\]\);/.test(html),
    'tier ごとに1 LineSegments へ統合していない');
  assert.ok(/for \(const rm of buildRailMeshes\(feats\.filter\(\(f\) => f\.kind === 'line'\), st\.y\)\) meshes\.push\(rm\);/.test(html),
    'railways branch が buildRailMeshes を使っていない');
});

test('[Mission13] 距離LOD: tier別 visible + band別 opacity、band しきい値は道路と一致', () => {
  assert.ok(/const RAIL_LOD_FAR_M = 9000, RAIL_LOD_MID_M = 3500;/.test(html), 'rail band が道路(9000/3500)と揃っていない');
  assert.ok(/if \(ud\.rail === 'line'\) \{[\s\S]*?railClassVisible\(ud\.railTier \|\| 'major', distance\)[\s\S]*?railTierOpacity\(ud\.railTier \|\| 'major', distance\)/.test(html),
    'applyLodToOneMesh の rail LOD 処理が無い');
});

test('[Mission13] rail color: 道路(light gray)より濃い medium neutral gray、河川シアン・公園緑と別系統', () => {
  const m = html.match(/const RAIL_COLORS = \{ major: (0x[0-9a-f]{6}), urban: (0x[0-9a-f]{6}), local: (0x[0-9a-f]{6}) \};/);
  assert.ok(m, 'RAIL_COLORS 未定義');
  const major = parseInt(m[1], 16);
  // 道路 CityTileLayer line 色 0x9aa1a8（161）より rail major が濃い
  assert.ok((major & 255) < 0xa8, `rail major (#${m[1].slice(2)}) が道路より濃くない`);
  // ほぼ無彩色（ごく僅かな寒色寄りは可）
  const r = (major >> 16) & 255, g = (major >> 8) & 255, b = major & 255;
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 18, 'rail 色の色味が強すぎる');
  // 河川 0x9ed6e6 / 公園 MS_PARK_GREEN とは別（無彩色 vs 有彩色）
  assert.ok(/fillColor: 0x9ed6e6/.test(html) && /const MS_PARK_GREEN = 0xcfe3c7;/.test(html), '前提の色定義が変わった');
});

test('[Mission13] 地下鉄(subway/urban)は弱め: FAR 非表示 + opacity 低め', () => {
  const m = html.match(/const RAIL_TIER_OPACITY = \{ major: \{ near: ([0-9.]+),[^}]*\}, urban: \{ near: ([0-9.]+),/);
  assert.ok(m, 'RAIL_TIER_OPACITY 未定義');
  assert.ok(parseFloat(m[2]) < parseFloat(m[1]), 'urban(地下鉄) が major より濃い');
  assert.ok(parseFloat(m[2]) <= 0.55, `urban opacity=${m[2]} が高い（地上と重なりノイズ）`);
  // railClassVisible: urban は far で false
  assert.ok(/if \(cls === 'urban'\) return b !== 'far';/.test(html), 'urban が FAR で非表示になっていない');
});

test('[Mission13] rail y は road y(0.13) より上、renderOrder は park(930) より上・building より下', () => {
  assert.ok(/railways:\s+\{ y: 0\.17,/.test(html), 'rail y が 0.17 でない（道路 0.13 より上）');
  assert.ok(/roads:\s+\{ y: 0\.13,/.test(html), '道路 y が変わった');
  assert.ok(/m\.renderOrder = 936;/.test(html), 'rail line の renderOrder が 936 でない');
  assert.ok(/sm\.userData\.rail = 'station'; sm\.renderOrder = 938;/.test(html), 'station renderOrder が rail line より下');
});

test('[Mission13] station データ保持: stationMesh は残る・破棄しない', () => {
  assert.ok(/function stationMesh\(features, y\)/.test(html), 'stationMesh が消えた');
  assert.ok(/feats\.filter\(\(f\) => f\.kind === 'station'\)/.test(html), 'station feature の抽出が消えた');
  assert.ok(/function stationVisible\(d\) \{ return d <= STATION_MAX_M; \}/.test(html), 'station 距離LODが消えた');
});

test('[Mission13] debug API: __RAIL_LOD_DEBUG__ / __RAIL_LOD_FORCE__ / __STATION_DEBUG__', () => {
  assert.ok(/window\.__RAIL_LOD_DEBUG__ = \(\) => \(typeof CityTileLayer !== 'undefined' \? CityTileLayer\.getRailLodDebug\(\)/.test(html));
  assert.ok(/window\.__RAIL_LOD_FORCE__ = \(band\) => \(typeof CityTileLayer !== 'undefined' \? CityTileLayer\.setRailLodForce\(band\)/.test(html));
  assert.ok(/window\.__STATION_DEBUG__ = \(\) => \(typeof CityTileLayer !== 'undefined' \? CityTileLayer\.getStationDebug\(\)/.test(html));
  const rd = html.match(/function getRailLodDebug\(\) \{[\s\S]*?\n  \}/)[0];
  for (const k of ['cameraDistance', 'band', 'visibleMajor', 'visibleUrban', 'visibleLocal', 'visibleSubway', 'loadedTiles', 'visibleFeatures', 'drawCallsEstimate']) {
    assert.ok(rd.includes(k), `getRailLodDebug に ${k} が無い`);
  }
  const sd = html.match(/function getStationDebug\(\) \{[\s\S]*?\n  \}/)[0];
  for (const k of ['stationCount', 'namedStationCount', 'sampleNames', 'bbox', 'operatorCounts']) {
    assert.ok(sd.includes(k), `getStationDebug に ${k} が無い`);
  }
});

test('[Mission13] 他ミッションの成果を壊していない', () => {
  assert.ok(/fillColor: 0x9ed6e6/.test(html), '河川色');
  assert.ok(/const MS_PARK_GREEN = 0xcfe3c7;/.test(html), '公園色');
  assert.ok(/const PARK_AREA_LARGE_M2 = 100000, PARK_AREA_MEDIUM_M2 = 10000;/.test(html), 'Mission12 公園 LOD');
  assert.ok(/const ROAD_RIBBON_COLOR = \{ major: 0xb8bdc3, mid: 0xc4c8cc, local: 0xd0d3d6 \};/.test(html), '道路 ribbon 色');
  // [Mission 33A] 背景は 0xf6f7f3 へ（明るい neutral のまま）
  assert.ok(/const MS_BG_NEUTRAL = 0xf6f7f3;/.test(html), 'Mission17 背景');
});

test('[Mission13] protected baseline fullward-v3.html は Mission13 の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/RAIL_COLORS|buildRailMeshes|railClassVisible|__RAIL_LOD_DEBUG__/.test(fw), 'fullward-v3.html に Mission13 の変更が混入');
});

test('[Mission 32U] production osaka_3d_buildings.html は promoted build（Mission13 を含む）', () => {
  const prod = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.html'), 'utf-8');
  assert.ok(/RAIL_COLORS|buildRailMeshes|__RAIL_LOD_DEBUG__/.test(prod), 'production HTML に Mission13 の内容が無い（32U cutover 後の production は ward-ux-v1 から生成した promoted build）');
});
