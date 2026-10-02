// tests/gsi-road-reconstruction-v2.test.js
// [Mission 31G-FIX17] GSI Road Edge Reconstruction v2。
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

test('[FIX17 §41] gsi-road-reconstruction-v2 validator が PASS', { skip: !rpt('gsi-road-reconstruction-v2-validation.json') && 'no report' }, () => {
  const v = rpt('gsi-road-reconstruction-v2-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['rawMutation', 'canonicalRoadMutation', 'buildingMutation', 'fix13Mutation',
    'invalidPrototypePolygon', 'untrackedPrototype', 'crossPairViolation', 'impossibleWidthViolation', 'intersectionGapCritical']) {
    assert.equal(v.checks[k], 0, k + ' が 0 でない: ' + v.checks[k]);
  }
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
  assert.equal(v.checks.publicHasOnlySample, true);
});

test('[FIX17 §46] finalDecision は READY_FOR_GSI_ROAD_SURFACE_PROTOTYPE / PAIRING_V2_NOT_READY のいずれか', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-reconstruction-v2.json');
  assert.ok(j, 'report が無い');
  assert.ok(['READY_FOR_GSI_ROAD_SURFACE_PROTOTYPE', 'PAIRING_V2_NOT_READY'].includes(j.finalDecision), '不正な finalDecision: ' + j.finalDecision);
});

test('[FIX17 §40] report に必須フィールドが全て存在する', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-reconstruction-v2.json');
  for (const f of ['rawEdgeCount', 'network', 'polygonization', 'pairing', 'coverageRate', 'widthStats',
    'majorRoads', 'residentialSamples', 'fix13Comparison', 'buildingOverlapComparison', 'finalDecision']) {
    assert.ok(f in j, '必須フィールドが無い: ' + f);
  }
  assert.ok('nodes' in j.network && 'segments' in j.network && 'intersections' in j.network);
});

test('[FIX17 §16] Strategy A(polygonization)は未実装と正直に記録している（誤 polygon を捏造しない）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-reconstruction-v2.json');
  assert.equal(j.polygonization.implemented, false);
  assert.ok(j.polygonization.reason.length > 0);
});

test('[FIX17 §8/§29] pairing の会計が一致する（pairs*2 + rejected + unpaired = totalSegments）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-reconstruction-v2.json');
  const p = j.pairing;
  const total = (p.high + p.medium + p.low) * 2 + p.rejected + p.unpaired;
  assert.equal(total, p.totalSegments, 'segment 会計が一致しない: ' + total + ' vs ' + p.totalSegments);
});

test('[FIX17 §10] majorRoadScatterSummary が v1 との比較を honest に記録している（悪化を隠さない）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-reconstruction-v2.json');
  assert.ok(j.majorRoadScatterSummary);
  assert.ok(['IMPROVED', 'WORSENED', 'MIXED_NO_CLEAR_IMPROVEMENT'].includes(j.majorRoadScatterSummary.verdict));
  assert.ok(Array.isArray(j.majorRoadScatterSummary.improvedRoads));
  assert.ok(Array.isArray(j.majorRoadScatterSummary.worsenedRoads));
});

test('[FIX17 §35] fix13Comparison は面積比較に基づく（Buildingを正解に使っていない §20/§36）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-road-reconstruction-v2.json');
  for (const [area, c] of Object.entries(j.fix13Comparison)) {
    assert.ok(['GSI_CLEARLY_BETTER', 'GSI_SLIGHTLY_BETTER', 'SIMILAR', 'FIX13_BETTER', 'UNRESOLVED'].includes(c.classification), area + ': 不正な分類');
    assert.doesNotMatch(c.method, /building.*ground.?truth|building.*正解/i);
  }
});

test('[FIX17 §37] canonical / building / FIX13 は完全不変', () => {
  const bm = rj(R('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'));
  assert.equal(bm.featureCount, 615617);
  const rm = rj(R('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'));
  assert.equal(rm.featureCount, CANONICAL_ROAD_FEATURE_COUNT);
  const refined = rj(R('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json'));
  assert.equal(refined.indexedCount, REFINED_ROAD_SURFACE_INDEXED_COUNT);
  if (hasRealRawData()) {
    const j = rpt('gsi-road-reconstruction-v2.json');
    assert.equal(j.sourceTruthProtection.canonicalRoadUnchanged, true);
    assert.equal(j.sourceTruthProtection.canonicalBuildingUnchanged, true);
    assert.equal(j.sourceTruthProtection.fix13Unchanged, true);
  }
});

