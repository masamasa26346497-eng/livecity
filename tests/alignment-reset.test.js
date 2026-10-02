// tests/alignment-reset.test.js
// [Mission 31G-ALIGNMENT-RESET] Scene Root 構造分離 + GSI Road Edge Authoritative Layer +
//   Reference Alignment Mode。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInlineScript } from './_ward-ux-v1-smoke-harness.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

test('[ALIGNMENT-RESET §35] validator が PASS', { skip: !rpt('alignment-reset-validation.json') && 'no report' }, () => {
  const v = rpt('alignment-reset-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['canonicalRootExists', 'legacyRootExists', 'debugRootExists', 'uiRootExists',
    'toggleOldLayersControlsRoots', 'gsiRoadEdgeTiled', 'gsiRoadEdgeCoordinateConvention',
    'gsiRoadEdgePublished', 'orthoCameraExists', 'referenceAlignmentModeExists', 'allSixSitesPresent',
    'fix24NearExactPreserved']) {
    assert.equal(v.checks[k], true, k + ' が true でない');
  }
  assert.equal(v.checks.directLegacySceneAdd, 0);
  assert.equal(v.checks.buildingGeometryMutation, 0);
  assert.equal(v.checks.roadGeometryMutation, 0);
  assert.equal(v.checks.projectionMutation, 0);
  assert.equal(v.checks.geometryMutation, 0);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[ALIGNMENT-RESET §3-§6] Scene Root(canonical/legacy/debug/ui)が定義され、scene へ addされている', () => {
  assert.match(html, /const canonicalRoot = new THREE\.Group\(\); canonicalRoot\.name = 'canonicalRoot';/);
  assert.match(html, /const legacyRoot = new THREE\.Group\(\); legacyRoot\.name = 'legacyRoot';/);
  assert.match(html, /const debugRoot = new THREE\.Group\(\); debugRoot\.name = 'debugRoot';/);
  assert.match(html, /const uiRoot = new THREE\.Group\(\); uiRoot\.name = 'uiRoot';/);
  assert.match(html, /scene\.add\(canonicalRoot\);/);
  assert.match(html, /scene\.add\(legacyRoot\);/);
  assert.match(html, /scene\.add\(debugRoot\);/);
  assert.match(html, /scene\.add\(uiRoot\);/);
});

test('[ALIGNMENT-RESET §3] toggleOldLayers が legacyRoot/canonicalRoot.visible を構造的に切り替える', () => {
  const start = html.indexOf('function toggleOldLayers(hidden) {');
  const end = html.indexOf('\n  function ', start + 10);
  const body = html.slice(start, end);
  assert.match(body, /legacyRoot\.visible = !hidden;/);
  assert.match(body, /canonicalRoot\.visible = !!hidden;/);
});

test('[ALIGNMENT-RESET §4] RoadLayer(Legacy)/BuildingTileLayer共有mesh builder/CityBuildingLOD が legacyRoot 経由', () => {
  assert.match(html, /const RoadLayer = \(function\(\)\{/);
  // RoadLayer.build() 内の group 追加が legacyRoot.add に変わっている
  const rlStart = html.indexOf("const RoadLayer = (function(){");
  const rlEnd = html.indexOf("const GroundVisualLayer = (function(){", rlStart);
  assert.ok(rlEnd > rlStart, 'GroundVisualLayer 境界が見つからない（RoadLayer範囲を特定できない）');
  const rlSlice = html.slice(rlStart, rlEnd);
  assert.match(rlSlice, /legacyRoot\.add\(group\);/);
  assert.match(html, /group\.name = 'CityBuildingLOD'; legacyRoot\.add\(group\);/);
});

test('[ALIGNMENT-RESET §16/§17] 真の OrthographicCamera が Perspective とは別に定義されている', () => {
  assert.match(html, /const orthoCamera = new THREE\.OrthographicCamera\(-400, 400, 400, -400, 1, 6000\);/);
  assert.match(html, /function activeCamera\(\)/);
  assert.match(html, /renderer\.render\(scene, activeCamera\(\)\);/);
});

test('[ALIGNMENT-RESET §18] 6地点(梅田/中之島/本町/難波/天王寺/住吉)全てが REFERENCE_SITES に定義されている', () => {
  for (const id of ['umeda', 'nakanoshima', 'honmachi', 'namba', 'tennoji', 'sumiyoshi']) {
    assert.ok(html.includes("id: '" + id + "'"), id + ' が REFERENCE_SITES に無い');
  }
});

test('[ALIGNMENT-RESET] 動的: 起動直後の Legacy residual = 0（scene root化後も既存の非vacuous性が維持）', () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const residual = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residual.total, 0, 'startup直後のresidualが0でない: ' + JSON.stringify(residual));
});

