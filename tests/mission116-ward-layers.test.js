// tests/mission116-ward-layers.test.js
// Mission 116: 24区 建物＋河川 統合表示のパス解決・失敗診断・座標/地表高さ回帰。
// 実データ（福島区など）が無くても動く合成fixtureを使う。住吉区は実タイルで回帰確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { latLonToLiveCityWorld, liveCityProjection } from '../tools/lib/livecity-coordinate-system.js';
import {
  planWard, findDataset, inspectWard, urls, urlToFile, CITY_LAYERS, EXPECTED_WATER_Y,
  insideWardRatio, buildingsOverWater, classifyWaterFeatures, groundBaseStats,
} from '../tools/lib/ward-layer-plan.js';

const PUBLIC = path.join(PROJECT_ROOT, 'public');
const rootManifest = JSON.parse(fs.readFileSync(urlToFile(PUBLIC, urls.buildingsRoot()), 'utf8'));
const wardPolys = JSON.parse(fs.readFileSync(urlToFile(PUBLIC, urls.wardPolygons()), 'utf8')).wards;

// ── 計画 ────────────────────────────────────────────────────────────
test('24区すべてが一意に解決でき、選択区のタイルだけを計画する', () => {
  assert.equal(rootManifest.datasets.length, 24);
  for (const d of rootManifest.datasets) {
    const p = planWard(rootManifest, d.wardId);
    assert.ok(p.ok, d.wardId);
    assert.equal(p.dataset.id, d.id);
    assert.ok(p.cityTiles.length >= 1 && p.cityTiles.length < 40, `${d.wardId}: 都市タイル数が異常 (${p.cityTiles.length})`);
    assert.ok(p.buildingManifestUrl.endsWith(`/${d.id}/manifest.json`));
  }
  assert.equal(findDataset(rootManifest, '福島区').id, 'osaka-fukushima');
  assert.equal(findDataset(rootManifest, '27103').wardId, 'fukushima');
  assert.equal(planWard(rootManifest, 'nowhere').code, 'unknown-ward');
});

test('福島区の計画は他区（住吉区）のタイルを含まない', () => {
  const f = planWard(rootManifest, 'fukushima');
  const s = planWard(rootManifest, 'sumiyoshi');
  const key = (t) => `${t.tx}_${t.tz}`;
  const fs_ = new Set(f.cityTiles.map(key));
  assert.ok(s.cityTiles.every((t) => !fs_.has(key(t))), '福島区と住吉区の都市タイルが重複（区選択が効いていない）');
});

test('bounds は全区が同一座標系(znorth-neg-v1)の区ポリゴンbboxと整合する（区ごとの原点/オフセット禁止）', () => {
  assert.equal(rootManifest.coordinateConvention, 'znorth-neg-v1');
  for (const d of rootManifest.datasets) {
    const wp = wardPolys.find((w) => w.wardCode === d.wardCode);
    assert.ok(wp, `区ポリゴンなし: ${d.ward}`);
    const tol = 600; // 建物bounds は PLATEAU メッシュ由来で区境をやや越える
    assert.ok(d.bounds.minX >= wp.bbox.minX - tol && d.bounds.maxX <= wp.bbox.maxX + tol, `${d.ward}: X範囲が区ポリゴンとずれている`);
    assert.ok(d.bounds.minZ >= wp.bbox.minZ - tol && d.bounds.maxZ <= wp.bbox.maxZ + tol, `${d.ward}: Z範囲が区ポリゴンとずれている`);
  }
});

// ── 座標系・回転・地表高さ回帰 ────────────────────────────────────
test('投影原点・北=-Z が固定されている（回転/原点の変更検出）', () => {
  const p = liveCityProjection();
  assert.equal(p.centerLat, 34.604208);
  assert.equal(p.centerLon, 135.52502);
  const o = latLonToLiveCityWorld(p.centerLat, p.centerLon);
  assert.equal(o.x, 0); assert.equal(o.z, -0);
  // 真北へ 1km → z が -1000 付近、x は 0（回転0°）。0.93°回転していれば x≈±16m ずれる。
  const n = latLonToLiveCityWorld(p.centerLat + 1000 / p.metersPerDegree, p.centerLon);
  assert.ok(Math.abs(n.x) < 1e-6 && Math.abs(n.z + 1000) < 1e-6);
});

