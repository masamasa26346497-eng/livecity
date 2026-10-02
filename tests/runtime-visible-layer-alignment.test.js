// tests/runtime-visible-layer-alignment.test.js
// [Mission 32J] RUNTIME VISIBLE-LAYER ALIGNMENT AUDIT（AUDIT ONLY）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInlineScript } from './_ward-ux-v1-smoke-harness.cjs';
import { CANONICAL_ROAD_FEATURE_COUNT, isKnownCanonicalCount } from "../tools/lib/canonical-baseline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';
const REPORT = 'runtime-visible-layer-alignment.json';

test('[32J §0/§25] validator が PASS（何も変更していない）', { skip: !rpt('runtime-visible-layer-alignment-validation.json') && 'no report' }, () => {
  const v = rpt('runtime-visible-layer-alignment-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.buildingMutation, 0);
  assert.equal(v.checks.roadMutation, 0);
  assert.equal(v.checks.projectionMutation, 0);
  assert.equal(v.checks.canonicalBuildings, 615617);
  // [Mission 35E] 32J 当時の記録。今日の件数ではなく「書かれた時点で正しかったか」で見る。
  assert.ok(isKnownCanonicalCount('roads', v.checks.canonicalRoads),
    '未知の canonical roads 件数: ' + v.checks.canonicalRoads);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[32J §1] 緑レイヤーが runtime 実測で1つに確定している', { skip: !rpt(REPORT) && 'no report' }, () => {
  const g = rpt(REPORT).greenLayerSource;
  assert.equal(g.GREEN_LAYER_SOURCE, 'GsiRoadEdgeTile');
  assert.ok(g.meshCount > 0, '緑 mesh が scene に無い');
  // 色は「コードから読んだ定数」ではなく runtime の material から実測している
  assert.ok(Array.isArray(g.measuredColors) && g.measuredColors.length === 1, '実測色が1つに定まっていない');
  assert.equal(g.measuredColors[0], '0x18c37a');
  assert.match(g.parentChain, /canonicalRoot > GsiRoadEdgeAuthoritative > GsiRoadEdgeTile$/);
  assert.equal(g.runtimeOwner, 'CANONICAL');
  assert.equal(g.datasetId, 'gsi-road-edge');
  // §1 の核心: 緑線は道路区域の境界であって建物外形線ではない
  assert.match(g.semantics, /道路縁|道路区域/);
});

test('[32J §2] 建物レイヤーが同定され、3D建物と同一タイルであることが記録されている', { skip: !rpt(REPORT) && 'no report' }, () => {
  const b = rpt(REPORT).buildingLayerSource;
  assert.equal(b.meshName, 'ReferencePlateauFootprintLines');
  assert.ok(b.parentChain && b.datasetId && b.sourceFiles && b.lodType);
  assert.equal(b.sameTilesAs3dBuildingLayer, true);
  assert.ok(b.sameTilesEvidence && b.sameTilesEvidence.length > 0);
  assert.ok(b.note3dLayer && b.note3dLayer.length > 0, '3Dレイヤーを使えなかった旨の開示が無い');
});

test('[32J §3/§4] 両レイヤーの effective transform が完全一致し identity である', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  assert.equal(r.transformsEqual, true);
  assert.equal(r.bothIdentity, true);
  for (const t of [r.buildingTransform, r.greenTransform]) {
    assert.equal(t.effectiveTranslationX, 0);
    assert.equal(t.effectiveTranslationZ, 0);
    assert.equal(t.effectiveScaleX, 1);
    assert.equal(t.effectiveScaleZ, 1);
    assert.equal(t.effectiveRotationY, 0);
    assert.ok(Array.isArray(t.chainSteps) && t.chainSteps.length > 0, 'parent chain が記録されていない');
  }
});

test('[32J §5/§17/§18] source 頂点が scene 上に無変換で存在し、符号も軸も保たれている', { skip: !rpt(REPORT) && 'no report' }, () => {
  const s = rpt(REPORT).signAxisAudit;
  assert.ok(s.tracedVertices >= 20, 'トレース頂点が少なすぎる: ' + s.tracedVertices);
  assert.equal(s.xPreserved, s.tracedVertices, 'x が保たれていない頂点がある');
  assert.equal(s.zPreserved, s.tracedVertices, 'z が保たれていない頂点がある');
  assert.equal(s.xzSwapped, 0);
  assert.equal(s.signConventionHeld, true);
  assert.equal(s.axisSwapDetected, false);
});

