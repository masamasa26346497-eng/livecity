// tests/gsi-road-reconstruction-v3.test.js
// [Mission 31G-FIX18] GSI Corridor-Level Road Reconstruction v3。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../tools/lib/canonical-baseline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

function hasRealRawData() {
  const dir = R('data', 'raw', 'gsi', 'road-edge');
  try { return fs.readdirSync(dir).some((f) => !/^readme\.md$/i.test(f) && !f.startsWith('.')); } catch { return false; }
}

test('[FIX18 §40] gsi-road-reconstruction-v3 validator が PASS', { skip: !rpt('gsi-road-reconstruction-v3-validation.json') && 'no report' }, () => {
  const v = rpt('gsi-road-reconstruction-v3-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['rawMutation', 'canonicalRoadMutation', 'buildingMutation', 'fix13Mutation',
    'illegalPairCrossing', 'impossibleWidth', 'unexplainedSideFlip', 'untrackedPairSwitch', 'brokenCorridor', 'invalidPrototypePolygon']) {
    assert.equal(v.checks[k], 0, k + ' が 0 でない: ' + v.checks[k]);
  }
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
  assert.equal(v.checks.publicHasOnlySample, true);
});

test('[FIX18 §43] finalDecision は READY_FOR_HYBRID_GSI_ROAD_PROTOTYPE / CORRIDOR_V3_NOT_READY のいずれか', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-reconstruction-v3.json');
  assert.ok(j, 'report が無い');
  assert.ok(['READY_FOR_HYBRID_GSI_ROAD_PROTOTYPE', 'CORRIDOR_V3_NOT_READY'].includes(j.finalDecision), '不正な finalDecision: ' + j.finalDecision);
});

test('[FIX18 §39] report に必須フィールドが全て存在する', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-reconstruction-v3.json');
  for (const f of ['corridorCount', 'edgeTrackCount', 'pairing', 'coverage',
    'pairSwitchCountBefore', 'pairSwitchCountAfter', 'sideFlipCountBefore', 'sideFlipCountAfter',
    'widthSpikeCountBefore', 'widthSpikeCountAfter', 'majorRoads', 'residentialRoads',
    'scatter', 'hybridCoverage', 'fix13Comparison', 'finalDecision']) {
    assert.ok(f in j, '必須フィールドが無い: ' + f);
  }
  assert.ok('v1' in j.scatter && 'v2' in j.scatter && 'v3' in j.scatter);
});

test('[FIX18 §5/§6] DP は greedy baseline より pair switch / side flip / width spike を減らす（悪化していない）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-reconstruction-v3.json');
  assert.ok(j.pairSwitchCountAfter <= j.pairSwitchCountBefore, 'pair switch が DP 適用後に増加');
  assert.ok(j.sideFlipCountAfter <= j.sideFlipCountBefore, 'side flip が DP 適用後に増加');
  assert.ok(j.widthSpikeCountAfter <= j.widthSpikeCountBefore, 'width spike が DP 適用後に増加');
});

test('[FIX18 §21] 核心指標: 幹線道路 scatter が v2 比で捏造なく honest に記録されている', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-reconstruction-v3.json');
  assert.ok(Array.isArray(j.scatter.improvedVsV2));
  assert.ok(Array.isArray(j.scatter.worsenedVsV2));
  assert.ok(typeof j.scatter.reachedReferenceTargetLE3_5 === 'boolean', '参考目標(<=3.5)の達成有無が記録されていない');
});

test('[FIX18 §22] FIX17 悪化4路線（御堂筋/玉造筋/あびこ筋/国道43号）を個別追跡している', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-reconstruction-v3.json');
  const targets = j.scatter.fix17TargetRoads;
  for (const r of ['御堂筋', '玉造筋', 'あびこ筋', '国道43号']) assert.ok(targets.includes(r), r + ' が追跡対象に無い');
});

test('[FIX18 §16] Strategy A(polygonization)は前回に続き未実装（誤 polygon を捏造しない）', () => {
  if (!hasRealRawData()) return;
  const src = fs.readFileSync(R('tools', 'lib', 'gsi-road-edge-corridor-v3.js'), 'utf-8');
  assert.doesNotMatch(src, /polygonize|faceTraversal/i, 'polygonization を実装した形跡があるなら §16 相当の評価記録が必要');
});

