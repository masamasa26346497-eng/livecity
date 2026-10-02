// tests/city-layer-tiles.test.js
// P1-6: 都市レイヤー共通タイルグリッド / 変換・タイル化 / validator のテスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { createCityTileGrid, geoToZNorthNeg, zNorthNegToGeo, toZNorthNegPoints } from '../tools/lib/city-tile-grid.js';
import { convertLayer, buildOne } from '../tools/build-city-layer-tiles.js';
import { validateCityLayer } from '../tools/lib/city-layer-validator.js';
import { buildTileQuery, mergeRawElements } from '../tools/download/city-tiles.js';

const AREA = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'areas', 'osaka-city.json'), 'utf-8').replace(/^﻿/, ''));
const FIX = path.join(PROJECT_ROOT, 'tools', 'lib', '__fixtures__', 'city-layers');
const TMP_ROOT = path.join(PROJECT_ROOT, 'temp', 'p16-tests');
mkdirSync(TMP_ROOT, { recursive: true });

test('grid: osaka-city bbox から znorth-neg-v1 の共通グリッドを作る（北=z負・24区を覆う）', () => {
  const g = createCityTileGrid({ bbox: AREA.bbox, projection: AREA.projection, tileSizeMeters: 2000 });
  assert.equal(g.coordinateConvention, 'znorth-neg-v1');
  assert.ok(g.bboxLocal.minZ < 0 && g.bboxLocal.maxZ <= 3000, '北側(z負)へ広がっている');
  assert.ok(g.cols >= 12 && g.rows >= 11, `grid が小さすぎる ${g.cols}x${g.rows}`);
  assert.equal(g.tileCount, g.cols * g.rows);
  // 往復変換
  const back = zNorthNegToGeo(...Object.values(geoToZNorthNeg(34.65, 135.5, AREA.projection)), AREA.projection);
  assert.ok(Math.abs(back.lat - 34.65) < 1e-6 && Math.abs(back.lon - 135.5) < 1e-6);
});

test('grid: feature bbox が重なる全タイルへ割り当てる（tile境界で欠落しない）', () => {
  const g = createCityTileGrid({ bbox: AREA.bbox, projection: AREA.projection, tileSizeMeters: 2000 });
  // tile 境界(x=0)をまたぐ bbox
  const tids = g.tilesForBounds({ minX: -100, maxX: 100, minZ: -100, maxZ: 100 });
  assert.ok(tids.length >= 2, `境界をまたぐ feature が1タイルにしか割り当てられていない: ${tids}`);
});

test('grid: latLonBboxForTile は buffer ぶん外側へ拡張した正しい向きの bbox を返す', () => {
  const g = createCityTileGrid({ bbox: AREA.bbox, projection: AREA.projection, tileSizeMeters: 2000, bufferMeters: 150 });
  const b = g.latLonBboxForTile(0, -1);
  assert.ok(b.south < b.north && b.west < b.east);
  assert.match(b.str, /^\d+\.\d+,\d+\.\d+,\d+\.\d+,\d+\.\d+$/);
});

test('convertLayer roads: +z の convert 出力を z 反転して znorth-neg-v1 にする', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, 'roads-osm.json'), 'utf-8'));
  const { features } = convertLayer('roads', raw.elements, AREA.projection);
  assert.ok(features.length >= 2);
  const primary = features.find((f) => f.highway === 'primary');
  assert.equal(primary.kind, 'line');
  assert.ok(primary.id.startsWith('road_'));
  // fixture の primary 先頭は znorth-neg-v1 の [-3000,-500]。往復して概ね戻る。
  assert.ok(Math.abs(primary.p[0][0] - (-3000)) < 5 && Math.abs(primary.p[0][1] - (-500)) < 5, JSON.stringify(primary.p[0]));
});

test('convertLayer waterways: relation を assemble し、未連結 relation は描画しない・中州は holes 保持', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, 'waterways-osm.json'), 'utf-8'));
  const { features, meta } = convertLayer('waterways', raw.elements, AREA.projection);
  const riverbank = features.find((f) => f.kind === 'area');
  assert.ok(riverbank, '河岸 area が assemble されていない');
  assert.ok(Array.isArray(riverbank.holes) && riverbank.holes.length === 1, '中州(inner ring)が holes に無い');
  assert.equal(meta.unclosedRelations, 1, '未連結 relation が検出されていない');
  assert.ok(!features.some((f) => f.name === '連結不能'), '未連結 relation を描画対象にしている');
});

test('convertLayer railways: line と station を分離', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, 'railways-osm.json'), 'utf-8'));
  const { features, meta } = convertLayer('railways', raw.elements, AREA.projection);
  assert.equal(meta.lines, 2);
  assert.equal(meta.stations, 2);
  assert.ok(features.filter((f) => f.kind === 'station').every((s) => Array.isArray(s.p) && s.p.length === 1));
});