test('[ALIGNMENT-RESET §15-§21] 動的: Reference Alignment ON→6地点全て選択可→OFF で例外なく往復できる', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const sites = w.__REFERENCE_SITES__();
  assert.equal(sites.length, 6);
  for (const s of sites) {
    const active = await w.__SET_REFERENCE_ALIGNMENT__(true, s.id);
    assert.equal(active, true, s.id + ' で ON にならなかった');
    const dbg = w.__REFERENCE_ALIGNMENT_DEBUG__();
    assert.equal(dbg.siteId, s.id);
    const residual = w.__CANONICAL_SELF_CHECK__();
    assert.equal(residual.total, 0, s.id + ' で residual が発生: ' + JSON.stringify(residual));
  }
  await w.__SET_REFERENCE_ALIGNMENT__(false);
  const dbgOff = w.__REFERENCE_ALIGNMENT_DEBUG__();
  assert.equal(dbgOff.active, false);
});

test('[ALIGNMENT-RESET §7-§10/§27] 動的: GSI Road Edge Authoritative Layer が manifest を読み city-wide tile を fetch できる', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  // Reference Alignment を一度 ON にして camera を近傍へ寄せ、tile fetch をトリガーする
  await w.__SET_REFERENCE_ALIGNMENT__(true, 'umeda');
  await new Promise((res) => setTimeout(res, 50));
  const dbg = w.__GSI_ROAD_EDGE_AUTHORITATIVE_DEBUG__();
  assert.equal(dbg.manifestLoaded, true, 'GSI Road Edge manifest が読み込めていない');
  assert.ok(dbg.distinctFeatureCount > 100000, 'city-wide feature count が想定より少ない: ' + dbg.distinctFeatureCount);
});

test('[ALIGNMENT-RESET] __GSI_ROAD_EDGE_AUTHORITATIVE_DEBUG__ は既存の __GSI_ROAD_EDGE_DEBUG__(FIX15/16 sample限定)と衝突しない別名である', () => {
  // 同名で定義していた場合、後方の代入で上書きされて本機能が消える実バグになるところだった（本ミッション中に発見）。
  const idx1 = html.indexOf('window.__GSI_ROAD_EDGE_AUTHORITATIVE_DEBUG__ =');
  const idx2 = html.indexOf('window.__GSI_ROAD_EDGE_DEBUG__ =');
  assert.ok(idx1 >= 0 && idx2 >= 0, '両方の定義が見つからない');
  assert.notEqual(idx1, idx2);
});

test('[ALIGNMENT-RESET §29] tools/build-gsi-road-edge-tiles.js は自身が所有する derived/gsi-road-edge/ だけを削除する', () => {
  const src = fs.readFileSync(R('tools', 'build-gsi-road-edge-tiles.js'), 'utf-8');
  assert.match(src, /fs\.rmSync\(OUT_DIR, \{ recursive: true, force: true \}\);/);
  assert.doesNotMatch(src, /fs\.rmSync\(resolveProjectPath\(path\.join\('data', 'processed', 'osaka-city', 'derived'\)\)/,
    '共有親ディレクトリ全体を削除している（[[shared-derived-dir-rmsync-trap]]の再発）');
});

test('[ALIGNMENT-RESET §34] alignment-reset.json に必須フィールドが揃っている', { skip: !rpt('alignment-reset.json') && 'no report' }, () => {
  const j = rpt('alignment-reset.json');
  assert.ok(j.buildingSource);
  assert.ok(j.roadEdgeSource);
  assert.ok(j.sceneRoots && j.sceneRoots.canonical === 'canonicalRoot' && j.sceneRoots.legacy === 'legacyRoot');
  assert.equal(j.referenceSites.length, 6);
  assert.equal(j.buildingVsGsiRoadEdge.length, 6);
  assert.ok(j.cityWideSample.sampleCount >= 10000, 'city-wide sample が「少なくとも数万棟」の目安に届いていない: ' + j.cityWideSample.sampleCount);
  for (const s of j.buildingVsGsiRoadEdge) {
    assert.ok(typeof s.crossingBuildingCount === 'number');
    assert.ok(s.nearestEdgeDistance && typeof s.nearestEdgeDistance.median !== 'undefined');
  }
});

test('[ALIGNMENT-RESET §0] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /canonicalRoot|legacyRoot|debugRoot|REFERENCE_SITES|GsiRoadEdgeAuthoritative/, f + ' に混入');
  }
});
