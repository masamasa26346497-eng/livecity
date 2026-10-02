// tests/building-rotation-root-cause.test.js
// [Mission 32M] BUILDING ROTATION ROOT CAUSE AUDIT（AUDIT ONLY）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const REPORT = 'building-rotation-root-cause.json';
const skip = (n) => (!rpt(n) && 'no report');

test('[32M §27] validator が PASS（何も変更していない・独立 truth のみ）', { skip: skip('building-rotation-root-cause-validation.json') }, () => {
  const v = rpt('building-rotation-root-cause-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['buildingMutation', 'roadMutation', 'projectionMutation', 'buildingConfigMutation']) assert.equal(v.checks[k], 0, k);
  assert.equal(v.checks.rawLatLonUsedAsTruth, true);
  assert.equal(v.checks.inverseDerivedTruthUsed, false);
  assert.equal(v.checks.rotationMeasuredAtEachStage, true);
  assert.equal(v.checks.firstBadStageIdentified, true);
});

test('[32M §8/§9] 回転は B（第7系への投影）で初めて現れ、以降の段階は座標を変えていない', { skip: skip(REPORT) }, () => {
  const r = rpt(REPORT);
  const byStage = new Map(r.stageMeasurements.map((s) => [s.stage, s]));
  assert.equal(byStage.get('A_raw_latlon_to_map').rotationDeg, 0);
  assert.ok(Math.abs(byStage.get('B_projected_zone7').rotationDeg - 0.93) < 0.05);
  assert.equal(r.firstBadStage, 'B_projected_zone7');
  // B → C1 は平行移動（localOrigin）だけ
  const t = r.stageTransitions;
  assert.equal(t.B_zone7_to_C1_jsonl.rotationDeg, 0);
  assert.ok(t.B_zone7_to_C1_jsonl.residualMedianM < 0.01);
  for (const k of ['C1_jsonl_to_C2_wardDataset', 'C2_wardDataset_to_C3_canonical', 'C3_canonical_to_D_derivedNear']) {
    assert.ok(t[k].vertices > 1000, k);
    assert.equal(t[k].medianM, 0, k);
    assert.equal(t[k].p95M, 0, k);
  }
  assert.equal(t.D_to_E_runtime.identity, true);
});

test('[32M §5/§6] 観測回転は第7系の経線収差と符号・大きさとも一致し、第6系とは一致しない', { skip: skip(REPORT) }, () => {
  const r = rpt(REPORT);
  const obs = r.observedRotationDeg;
  assert.ok(obs > 0, '符号');
  assert.ok(Math.abs(obs - r.zoneVIIConvergence.atLiveCityOriginDeg) < 0.05, 'VII と大きさが一致しない');
  assert.ok(Math.abs(obs - r.zoneVIConvergence.atLiveCityOriginDeg) > 0.5, 'VI とも一致してしまう');
  assert.equal(r.zoneComparison.matchesObserved, 'VII');
  assert.match(r.rotationDirection, /^CLOCKWISE/);
});

test('[32M §17] 回転しているのは建物だけ（道路・鉄道・水域・公園・行政界は地図と同じ frame）', { skip: skip(REPORT) }, () => {
  const r = rpt(REPORT);
  for (const l of r.layerComparison) {
    if (l.layer.startsWith('building')) assert.equal(l.frame, 'JPRECT_ZONE_VII_LOCAL');
    else { assert.equal(l.frame, 'MAP_EQUIRECT', l.layer); assert.ok(l.exactRatio > 0.95, l.layer + ' exactRatio=' + l.exactRatio); }
  }
  assert.equal(r.onlyBuildingsRotated, true);
});

test('[32M §19] 死骸と思われていた第7系 config が実際の生成に使われていたことを記録している', { skip: skip(REPORT) }, () => {
  const r = rpt(REPORT);
  const cfg = r.sourceConfigUsed.find((c) => c.file.startsWith('data/buildings/coordinate-config.json'));
  assert.ok(cfg);
  assert.equal(cfg.status, 'USED');
  assert.match(r.buildingConfig.declaredStatus, /DEPRECATED/);
  assert.equal(r.buildingConfig.zone, 7);
});

test('[32M §16] 24区すべての予測変位が出ており、原点から遠い区ほど大きい', { skip: skip(REPORT) }, () => {
  const r = rpt(REPORT);
  assert.equal(r.byWard.length, 24);
  const near = r.byWard.slice(0, 4).map((w) => w.predictedDisplacementM);
  const far = r.byWard.slice(-4).map((w) => w.predictedDisplacementM);
  assert.ok(Math.max(...near) < Math.min(...far));
});

test('[32M §22/§23] 正しい変換で作り直すと OSM 一致が改善し、住吉も悪化しない', { skip: skip(REPORT) }, () => {
  const p = rpt(REPORT).predictedCorrection;
  assert.ok(p.osmOverlapAfter > p.osmOverlapBefore + 0.3, 'umeda osm');
  assert.ok(p.roadOverlapAfter < p.roadOverlapBefore, 'umeda road');
  assert.ok(p.waterOverlapAfter <= p.waterOverlapBefore, 'umeda water');
  assert.equal(p.overCorrectionCheck.sumiyoshiWorsened, false);
  // 区の正解は生 CityGML の「区名」（循環しない truth）
  assert.match(p.umeda.wardPlacementTruth, /区名/);
  assert.ok(p.umeda.wardPlacementAfter > p.umeda.wardPlacementBefore);
});

test('[32M §21/§24] canonicalId は維持でき、補正は global rotate ではなく変換のやり直しとして記録', { skip: skip(REPORT) }, () => {
  const r = rpt(REPORT);
  assert.equal(r.canonicalIdPreservation.preservable, true);
  assert.match(r.predictedCorrection.method, /正しい source→canonical 変換/);
  assert.ok(r.rebuildScope.mustRegenerate.length >= 5);
});

test('[32M §25/§28] classification / stopToken', { skip: skip(REPORT) }, () => {
  const r = rpt(REPORT);
  assert.equal(r.classification, 'PLANE_RECTANGULAR_CONVERGENCE_ERROR');
  assert.equal(r.stopToken, 'BUILDING_ROTATION_ROOT_CAUSE_IDENTIFIED');
});

test('[32M §0] 監査対象（第7系 config）を書き換えていない', () => {
  const cfg = rj(path.join(ROOT, 'data', 'buildings', 'coordinate-config.json'));
  assert.equal(cfg.jprectZone, 7);
  assert.equal(cfg.localOrigin.projectedE, -150573.671);
  assert.equal(cfg.localOrigin.projectedN, -153599.466);
});
