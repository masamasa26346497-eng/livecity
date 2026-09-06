// tests/mission03-road-ribbon.test.js
// [見た目改善 Mission03] 道路 ribbon 表示のHTML配線検証。
//   純粋ロジック（幅推定・ribbon生成・validator）は tests/road-ribbon.test.js。
//   本ファイルは HTML inline 実装が pure lib と一致すること、LOD維持、旧Line二重表示防止、
//   色・y位置・デバッグAPI、実データ regression（主要道路）を検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { computeRoadWidth, buildRoadRibbon, validateRoadRibbon } from '../tools/lib/road-ribbon.js';
import { classifyRoadLod } from '../tools/lib/road-lod.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

function extractRoadRibbonFns() {
  const start = html.indexOf('const ROAD_RIBBON_WIDTH = {');
  const end = html.indexOf('function buildRoadMeshes(features, y, baseColor) {');
  assert.ok(start >= 0 && end > start, 'road ribbon helper 群の範囲を特定できない');
  const src = html.slice(start, end);
  const fn = new Function(`${src}\nreturn { roadRibbonWidth, roadRibbonOffsets, rrDensify };`);
  return fn();
}

test('[Mission03] HTML inline の道路幅 helper が pure lib(computeRoadWidth) と一致する', () => {
  const { roadRibbonWidth } = extractRoadRibbonFns();
  for (const f of [
    { highway: 'motorway' }, { highway: 'primary' }, { highway: 'residential' }, { highway: 'unknown_x' },
    { highway: 'residential', width: '15' }, { highway: 'primary', lanes: 4 },
  ]) {
    assert.equal(roadRibbonWidth(f), computeRoadWidth(f).width, `幅がズレている: ${JSON.stringify(f)}`);
  }
});

test('[Mission03] HTML inline の ribbon offset が pure lib(buildRoadRibbon) と一致する（直線・カーブ）', () => {
  const { roadRibbonWidth, roadRibbonOffsets, rrDensify } = extractRoadRibbonFns();
  for (const cl of [[[0, 0], [200, 0], [400, 0]], [[0, 0], [300, 0], [300, 300]], [[0, 0], [100, 50], [250, -30], [400, 10]]]) {
    const width = roadRibbonWidth({ highway: 'primary' });
    const dense = rrDensify(cl, 40);
    const htmlOff = roadRibbonOffsets(dense, width, 2.75);
    const libRibbon = buildRoadRibbon(cl, width, {});
    assert.equal(htmlOff.left.length, libRibbon.left.length, 'offset点数がズレている');
    for (let i = 0; i < htmlOff.left.length; i++) {
      assert.ok(Math.abs(htmlOff.left[i][0] - libRibbon.left[i][0]) < 1e-6 && Math.abs(htmlOff.left[i][1] - libRibbon.left[i][1]) < 1e-6,
        `left[${i}] がpure libとズレている`);
      assert.ok(Math.abs(htmlOff.right[i][0] - libRibbon.right[i][0]) < 1e-6 && Math.abs(htmlOff.right[i][1] - libRibbon.right[i][1]) < 1e-6,
        `right[${i}] がpure libとズレている`);
    }
  }
});

test('[Mission03] buildRoadMeshes は ribbon(THREE.Mesh) を作る。旧LineSegmentsは __ROAD_LINE_DEBUG__ 時のみ', () => {
  const idx = html.indexOf('function buildRoadMeshes(features, y, baseColor) {');
  const body = html.slice(idx, idx + 1400);
  assert.ok(/const lineDebug = \(typeof window !== 'undefined' && window\.__ROAD_LINE_DEBUG__ === true\);/.test(body),
    '__ROAD_LINE_DEBUG__ フラグが無い');
  assert.ok(/new THREE\.Mesh\(g, new THREE\.MeshBasicMaterial\(\{ color: ROAD_RIBBON_COLOR\[tier\], side: THREE\.FrontSide \}\)\)/.test(body),
    'ribbon描画が THREE.Mesh になっていない');
  assert.ok(/appendRoadRibbon\(buckets\[tier\], f\.p, roadRibbonWidth\(f\), ty\)/.test(body), 'ribbon生成呼び出しが無い');
  // 二重表示防止: lineDebug が false のとき LineSegments を push しない
  assert.ok(/lineDebug\s*\?\s*new THREE\.LineSegments/.test(body), 'LineSegmentsが lineDebug 分岐に入っていない（二重表示の疑い）');
});

