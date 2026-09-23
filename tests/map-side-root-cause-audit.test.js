// tests/map-side-root-cause-audit.test.js
// [Mission 32D] MAP-SIDE ROOT CAUSE AUDIT。
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

test('[32D §35] validator が PASS', { skip: !rpt('map-side-root-cause-audit-validation.json') && 'no report' }, () => {
  const v = rpt('map-side-root-cause-audit-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.buildingMutation, 0);
  assert.equal(v.checks.canonicalRoadMutation, 0);
  assert.equal(v.checks.buildingScaleMutation, 0);
  assert.equal(v.checks.buildingPositionMutation, 0);
  assert.equal(v.checks.mapLayerProvenanceComplete, true);
  assert.equal(v.checks.unknownVisibleMapObjects, 0);
  assert.equal(v.checks.runtimeMapScaleMeasured, true);
  assert.equal(v.checks.projectionAuditComplete, true);
  assert.equal(v.checks.blockSemanticsExplicit, true);
  assert.equal(v.checks.correctionAppliedThisMission, 0);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[32D §28] map-side-root-cause-audit.json に必須フィールドが揃っている', { skip: !rpt('map-side-root-cause-audit.json') && 'no report' }, () => {
  const r = rpt('map-side-root-cause-audit.json');
  assert.ok(r.visibleMapLayers);
  assert.ok(r.provenanceCounts);
  assert.equal(r.provenanceCounts.UNKNOWN, 0);
  assert.ok(r.gsiRoadEdge && r.gsiRoadEdge.featureCount > 0);
  assert.ok(r.fix13 && r.fix13.featureCount > 0);
  assert.ok(r.plateauTran && r.plateauTran.featureCount > 0);
  assert.ok(r.osm && r.osm.featureCount > 0);
  assert.ok(r.block && r.block.umeda && r.block.sumiyoshi);
  assert.equal(r.block.officialName, 'ROAD_ENCLOSED_BLOCK');
  assert.ok(r.pairwiseAlignment && r.pairwiseAlignment.tranVsCanonicalExact);
  assert.ok(r.pairwiseAlignment.umeda && r.pairwiseAlignment.sumiyoshi);
  assert.equal(r.pairwiseAlignment.umeda.perPoint.length, 5, '梅田は5地点');
  assert.equal(r.pairwiseAlignment.sumiyoshi.perPoint.length, 3, '住吉は3地点');
  assert.ok(r.projectionAudit);
  assert.ok(r.runtimeTransformAudit);
  assert.ok(Array.isArray(r.classification) && r.classification.length > 0);
  const ALLOWED = ['MAP_DATA_POSITION_ERROR', 'MAP_DATA_SCALE_ERROR', 'MAP_RUNTIME_TRANSFORM_ERROR',
    'ROAD_SEMANTICS_MISMATCH', 'BLOCK_SEMANTICS_MISMATCH', 'MULTI_LAYER_VISUAL_CONFLICT',
    'BUILDING_MAP_SOURCE_CONFLICT', 'NO_MAP_SIDE_GEOMETRIC_ERROR'];
  for (const c of r.classification) assert.ok(ALLOWED.includes(c), '未知のclassification: ' + c);
});

test('[32D §17-19] PLATEAU tran → Canonical Road の厳密diffは位置/scale誤差ゼロ（tranId厳密対応）', { skip: !rpt('map-side-root-cause-audit.json') && 'no report' }, () => {
  const r = rpt('map-side-root-cause-audit.json');
  const t = r.pairwiseAlignment.tranVsCanonicalExact;
  assert.ok(t.matchedByExactTranId > 100000, 'マッチ件数が少なすぎる: ' + t.matchedByExactTranId);
  assert.equal(t.ringLengthMismatchCount, 0);
  assert.equal(t.perFeatureMaxVertexOffsetM.max, 0, 'tran→canonicalパイプラインで頂点位置がズレている(要再調査)');
});

test('[32D §14] primary(carriageway)分類面積の大半がPLATEAU tran(歩道込み道路区域)由来', { skip: !rpt('map-side-root-cause-audit.json') && 'no report' }, () => {
  const r = rpt('map-side-root-cause-audit.json');
  const p = r.fix13.primarySourceBreakdown;
  assert.ok(p.tranSourcedPrimaryAreaRatio > 0.9, 'tran由来比率が低い: ' + p.tranSourcedPrimaryAreaRatio);
});

test('[32D §11] GSI Road Edge を parcel/lot/site boundary として扱う実装コードが存在しない', { skip: !rpt('map-side-root-cause-audit.json') && 'no report' }, () => {
  const r = rpt('map-side-root-cause-audit.json');
  // 自己監査コード/コメント中の説明的言及は除外し、GSI Road Edgeの意味づけを変えるコード(代入/条件式)が無いことを確認
  const codeHits = (r.parcelConflationAudit.conflationHits || []).filter((h) => !/^\/\/|^\s*\/\//.test(h.text) && !/officialName:/.test(h.text));
  assert.equal(codeHits.length, 0, 'parcel/lot/site とGSI Road Edgeを結びつける実コードが見つかった: ' + JSON.stringify(codeHits));
});

test('[32D §21] GSI_EDGE/canonicalRoot等のgroupへ非1 scale代入が無い', { skip: !rpt('map-side-root-cause-audit.json') && 'no report' }, () => {
  const r = rpt('map-side-root-cause-audit.json');
  assert.deepEqual(r.runtimeTransformAudit.nonUnitScaleAssignments, []);
});

test('[32D §5/§6] MAP AUDIT runtime API が存在し既定OFF', () => {
  assert.match(html, /let mapAuditEnabled = false;/);
  assert.match(html, /async function setMapAuditMode\(enabled, region\)/);
  assert.match(html, /function setMapAuditLayer\(layer, on\)/);
  assert.match(html, /function setMapAuditSingleLayer\(layer\)/);
  assert.match(html, /window\.__SET_MAP_AUDIT_MODE__/);
  assert.match(html, /window\.__MAP_AUDIT_DEBUG__/);
});

test('[32D §7] MAP AUDIT は既存の真のOrthographicCameraを再利用する', () => {
  assert.match(html, /if \(typeof CanonicalRuntime !== 'undefined' && CanonicalRuntime\.isMapAuditActive && CanonicalRuntime\.isMapAuditActive\(\)\) return orthoCamera;/);
  assert.match(html, /setOrthoAlignmentView\(pt\.x, pt\.z, 250\);/);
});

test('[32D §23] block は ROAD_ENCLOSED_BLOCK と明示され parcel/lot/site という名称を使わない', { skip: !rpt('map-side-root-cause-audit.json') && 'no report' }, () => {
  const r = rpt('map-side-root-cause-audit.json');
  assert.equal(r.block.officialName, 'ROAD_ENCLOSED_BLOCK');
  // note欄は「parcel/lot/siteという名称は使わない」という説明目的で意図的にそれらの語を含むため、
  // 自己参照的false-positiveを避けてofficialName欄だけを対象にする（32Bのillegal Warp検出と同種の教訓）。
  assert.doesNotMatch(r.block.officialName, /parcel|lot boundary|\bsite\b/i);
});

test('[32D 動的] MAP AUDIT トグルON/OFF・地点/レイヤー切替でresidualが0を維持する', async () => {
  if (!fs.existsSync(HTML)) return;
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const before = w.__MAP_AUDIT_DEBUG__();
  assert.equal(before.enabled, false, '既定でONになっている');
  await w.__SET_MAP_AUDIT_MODE__(true, 'umeda');
  await new Promise((res) => setTimeout(res, 300));
  const afterOn = w.__MAP_AUDIT_DEBUG__();
  assert.equal(afterOn.enabled, true);
  assert.equal(afterOn.region, 'umeda');
  // FIX13/PLATEAU_TRANはpolygon fill(THREE.ShapeUtils.triangulateShape依存)のため、
  // このharnessでは実際に三角形化できず常にmeshCount=0になる(§既知のharness制約。
  // memory: shapeutils-stub-missing-unmasks-untagged-residual を参照。line/canvasベースの
  // GSI_EDGE/OSM_ROAD/BLOCKのみ動的に検証する)。
  assert.ok(afterOn.meshCounts.GSI_EDGE > 0, 'GSI_EDGEメッシュが作られていない');
  assert.ok(afterOn.meshCounts.OSM_ROAD > 0, 'OSM_ROADメッシュが作られていない');
  assert.ok(afterOn.meshCounts.BLOCK > 0, 'BLOCKメッシュ(raster texture plane)が作られていない');
  const residualOn = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualOn.total, 0, 'MAP AUDIT ON時にresidualが0でない: ' + JSON.stringify(residualOn));

  w.__SET_MAP_AUDIT_SINGLE_LAYER__('BLOCK');
  assert.equal(w.__MAP_AUDIT_DEBUG__().singleLayer, 'BLOCK');
  w.__SET_MAP_AUDIT_SINGLE_LAYER__(null);
  w.__SET_MAP_AUDIT_POINT__(4);
  assert.equal(w.__MAP_AUDIT_DEBUG__().pointIdx, 4);

  await w.__SET_MAP_AUDIT_MODE__(true, 'sumiyoshi');
  await new Promise((res) => setTimeout(res, 300));
  const afterSumiyoshi = w.__MAP_AUDIT_DEBUG__();
  assert.equal(afterSumiyoshi.region, 'sumiyoshi');
  const residualSumiyoshi = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualSumiyoshi.total, 0, '住吉切替後にresidualが0でない: ' + JSON.stringify(residualSumiyoshi));

  await w.__SET_MAP_AUDIT_MODE__(false);
  const afterOff = w.__MAP_AUDIT_DEBUG__();
  assert.equal(afterOff.enabled, false);
  const residualOff = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residualOff.total, 0, 'OFF後にresidualが0でない: ' + JSON.stringify(residualOff));
});

test('[32D §34] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /mapAuditEnabled|setMapAuditMode|MAP_AUDIT_REGIONS/, f + ' に混入');
  }
});