test('住吉区の実タイル: 建物代表点の区ポリゴン内率 ≥ 99% / 地表基準 z0≈0', () => {
  const r = inspectWard({ publicDir: PUBLIC, rootManifest, wardKey: 'sumiyoshi', wardPolygons: wardPolys });
  assert.equal(r.layers.buildings.status, 'ok');
  assert.equal(r.layers.buildings.buildingsLoaded, 35031);
  assert.ok(r.checks.insideWard.ratio >= 0.99, `区内率 ${r.checks.insideWard.ratio}`);
  assert.equal(r.checks.groundBase.pass, true);
  assert.equal(r.browserVerified, false);
});

test('検出器の感度: 60m の平行移動 / 回転で区内率が閾値を割る（補正ではなく検出）', () => {
  const ring = [[0, 0], [2000, 0], [2000, 2000], [0, 2000]];
  const ward = { wardId: 't', bbox: { minX: 0, maxX: 2000, minZ: 0, maxZ: 2000 }, polygons: [{ outer: ring }] };
  const pts = [];
  for (let x = 10; x < 2000; x += 40) for (let z = 10; z < 2000; z += 40) pts.push({ repX: x, repZ: z });
  assert.equal(insideWardRatio(pts, ward).ratio, 1);
  const shifted = pts.map((p) => ({ repX: p.repX + 60, repZ: p.repZ }));
  assert.ok(insideWardRatio(shifted, ward).ratio < 0.99);
  const a = 0.93 * Math.PI / 180;
  const rot = pts.map((p) => ({ repX: p.repX * Math.cos(a) - (p.repZ - 10000) * Math.sin(a), repZ: p.repX * Math.sin(a) + (p.repZ - 10000) * Math.cos(a) + 10000 }));
  assert.ok(insideWardRatio(rot, ward).ratio < 1);
});

test('HTML(ward-ux-v1 / production)の描画高さ・URL規約がモジュールの期待値と一致する', () => {
  for (const f of ['osaka_3d_buildings.html', 'osaka_3d_buildings.ward-ux-v1.html']) {
    const html = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    assert.match(html, new RegExp(`WATER_FILL_Y = ${EXPECTED_WATER_Y.waterFill};`), `${f}: WATER_FILL_Y`);
    assert.match(html, new RegExp(`WATER_SHORE_Y = ${EXPECTED_WATER_Y.waterShore};`), `${f}: WATER_SHORE_Y`);
    assert.match(html, new RegExp(`waterways: \\{ y: ${EXPECTED_WATER_Y.waterways},`), `${f}: waterways y`);
    assert.match(html, new RegExp(`roads:     \\{ y: ${EXPECTED_WATER_Y.roads},`), `${f}: roads y`);
    assert.ok(html.includes('`${BUILDING_TILE_CONFIG.basePath}/${datasetId}/tile_${tx}_${tz}.json`'), `${f}: 建物タイルURL`);
    assert.ok(html.includes('`${BASE}/${layer}/tile_${tx}_${tz}.json`'), `${f}: 都市タイルURL`);
    assert.ok(html.includes(urls.riversV2()), `${f}: rivers-v2`);
    assert.ok(html.includes(urls.waterSurface()), `${f}: water-surface`);
    assert.ok(html.includes("const BASE = 'map-data/osaka-city'"), `${f}: BASE`);
  }
  // 水は建物の地表(0)より上、道路より下（z-fighting/被覆回避の順序）
  assert.ok(EXPECTED_WATER_Y.waterFill > 0 && EXPECTED_WATER_Y.waterFill < EXPECTED_WATER_Y.waterways && EXPECTED_WATER_Y.waterways < EXPECTED_WATER_Y.roads);
});

