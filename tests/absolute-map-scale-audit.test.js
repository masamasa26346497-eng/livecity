// tests/absolute-map-scale-audit.test.js
// [Mission 32L] ABSOLUTE MAP SCALE AUDIT（AUDIT ONLY）。
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
const REPORT = 'absolute-map-scale-audit.json';
const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

test('[32L §0] validator が PASS（何も変更していない）', { skip: !rpt('absolute-map-scale-audit-validation.json') && 'no report' }, () => {
  const v = rpt('absolute-map-scale-audit-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.buildingMutation, 0);
  assert.equal(v.checks.roadMutation, 0);
  assert.equal(v.checks.projectionMutation, 0);
  assert.equal(v.checks.usesNearestEdge, false);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[32L §3] Map 側の変換が equirect であることを実測で確認している', { skip: !rpt(REPORT) && 'no report' }, () => {
  const m = rpt(REPORT).mapPipelineVerification;
  assert.equal(m.verified, true);
  assert.ok(m.pairs >= 50);
  assert.ok(Math.abs(m.medianDxM) < 0.05 && Math.abs(m.medianDzM) < 0.05);
});

test('[32L §1/§2/§15/§16] control point 20 以上・全距離帯・梅田/住吉 10 ペア以上', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  assert.ok(r.controlPointCount >= 20);
  for (const k of ['50-100m', '100-250m', '250-500m', '500-1000m', '1000-3000m']) assert.ok(r.distanceBands[k].count > 0, k);
  assert.ok(r.umeda.count >= 10);
  assert.ok(r.sumiyoshi.count >= 10);
});

test('[32L §5/§6/§7/§19] 絶対縮尺は建物・地図で一致（0.995–1.005）', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  for (const v of [r.relative.medianRatio, r.relative.buildingVsMapX, r.relative.buildingVsMapZ, r.relative.diagonal]) {
    assert.ok(v >= 0.995 && v <= 1.005, 'relativeScale が許容帯外: ' + v);
  }
  assert.equal(r.classification, 'ABSOLUTE_SCALE_MATCH');
});

test('[32L §9] 普通の低層建物は 50m/100m 級になっていない', { skip: !rpt(REPORT) && 'no report' }, () => {
  const b = rpt(REPORT).buildingBboxSanity;
  assert.ok(b.sampleCount >= 30);
  assert.ok(b.widthM.median > 3 && b.widthM.median < 30, 'width median: ' + b.widthM.median);
  assert.ok(b.depthM.median > 3 && b.depthM.median < 30, 'depth median: ' + b.depthM.median);
  assert.equal(b.over100mCount, 0);
});

test('[32L] 縮尺とは別の不一致（frame 回転）を隠さず報告している', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  const f = r.rotationFinding;
  assert.ok(f && typeof f.rotationDeg === 'number');
  assert.ok(f.whyPriorAuditMissedIt && f.whyPriorAuditMissedIt.length > 0);
  assert.ok(f.independentConfirmation && /OSM/.test(f.independentConfirmation));
  // 変位は原点からの距離とともに増える（回転の特徴）
  const d = r.frameDisplacement.byRegion;
  assert.ok(d.sumiyoshi.displacementMedianM < d.mid.displacementMedianM);
  assert.ok(d.mid.displacementMedianM < d.umeda.displacementMedianM);
});

test('[32L §12/§13] 100 m ruler は正確に 100 world units で、既定 OFF・Ortho 固定', () => {
  assert.match(html, /let scaleRulerEnabled = false;/);
  assert.match(html, /CanonicalRuntime\.isScaleRulerActive\(\)\) return orthoCamera;/);
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  assert.equal(w.__SCALE_RULER_DEBUG__().enabled, false);
  w.__SET_SCALE_RULER__(true);
  const d = w.__SCALE_RULER_DEBUG__();
  assert.equal(d.enabled, true);
  assert.equal(d.measuredLengthWorld.eastWest, 100);
  assert.equal(d.measuredLengthWorld.northSouth, 100);
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
  w.__SET_SCALE_RULER__(false);
  assert.equal(w.__SCALE_RULER_DEBUG__().enabled, false);
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
});

test('[32L] protected HTML に混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    assert.doesNotMatch(fs.readFileSync(p, 'utf-8'), /SCALE_RULER_M|scale-ruler-toggle|ScaleRuler100m/);
  }
});