test('[FIX18 §24] residential 4地区で regression が無い（HIGH比率が崩れていない）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-reconstruction-v3.json');
  for (const area of ['住吉', '阿倍野', '平野', '十三']) {
    const r = j.residentialRoads[area];
    if (!r || r.pairs === 0) continue;
    assert.ok(r.confidence.high / r.pairs >= 0.3, area + ': HIGH比率が著しく低下 (' + (r.confidence.high / r.pairs) + ')');
  }
});

test('[FIX18 §37] canonical / building / FIX13 は完全不変', () => {
  const bm = rj(R('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'));
  assert.equal(bm.featureCount, 615617);
  const rm = rj(R('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'));
  assert.equal(rm.featureCount, CANONICAL_ROAD_FEATURE_COUNT);
  const refined = rj(R('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json'));
  assert.equal(refined.indexedCount, REFINED_ROAD_SURFACE_INDEXED_COUNT);
  if (hasRealRawData()) {
    const j = rpt('gsi-road-reconstruction-v3.json');
    assert.equal(j.sourceTruthProtection.canonicalRoadUnchanged, true);
    assert.equal(j.sourceTruthProtection.canonicalBuildingUnchanged, true);
    assert.equal(j.sourceTruthProtection.fix13Unchanged, true);
  }
});

test('[FIX18 §36/§37] output は offline precompute のみ・public には sample overlay のみ配信', () => {
  const pubSample = R('public', 'map-data', 'osaka-city', 'gsi-road-surface-v3', 'prototype-surfaces-sample.json');
  const pubFull = R('public', 'map-data', 'osaka-city', 'gsi-road-surface-v3', 'prototype-surfaces.json');
  if (!fs.existsSync(path.dirname(pubSample))) return;
  assert.ok(!fs.existsSync(pubFull), '全大阪版が public に配信されている');
  if (fs.existsSync(pubSample)) assert.ok(fs.statSync(pubSample).size < 10 * 1024 * 1024, 'sample overlay が過大');
});

test('[FIX18 §34] runtime: GSI Prototype v3 toggle は既定 OFF・v2 と明確に別の色・per-frame cost なし', { skip: !html && 'no html' }, () => {
  assert.match(html, /let v3Visible = false;/);
  assert.match(html, /window\.toggleGsiPrototypeV3 = async function/);
  assert.match(html, /color: 0x7cff4a/);   // v2(0x00e5ff)・raw edge(0xff2d95)と明確に違う色
  const animIdx = html.indexOf('function animate(');
  if (animIdx >= 0) assert.doesNotMatch(html.slice(animIdx, animIdx + 4000), /v3Visible|v3Group/);
});

test('[FIX18 §0] protected HTML に v3 コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /gsi-road-surface-v3|toggleGsiPrototypeV3|reconstructCorridorsV3/, f + ' に混入');
  }
});

test('[FIX18] tools/lib/gsi-road-edge-corridor-v3.js: buildEdgeTracks が連続 segment を束ねる', async () => {
  const { buildEdgeTracks } = await import('../tools/lib/gsi-road-edge-corridor-v3.js');
  const segA = { id: 'a', parentId: 'lineA', coords: [[0, 0], [10, 0]], midpoint: [5, 0], bearing: [1, 0], bbox: { minX: 0, maxX: 10, minZ: -1, maxZ: 1 }, length: 10 };
  const segB = { id: 'b', parentId: 'lineB', coords: [[10, 0], [20, 0]], midpoint: [15, 0], bearing: [1, 0], bbox: { minX: 10, maxX: 20, minZ: -1, maxZ: 1 }, length: 10 };
  const { trackOf } = buildEdgeTracks([segA, segB]);
  assert.equal(trackOf.get('a'), trackOf.get('b'), '端点で連続する2 segmentが同一 track に束ねられていない');
});

test('[FIX18] gsi-road-edge-corridor-v3.js: detectChangePoints は孤立spikeと持続的changeを区別する', async () => {
  const { detectChangePoints } = await import('../tools/lib/gsi-road-edge-corridor-v3.js');
  // index5=孤立spike（前後は元の水準に戻る）、index7-13=持続的change（複数 segment 継続）
  const series = [12, 12, 12, 12, 12, 32, 12, 12, 12, 30, 30, 30, 30, 30, 12, 12, 12];
  const flags = detectChangePoints(series, { minSustain: 3, spikeThreshold: 1.8 });
  assert.equal(flags[5].spike, true, '孤立spikeが検出されていない');
  assert.equal(flags[5].changePoint, false, '孤立spikeがchangePoint扱いされている');
  assert.ok(flags.slice(7, 14).some((f) => f.changePoint), '持続的changeがchangePointとして検出されていない');
});
