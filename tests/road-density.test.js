// tests/road-density.test.js
// [Mission26 大阪市道路網の完全高密度化]
//   auditRoadDensity の純ロジック / track・alley 分類 / 幅 / sourceMissing 分類 /
//   coverage report の density ブロック / road-density validator / HTML 配線 / regression。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { classifyRoad, resolveRoadWidth, auditRoadDensity, ROAD_DEFAULT_WIDTH } from '../tools/lib/road-network.js';

const HTML_PATH = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
const COV = path.join(PROJECT_ROOT, 'data', 'reports', 'road-network-coverage.json');
const VAL = path.join(PROJECT_ROOT, 'data', 'reports', 'road-density-validation.json');
const cov = fs.existsSync(COV) ? JSON.parse(fs.readFileSync(COV, 'utf-8')) : null;
const val = fs.existsSync(VAL) ? JSON.parse(fs.readFileSync(VAL, 'utf-8')) : null;

// 合成 ward（1km 四方）
const WARDS = [{ wardId: 'a', polygons: [{ outer: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] }] }];

test('[Mission26] HTML: インライン <script> 構文が壊れていない', () => {
  const f = path.join(os.tmpdir(), `m26-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission26] track / alley の幅 default', () => {
  assert.equal(ROAD_DEFAULT_WIDTH.track, 3);
  assert.equal(resolveRoadWidth({ highway: 'track' }).width, 3);
  // alley は class-default で 3（service 3.5 ではない）
  assert.equal(resolveRoadWidth({ highway: 'service', service: 'alley' }).width, 3);
  assert.equal(resolveRoadWidth({ highway: 'service' }).width, 3.5);
  // width タグは最優先
  assert.equal(resolveRoadWidth({ highway: 'service', service: 'alley', width: '5' }).source, 'width');
});

test('[Mission26] auditRoadDensity: 建物あり・道路なし cell を抽出 / 3x3 窓で街区内部ノイズを除外', () => {
  // 道路を全域に格子状（200m 間隔）→ どの建物 cell も 3x3 窓に道路あり → mismatch 0
  const roads = [];
  for (let v = 50; v <= 950; v += 200) { roads.push({ p: [[0, v], [1000, v]] }); roads.push({ p: [[v, 0], [v, 1000]] }); }
  const buildings = [];
  for (let x = 100; x < 900; x += 50) for (let z = 100; z < 900; z += 50) buildings.push({ x, z });
  let A = auditRoadDensity({ roads, buildings, wards: WARDS, cellM: 100 });
  assert.ok(A.roadCellCoverage > 0.5);
  assert.equal(A.buildingRoadMismatchCells, 0, '格子道路があるのに mismatch が出た（3x3窓が効いていない）');

  // 中央 300m を道路なしにする → その建物 cell が mismatch
  const roads2 = roads.filter((r) => !(r.p[0][1] >= 300 && r.p[0][1] <= 700 && r.p[1][1] >= 300 && r.p[1][1] <= 700)
    && !(r.p[0][0] >= 300 && r.p[0][0] <= 700 && r.p[1][0] >= 300 && r.p[1][0] <= 700));
  A = auditRoadDensity({ roads: roads2, buildings, wards: WARDS, cellM: 100 });
  assert.ok(A.buildingRoadMismatchCells >= 1, '中央の道路欠落が mismatch として出ない');
});

test('[Mission26] auditRoadDensity: rawRoadNodes 範囲外は sourceMissing、sparseWard は sourceSparseWard', () => {
  const buildings = [];
  for (let x = 100; x < 900; x += 60) for (let z = 100; z < 900; z += 60) buildings.push({ x, z });
  // 道路は南半分だけ、生 OSM ノードも南半分だけ
  const roads = [{ p: [[50, 800], [950, 800]] }];
  const rawRoadNodes = [];
  for (let x = 0; x <= 1000; x += 50) for (let z = 700; z <= 1000; z += 50) rawRoadNodes.push([x, z]);
  const A = auditRoadDensity({ roads, buildings, wards: WARDS, rawRoadNodes, cellM: 100, sourceRadiusM: 200 });
  assert.ok(A.sourceMissingCells > 0, '北半分が sourceMissing にならない');
  // 区の 8% 以上が sourceMissing → sparseWard
  assert.ok(A.sparseWards.includes('a'), 'a 区が sparseWard 判定されない');
  assert.ok((A.mismatchByCause.sourceMissing || 0) + (A.mismatchByCause.sourceSparseWard || 0) >= (A.mismatchByCause.unexplained || 0),
    'sourceMissing/sparseWard が unexplained より少ない');
});

test('[Mission26] coverage report: density ブロック / sourceMissing 分類', { skip: !cov && 'no coverage' }, () => {
  assert.ok(cov.density, 'coverage report に density が無い');
  for (const k of ['roadCellCoverage', 'sourceMissingCells', 'sparseWards', 'mismatchByCause',
    'unexplainedRoadGapCells', 'maxBuildingToRoadDistanceM', 'byWard']) {
    assert.ok(k in cov.density, `density に ${k} が無い`);
  }
  // 東淀川区・淀川区 は sparseWard（PBF 抽出の北端で source なし）
  assert.ok(cov.density.sparseWards.includes('higashiyodogawa'), 'higashiyodogawa が sparseWard でない');
  assert.ok(cov.density.sparseWards.includes('yodogawa'), 'yodogawa が sparseWard でない');
  // unexplained は予算内
  assert.ok(cov.density.unexplainedRoadGapCells <= Math.max(60, cov.density.landCells * 0.004),
    `unexplained road gap ${cov.density.unexplainedRoadGapCells} が予算超過`);
});

test('[Mission26] 配信 feature: track / alley が取り込まれている', { skip: !cov && 'no coverage' }, () => {
  assert.ok((cov.byDetail.LOCAL_ALLEY || 0) > 1000, 'LOCAL_ALLEY が少ない: ' + cov.byDetail.LOCAL_ALLEY);
  assert.ok('LOCAL_TRACK' in cov.byDetail, 'LOCAL_TRACK が byDetail に無い');
  assert.ok((cov.byHighwayTag.track || 0) >= 1, '生データに track が無い');
});

test('[Mission26] road-density validator: RESULT PASS / 主要チェック', { skip: !val && 'no validation' }, () => {
  assert.equal(val.RESULT, 'PASS', 'errors: ' + JSON.stringify(val.errors));
  assert.equal(val.counts.badGeom, 0);
  assert.equal(val.counts.giantSeg, 0);
  assert.equal(val.counts.noSource, 0);
  assert.equal(val.counts.badClass, 0);
  assert.equal(val.counts.outsideCity, 0);
  assert.ok(val.counts.alley > 1000);
  assert.ok(val.nearLocalCoveragePercent >= 99);
  assert.equal(val.tileBoundaryBreaks, 0);
});

test('[Mission26] HTML 配線: track 幅 / alley 個別幅 / getRoadNetworkDebug 集計', () => {
  assert.ok(/road: 4, track: 3 \}/.test(html), 'ROAD_RIBBON_WIDTH に track が無い');
  assert.ok(/f\.highway === 'service' && f\.service === 'alley'\) w = 3;/.test(html), 'roadRibbonWidth に alley 個別幅が無い');
  assert.ok(/byHighway, serviceTypes, alley, track, ultraLocal/.test(html), 'getRoadNetworkDebug の集計拡張が無い');
});

test('[Mission26] Road LOD（Mission02）/ ribbon（Mission03）は不変', () => {
  assert.ok(/const ROAD_LOD_FAR_M = 9000, ROAD_LOD_MID_M = 3500;/.test(html));
  assert.ok(/const buckets = \{ major: \[\], mid: \[\], local: \[\] \};/.test(html), '3-tier merged mesh が消えた（1道路=1mesh 禁止）');
  assert.ok(/if \(f\.underground === true\) continue;/.test(html), '地下道路の ribbon 除外が消えた');
});

test('[Mission26] protected HTML に Mission26 変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/road: 4, track: 3 \}|byHighway, serviceTypes, alley, track/.test(h), `${rel} に Mission26 混入`);
  }
});