test('[Mission03] tierごとに1 merged mesh（1 tile 最大3 mesh、1道路=1meshにしない）', () => {
  const idx = html.indexOf('function buildRoadMeshes(features, y, baseColor) {');
  const body = html.slice(idx, idx + 1400);
  assert.ok(/for \(const tier of \['major', 'mid', 'local'\]\) \{/.test(body), '3tierループが無い');
  // features ループ内で mesh を作っていない（merge してから tier ループで mesh 化）
  const featLoop = body.slice(body.indexOf('for (const f of features)'), body.indexOf("for (const tier of ['major', 'mid', 'local'])"));
  assert.ok(!/new THREE\.Mesh|new THREE\.LineSegments/.test(featLoop), 'feature ごとに mesh を生成している（1道路=1mesh禁止）');
});

test('[Mission03] 道路色は白模型グレー階調（major #b8bdc3 / mid #c4c8cc / local #d0d3d6）', () => {
  assert.ok(/const ROAD_RIBBON_COLOR = \{ major: 0xb8bdc3, mid: 0xc4c8cc, local: 0xd0d3d6 \};/.test(html), '道路tier色が指示書6節と一致しない');
});

test('[Mission03] y位置: 道路(0.13)は水域(0.05)・公園(0.07)より上（river < park < road を維持）', () => {
  assert.ok(/roads:\s+\{ y: 0\.13,/.test(html), 'CityTileLayer roads の y が 0.13 でない');
  assert.ok(/waterways: \{ y: 0\.05,/.test(html) && /parks:\s+\{ y: 0\.07,/.test(html), '水域/公園のyが想定と違う');
  assert.ok(/const ROAD_TIER_DY = \{ major: 0, mid: 0\.004, local: 0\.008 \};/.test(html), 'tier間z-fighting回避のy差が無い');
});

test('[Mission03] LOD維持: ribbon mesh も userData.roadTier を持ち applyLodToOneMesh(roadClassVisible)で制御される', () => {
  const idx = html.indexOf('function buildRoadMeshes(features, y, baseColor) {');
  const body = html.slice(idx, idx + 1400);
  assert.ok(/m\.userData\.roadTier = tier;/.test(body), 'ribbon mesh に roadTier タグが無い（LODが効かない）');
  assert.ok(/if \(ud\.roadTier\) \{ m\.visible = layerEnabled\.roads && roadClassVisible\(ud\.roadTier, distance\); return; \}/.test(html),
    'applyLodToOneMesh の roadTier 分岐が Mission02 の roadClassVisible のまま');
});

test('[Mission03・指示書14節] CityTileLayer.getRoadRibbonDebug() が定義・公開されている', () => {
  assert.ok(/function getRoadRibbonDebug\(\) \{/.test(html), 'getRoadRibbonDebug 未定義');
  const idx = html.indexOf('function getRoadRibbonDebug() {');
  const body = html.slice(idx, html.indexOf('\n  return {', idx));
  for (const field of ['distance', 'band', 'mode', 'triangleCount', 'maxTriangleEdge', 'sampleNamedRoads']) {
    assert.ok(body.includes(field), `getRoadRibbonDebug に ${field} が無い`);
  }
  assert.ok(/sourceId: f\.source && `\$\{f\.source\.type\}\/\$\{f\.source\.id\}`/.test(body), 'サンプルに sourceId が無い');
  assert.ok(/getRoadRibbonDebug, \/\/ \[見た目改善 Mission03\]/.test(html), 'CityTileLayer が getRoadRibbonDebug を公開していない');
});

test('[Mission03] 実データ regression: roads tile に name/source が付き、主要道路の ribbon が ERROR 0', () => {
  const dir = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'roads');
  if (!fs.existsSync(dir)) { assert.ok(true, 'roads tile 未生成（skip）'); return; }
  const byId = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => /^tile_.*\.json$/.test(n))) {
    for (const ft of (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')).features || [])) {
      if (ft.kind === 'line' && !byId.has(ft.id)) byId.set(ft.id, ft);
    }
  }
  const feats = [...byId.values()];
  assert.ok(feats.some((f) => f.name), 'roads tile に name が保持されていない');
  assert.ok(feats.every((f) => f.source), 'roads tile に source が保持されていない');
  const targets = ['阪神高速', '御堂筋', '中央大通', '国道43号'];
  for (const t of targets) {
    const segs = feats.filter((f) => f.name && f.name.includes(t));
    assert.ok(segs.length > 0, `${t} が roads tile に無い`);
    for (const seg of segs) {
      const wr = computeRoadWidth(seg);
      const ribbon = buildRoadRibbon(seg.p, wr.width, {});
      assert.equal(ribbon.ok, true, `${t}(${seg.id}) ribbon生成失敗: ${ribbon.reason}`);
      const v = validateRoadRibbon({ id: seg.id, name: seg.name, highway: seg.highway, width: wr.width, ...ribbon });
      assert.deepEqual(v.errors, [], `${t}(${seg.id}) validator ERROR: ${JSON.stringify(v.errors)}`);
    }
  }
});

test('protected baseline fullward-v3.html は Mission03 の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  // 注: fullward-v3.html は 2026-08 時点で既に独自の appendRoadRibbon を持つ（コミット済み・無変更）。
  //   Mission03固有の識別子だけをチェックする。
  assert.ok(!/ROAD_RIBBON_COLOR|ROAD_RIBBON_WIDTH|getRoadRibbonDebug|__ROAD_LINE_DEBUG__/.test(fw), 'fullward-v3.html に Mission03 の変更が混入');
});