async function buildAllFixtures() {
  const dir = mkdtempSync(path.join(TMP_ROOT, 'run-'));
  const g = createCityTileGrid({ bbox: AREA.bbox, projection: AREA.projection, tileSizeMeters: 2000 });
  for (const layer of ['roads', 'parks', 'railways', 'waterways']) {
    await buildOne(layer, path.join(FIX, `${layer}-osm.json`), AREA, g, dir, null);
  }
  return { dir, g };
}

test('buildOne + validator: 4レイヤーとも生成され、共通validator が error なしで PASS', async () => {
  const { dir, g } = await buildAllFixtures();
  const wp = { wards: JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'), 'utf-8')).wards };
  try {
    for (const layer of ['roads', 'parks', 'railways', 'waterways']) {
      const man = JSON.parse(fs.readFileSync(path.join(dir, layer, 'manifest.json'), 'utf-8'));
      assert.equal(man.coordinateConvention, 'znorth-neg-v1');
      assert.ok(man.tileCount > 0 && man.featureCount > 0);
      const r = validateCityLayer(path.join(dir, layer), { grid: g, wardPolygons: wp });
      assert.equal(r.ok, true, `${layer}: ${JSON.stringify(r.checks.filter((c) => !c.pass && c.severity === 'error'))}`);
      assert.equal(r.checks.find((c) => c.name === '24-ward-bbox-coverage').pass, true);
      assert.equal(r.checks.find((c) => c.name === 'known-3-wards-coverage').pass, true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validator: 巨大セグメントを持つ河岸 area を仕込むと no-oversized-area-segments が FAIL', async () => {
  const { dir, g } = await buildAllFixtures();
  try {
    const tilesDir = path.join(dir, 'waterways', 'tiles');
    const f = fs.readdirSync(tilesDir)[0];
    const tile = JSON.parse(fs.readFileSync(path.join(tilesDir, f), 'utf-8'));
    // 地物を横断する巨大辺つきの壊れ area を追加
    tile.features.push({ id: 'water_broken', kind: 'area', subtype: 'river', p: [[0, 0], [50, 0], [50, 50], [3000, 3000], [0, 50], [0, 0]] });
    tile.count = tile.features.length;
    fs.writeFileSync(path.join(tilesDir, f), JSON.stringify(tile));
    const r = validateCityLayer(path.join(dir, 'waterways'), { grid: g });
    assert.equal(r.checks.find((c) => c.name === 'no-oversized-area-segments').pass, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('download: buildTileQuery / mergeRawElements（ネットワーク無しで検証可能な部分）', () => {
  const q = buildTileQuery('way["highway"="primary"];node["railway"="station"]', '34.58,135.52,34.60,135.55', 90);
  assert.match(q, /\[out:json\]\[timeout:90\]/);
  assert.match(q, /way\["highway"="primary"\]\(34\.58,135\.52,34\.60,135\.55\)/);
  assert.match(q, /out geom;/);
  const m = mergeRawElements([{ elements: [{ type: 'way', id: 1 }, { type: 'way', id: 2 }] }, { elements: [{ type: 'way', id: 2 }, { type: 'node', id: 1 }] }]);
  assert.equal(m.length, 3);
});

test('toZNorthNegPoints: z を反転する', () => {
  assert.deepEqual(toZNorthNegPoints([[1, 2], [3, -4]]), [[1, -2], [3, 4]]);
});

test('ward-ux-v1.html: CityTileLayer が存在し camUpd / ward切替 / WARD-DIAG に配線されている', () => {
  const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
  assert.ok(/const CityTileLayer = \(function \(\) \{/.test(html), 'CityTileLayer 未定義');
  assert.ok(/map-data\/osaka-city/.test(html) && /coordinateConvention !== 'znorth-neg-v1'/.test(html), 'znorth-neg-v1 チェックが無い');
  assert.ok(/CityTileLayer\.updateForTarget\(cs\.tgt\.x, cs\.tgt\.z\)/.test(html), 'camUpd に配線されていない');
  assert.ok(/CityTileLayer\.onWardSwitch\(/.test(html), 'ward切替に配線されていない');
  assert.ok(/\[LAYER-PERF\]/.test(html), '[LAYER-PERF] ログが無い');
  // 既存 RoadLayer / ParkLayer / WaterLayer の定義数は変えていない（html-regression と重複するが明示）
  for (const L of ['RoadLayer', 'ParkLayer', 'WaterLayer']) {
    assert.equal((html.match(new RegExp(`^const ${L} = `, 'gm')) || []).length, 1, `${L} が重複/消失`);
  }
});