test('[32J §7] fixture は低層のみ 20件以上（駅・高架・巨大施設を除外）', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  assert.ok(r.fixtureCount >= 20, 'fixture が20未満: ' + r.fixtureCount);
  assert.ok(r.fixtureCriteria.maxHeightM <= 15);
  assert.ok(r.fixtureCriteria.areaM2Range[1] <= 1500);
  assert.ok(r.fixtureCriteria.excludedUsage.length > 0);
});

test('[32J §11/§12] systematic offset と affine が算出され、平行移動も scale 誤差も無い', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  assert.ok(Math.abs(r.medianDx) < 1, 'median dx が 1m 以上: ' + r.medianDx);
  assert.ok(Math.abs(r.medianDz) < 5, 'median dz が 5m 以上: ' + r.medianDz);
  assert.ok(r.p95Distance != null);
  const a = r.affine;
  assert.ok(Math.abs(a.scaleX - 1) < 0.02, 'affine scaleX が 1 から乖離: ' + a.scaleX);
  assert.ok(Math.abs(a.scaleZ - 1) < 0.02, 'affine scaleZ が 1 から乖離: ' + a.scaleZ);
  assert.ok(Math.abs(a.rotation) < 0.01, 'affine rotation が 0 から乖離: ' + a.rotation);
});

test('[32J §21] 誤差ベクトルの向きが揃っていない（＝系統的な runtime offset ではない）', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  assert.ok(r.directionConsistency != null);
  assert.ok(r.directionConsistency < 0.7,
    '誤差ベクトルの向きが揃っている（runtime offset の疑い）: ' + r.directionConsistency);
  assert.ok(r.directionConsistencyNote && r.directionConsistencyNote.length > 0);
});

test('[32J §13/§14] tile 別結果が 3 tile 以上あり、tile 依存のズレが無い', { skip: !rpt(REPORT) && 'no report' }, () => {
  const t = rpt(REPORT).tileResults;
  assert.ok(t.length >= 3, 'tile が3未満: ' + t.length);
  for (const x of t) {
    assert.ok(x.tileOriginWorld && x.tileBboxWorld, 'tile origin / bbox が無い');
    assert.ok(Math.abs(x.medianDx) < 1, 'tile ' + x.tileId + ' の median dx が大きい: ' + x.medianDx);
  }
});

test('[32J §15/§16] 二重原点・tile offset の加減算が無い', { skip: !rpt(REPORT) && 'no report' }, () => {
  const a = rpt(REPORT).tileOriginAudit;
  for (const k of ['buildingCenter', 'mapCenter', 'roadCenter', 'tileCenter', 'localOrigin', 'worldOrigin']) {
    assert.equal(a.doubleOriginTermHits[k], 0, k + ' が実コードに出現している');
  }
  assert.equal(a.doubleOriginDetected, false);
  assert.equal(a.buildingUsesRawSourceCoords, true);
  assert.ok(a.placementStepNote && /座標を変えない/.test(a.placementStepNote));
});

test('[32J §19] world unit が 1 unit = 1m', { skip: !rpt(REPORT) && 'no report' }, () => {
  assert.equal(rpt(REPORT).worldUnitAudit.unitsPerMeter, 1);
});

test('[32J §6] scene 全体が単一カメラで描画される（screen だけズレることは無い）', { skip: !rpt(REPORT) && 'no report' }, () => {
  const s = rpt(REPORT).screenAudit;
  assert.equal(s.singleCameraForWholeScene, true);
  assert.equal(s.otherRenderCalls, 0);
  assert.ok(s.note && /カメラ/.test(s.note));
});

test('[32J §22/§25] classification と stopToken が規定の選択肢', { skip: !rpt(REPORT) && 'no report' }, () => {
  const r = rpt(REPORT);
  assert.match(r.classification, /^(RUNTIME_LAYER_TRANSLATION_ERROR|RUNTIME_LAYER_SCALE_ERROR|RUNTIME_TILE_OFFSET_ERROR|RUNTIME_PARENT_TRANSFORM_ERROR|RUNTIME_SIGN_AXIS_ERROR|SOURCE_SEMANTICS_DIFFERENCE|NO_RUNTIME_ALIGNMENT_ERROR)$/);
  assert.match(r.stopToken, /^(VISIBLE_LAYER_ROOT_CAUSE_IDENTIFIED|VISIBLE_LAYER_ALIGNMENT_CORRECT)$/);
  assert.ok(r.classificationReason && r.classificationReason.length > 0);
  assert.ok(Array.isArray(r.limitations) && r.limitations.length > 0, '限界の開示が無い');
});

