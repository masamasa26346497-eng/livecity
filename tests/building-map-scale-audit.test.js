// tests/building-map-scale-audit.test.js
// [Mission 31G-SCALE-AUDIT] Building vs Map Scale 最終監査。測定専用（geometry/coordinate/road不変）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const VALID_CLASS = ['BUILDING_SIZE_CORRECT', 'BUILDING_FOOTPRINT_OVERSIZED', 'BUILDING_FOOTPRINT_UNDERSIZED',
  'RUNTIME_SCALE_ERROR', 'MAP_SCALE_ERROR', 'ANISOTROPIC_SCALE_ERROR', 'SOURCE_SEMANTICS_DIFFERENCE'];

test('[SCALE-AUDIT §24] validator が PASS', { skip: !rpt('building-map-scale-audit-validation.json') && 'no report' }, () => {
  const v = rpt('building-map-scale-audit-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['auditReportExists', 'matchedCountSufficient', 'runtimeScaleMeasured', 'parentScaleMeasured',
    'affineMeasured', 'footprintDimensionMeasured', 'classificationPresent', 'classificationValid',
    'correctionNotApplied', 'noNonSpriteScaleMutation']) {
    assert.equal(v.checks[k], true, k + ' が true でない');
  }
  assert.equal(v.checks.geometryMutation, 0);
  assert.equal(v.checks.roadMutation, 0);
  assert.equal(v.checks.coordinateMutation, 0);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[SCALE-AUDIT §23] building-map-scale-audit.json に必須フィールドが揃っている', { skip: !rpt('building-map-scale-audit.json') && 'no report' }, () => {
  const j = rpt('building-map-scale-audit.json');
  assert.ok(j.matchedCount >= 2000, 'matchedCount が下限未満: ' + j.matchedCount);
  assert.ok(j.footprint);
  for (const k of ['areaRatioMedian', 'linearScaleMedian', 'widthRatioMedian', 'depthRatioMedian']) {
    assert.ok(typeof j.footprint[k] === 'number', 'footprint.' + k + ' が数値でない');
  }
  assert.ok(j.affine, 'affine transform が測定されていない');
  for (const k of ['scaleX', 'scaleZ', 'rotationDeg', 'shear', 'tx', 'tz']) {
    assert.ok(k in j.affine, 'affine.' + k + ' が無い');
  }
  assert.ok(j.runtime);
  assert.equal(j.runtime.meshScale, 1, 'meshScale が1でない（runtime scale mutationの疑い）');
  assert.equal(j.runtime.parentScale, 1, 'parentScale が1でない');
  assert.equal(j.runtime.effectiveWorldScale, 1, 'effectiveWorldScale が1でない');
  assert.ok(j.distanceRatio && j.distanceRatio.byDistanceBucket);
  for (const k of ['0-100m', '100-500m', '500-1000m', '1-5km', '5km+']) {
    assert.ok(k in j.distanceRatio.byDistanceBucket, 'distanceRatio bucket 不足: ' + k);
  }
  assert.ok(j.byWard && Object.keys(j.byWard).length > 0, '24区別集計が空');
  assert.ok(j.deepDive && j.deepDive.umeda && j.deepDive.sumiyoshi, '梅田/住吉の深掘りが無い');
  assert.ok(VALID_CLASS.includes(j.classification), 'classification が §20 の分類外: ' + j.classification);
  assert.ok(j.recommendedCorrection);
  assert.equal(j.recommendedCorrection.appliedToRuntime, false, '§0/§21違反: correctionがruntimeへ適用されたと記録されている');
  assert.equal(j.validatorFlags.geometryMutation, 0);
  assert.equal(j.validatorFlags.coordinateMutation, 0);
  assert.equal(j.validatorFlags.roadMutation, 0);
});

test('[SCALE-AUDIT §7/§9] runtime に canonicalRoot/layerGroup/buildingメッシュへの非sprite scale代入が無い', { skip: !rpt('building-map-scale-audit.json') && 'no report' }, () => {
  const j = rpt('building-map-scale-audit.json');
  assert.equal(j.runtime.audit.nonSpriteScaleAssignments.length, 0);
  assert.equal(j.runtime.audit.canonicalRootScaleTouched, false);
  assert.equal(j.runtime.audit.rtRootScaleTouched, false);
  assert.equal(j.runtime.audit.layerGroupScaleTouched, false);
});

test('[SCALE-AUDIT §10/§11] 全pipelineが単一projection設定を共有している', { skip: !rpt('building-map-scale-audit.json') && 'no report' }, () => {
  const j = rpt('building-map-scale-audit.json');
  assert.ok(j.projection);
  assert.equal(j.projection.centerLat, 34.604208);
  assert.equal(j.projection.centerLon, 135.52502);
  assert.equal(j.projection.metersPerDegree, 111320);
  for (const f of j.projection.perFile) {
    if (f.exists) assert.equal(f.usesSharedConfig, true, f.file + ' が共有configを使っていない');
  }
});

test('[SCALE-AUDIT §0] tools/audit/building-map-scale-audit.js は測定のみでruntimeへ補正を適用しない', () => {
  const src = fs.readFileSync(R('tools', 'audit', 'building-map-scale-audit.js'), 'utf-8');
  assert.doesNotMatch(src, /\.scale\.set\(|building\.offset|applyCorrection/, '補正適用コードが混入している疑い');
  assert.match(src, /appliedToRuntime: false/);
});

test('[SCALE-AUDIT §0] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /building-map-scale-audit|principalAxisExtents|estimateAffine/, f + ' に混入');
  }
});