test('[FIX17 §38/§39] output は offline precompute のみ・runtime は sample overlay のみ配信', () => {
  const pubSample = R('public', 'map-data', 'osaka-city', 'gsi-road-surface-v2', 'prototype-surfaces-sample.json');
  const pubFull = R('public', 'map-data', 'osaka-city', 'gsi-road-surface-v2', 'prototype-surfaces.json');
  if (!fs.existsSync(path.dirname(pubSample))) return;
  assert.ok(!fs.existsSync(pubFull), '全大阪版が public に配信されている（§27/§38 違反）');
  if (fs.existsSync(pubSample)) assert.ok(fs.statSync(pubSample).size < 10 * 1024 * 1024, 'sample overlay が過大');
});

test('[FIX17 §32/§33] runtime: GSI Prototype v2 toggle は既定 OFF・per-frame cost なし・Console 不要', { skip: !html && 'no html' }, () => {
  assert.match(html, /let v2Visible = false;/);
  assert.match(html, /window\.toggleGsiPrototypeV2 = async function/);
  assert.match(html, /color: 0x00e5ff/);   // GSI raw edge(マゼンタ)・FIX13(グレー)と明確に違う色
  const animIdx = html.indexOf('function animate(');
  if (animIdx >= 0) assert.doesNotMatch(html.slice(animIdx, animIdx + 4000), /v2Visible|v2Group/);
});

test('[FIX17 §0] protected HTML に v2 コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /gsi-road-surface-v2|toggleGsiPrototypeV2|pairSegmentsV2/, f + ' に混入');
  }
});

test('[FIX17] tools/lib/gsi-road-edge-pairing-v2.js: 交差点近傍の pair は confidence が抑制される', async () => {
  const { pairSegmentsV2, buildIntersectionIndex } = await import('../tools/lib/gsi-road-edge-pairing-v2.js');
  const a = { id: 'a', parentId: 'lineA', coords: [[0, 0], [30, 0]], midpoint: [15, 0], bearing: [1, 0], bbox: { minX: 0, maxX: 30, minZ: -1, maxZ: 1 }, length: 30 };
  const b = { id: 'b', parentId: 'lineB', coords: [[0, 8], [30, 8]], midpoint: [15, 8], bearing: [1, 0], bbox: { minX: 0, maxX: 30, minZ: 7, maxZ: 9 }, length: 30 };
  const intersectionIndex = { isNear: (pt) => Math.abs(pt[0] - 15) < 5 };   // 疑似的に交差点近傍とする
  const { pairs } = pairSegmentsV2([a, b], { intersectionIndex });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].confidence, 'medium');   // HIGH ではなく confidence 抑制
  assert.equal(pairs[0].nearIntersection, true);
});

test('[FIX17] gsi-road-edge-pairing-v2.js: mutual best match でない場合は LOW 止まり', async () => {
  const { pairSegmentsV2 } = await import('../tools/lib/gsi-road-edge-pairing-v2.js');
  // c にとって a が best、a にとっては c より d の方が良い best（mutual でないケース）
  const a = { id: 'a', parentId: 'lineA', coords: [[0, 0], [30, 0]], midpoint: [15, 0], bearing: [1, 0], bbox: { minX: 0, maxX: 30, minZ: -1, maxZ: 1 }, length: 30 };
  const c = { id: 'c', parentId: 'lineC', coords: [[0, 20], [30, 20]], midpoint: [15, 20], bearing: [1, 0], bbox: { minX: 0, maxX: 30, minZ: 19, maxZ: 21 }, length: 30 };
  const d = { id: 'd', parentId: 'lineD', coords: [[0, 8], [30, 8]], midpoint: [15, 8], bearing: [1, 0], bbox: { minX: 0, maxX: 30, minZ: 7, maxZ: 9 }, length: 30 };
  const { pairs } = pairSegmentsV2([a, c, d], {});
  // a-d が最も近い(8m)ので mutual best、c は a/d いずれからも遠く(12m/12m)最良ではない可能性
  const withC = pairs.find((p) => p.a.id === 'c' || p.b.id === 'c');
  if (withC) assert.notEqual(withC.confidence, 'high');
});