test('[32J §24] canonical 同士ではなく scene 実座標を読んでいる', () => {
  const src = fs.readFileSync(R('tools', 'audit', 'runtime-visible-layer-alignment.js'), 'utf-8');
  assert.match(src, /runInlineScript\(/);
  assert.match(src, /geometry\.attributes\.position/);
});

test('[32J §20/§8] Visible Alignment QA overlay が存在し既定OFF・Ortho固定', () => {
  assert.match(html, /let visibleAlignQaEnabled = false;/);
  assert.match(html, /async function setVisibleAlignQaEnabled\(on\)/);
  assert.match(html, /window\.__SET_VISIBLE_ALIGN_QA__/);
  assert.match(html, /window\.__VISIBLE_ALIGN_QA_DEBUG__/);
  assert.match(html, /visible-align-qa-toggle/);
  assert.match(html, /CanonicalRuntime\.isVisibleAlignQaActive\(\)\) return orthoCamera;/);
  // §20 指定色
  const m = /const VISIBLE_ALIGN_QA_COLOR = \{[\s\S]*?\};/.exec(html);
  assert.ok(m, 'VISIBLE_ALIGN_QA_COLOR が無い');
  assert.match(m[0], /building: 0x00e5ff/);  // cyan
  assert.match(m[0], /green: 0xff33cc/);     // magenta
  assert.match(m[0], /vector: 0xffe033/);    // yellow
});

test('[32J §0/§9] QA overlay は read-only で 3D extrusion / 他レイヤーを隠して復元する', () => {
  const start = html.indexOf('[Mission 32J §20/§21] VISIBLE ALIGNMENT QA');
  const end = html.indexOf('function getVisibleAlignQaDebug()');
  assert.ok(start > 0 && end > start, 'Mission 32J の runtime コード範囲が特定できない');
  const section = html.slice(start, end);
  assert.doesNotMatch(section, /pushExtrude/);
  assert.match(section, /layerGroup\.buildings\.visible = false; layerGroup\.roads\.visible = false;/);
  assert.match(section, /savedBeforeVisibleAlignQa/);
});

test('[32J 動的] QA overlay ON/OFF で表示が復元され residual が 0 を維持する', async () => {
  if (!fs.existsSync(HTML)) return;
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  assert.equal(w.__VISIBLE_ALIGN_QA_DEBUG__().enabled, false, '既定で ON になっている');
  await w.__SET_VISIBLE_ALIGN_QA__(true);
  await new Promise((res) => setTimeout(res, 400));
  const on = w.__VISIBLE_ALIGN_QA_DEBUG__();
  assert.equal(on.enabled, true);
  assert.equal(on.dataLoaded, true, 'overlay.json が fetch されていない');
  assert.ok(on.fixtureCount >= 20, 'fixture が 20 未満: ' + on.fixtureCount);
  assert.equal(on.buildingsHidden, true, '§9: 建物3D extrusion が隠れていない');
  assert.equal(on.greenLayerSource, 'GsiRoadEdgeTile');
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0, 'QA ON 時に residual が 0 でない');
  await w.__SET_VISIBLE_ALIGN_QA__(false);
  const off = w.__VISIBLE_ALIGN_QA_DEBUG__();
  assert.equal(off.enabled, false);
  assert.equal(off.buildingsHidden, false, 'OFF 後に建物表示が復元されていない');
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0, 'QA OFF 後に residual が 0 でない');
});

test('[32J harness] material 色が runtime から読めること（§1 を実測可能にした変更の回帰防止）', () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true);
  // 既定色（未指定）は白のまま。指定色は保持される。
  const THREE = r.window.THREE;
  assert.equal(new THREE.MeshBasicMaterial({ color: 0x18c37a }).color.getHex(), 0x18c37a);
  assert.equal(new THREE.LineBasicMaterial({ color: 0xff33cc }).color.getHex(), 0xff33cc);
  assert.equal(new THREE.MeshBasicMaterial().color.getHex(), 0xffffff);
});

test('[32J] protected HTML に本ミッション関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /visibleAlignQaEnabled|VisibleAlignQa_|visible-align-qa/, f + ' に混入');
  }
});
