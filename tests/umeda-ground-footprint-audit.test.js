// tests/umeda-ground-footprint-audit.test.js
// [Mission 32G] GROUND FOOTPRINT ROOT AUDIT（AUDIT ONLY）。
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

test('[32G §21] validator が PASS（AUDIT ONLY: 何も変更していない）', { skip: !rpt('umeda-ground-footprint-audit-validation.json') && 'no report' }, () => {
  const v = rpt('umeda-ground-footprint-audit-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.buildingMutation, 0);
  assert.equal(v.checks.roadMutation, 0);
  assert.equal(v.checks.landBlockMutation, 0);
  assert.equal(v.checks.projectionMutation, 0);
  assert.equal(v.checks.sourceGeometryTraced, true);
  assert.equal(v.checks.groundSurfaceChecked, true);
  assert.equal(v.checks.roofEdgeChecked, true);
  assert.equal(v.checks.runtimeSourceIdentified, true);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[32G §2] 生CityGML実測: lod0FootPrintのみ存在し、RoofEdge/GroundSurface/WallSurface/lod2は0件', { skip: !rpt('umeda-ground-footprint-audit.json') && 'no report' }, () => {
  const g = rpt('umeda-ground-footprint-audit.json').sourceAvailability.rawCityGmlAvailability.sumiyoshiRawGrepCounts;
  assert.ok(g, '生CityGMLのgeometry型カウントが無い');
  assert.equal(g.lod0FootPrint, g.buildingCount, 'lod0FootPrintが全建物ぶん存在していない');
  assert.equal(g.lod0RoofEdge, 0);
  assert.equal(g.GroundSurface, 0);
  assert.equal(g.RoofSurface, 0);
  assert.equal(g.WallSurface, 0);
  assert.equal(g.lod2Solid, 0);
  assert.equal(g.lod2MultiSurface, 0);
});

test('[32G §3] currentFootprintSource が LOD0_FOOTPRINT と特定されている', { skip: !rpt('umeda-ground-footprint-audit.json') && 'no report' }, () => {
  const r = rpt('umeda-ground-footprint-audit.json');
  assert.equal(r.currentFootprintSource.classification, 'LOD0_FOOTPRINT');
  // converterの優先順位が実コードから読めていること（推測ではない）
  const c = r.sourceAvailability.converterLogic;
  assert.equal(c.usesLod0FootPrint, true);
  assert.equal(c.excludesRoofSurface, true);
  assert.equal(c.referencesLod0RoofEdge, false, 'converterがlod0RoofEdgeを参照している');
  assert.equal(c.referencesLod2, false, 'converterがlod2を参照している');
});

test('[32G §1/§16] sample30棟と集計が揃っている', { skip: !rpt('umeda-ground-footprint-audit.json') && 'no report' }, () => {
  const r = rpt('umeda-ground-footprint-audit.json');
  assert.ok(r.sampleCount >= 30, 'sampleが30棟未満: ' + r.sampleCount);
  assert.equal(r.classifications.length, r.sampleCount);
  const sum = Object.values(r.classCounts).reduce((a, b) => a + b, 0);
  assert.equal(sum, r.sampleCount, 'classCountsの合計がsampleCountと一致しない');
  for (const s of r.classifications) {
    assert.ok(['YES', 'NO', 'UNKNOWN'].includes(s.groundFootprintAnswer), '§15の答えがYES/NO/UNKNOWNでない');
    assert.ok(s.groundFootprintReason && s.groundFootprintReason.length > 0, '判定理由が無い');
  }
});

test('[32G 測定の健全性] 対照群があり、判別限界が開示されている（循環論法でない）', { skip: !rpt('umeda-ground-footprint-audit.json') && 'no report' }, () => {
  const r = rpt('umeda-ground-footprint-audit.json');
  const cg = r.comparison.controlGroup;
  assert.ok(cg && cg.count > 100, '対照群が小さすぎる/無い');
  // 対照群のGSI coverageも低い(=GSIの取りこぼしは梅田全域の性質)という事実が記録されていること
  assert.ok(cg.gsiCoverageRatio.median != null);
  assert.ok(r.discriminationLimitation && r.discriminationLimitation.note.includes('区別できない'),
    'H1/H2を区別できない旨の開示が無い');
  // roof系geometryがsourceに無い以上、ROOF_LIKE/PROJECTIONに分類された建物は0でなければならない
  assert.equal(r.discriminationLimitation.roofGeometryExistsInSource, false);
  assert.equal(r.classCounts.CURRENT_IS_ROOF_LIKE, 0, 'sourceにroof geometryが無いのにROOF_LIKE分類が発生している');
  assert.equal(r.classCounts.CURRENT_IS_PROJECTION, 0);
});

test('[32G §22] 最終判定が4択のいずれか', { skip: !rpt('umeda-ground-footprint-audit.json') && 'no report' }, () => {
  const r = rpt('umeda-ground-footprint-audit.json');
  assert.match(r.finalClassification, /^(GROUND_FOOTPRINT_SEMANTICS_ERROR|CURRENT_FOOTPRINT_IS_CORRECT|SPECIAL_STRUCTURE_DOMINANT|SOURCE_CONFLICT)$/);
  assert.ok(r.finalClassificationReason && r.finalClassificationReason.length > 0);
});

test('[32G §14] Ground FP QA overlay runtime APIが存在し既定OFF', () => {
  assert.match(html, /let groundFpQaEnabled = false;/);
  assert.match(html, /async function setGroundFpQaEnabled\(on\)/);
  assert.match(html, /window\.__SET_GROUND_FP_QA__/);
  assert.match(html, /window\.__GROUND_FP_QA_DEBUG__/);
  assert.match(html, /ground-fp-qa-toggle/);
});

test('[32G §0/§14] QA overlayはread-only（building geometryを再構築しない）', () => {
  // overlayはpushPolygon(平面塗り)のみを使い、pushExtrude(建物の押し出し)は使わない
  const start = html.indexOf('[Mission 32G §14] GROUND FOOTPRINT QA');
  const end = html.indexOf('function getGroundFpQaDebug()');
  assert.ok(start > 0 && end > start, 'Mission 32Gのruntimeコード範囲が特定できない');
  const section = html.slice(start, end);
  assert.doesNotMatch(section, /pushExtrude/);
  assert.match(section, /layerGroup\.buildings\.visible = false;/); // §14: 3D extrusionを隠す
  assert.match(section, /savedBuildingsVisibleBeforeGroundFpQa/); // OFFで必ず戻す
});

test('[32G 動的] QA overlay ON/OFFでbuilding表示が復元されresidualが0を維持する', async () => {
  if (!fs.existsSync(HTML)) return;
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const before = w.__GROUND_FP_QA_DEBUG__();
  assert.equal(before.enabled, false, '既定でONになっている');
  await w.__SET_GROUND_FP_QA__(true);
  await new Promise((res) => setTimeout(res, 300));
  const on = w.__GROUND_FP_QA_DEBUG__();
  assert.equal(on.enabled, true);
  assert.equal(on.dataLoaded, true, 'overlay.jsonがfetchされていない');
  assert.equal(on.sampleCount, 30);
  assert.equal(on.buildingsHidden, true, '§14: 建物3D extrusionが隠れていない');
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0, 'QA ON時にresidualが0でない');
  await w.__SET_GROUND_FP_QA__(false);
  const off = w.__GROUND_FP_QA_DEBUG__();
  assert.equal(off.enabled, false);
  assert.equal(off.buildingsHidden, false, 'OFF後に建物表示が復元されていない');
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0, 'QA OFF後にresidualが0でない');
});

test('[32G] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /groundFpQaEnabled|setGroundFpQaEnabled|ground-footprint-qa/, f + ' に混入');
  }
});
