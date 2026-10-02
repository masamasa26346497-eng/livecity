// tests/cartographic-camera-audit.test.js
// [Mission 31G-FIX25] Cartographic 3D Camera。建物geometryは一切変更せず、camera(FOV/pitch/distance)
//   だけで screen-space の roof/base displacement をどれだけ軽減できるかの検証。
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

test('[FIX25 §21] validator が PASS', { skip: !rpt('cartographic-camera-audit-validation.json') && 'no report' }, () => {
  const v = rpt('cartographic-camera-audit-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['cartographicCameraExists', 'threeModeToggleExists', 'targetGroundAnchored',
    'groundCoverageComparable', 'defaultIsCurrent', 'noHeightScaleMutation', 'auditReportExists',
    'screenShiftMeasured', 'fiveSitesPresent']) {
    assert.equal(v.checks[k], true, k + ' が true でない');
  }
  assert.equal(v.checks.buildingGeometryMutation, 0);
  assert.equal(v.checks.roadGeometryMutation, 0);
  assert.equal(v.checks.buildingScaleMutation, 0);
  assert.equal(v.checks.buildingHeightMutation, 0);
  assert.equal(v.checks.projectionMutation, 0);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[FIX25 §20] cartographic-camera-audit.json に必須フィールドが揃っている', { skip: !rpt('cartographic-camera-audit.json') && 'no report' }, () => {
  const j = rpt('cartographic-camera-audit.json');
  assert.ok(j.current && typeof j.current.fov === 'number' && typeof j.current.pitchDeg === 'number' && typeof j.current.distance === 'number' && typeof j.current.targetY === 'number');
  assert.ok(j.cartographic && typeof j.cartographic.fov === 'number' && typeof j.cartographic.pitchDeg === 'number');
  assert.ok(j.screenShift);
  for (const k of ['currentMedian', 'currentP95', 'cartographicMedian', 'cartographicP95', 'improvementPercent']) {
    assert.ok(typeof j.screenShift[k] === 'number', 'screenShift.' + k + ' が数値でない');
  }
  assert.equal(j.sites.length, 5);
  const names = j.sites.map((s) => s.site);
  for (const n of ['梅田', '中之島', '難波', '天王寺', '住吉']) assert.ok(names.includes(n), n + ' が sites に無い');
  assert.ok(j.sites.find((s) => s.siteId === 'umeda').highRiseFocus, '梅田の高層建物重点集計が無い');
  assert.equal(j.heightScaleUnchanged, true);
  assert.equal(j.validatorFlags.buildingGeometryMutation, 0);
  assert.equal(j.validatorFlags.buildingScaleMutation, 0);
  assert.equal(j.validatorFlags.buildingHeightMutation, 0);
  assert.equal(j.validatorFlags.roadGeometryMutation, 0);
  assert.equal(j.validatorFlags.cartographicCameraExists, true);
  assert.equal(j.validatorFlags.targetGroundAnchored, true);
  assert.equal(j.validatorFlags.groundCoverageComparable, true);
});

test('[FIX25 §3] 高さとscreen shiftの相関（heightVsShiftCorrelation）が測定されている', { skip: !rpt('cartographic-camera-audit.json') && 'no report' }, () => {
  const j = rpt('cartographic-camera-audit.json');
  assert.ok(j.heightVsShiftCorrelation);
  assert.ok(Array.isArray(j.heightVsShiftCorrelation.points) && j.heightVsShiftCorrelation.points.length === 5);
  assert.ok(['VISUAL_PARALLAX_CONFIRMED', 'HEIGHT_SHIFT_CORRELATION_NOT_MONOTONIC'].includes(j.heightVsShiftCorrelation.result));
});

test('[FIX25] 動的: setCameraMode がcurrent/cartographic/topdownを往復し、rのround-tripが誤差無く戻る', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const before = w.__CAMERA_MODE_DEBUG__();
  assert.equal(before.mode, 'current', '既定のcameraModeがcurrentでない（§19違反）');
  w.__SET_CAMERA_MODE__('cartographic');
  const cart = w.__CAMERA_MODE_DEBUG__();
  assert.equal(cart.mode, 'cartographic');
  assert.equal(cart.fov, 35);
  assert.equal(cart.pitchDeg, 25);
  assert.ok(cart.distance > before.distance, 'cartographic distance が current より大きくなっていない（ground coverage補正）');
  w.__SET_CAMERA_MODE__('topdown');
  const top = w.__CAMERA_MODE_DEBUG__();
  assert.equal(top.mode, 'topdown');
  assert.ok(top.pitchDeg < 10, 'topdown pitch が十分に真上寄りでない: ' + top.pitchDeg);
  w.__SET_CAMERA_MODE__('current');
  const after = w.__CAMERA_MODE_DEBUG__();
  assert.equal(after.mode, 'current');
  assert.ok(Math.abs(after.distance - before.distance) < 0.5, 'current往復後にdistanceが元の値へ戻っていない: ' + after.distance + ' vs ' + before.distance);
  assert.equal(after.pitchDeg, before.pitchDeg);
  const residual = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residual.total, 0, 'camera mode切替後もresidualが0でない: ' + JSON.stringify(residual));
});

test('[FIX25 §8/§9] flyTo/selectBuildingがcamera target.y・FOV・pitchを変更しない', () => {
  const flyToStart = html.indexOf('function flyTo(x, z, opts={}){');
  const flyToBody = html.slice(flyToStart, flyToStart + 900);
  assert.doesNotMatch(flyToBody, /tgt\.y\s*=/);
  const selStart = html.indexOf('function selectBuilding(e, h){');
  const selBody = html.slice(selStart, selStart + 2000);
  assert.doesNotMatch(selBody, /cs\.ph\s*=|camera\.fov\s*=|cs\.tgt\.y\s*=/);
});

test('[FIX25 §0] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /CAMERA_MODE_PITCH|CAMERA_MODE_R_SCALE|setCameraMode|cartographic-camera-audit/, f + ' に混入');
  }
});