// ── 合成fixture: 河川・水域・失敗診断 ─────────────────────────────
function makeFixture({ convention = 'znorth-neg-v1', withSurface = true, tilesSubdir = false, dropBuildingTile = false, offset = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm116-'));
  const w = (rel, obj) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); };
  const ds = { id: 'osaka-fake', wardId: 'fake', ward: '架空区', wardCode: '99999', buildings: 4, tiles: 1, bounds: { minX: 100, maxX: 400, minZ: 100, maxZ: 400 } };
  w(urls.buildingsRoot(), { coordinateConvention: convention, datasets: [ds] });
  const bl = [];
  for (let i = 0; i < 4; i++) bl.push({ id: 'b' + i, fp: [[0, 0]], z0: 0, h: 5, repX: 150 + i * 50 + offset, repZ: 150 + offset });
  w(urls.buildingsManifest('osaka-fake'), { coordinateConvention: convention, totalBuildings: 4, tiles: [{ tx: 0, tz: 0, file: 'tile_0_0.json', count: 4 }] });
  if (!dropBuildingTile) w(urls.buildingsTile('osaka-fake', 0, 0), { tx: 0, tz: 0, count: 4, buildings: bl });
  const river = { id: 'r', kind: 'area', p: [[100, 300], [400, 300], [400, 380], [100, 380]] };
  const line = { id: 'l', kind: 'line', p: [[100, 340], [400, 340]] };
  for (const layer of CITY_LAYERS) {
    w(urls.cityManifest(layer), { coordinateConvention: convention, tileSize: 2000, tiles: [{ tx: 0, tz: 0, file: `tiles/tile_0_0.json`, count: 2 }] });
    const tile = { tx: 0, tz: 0, features: layer === 'waterways' ? [river, line] : [line] };
    w(tilesSubdir ? `${urls.cityManifest(layer).replace('manifest.json', '')}tiles/tile_0_0.json` : urls.cityTile(layer, 0, 0), tile);
  }
  w(urls.riversV2(), { coordinateConvention: convention, rivers: [{}] });
  if (withSurface) w(urls.waterSurface(), { coordinateConvention: convention });
  const poly = [{ wardId: 'fake', wardCode: '99999', bbox: ds.bounds, polygons: [{ outer: [[100, 100], [400, 100], [400, 400], [100, 400]], holes: [] }] }];
  return { dir, root: JSON.parse(fs.readFileSync(path.join(dir, ...urls.buildingsRoot().split('/')), 'utf8')), poly };
}

test('完備fixture: 建物+河川(面+線)が complete、ただし browserVerified は false', () => {
  const f = makeFixture();
  const r = inspectWard({ publicDir: f.dir, rootManifest: f.root, wardKey: 'fake', wardPolygons: f.poly });
  assert.equal(r.layers.buildings.status, 'ok');
  assert.equal(r.layers.waterways.status, 'ok');
  assert.deepEqual(r.layers.waterways.water, { polygons: 1, lines: 1, other: 0 });
  assert.equal(r.waterKind, 'polygon+line');
  assert.equal(r.localData, 'complete');
  assert.equal(r.browserVerified, false);
});

test('診断: 建物タイル欠落 / 座標規約違い / tiles配下のみ / 水面欠落 を区別する', () => {
  let r = inspectWard({ publicDir: makeFixture({ dropBuildingTile: true }).dir, rootManifest: makeFixture().root, wardKey: 'fake', wardPolygons: [] });
  assert.equal(r.layers.buildings.status, 'missing');
  assert.equal(r.layers.buildings.tilesMissing[0].code, 'missing-file');
  assert.notEqual(r.localData, 'complete');

  const fc = makeFixture({ convention: 'znorth-pos-v0' });
  r = inspectWard({ publicDir: fc.dir, rootManifest: fc.root, wardKey: 'fake', wardPolygons: fc.poly });
  assert.equal(r.layers.buildings.code, 'convention-mismatch');
  assert.equal(r.layers.waterways.code, 'convention-mismatch');

  const fw = makeFixture({ tilesSubdir: true });
  r = inspectWard({ publicDir: fw.dir, rootManifest: fw.root, wardKey: 'fake', wardPolygons: fw.poly });
  assert.equal(r.layers.waterways.problems[0].code, 'wrong-dir');
  assert.notEqual(r.layers.waterways.status, 'ok');

  const fs2 = makeFixture({ withSurface: false });
  r = inspectWard({ publicDir: fs2.dir, rootManifest: fs2.root, wardKey: 'fake', wardPolygons: fs2.poly });
  assert.equal(r.layers.waterSurface.status, 'missing');
});

test('位置ずれ検出: 建物が区外へずれたfixtureは insideWard 失敗、水面上建物率も算出する', () => {
  const f = makeFixture({ offset: 500 });
  const r = inspectWard({ publicDir: f.dir, rootManifest: f.root, wardKey: 'fake', wardPolygons: f.poly });
  assert.equal(r.checks.insideWard.pass, false);
  assert.equal(r.warnings[0].code, 'out-of-ward');
  assert.notEqual(r.localData, 'complete');
  const o = buildingsOverWater([{ repX: 200, repZ: 330 }, { repX: 200, repZ: 150 }], [{ kind: 'area', p: [[100, 300], [400, 300], [400, 380], [100, 380]] }]);
  assert.deepEqual([o.over, o.total], [1, 2]);
});

test('補助: classifyWaterFeatures / groundBaseStats', () => {
  assert.deepEqual(classifyWaterFeatures([{ kind: 'area' }, { kind: 'line' }, { kind: 'line' }, { kind: 'station' }]), { polygons: 1, lines: 2, other: 1 });
  assert.equal(groundBaseStats([{ z0: 0 }, { z0: 0 }, { z0: 3 }]).median, 0);
  assert.equal(groundBaseStats([]).n, 0);
});
